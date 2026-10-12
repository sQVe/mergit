import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocalSnapshot } from './localState.ts';
import { cacheDirectory, loadSnapshot, saveSnapshot } from './localState.ts';
import { toViewerLogin } from './work/work.ts';

let root = '';
let directory = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zeta-local-state-'));
  directory = join(root, 'zeta');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const makeSnapshot = (login: string, bodies: string[]): LocalSnapshot => ({
  host: 'github.com',
  login: toViewerLogin(login),
  savedAt: new Date('2026-10-12T06:00:00.000Z'),
  pages: bodies.map((body, index) => ({
    path: `/notifications?page=${index + 1}`,
    etag: index === 0 ? '"etag-1"' : null,
    next: index === 0 ? '/notifications?page=2' : null,
    body,
  })),
});

const loadValue = (): LocalSnapshot | null => {
  const result = loadSnapshot(directory);
  expect(result.ok).toBe(true);

  return result.ok ? result.value : null;
};

test('loads the saved snapshot from a fresh open', () => {
  const snapshot = makeSnapshot('octocat', ['[{"id":"1"}]', '[{"id":"2"}]']);

  expect(saveSnapshot(directory, snapshot).ok).toBe(true);

  expect(loadValue()).toEqual(snapshot);
});

test('loads no snapshot when nothing was saved', () => {
  expect(loadValue()).toBeNull();
});

test('a save for another login makes it the last one', () => {
  saveSnapshot(directory, makeSnapshot('octocat', ['first']));
  const other = makeSnapshot('hubot', ['other']);
  saveSnapshot(directory, other);

  expect(loadValue()).toEqual(other);
});

test('a second save for the same login replaces its pages', () => {
  saveSnapshot(directory, makeSnapshot('octocat', ['a', 'b', 'c']));
  const second = makeSnapshot('octocat', ['d']);
  saveSnapshot(directory, second);

  expect(loadValue()).toEqual(second);
});

test('recreates a cache file that is not SQLite', () => {
  const snapshot = makeSnapshot('octocat', ['a']);
  saveSnapshot(directory, snapshot);
  writeFileSync(join(directory, 'cache.db'), 'not a database, just garbage bytes'.repeat(200));

  expect(loadValue()).toBeNull();
  expect(saveSnapshot(directory, snapshot).ok).toBe(true);
  expect(loadValue()).toEqual(snapshot);
});

test('recreates a cache with an unknown schema version', () => {
  const snapshot = makeSnapshot('octocat', ['a']);
  saveSnapshot(directory, snapshot);
  const database = new Database(join(directory, 'cache.db'));
  database.run('PRAGMA user_version = 999');
  database.close();

  expect(loadValue()).toBeNull();
  expect(saveSnapshot(directory, snapshot).ok).toBe(true);
  expect(loadValue()).toEqual(snapshot);
});

test('returns a failure when the directory cannot be created', () => {
  writeFileSync(join(root, 'blocker'), 'file');
  const blocked = join(root, 'blocker', 'zeta');

  expect(loadSnapshot(blocked).ok).toBe(false);
  expect(saveSnapshot(blocked, makeSnapshot('octocat', ['a'])).ok).toBe(false);
});

test('resolves the cache directory from the environment', () => {
  expect(cacheDirectory({ XDG_CACHE_HOME: '/xdg', HOME: '/home/a' })).toBe('/xdg/zeta');
  expect(cacheDirectory({ HOME: '/home/a' })).toBe('/home/a/.cache/zeta');
  expect(cacheDirectory({ XDG_CACHE_HOME: '', HOME: '/home/a' })).toBe('/home/a/.cache/zeta');
  expect(cacheDirectory({})).toBeNull();
});
