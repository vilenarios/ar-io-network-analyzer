/**
 * How complete an epoch's published observation list is.
 *
 * Every epoch document carries an observation array, and until now nothing
 * said whether that array was the whole truth. It frequently is not, in two
 * different ways that used to look identical from outside:
 *
 *   - epoch 554 (2026-09-24): the chain's Epoch account reports
 *     `observations_submitted: 0` with an all-zero `has_observed` bitmap. Nobody
 *     reported. An empty list here is COMPLETE — there was nothing to capture.
 *   - epoch 508: the chain reports 10 submissions and we hold none, because
 *     capture had not started yet. An empty list here is MISSING, and the data
 *     is unrecoverable: `close_epoch` is permissionless and reclaims the Epoch
 *     account, so whatever was on chain at poll time is all there will ever be.
 *
 * Publishing both as a bare empty array would state "nobody observed" for an
 * epoch where ten observers did. That is worse than the 404 it replaces, so the
 * state is computed explicitly and published alongside the counts.
 *
 * It also catches the quieter case: epoch 520 publishes 16 observations while
 * the chain counted 18. Consumers computing participation read 16/50 instead of
 * 18/50 with nothing to warn them.
 */

export type CaptureState =
  /** We hold exactly what the chain says was submitted (including 0 of 0). */
  | 'complete'
  /** We hold some, but fewer than the chain counted. */
  | 'partial'
  /** The chain counted submissions and we hold none of them. */
  | 'missing'
  /** No chain-side count to compare against; completeness is unknowable. */
  | 'unknown';

/**
 * Compare what we captured against the chain's own tally.
 *
 * `chainSubmitted` is `null` when the Epoch account was never captured or the
 * field is absent — that yields `unknown` rather than a guess, because claiming
 * completeness we cannot verify is the failure this whole field exists to stop.
 *
 * A count HIGHER than the chain's is reported as `complete`, not as an error:
 * `observations_submitted` is a running tally on a live epoch, so a capture
 * taken later in the epoch legitimately holds more than an earlier read of the
 * counter. Under-reporting is the direction that loses data.
 */
export function captureState(
  observationCount: number,
  chainSubmitted: number | null,
): CaptureState {
  if (chainSubmitted === null) return 'unknown';
  if (observationCount >= chainSubmitted) return 'complete';
  if (observationCount === 0) return 'missing';
  return 'partial';
}

/**
 * Is an epoch with no observations safe to publish as "nobody reported"?
 *
 * Only when the chain corroborates it. This is the guard that keeps 508/509
 * (10 and 8 submissions we never captured) from being published as quiet
 * epochs.
 */
export function isProvablyUnobserved(chainSubmitted: number | null): boolean {
  return chainSubmitted === 0;
}
