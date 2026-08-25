/**
 * Decode the ARIO program's on-chain reward events.
 *
 * WHY THIS EXISTS. Rewards compound into stake, so a position's balance shows
 * what it HOLDS, never what it EARNED. For delegations the program is kinder
 * than that: `CompoundDelegationRewards` emits an Anchor event naming the
 * delegate, the gateway and the exact amount credited. Those events live in
 * transaction logs, which means delegate earnings are attributable exactly AND
 * recoverable from history — unlike the PDA state they update.
 *
 * That is worth stating plainly because the opposite was assumed at first: the
 * credit is PDA state with no transaction history, so earnings looked
 * unrecoverable. The event is the thing that makes them recoverable.
 *
 * OPERATORS ARE NOT COVERED HERE, and it is not an oversight. `DistributeEpoch`
 * emits only an epoch summary — (epochIndex, gatewayCount, totalEligibleRewards,
 * timestamp), no per-operator record — so an operator's earnings can only be
 * derived from stake snapshots taken either side of an epoch. That is what
 * `rewards/sample.ts` retains, and why it had to start before this was written.
 *
 * Layout, verified against 540 live events (539 of which resolve to a known
 * delegation, the odd one out being a delegation since closed):
 *
 *   [0..8)   discriminator 0df91e234997ba42
 *   [8..40)  delegate pubkey
 *   [40..72) gateway pubkey
 *   [72..80) u64 amount, mARIO, little-endian
 *   [80..88) u64 unix seconds, equal to the transaction's blockTime
 */

/** Anchor discriminator for CompoundDelegationRewards. */
export const COMPOUND_DELEGATION_REWARDS = '0df91e234997ba42';

/** Total byte length of that event. Anything else is a different event. */
const EVENT_BYTES = 88;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58-encode a 32-byte public key, leading zero bytes preserved as '1's. */
export function encodeBase58(bytes: Buffer): string {
  let value = BigInt('0x' + (bytes.toString('hex') || '0'));
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  return '1'.repeat(leading) + out;
}

export interface DelegateRewardEvent {
  delegate: string;
  gateway: string;
  /** mARIO credited to the delegation. */
  amount: number;
  /** Unix seconds, as the program recorded it. */
  at: number;
}

/**
 * Extract reward events from a transaction's log messages.
 *
 * Anchor emits events as `Program data: <base64>`. Anything that is not this
 * event — a different discriminator, a different length — is ignored rather
 * than guessed at, so a future program upgrade adding events cannot silently
 * corrupt these figures.
 */
export function decodeRewardEvents(logMessages: readonly string[]): DelegateRewardEvent[] {
  const events: DelegateRewardEvent[] = [];

  for (const line of logMessages) {
    const match = /^Program data: (.+)$/.exec(line);
    if (!match) continue;

    let bytes: Buffer;
    try {
      bytes = Buffer.from(match[1], 'base64');
    } catch {
      continue;
    }
    if (bytes.length !== EVENT_BYTES) continue;
    if (bytes.subarray(0, 8).toString('hex') !== COMPOUND_DELEGATION_REWARDS) continue;

    const amount = bytes.readBigUInt64LE(72);
    // A u64 of mARIO cannot exceed Number.MAX_SAFE_INTEGER at any realistic
    // supply, but assert rather than assume: silently truncating a reward is
    // exactly the kind of error nothing downstream could detect.
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`reward amount ${amount} exceeds safe integer range`);
    }

    events.push({
      delegate: encodeBase58(bytes.subarray(8, 40)),
      gateway: encodeBase58(bytes.subarray(40, 72)),
      amount: Number(amount),
      at: Number(bytes.readBigUInt64LE(80)),
    });
  }

  return events;
}
