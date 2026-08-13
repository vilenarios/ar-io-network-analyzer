#!/usr/bin/env node

/**
 * ENTRY POINT (b3) — similarity calibration.
 *
 * The 0.90 default threshold is a guess made from one epoch of anecdote, and
 * it may well sit on the wrong side of the very cluster that motivated this
 * work. This command measures the actual distribution instead.
 *
 * It reads, prints a distribution table, and writes one `calibration` row.
 * It publishes nothing. Activating a calibration is a deliberate manual step:
 *
 *   yarn observers:calibrate                # measure and record
 *   yarn observers:calibrate --activate 3   # promote row 3
 */

import { assertNodeVersion } from '../utils/runtime.js';
import { openWriter } from '../db/index.js';
import { getObservationsForEpochs, listEpochs } from '../db/repo-read.js';
import { pairwiseMatrix } from './hamming.js';
import { readPublishedDocument } from '../publish/publish.js';
import type { GatewaysDocument } from '../publish/contract.js';
import type { GatewayFacts } from './types.js';

/** A threshold fitted to fewer epochs than this is worse than no threshold. */
const MIN_EPOCHS_FOR_CALIBRATION = 14;
const MIN_RECOMMENDED_THRESHOLD = 0.8;

interface PairSample {
  epochIndex: number;
  a: string;
  b: string;
  similarity: number;
  related: boolean;
  relatedBy: string[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function describe(label: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const fmt = (v: number | null) => (v === null ? '   n/a' : v.toFixed(4));
  return (
    `  ${label.padEnd(22)} n=${String(sorted.length).padStart(6)}  ` +
    `p50=${fmt(percentile(sorted, 50))}  p90=${fmt(percentile(sorted, 90))}  ` +
    `p99=${fmt(percentile(sorted, 99))}  p99.5=${fmt(percentile(sorted, 99.5))}  ` +
    `p99.9=${fmt(percentile(sorted, 99.9))}  max=${fmt(sorted[sorted.length - 1] ?? null)}`
  );
}

/** Two observers are "related" when any infrastructure fact is shared. */
function relationBetween(a: GatewayFacts | undefined, b: GatewayFacts | undefined): string[] {
  if (!a || !b) return [];
  const reasons: string[] = [];
  if (a.ipAddress && a.ipAddress === b.ipAddress) reasons.push('ip');
  if (a.ipRange && a.ipRange === b.ipRange) reasons.push('ip_range');
  if (a.baseDomain && a.baseDomain === b.baseDomain) reasons.push('base_domain');
  if (a.asn && a.asn === b.asn) reasons.push('asn');
  if (a.clusterKey && a.clusterKey === b.clusterKey) reasons.push('cluster');
  return reasons;
}

function loadRoster(): Map<string, GatewayFacts> {
  const document = readPublishedDocument<GatewaysDocument>('api/v1/gateways.json');
  const roster = new Map<string, GatewayFacts>();
  if (!document) return roster;

  for (const entry of document.gateways) {
    roster.set(entry.wallet, {
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
  return roster;
}

function activate(id: number): void {
  const db = openWriter();
  try {
    const row = db.prepare('SELECT id FROM calibration WHERE id = ?').get(id);
    if (!row) {
      console.error(`❌ no calibration row with id ${id}`);
      process.exitCode = 1;
      return;
    }
    const run = db.transaction(() => {
      db.prepare('UPDATE calibration SET active = 0').run();
      db.prepare('UPDATE calibration SET active = 1 WHERE id = ?').run(id);
    });
    run.immediate();
    console.log(
      `✅ calibration ${id} is now active — near_identical_results findings are calibrated.`
    );
  } finally {
    db.close();
  }
}

function main(): void {
  assertNodeVersion();

  const args = process.argv.slice(2);
  const activateIndex = args.indexOf('--activate');
  if (activateIndex !== -1) {
    const id = parseInt(args[activateIndex + 1] || '', 10);
    if (!Number.isFinite(id)) {
      console.error('❌ usage: yarn observers:calibrate --activate <id>');
      process.exitCode = 1;
      return;
    }
    activate(id);
    return;
  }

  const db = openWriter();
  try {
    const known = listEpochs(db);
    if (known.length < MIN_EPOCHS_FOR_CALIBRATION) {
      console.error(
        `❌ ${known.length} epochs captured; calibration needs at least ${MIN_EPOCHS_FOR_CALIBRATION}.\n` +
          `   A threshold fitted to one epoch is worse than no threshold — keep capturing.`
      );
      process.exitCode = 1;
      return;
    }

    const epochs = getObservationsForEpochs(
      db,
      known.map((e) => e.epochIndex)
    );
    const roster = loadRoster();
    if (roster.size === 0) {
      console.warn(
        '⚠️  no published gateways.json — every pair will be treated as presumed-independent, ' +
          'which biases the recommendation. Run `yarn analyze` first.'
      );
    }

    const samples: PairSample[] = [];
    for (const epoch of epochs) {
      for (const pair of pairwiseMatrix(epoch.observations)) {
        const reasons = relationBetween(roster.get(pair.a.observer), roster.get(pair.b.observer));
        samples.push({
          epochIndex: epoch.epochIndex,
          a: pair.a.observer,
          b: pair.b.observer,
          similarity: pair.result.similarity,
          related: reasons.length > 0,
          relatedBy: reasons,
        });
      }
    }

    const independent = samples.filter((s) => !s.related).map((s) => s.similarity);
    const related = samples.filter((s) => s.related).map((s) => s.similarity);

    const independentSorted = [...independent].sort((a, b) => a - b);
    const relatedSorted = [...related].sort((a, b) => a - b);

    const p999 = percentile(independentSorted, 99.9);
    const maxIndependent = independentSorted[independentSorted.length - 1] ?? null;
    const p50Related = percentile(relatedSorted, 50);
    const recommended = Math.max(p999 ?? MIN_RECOMMENDED_THRESHOLD, MIN_RECOMMENDED_THRESHOLD);

    // No separating signal: the most similar independent pair beats the median
    // related pair, so the detector cannot discriminate at this network size.
    const separates =
      maxIndependent === null || p50Related === null ? null : maxIndependent <= p50Related;

    console.log(
      `\nSimilarity calibration — epochs ${epochs[0].epochIndex}–${epochs[epochs.length - 1].epochIndex} (${epochs.length})`
    );
    console.log(
      `Pairs: ${samples.length} (${independent.length} presumed-independent, ${related.length} presumed-related)\n`
    );
    console.log(describe('presumed-independent', independent));
    console.log(describe('presumed-related', related));
    console.log('');

    let notes = `epochs=${epochs.length}; roster=${roster.size}`;
    if (separates === false) {
      notes +=
        '; NO_SEPARATION: max(independent) > p50(related) — demote near_identical_results to info';
      console.warn(
        '⚠️  RECOMMENDATION FAILS: the most similar independent pair exceeds the median related ' +
          'pair. Blob similarity carries no separating signal at this network size; the detector ' +
          'should be demoted to info rather than activated.'
      );
    } else if (separates === true) {
      console.log(
        `Overlap region: independent max ${maxIndependent?.toFixed(4)} vs related p50 ${p50Related?.toFixed(4)}`
      );
    }

    const info = db
      .prepare(
        `INSERT INTO calibration (
           computed_at, epoch_from, epoch_to, epoch_count, pair_count, independent_pairs,
           p50, p90, p99, p995, p999, max_independent, recommended_threshold, active, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        Date.now(),
        epochs[0].epochIndex,
        epochs[epochs.length - 1].epochIndex,
        epochs.length,
        samples.length,
        independent.length,
        percentile(independentSorted, 50),
        percentile(independentSorted, 90),
        percentile(independentSorted, 99),
        percentile(independentSorted, 99.5),
        p999,
        maxIndependent,
        recommended,
        notes
      );

    console.log(`\nRecommended threshold: ${recommended.toFixed(4)}`);
    console.log(`Recorded as calibration id ${info.lastInsertRowid} (inactive).`);
    console.log(`Review the distribution above, then activate deliberately:`);
    console.log(`  yarn observers:calibrate --activate ${info.lastInsertRowid}\n`);
  } finally {
    db.close();
  }
}

main();
