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
 * A `windowClosed` that is not `true` — false, or null when no end timestamp
 * was captured — yields `unknown` for the same reason, and it is the
 * case that matters most in practice: the CURRENT epoch always starts with zero
 * observations because nobody has reported yet. Judging that `complete` would
 * publish "nobody reported" about an epoch a few minutes old, every day, for
 * the hours before the first report lands. Completeness is simply not knowable
 * until the window shuts.
 *
 * A count HIGHER than the chain's is reported as `complete`, not as an error:
 * `observations_submitted` is a running tally, so a capture taken later than a
 * read of the counter legitimately holds more. Under-reporting is the direction
 * that loses data.
 */
export function captureState(
  observationCount: number,
  chainSubmitted: number | null,
  windowClosed: boolean | null = true,
): CaptureState {
  // `!== true`, not `=== false`: a null (no end timestamp captured) means we do
  // not know whether the window has shut, and "complete" is exactly the claim
  // we must not make without knowing.
  if (windowClosed !== true) return 'unknown';
  if (chainSubmitted === null) return 'unknown';
  if (observationCount >= chainSubmitted) return 'complete';
  if (observationCount === 0) return 'missing';
  return 'partial';
}

/**
 * Has the epoch's observation window shut?
 *
 * Derived from the Epoch account's own `end_timestamp` (unix seconds) rather
 * than from wall-clock guesswork about epoch length. `null` when we have no end
 * timestamp, which propagates to `unknown` instead of an assumption.
 *
 * The protocol also exposes an `observations_closed` flag, which would be the
 * more direct signal; capture does not store it yet, so the timestamp is the
 * honest approximation available today.
 */
export function isWindowClosed(
  endTimestampUnix: number | null,
  nowMs: number = Date.now(),
): boolean | null {
  if (endTimestampUnix === null) return null;
  return nowMs >= endTimestampUnix * 1000;
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
