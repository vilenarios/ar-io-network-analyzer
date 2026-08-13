/**
 * Finding construction helpers shared by every detector.
 *
 * The id is deterministic — `kind:epoch|all:sha256(sorted observers)[0..12]` —
 * so recomputing an epoch produces byte-identical ids and the upsert preserves
 * `first_seen_at`. Sorting before hashing is mandatory: unsorted observer
 * arrays make ids churn on every run.
 */

import { createHash } from 'crypto';
import type { Finding, FindingKind, Severity } from './types.js';
import { SEVERITY_ORDER } from './types.js';

/** 12 hex chars of sha256 over the ASCII-sorted observer set. */
export function observerHash(observers: string[]): string {
  const sorted = [...observers].sort();
  return createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 12);
}

export function findingId(
  kind: FindingKind,
  epochIndex: number | null,
  observers: string[]
): string {
  return `${kind}:${epochIndex ?? 'all'}:${observerHash(observers)}`;
}

export interface MakeFindingInput {
  kind: FindingKind;
  epochIndex: number | null;
  observers: string[];
  severity: Severity;
  confidence: number;
  summary: string;
  detail: Record<string, unknown>;
  now: number;
}

export function makeFinding(input: MakeFindingInput): Finding {
  const observers = [...input.observers].sort();
  return {
    id: findingId(input.kind, input.epochIndex, observers),
    kind: input.kind,
    epochIndex: input.epochIndex,
    observers,
    severity: input.severity,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    detectedAt: new Date(input.now).toISOString(),
    summary: input.summary,
    detail: input.detail,
  };
}

/** Never above the cap. Used by the uncalibrated and degraded paths. */
export function capSeverity(severity: Severity, cap: Severity): Severity {
  return SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(cap) ? cap : severity;
}

export function maxSeverity(severities: Severity[]): Severity {
  return severities.reduce<Severity>(
    (worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst),
    'info'
  );
}

/** One step more severe, capped at `high`. */
export function escalate(severity: Severity): Severity {
  const index = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(index + 1, SEVERITY_ORDER.length - 1)];
}

export function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}
