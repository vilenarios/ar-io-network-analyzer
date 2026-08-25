#!/usr/bin/env node

/**
 * ENTRY POINT (b2) — the cheap cadence (every 10 minutes).
 *
 * Pure recomputation: masked Hamming over a few dozen 81-byte prefixes plus a
 * join against the gateway roster the daily analysis already published. It
 * must never trigger DNS or geo — that is what degraded mode is for.
 *
 * Publishes `observers.json`, `findings.json` and the per-epoch documents.
 */

import { assertNodeVersion, scrubSecrets } from '../utils/runtime.js';
import { openWriter } from '../db/index.js';
import {
  activeCalibration,
  getObservationsForEpochs,
  listEpochs,
  epochEndTimestampSeconds,
  listEconomicsSamples,
  listScannedRewardEpochs,
  listDelegateRewards,
  latestStakePerPosition,
  listFindings,
  upsertFindings,
} from '../db/repo-read.js';
import { buildEconomicsDocument } from '../economics/document.js';
import { readEconomicsInputsFromSummary } from '../economics/inputs.js';
import { sampleEconomics } from '../economics/sample.js';
import { createBalanceReader } from '../economics/solana-balance.js';
import { readStakePositions } from '../rewards/inputs.js';
import { sampleStakePositions } from '../rewards/sample.js';
import { createProgramReader } from '../rewards/program-reader.js';
import { buildRewardsDocument } from '../rewards/document.js';
import { epochsAwaitingRewardScan, scanDelegateRewards } from '../rewards/scan.js';
import { publicDir } from '../publish/publish.js';
import {
  DETECTOR_VERSION,
  EPOCH_DETECTORS,
  GATEWAY_DEPENDENT_KINDS,
  WINDOW_DETECTORS,
} from './detectors/index.js';
import { buildEpochDocument, buildFindingsDocument, buildObserversDocument } from './documents.js';
import { capSeverity, makeFinding } from './finding.js';
import { publishDocuments } from '../publish/publish.js';
import { loadGatewayRoster } from './roster.js';
import type { DetectorConfig, DetectorContext, EpochSnapshot, Finding } from './types.js';

const DEFAULT_SIMILARITY_THRESHOLD = 0.9; // UNCALIBRATED PLACEHOLDER — see §5
const DEFAULT_WINDOW_EPOCHS = 30;
const DEFAULT_CO_SUBMISSION_WINDOW_S = 60;
const DEFAULT_SHARED_ASN_MIN_OBSERVERS = 4;
const DEFAULT_PERSISTENT_MIN_EPOCHS = 3;
const DEFAULT_COMPOSITE_MIN_KINDS = 2;

/** Confidence multiplier applied when the gateway roster is missing or stale. */
const DEGRADED_CONFIDENCE_FACTOR = 0.6;

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function buildConfig(calibrationId: number | null, threshold: number): DetectorConfig {
  return {
    similarityThreshold: threshold,
    calibrated: calibrationId !== null,
    calibrationId,
    coSubmissionWindowSeconds: envNumber(
      'OBSERVER_CO_SUBMISSION_WINDOW_S',
      DEFAULT_CO_SUBMISSION_WINDOW_S
    ),
    sharedAsnMinObservers: DEFAULT_SHARED_ASN_MIN_OBSERVERS,
    persistentMinEpochs: DEFAULT_PERSISTENT_MIN_EPOCHS,
    compositeMinKinds: DEFAULT_COMPOSITE_MIN_KINDS,
    windowEpochs: envNumber('OBSERVER_WINDOW_EPOCHS', DEFAULT_WINDOW_EPOCHS),
    detectorVersion: DETECTOR_VERSION,
  };
}

/**
 * Degraded mode: infrastructure findings keep their shape but lose weight, and
 * say which roster they were computed against.
 */
function degrade(finding: Finding, snapshotAt: string | null): Finding {
  if (!GATEWAY_DEPENDENT_KINDS.has(finding.kind)) return finding;
  return {
    ...finding,
    severity: capSeverity(finding.severity, 'medium'),
    confidence: finding.confidence * DEGRADED_CONFIDENCE_FACTOR,
    detail: { ...finding.detail, degraded: true, gatewaySnapshotAt: snapshotAt },
  };
}

/** One bad detector never blackholes the cycle. */
function runDetector(
  detector: { kind: string; run(ctx: DetectorContext): Finding[] },
  ctx: DetectorContext
): Finding[] {
  try {
    return detector.run(ctx);
  } catch (error) {
    // scrubSecrets, not `.message`: a detector that touches the network can
    // throw with a token-bearing URL inside the message, and this goes to a log.
    console.error(`❌ detector ${detector.kind} threw: ${scrubSecrets(error)}`);
    return [
      makeFinding({
        kind: 'detector_error',
        epochIndex: ctx.epoch.epochIndex,
        observers: [],
        severity: 'info',
        confidence: 1,
        summary: `Detector ${detector.kind} failed for epoch ${ctx.epoch.epochIndex}.`,
        // Worse than the log line above: this is PERSISTED into the findings
        // table and then published in findings.json, so an unscrubbed message
        // would ship a provider token to every consumer of the API.
        detail: { detector: detector.kind, error: scrubSecrets(error) },
        now: ctx.now,
      }),
    ];
  }
}

async function main(): Promise<void> {
  assertNodeVersion();

  const allEpochs = process.argv.includes('--all-epochs');
  const db = openWriter();

  try {
    const calibration = activeCalibration(db);
    const config = buildConfig(
      calibration?.id ?? null,
      calibration?.recommendedThreshold ??
        envNumber('OBSERVER_SIMILARITY_THRESHOLD', DEFAULT_SIMILARITY_THRESHOLD)
    );

    const known = listEpochs(db);
    if (known.length === 0) {
      console.log('No observations captured yet — publishing empty observer documents.');
      await publishDocuments({
        observers: buildObserversDocument([], [], new Map()),
        findings: buildFindingsDocument([], [], config),
        lock: 'skip',
      });
      return;
    }

    const selected = allEpochs ? known : known.slice(-config.windowEpochs);
    const epochs: EpochSnapshot[] = getObservationsForEpochs(
      db,
      selected.map((e) => e.epochIndex)
    );

    const roster = loadGatewayRoster();
    const now = Date.now();
    const findings: Finding[] = [];

    for (const epoch of epochs) {
      const epochFindings: Finding[] = [];
      for (const detector of EPOCH_DETECTORS) {
        const ctx: DetectorContext = {
          epoch,
          epochs,
          gateways: roster.gateways,
          gatewaySnapshotAt: roster.snapshotAt,
          config,
          now,
          priorFindings: epochFindings,
        };
        epochFindings.push(
          ...runDetector(detector, ctx).map((finding) =>
            roster.degraded ? degrade(finding, roster.snapshotAt) : finding
          )
        );
      }
      findings.push(...epochFindings);
    }

    for (const detector of WINDOW_DETECTORS) {
      const ctx: DetectorContext = {
        epoch: epochs[epochs.length - 1],
        epochs,
        gateways: roster.gateways,
        gatewaySnapshotAt: roster.snapshotAt,
        config,
        now,
        priorFindings: findings,
      };
      findings.push(...runDetector(detector, ctx));
    }

    upsertFindings(
      db,
      findings,
      config.detectorVersion,
      epochs.map((e) => e.epochIndex),
      true
    );

    // Re-attach `firstSeenAt` from the store before publishing.
    //
    // The findings above are freshly detected, so each carries
    // `detectedAt = now` — this run's clock. The store is what remembers when
    // a finding was FIRST seen, and `upsertFindings` preserves that across
    // runs. Publishing the in-memory objects therefore stamped every finding
    // with "now" on every hourly run, including findings about epochs that
    // settled weeks ago.
    //
    // Wrong twice over: `detectedAt` claimed a two-week-old signal was
    // detected seconds ago, and the churn gave every epoch document new bytes
    // hourly even though its data can never change.
    const storedById = new Map(
      listFindings(db, { epochIndexes: epochs.map((e) => e.epochIndex) }).map((stored) => [
        stored.id,
        stored.firstSeenAt,
      ])
    );
    const publishable = findings.map((finding) => {
      const firstSeenAt = storedById.get(finding.id);
      return firstSeenAt === undefined ? finding : { ...finding, firstSeenAt };
    });

    // Retain one protocol-balance sample per completed epoch, so a delta can
    // be taken across it. Guarded: a failure here must never cost the findings
    // publish, which is the job this process actually exists to do.
    try {
      // Anchored to the epoch boundary, not to now — see rule 3 in sample.ts.
      // Costs a handful of RPC calls once per epoch (roughly once a day), not
      // per cycle: the reader caches signatures for the life of the process and
      // is only consulted when an epoch is actually pending.
      const balanceReader = createBalanceReader();
      const result = await sampleEconomics(
        db,
        async () => readEconomicsInputsFromSummary(publicDir()),
        {
          readBoundaryBalance: async (epochIndex) => {
            const endSeconds = epochEndTimestampSeconds(db, epochIndex);
            if (endSeconds === null) return null;
            const boundary = await balanceReader.balanceAtBoundary(endSeconds);
            return boundary ? { ...boundary, endMs: endSeconds * 1000 } : null;
          },
        }
      );
      if (result.sampled.length > 0) {
        console.log(`💰 economics: sampled epoch(s) ${result.sampled.join(', ')}`);
      }
      if (result.skipped.length > 0) {
        console.log(
          `⏭️  economics: skipped epoch(s) ${result.skipped.join(', ')} — ` +
            `no usable protocol balance (a gap is published as a gap, never filled in)`
        );
      }
    } catch (error) {
      console.error(`❌ economics sampling failed: ${scrubSecrets(error)}`);
    }

    // Retain every staking position once per settled epoch, so a position's
    // earnings become derivable at all. Guarded like the economics sample: this
    // must never cost the findings publish.
    //
    // Costs ZERO extra RPC — the positions are read from the portal snapshot
    // already on disk, not re-fetched. Querying the ~805 positions individually
    // would add real load to obtain numbers we already have.
    //
    // Unlike the economics sample this cannot be backfilled: stake credits land
    // in PDA state, which has no per-transaction history. A missed epoch is
    // gone, which is why it runs on the cheap cadence.
    try {
      const result = await sampleStakePositions(db, async () =>
        readStakePositions(publicDir())
      );
      if (result.sampled.length > 0) {
        console.log(
          `🥩 stake: retained ${result.positions} position(s) for epoch(s) ${result.sampled.join(', ')}`
        );
      }
      if (result.skipped.length > 0) {
        console.log(
          `⏭️  stake: skipped epoch(s) ${result.skipped.join(', ')} — portal snapshot ` +
            `missing or stale (retries next cycle; a gap here is unrecoverable)`
        );
      }
    } catch (error) {
      console.error(`❌ stake sampling failed: ${scrubSecrets(error)}`);
    }

    // Record exact delegate rewards from the program's own events. Unlike the
    // stake sample this is replayable — the events are immutable log data — so
    // a failure here costs nothing permanent and the epoch is simply rescanned.
    try {
      const pending = epochsAwaitingRewardScan(db, 2);
      if (pending.length > 0) {
        const result = await scanDelegateRewards(db, createProgramReader(), pending);
        console.log(
          `🎁 rewards: ${result.events} event(s), ` +
            `${(result.totalAmount / 1e6).toFixed(6)} ARIO across epoch(s) ${result.epochs.join(', ')}`
        );
      }
    } catch (error) {
      console.error(`❌ reward scan failed: ${scrubSecrets(error)}`);
    }

    await publishDocuments({
      observers: buildObserversDocument(epochs, publishable, roster.gateways),
      findings: buildFindingsDocument(publishable, epochs, config),
      economics: buildEconomicsDocument(
        listEconomicsSamples(db),
        (epochIndex) => epochEndTimestampSeconds(db, epochIndex),
        new Date().toISOString()
      ),
      rewards: buildRewardsDocument(
        // Only epochs actually scanned, so an unscanned one can never be read
        // as an epoch in which a position earned nothing.
        listScannedRewardEpochs(db),
        (epochIndex) => epochEndTimestampSeconds(db, epochIndex),
        listDelegateRewards(db),
        latestStakePerPosition(db),
        new Date().toISOString()
      ),
      epochDocs: epochs.map((epoch) => ({
        epochIndex: epoch.epochIndex,
        doc: buildEpochDocument(epoch, publishable),
      })),
      lock: 'skip',
    });

    const bySeverity = findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
      return counts;
    }, {});

    console.log(
      `🔎 ${findings.length} findings across ${epochs.length} epochs ` +
        `(${
          Object.entries(bySeverity)
            .map(([severity, count]) => `${count} ${severity}`)
            .join(', ') || 'none'
        })` +
        `${config.calibrated ? '' : ' · similarity threshold UNCALIBRATED'}`
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('❌ findings run failed:', error);
  process.exit(1);
});
