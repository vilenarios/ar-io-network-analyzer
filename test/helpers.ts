/**
 * Test fixtures and helpers.
 *
 * Everything here is synthetic and deterministic. No test in this suite may
 * touch the network: the capture path is the only thing that talks to an RPC
 * endpoint, and it is exercised through injected decoders and in-memory
 * databases, never through a live `getProgramAccounts`.
 *
 * The shapes mirror what was actually measured on AR.IO mainnet: a 469-byte
 * Observation account carrying a 375-byte result blob for `gatewayCount = 643`,
 * of which only the first 81 bytes are meaningful.
 */

import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations.js';
import type {
  DecodedObservation,
  EpochSnapshot,
  ObservationRecord,
} from '../src/observers/types.js';

export const GATEWAY_COUNT = 643;
export const BLOB_BYTES = 375;
export const MEANINGFUL_BYTES = 81; // ceil(643 / 8)
export const ACCOUNT_BYTES = 469;

/** An in-memory store with the full schema applied. */
export function memoryDb(): Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

/**
 * A deterministic result blob.
 *
 * `seed` fills the meaningful prefix; the tail is left as the constant zero
 * padding real accounts carry, because the masking rules only mean anything
 * against that shape.
 */
export function blob(fill = 0xa5, bytes = MEANINGFUL_BYTES): Buffer {
  const buffer = Buffer.alloc(BLOB_BYTES, 0);
  buffer.fill(fill, 0, Math.min(bytes, BLOB_BYTES));
  // Byte 81 is the partial byte for 643 gateways (643 % 8 === 3), and every
  // real blob has only its low three bits set there.
  buffer[MEANINGFUL_BYTES - 1] = 0x03;
  return buffer;
}

/** Flip `count` bits in the meaningful prefix of a copy of `source`. */
export function flipBits(source: Buffer, count: number, startBit = 0): Buffer {
  const copy = Buffer.from(source);
  for (let i = 0; i < count; i++) {
    const bit = startBit + i;
    const byteIndex = Math.floor(bit / 8);
    if (byteIndex >= MEANINGFUL_BYTES - 1) throw new Error('fixture would flip padding bits');
    copy[byteIndex] ^= 1 << bit % 8;
  }
  return copy;
}

export interface ObservationOverrides {
  epochIndex?: number;
  observer?: string;
  pubkey?: string;
  gatewayResults?: Buffer;
  gatewayCount?: number;
  reportTxId?: string;
  submittedAt?: number;
}

export function decodedObservation(overrides: ObservationOverrides = {}): DecodedObservation {
  const observer = overrides.observer ?? 'observer-1';
  return {
    epochIndex: overrides.epochIndex ?? 511,
    observer,
    pubkey: overrides.pubkey ?? `pda-${observer}`,
    gatewayResults: overrides.gatewayResults ?? blob(),
    gatewayCount: overrides.gatewayCount ?? GATEWAY_COUNT,
    reportTxId: overrides.reportTxId ?? `report-${observer}`,
    submittedAt: overrides.submittedAt ?? 1_760_000_000,
    schemaVersion: { major: 1, minor: 0, patch: 0 },
    accountBytes: ACCOUNT_BYTES,
    suspectTimestamp: false,
  };
}

export function observationRecord(overrides: ObservationOverrides = {}): ObservationRecord {
  return {
    ...decodedObservation(overrides),
    revision: 1,
    firstSeenAt: 1_760_000_100_000,
    lastSeenAt: 1_760_000_100_000,
    firstSeenSlot: 1000,
    lastSeenSlot: 1000,
  };
}

export function epochSnapshot(observations: ObservationRecord[], epochIndex = 511): EpochSnapshot {
  const submitted = observations.map((o) => o.submittedAt);
  return {
    epochIndex,
    observations,
    distinctReportTxIds: new Set(observations.map((o) => o.reportTxId)).size,
    firstSubmittedAtUnix: Math.min(...submitted),
    lastSubmittedAtUnix: Math.max(...submitted),
    registry: null,
  };
}

/**
 * The real epoch 511, reduced to its load-bearing structure:
 *   17 observations, 11 distinct report transactions,
 *   7 observers sharing ONE report tx,
 *   and those 7 blobs all DISTINCT but 96.5–97.9% byte-identical.
 *
 * This is the case the whole capability exists for, and the one that breaks a
 * `reportTxId` primary key, an equality-based comparison, and an unmasked
 * Hamming distance — in that order.
 */
export const SHARED_REPORT_TX = 'wE408GNPPIoTbRJEDfI0dm6dsklhE32zgdoCc2C1YKw';
export const SHARED_REPORT_OBSERVERS = [
  'arh.noddex.com',
  'ard.noddex.com',
  'arn.noddex.com',
  'arm.noddex.com',
  'arm.innostack.xyz',
  'ark.innostack.xyz',
  'arh.oohgroup.vn',
];

export function epoch511Observations(): ObservationRecord[] {
  const base = blob(0xa5);
  const observations: ObservationRecord[] = [];

  // The seven that share one report tx: 8–13 differing bits out of 643, i.e.
  // 97.98%–98.76% similar. All blobs distinct.
  SHARED_REPORT_OBSERVERS.forEach((observer, index) => {
    observations.push(
      observationRecord({
        observer,
        reportTxId: SHARED_REPORT_TX,
        gatewayResults: flipBits(base, 8 + index, index * 17),
        submittedAt: 1_760_000_000 + index * 3,
      })
    );
  });

  // Ten independent observers, each with its own report and its own blob.
  for (let i = 0; i < 10; i++) {
    observations.push(
      observationRecord({
        observer: `independent-${i}`,
        reportTxId: `report-independent-${i}`,
        gatewayResults: blob(0x5a + i),
        submittedAt: 1_760_000_500 + i * 600,
      })
    );
  }

  return observations;
}
