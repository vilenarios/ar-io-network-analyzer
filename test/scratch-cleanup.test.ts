/**
 * Scratch trees are named per-pid, which fixed two publishers deleting each
 * other's work but introduced a quieter bug: nothing reclaimed a tree once its
 * process was gone. Every crash, failed publish and daemon restart stranded one
 * permanently, and cleanup on the happy path cannot help — by definition these
 * are the runs that never reached it.
 *
 * The sweep is the fix, so its safety property is what these tests pin down: it
 * must reclaim the dead and never touch the living.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupScratchTree, sweepScratchTrees } from '../src/publish/publish.js';

/** Run `fn` with PUBLIC_DIR pointed at a throwaway tree. */
function withPublicDir<T>(fn: (publicDir: string, parent: string) => T): T {
  const parent = mkdtempSync(join(tmpdir(), 'scratch-sweep-'));
  const publicDir = join(parent, 'public');
  mkdirSync(publicDir, { recursive: true });

  const previous = process.env.PUBLIC_DIR;
  process.env.PUBLIC_DIR = publicDir;
  try {
    return fn(publicDir, parent);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = previous;
  }
}

function makeTree(publicDir: string, pid: number, ageMs = 0): string {
  const path = `${publicDir}.tmp.${pid}`;
  mkdirSync(join(path, 'api', 'v1'), { recursive: true });
  writeFileSync(join(path, 'api', 'v1', 'partial.json'), '{}');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }
  return path;
}

/** A pid that cannot be running: beyond any pid_max, and never allocated. */
const DEAD_PID = 4_194_305;

test('a tree left by a dead process is reclaimed', () => {
  withPublicDir((publicDir) => {
    const abandoned = makeTree(publicDir, DEAD_PID);
    assert.equal(sweepScratchTrees(), 1);
    assert.equal(existsSync(abandoned), false);
  });
});

test('a live publisher\'s tree is never touched', () => {
  withPublicDir((publicDir) => {
    // Another publisher, mid-write. Deleting this is the original bug that
    // per-pid naming was introduced to fix; the sweep must not reintroduce it.
    const live = makeTree(publicDir, process.ppid);
    const own = makeTree(publicDir, process.pid);

    assert.equal(sweepScratchTrees(), 0);
    assert.equal(existsSync(live), true, 'a running process is still writing here');
    assert.equal(existsSync(own), true, 'never sweep our own tree');
  });
});

test('a live pid with an ancient tree is treated as pid reuse', () => {
  withPublicDir((publicDir) => {
    // The OS recycles pids. A tree whose pid is alive but which has not been
    // touched in hours belongs to a process that died long ago, not to the
    // unrelated one now holding that number — a real publish writes in seconds.
    const stale = makeTree(publicDir, process.ppid, 7 * 60 * 60 * 1000);
    assert.equal(sweepScratchTrees(), 1);
    assert.equal(existsSync(stale), false);
  });
});

test('unrelated siblings of the public directory are left alone', () => {
  withPublicDir((publicDir, parent) => {
    const decoys = ['public.backup', 'public.tmp.notapid', 'public.tmp.-1', 'unrelated'];
    for (const name of decoys) mkdirSync(join(parent, name), { recursive: true });
    makeTree(publicDir, DEAD_PID);

    assert.equal(sweepScratchTrees(), 1, 'only the dead scratch tree');
    for (const name of decoys) {
      assert.equal(existsSync(join(parent, name)), true, `${name} must survive`);
    }
    assert.equal(existsSync(publicDir), true, 'the published tree itself must survive');
  });
});

test('cleanup is idempotent and safe when nothing was written', () => {
  withPublicDir(() => {
    assert.doesNotThrow(() => cleanupScratchTree());
    assert.doesNotThrow(() => cleanupScratchTree());
  });
});

test('sweeping a missing parent directory is not an error', () => {
  const previous = process.env.PUBLIC_DIR;
  process.env.PUBLIC_DIR = join(tmpdir(), 'definitely-does-not-exist-xyz', 'public');
  try {
    assert.equal(sweepScratchTrees(), 0);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = previous;
  }
});
