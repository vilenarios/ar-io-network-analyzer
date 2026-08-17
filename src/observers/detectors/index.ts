/**
 * The detector registry, in fixed execution order.
 *
 * Order matters: #11 (composite) and #12 (persistent) consume the output of
 * everything before them, so they must run last. Every v1 detector has
 * `requiresDecodedResults: false` — the result bitmap is compared as bytes and
 * never interpreted. #13 (divergent_assessment) is the first exception: it
 * reads bitmap DENSITY, so it declares `requiresDecodedResults: true`.
 */

import type { Detector } from '../types.js';
import { sharedReportTxDetector } from './shared-report-tx.js';
import { identicalResultsDetector } from './identical-results.js';
import { nearIdenticalResultsDetector } from './near-identical-results.js';
import { coSubmissionTimingDetector } from './co-submission-timing.js';
import {
  sharedAsnDetector,
  sharedBaseDomainDetector,
  sharedIpDetector,
  sharedIpRangeDetector,
} from './infra-joins.js';
import { clusterOverlapDetector } from './cluster-overlap.js';
import { unmatchedObserverDetector } from './unmatched-observer.js';
import { compositeDetector } from './composite.js';
import { persistentDetector } from './persistent.js';
import { divergentAssessmentDetector } from './divergent-assessment.js';

/** Bump to force a full recompute of the findings window. */
export const DETECTOR_VERSION = 1;

/** Kinds whose evidence comes from the published gateway roster (degraded mode). */
export const GATEWAY_DEPENDENT_KINDS = new Set([
  'shared_ip',
  'shared_ip_range',
  'shared_base_domain',
  'shared_asn',
  'analyzer_cluster_overlap',
  'unmatched_observer',
]);

export const DETECTORS: Detector[] = [
  sharedReportTxDetector,
  identicalResultsDetector,
  nearIdenticalResultsDetector,
  coSubmissionTimingDetector,
  sharedIpDetector,
  sharedIpRangeDetector,
  sharedBaseDomainDetector,
  sharedAsnDetector,
  clusterOverlapDetector,
  unmatchedObserverDetector,
  divergentAssessmentDetector,
  compositeDetector,
  persistentDetector,
];

export const EPOCH_DETECTORS = DETECTORS.filter((d) => d.scope === 'epoch');
export const WINDOW_DETECTORS = DETECTORS.filter((d) => d.scope === 'window');
