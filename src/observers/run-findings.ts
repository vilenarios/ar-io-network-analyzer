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

import { assertNodeVersion } from '../utils/runtime.js';
import { openWriter } from '../db/index.js';
import {
  activeCalibration,
  getObservationsForEpochs,
  listEpochs,
  upsertFindings,
} from '../db/repo-read.js';
import {
  DETECTOR_VERSION,
  EPOCH_DETECTORS,
  GATEWAY_DEPENDENT_KINDS,
  WINDOW_DETECTORS,
} from './detectors/index.js';
import { buildEpochDocument, buildFindingsDocument, buildObserversDocument } from './documents.js';
import { capSeverity, makeFinding } from './finding.js';
import { publishDocuments, readPublishedDocument } from '../publish/publish.js';
import type { GatewaysDocument } from '../publish/contract.js';
import type {
  DetectorConfig,
  DetectorContext,
  EpochSnapshot,
  Finding,
  GatewayFacts,
} from './types.js';

const DEFAULT_SIMILARITY_THRESHOLD = 0.9; // UNCALIBRATED PLACEHOLDER — see §5
const DEFAULT_WINDOW_EPOCHS = 30;
const DEFAULT_CO_SUBMISSION_WINDOW_S = 60;
const DEFAULT_SHARED_ASN_MIN_OBSERVERS = 4;
const DEFAULT_PERSISTENT_MIN_EPOCHS = 3;
const DEFAULT_COMPOSITE_MIN_KINDS = 2;
const DEFAULT_ANALYSIS_MAX_AGE_SECONDS = 172_800;

/** Confidence multiplier applied when the gateway roster is missing or stale. */
const DEGRADED_CONFIDENCE_FACTOR = 0.6;

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

interface GatewayRoster {
  gateways: Map<string, GatewayFacts>;
  snapshotAt: string | null;
  degraded: boolean;
}

/**
 * Load the roster from the published `gateways.json`. Never resolves DNS:
 * a missing or stale roster degrades the infrastructure detectors instead.
 */
function loadGatewayRoster(): GatewayRoster {
  const document = readPublishedDocument<GatewaysDocument>('api/v1/gateways.json');
  if (!document) {
    console.warn('⚠️  no published gateways.json — infrastructure detectors run degraded');
    return { gateways: new Map(), snapshotAt: null, degraded: true };
  }

  const ageSeconds = (Date.now() - Date.parse(document.generatedAt)) / 1000;
  const maxAge = envNumber('ANALYSIS_MAX_AGE_SECONDS', DEFAULT_ANALYSIS_MAX_AGE_SECONDS);
  const degraded = !Number.isFinite(ageSeconds) || ageSeconds > maxAge;

  if (degraded) {
    console.warn(
      `⚠️  gateways.json is ${Math.round(ageSeconds / 3600)}h old — infrastructure detectors run degraded`
    );
  }

  const gateways = new Map<string, GatewayFacts>();
  for (const entry of document.gateways) {
    gateways.set(entry.wallet, {
      wallet: entry.wallet,
      fqdn: entry.fqdn,
      ipAddress: entry.ipAddress,
      ipRange: entry.ipRange,
      asn: entry.asn,
      asnOrg: entry.asnOrg,
      baseDomain: entry.baseDomain,
      clusterKey: entry.clusterKey,
      clusterKind: entry.clusterKind,
      clusterSize: entry.clusterSize,
      stake: entry.stake,
      overallCentralization: entry.scores.overall,
    });
  }

  return { gateways, snapshotAt: document.generatedAt, degraded };
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
    console.error(`❌ detector ${detector.kind} threw: ${(error as Error).message}`);
    return [
      makeFinding({
        kind: 'detector_error',
        epochIndex: ctx.epoch.epochIndex,
        observers: [],
        severity: 'info',
        confidence: 1,
        summary: `Detector ${detector.kind} failed for epoch ${ctx.epoch.epochIndex}.`,
        detail: { detector: detector.kind, error: (error as Error).message },
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

    await publishDocuments({
      observers: buildObserversDocument(epochs, findings, roster.gateways),
      findings: buildFindingsDocument(findings, epochs, config),
      epochDocs: epochs.map((epoch) => ({
        epochIndex: epoch.epochIndex,
        doc: buildEpochDocument(epoch, findings),
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
