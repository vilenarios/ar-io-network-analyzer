/**
 * Static-file plumbing: MIME types, path validation, ETag/304 and
 * precompressed siblings. No business logic and no database access.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve, extname } from 'path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

export interface ResolvedFile {
  path: string;
  contentType: string;
  bytes: Buffer;
  etag: string;
  gzipped: boolean;
}

/** `^\d+$` and `^\d{4}-\d{2}-\d{2}$` guards, applied before touching the disk. */
export const EPOCH_PATTERN = /^\d+$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a request path inside the public root.
 *
 * Returns null for anything that escapes the root — the containment check is
 * made on the resolved absolute path, after the pattern guards.
 */
export function resolveWithin(root: string, relativePath: string): string | null {
  const clean = relativePath.replace(/^\/+/, '');
  if (clean.includes('\0')) return null;

  const absolute = resolve(join(root, clean));
  const rootResolved = resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(`${rootResolved}/`)) return null;
  return absolute;
}

/**
 * Read a file, preferring a precompressed `.gz` sibling when the client
 * accepts gzip. Compression happens at publish time, never here.
 */
export function readFile(
  path: string,
  acceptsGzip: boolean,
  etagHint?: string
): ResolvedFile | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;

  const gzPath = `${path}.gz`;
  const useGzip = acceptsGzip && existsSync(gzPath);
  const bytes = readFileSync(useGzip ? gzPath : path);

  // The manifest already carries the sha256 of every document — reuse it as
  // the ETag rather than hashing the body on every request. The compressed
  // representation gets its own tag so a shared cache cannot hand a gzipped
  // body to a client that did not ask for one.
  const stat = statSync(path);
  const base = etagHint ?? `${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}`;
  const weak = etagHint ? '' : 'W/';
  const etag = `${weak}"${base}${useGzip ? '-gzip' : ''}"`;

  return { path, contentType: contentType(path), bytes, etag, gzipped: useGzip };
}

/** Documents change once per cadence; the manifest is the polling target. */
export function cacheControlFor(requestPath: string): string {
  if (requestPath.endsWith('/index.json')) return 'public, max-age=30';
  if (requestPath.startsWith('/api/v1/epochs/')) return 'public, max-age=300';
  if (requestPath.startsWith('/api/v1/')) return 'public, max-age=60';
  if (requestPath.startsWith('/archive/')) return 'public, max-age=86400, immutable';
  return 'public, max-age=60';
}
