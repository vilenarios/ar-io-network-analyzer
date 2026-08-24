/**
 * Writes the portal snapshot documents. Pure projection plus filesystem —
 * no queries, no network, no analysis, matching the rest of `src/publish/`.
 *
 * Publishing is atomic per document (scratch tree -> fsync -> rename), and the
 * manifest is written last. A consumer that reads the manifest and then a
 * document therefore never sees a manifest describing bytes that are not on
 * disk yet.
 *
 * The ordering is deliberately one-sided, and the exposure is worth naming: a
 * crash between the first document and the manifest leaves documents NEWER
 * than the manifest that describes them. Nothing is torn — every file is a
 * complete document from some cycle — but the manifest's digests no longer
 * match the bytes on disk, and those digests are what the Node server serves
 * as ETags. A consumer can therefore be handed a body under an ETag that does
 * not describe it, and a `If-None-Match` revalidation can return 304 for
 * content that has in fact changed. It self-heals on the next successful
 * cycle (<= one interval), and nginx is unaffected because it stamps its own
 * validator from mtime+size rather than reading the manifest.
 *
 * The alternative — manifest first — is strictly worse: it would advertise
 * digests for bytes that are not on disk at all, turning a stale ETag into a
 * 404.
 *
 * A failed cycle rewrites the manifest and nothing else. The documents stay as
 * they were — they are still the best data available — but the manifest says
 * so, because a publisher that has been failing for six hours would otherwise
 * be indistinguishable from one that just succeeded.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { publicDir, writeDocument } from './publish.js';
import type { DocumentEntry } from './contract.js';
import {
  PORTAL_SCHEMA_VERSION,
  type PortalCollectionDocument,
  type PortalDocumentName,
  type PortalManifest,
  type PortalNetwork,
  type PortalProgramIds,
  type PortalSummaryDocument,
  portalDocumentPath,
} from '../portal/contract.js';
import type { PortalSnapshot } from '../portal/fetch.js';

function collection<T>(
  items: T[],
  generatedAt: string,
  network: PortalNetwork,
  programIds: PortalProgramIds
): PortalCollectionDocument<T> {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    generatedAt,
    network,
    programIds,
    // Always the array length rather than a separately tracked total: a
    // consumer that trusts `count` and iterates `items` cannot disagree.
    count: items.length,
    items,
  };
}

function summary(snapshot: PortalSnapshot, generatedAt: string): PortalSummaryDocument {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    generatedAt,
    network: snapshot.network,
    programIds: snapshot.programIds,
    counts: {
      gateways: snapshot.gateways.length,
      vaults: snapshot.vaults.length,
      balances: snapshot.balances.length,
      delegates: snapshot.delegates.length,
      withdrawals: snapshot.withdrawals.length,
      primaryNames: snapshot.primaryNames.length,
      arnsRecords: snapshot.arnsRecordCount,
    },
    tokenSupply: snapshot.tokenSupply,
    demandFactor: snapshot.demandFactor,
    gatewayRegistrySettings: snapshot.gatewayRegistrySettings,
  };
}

/** The manifest currently on disk, or null when nothing has been published. */
export function readPortalManifest(): PortalManifest | null {
  const path = join(publicDir(), portalDocumentPath('index'));
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PortalManifest;
  } catch {
    // A corrupt manifest is treated as absent: the next successful cycle
    // replaces it, and until then the server falls back to weak ETags.
    return null;
  }
}

/**
 * Write all eight documents plus the manifest.
 *
 * `generatedAt` is taken once and stamped on every document so a consumer can
 * tell the set is internally consistent — documents each carrying their own
 * write time would be indistinguishable from a torn publish.
 */
export function publishPortalDocuments(
  snapshot: PortalSnapshot,
  now: Date = new Date()
): PortalManifest {
  const generatedAt = now.toISOString();

  const documents: Partial<Record<PortalDocumentName, DocumentEntry>> = {
    gateways: writeDocument(
      portalDocumentPath('gateways'),
      collection(snapshot.gateways, generatedAt, snapshot.network, snapshot.programIds),
      generatedAt
    ),
    vaults: writeDocument(
      portalDocumentPath('vaults'),
      collection(snapshot.vaults, generatedAt, snapshot.network, snapshot.programIds),
      generatedAt
    ),
    balances: writeDocument(
      portalDocumentPath('balances'),
      collection(snapshot.balances, generatedAt, snapshot.network, snapshot.programIds),
      generatedAt
    ),
    delegates: writeDocument(
      portalDocumentPath('delegates'),
      collection(snapshot.delegates, generatedAt, snapshot.network, snapshot.programIds),
      generatedAt
    ),
    withdrawals: writeDocument(
      portalDocumentPath('withdrawals'),
      collection(snapshot.withdrawals, generatedAt, snapshot.network, snapshot.programIds),
      generatedAt
    ),
    primaryNames: writeDocument(
      portalDocumentPath('primaryNames'),
      collection(snapshot.primaryNames, generatedAt, snapshot.network, snapshot.programIds),
      generatedAt
    ),
    arnsRecords: writeDocument(
      portalDocumentPath('arnsRecords'),
      collection(snapshot.arnsRecords, generatedAt, snapshot.network, snapshot.programIds),
      generatedAt
    ),
    summary: writeDocument(
      portalDocumentPath('summary'),
      summary(snapshot, generatedAt),
      generatedAt
    ),
  };

  const manifest: PortalManifest = {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    generatedAt,
    network: snapshot.network,
    programIds: snapshot.programIds,
    documents,
    freshness: {
      generatedAt,
      // Zero by construction at publish time. The server recomputes age on
      // read, which is the only place the value is meaningful.
      ageSeconds: 0,
      stale: false,
      lastSuccessAt: generatedAt,
      consecutiveFailures: 0,
    },
  };

  writeDocument(portalDocumentPath('index'), manifest, generatedAt);

  return manifest;
}

/**
 * Record a failed cycle in the manifest without touching the documents.
 *
 * Returns null when nothing has ever been published — there is no manifest to
 * annotate, and inventing one would claim documents that do not exist.
 */
export function markPortalPublishFailure(now: Date = new Date()): PortalManifest | null {
  const previous = readPortalManifest();
  if (!previous) return null;

  const lastSuccessAt = previous.freshness?.lastSuccessAt ?? previous.generatedAt ?? null;
  const manifest: PortalManifest = {
    ...previous,
    freshness: {
      ...previous.freshness,
      generatedAt: previous.generatedAt,
      stale: true,
      lastSuccessAt,
      consecutiveFailures: (previous.freshness?.consecutiveFailures ?? 0) + 1,
    },
  };

  // `generatedAt` at the top level still describes the documents, which have
  // not changed. Only the freshness block moves.
  writeDocument(portalDocumentPath('index'), manifest, previous.generatedAt);

  return manifest;
}
