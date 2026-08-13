/**
 * Process-level guards shared by every entry point.
 *
 * Two concerns live here and nothing else:
 *  - Node version assertion. The nvm default on the target box is v16, and a
 *    bare native-module (better-sqlite3 ABI) failure reads like a code bug.
 *  - Secret scrubbing. `SOLANA_RPC_URL` may carry a provider token; it must
 *    never reach stdout, the database, a published document or /healthz.
 */

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 9;

/**
 * Refuse to run on a Node older than the engines floor.
 * Exits the process rather than throwing: the message must be the last thing
 * an operator sees, not a stack trace buried under a module loader error.
 */
export function assertNodeVersion(): void {
  const match = /^v(\d+)\.(\d+)\./.exec(process.version);
  if (!match) return; // Unknown format — do not block on a parse failure.

  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) {
    return;
  }

  console.error(
    `\n❌ Node ${process.version} is too old. This tool requires Node >= v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} ` +
      `(better-sqlite3 prebuilds are ABI-specific; see .nvmrc).\n` +
      `   Try: nvm use 22\n`
  );
  process.exit(1);
}

/**
 * Strip anything URL-shaped out of a string.
 *
 * Applied to every error message before it is logged or written to
 * `poll_runs.error`. RPC transports habitually echo the endpoint (and
 * therefore the provider token) into their error text.
 */
export function scrubSecrets(input: unknown): string {
  const raw =
    input instanceof Error
      ? `${input.name}: ${input.message}`
      : typeof input === 'string'
        ? input
        : String(input);

  return raw
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]+/g, '<redacted-url>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted-token>')
    .slice(0, 1000);
}

/** Host-only rendering of a URL, safe to log. Never returns path or query. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<redacted>';
  }
}
