/**
 * Static-file plumbing: MIME types, path validation, ETag/304 and
 * precompressed siblings. No business logic and no database access.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
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
/** The publisher writes exactly these three files per archived date. */
export const ARCHIVE_FILE_PATTERN = /^(index\.html|gateways\.csv|summary\.json)$/;

/**
 * Resolve a request path inside the public root.
 *
 * Two containment checks, because `resolve()` is purely lexical: it collapses
 * `..` in the string but knows nothing about symlinks, so a link planted
 * anywhere under `public/` would pass the string check and then be followed by
 * `readFileSync`. The realpath check closes that. Nothing but the publisher
 * writes `public/` today, so this is defence in depth — for the operator who
 * symlinks a large artifact into `archive/` and does not think of it as
 * granting read access to its target.
 */
export function resolveWithin(root: string, relativePath: string): string | null {
  const clean = relativePath.replace(/^\/+/, '');
  if (clean.includes('\0')) return null;

  const rootResolved = resolve(root);
  const absolute = resolve(join(rootResolved, clean));
  if (!contains(rootResolved, absolute)) return null;

  try {
    // Only meaningful once the file exists; a 404 is handled downstream.
    if (existsSync(absolute) && !contains(realpathSync(rootResolved), realpathSync(absolute))) {
      return null;
    }
  } catch {
    return null;
  }

  return absolute;
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
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
