import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
  viewerEtag: '"viewer-1"',
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

test('keeps the cache when another connection holds a write lock during a load', () => {
  const snapshot = makeSnapshot('octocat', ['a']);
  saveSnapshot(directory, snapshot);

  const other = new Database(join(directory, 'cache.db'));
  other.run('BEGIN IMMEDIATE');

  try {
    loadSnapshot(directory);
    saveSnapshot(directory, makeSnapshot('hubot', ['b']));
  } finally {
    other.run('ROLLBACK');
    other.close();
  }

  expect(loadValue()).toEqual(snapshot);
});

test('recreates a cache whose pages table is damaged', () => {
  const snapshot = makeSnapshot('octocat', ['a']);
  saveSnapshot(directory, snapshot);

  const file = join(directory, 'cache.db');
  const database = new Database(file);

  const pagesTable = database
    .query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name = 'pages'")
    .get();

  const pageSize = database.query<{ page_size: number }, []>('PRAGMA page_size').get();

  database.close();

  const handle = openSync(file, 'r+');
  const size = pageSize?.page_size ?? 4096;

  writeSync(handle, new Uint8Array(size), 0, size, ((pagesTable?.rootpage ?? 1) - 1) * size);

  closeSync(handle);

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

test('the viewer ETag round-trips, including a missing one', () => {
  const withEtag = makeSnapshot('octocat', ['a']);
  saveSnapshot(directory, withEtag);

  expect(loadValue()?.viewerEtag).toBe('"viewer-1"');

  saveSnapshot(directory, { ...withEtag, viewerEtag: null });

  expect(loadValue()?.viewerEtag).toBeNull();
});

test('recreates a version 1 cache file', () => {
  const file = join(directory, 'cache.db');
  mkdirSync(directory);
  const database = new Database(file);

  database.run(
    'CREATE TABLE last (id INTEGER PRIMARY KEY, host TEXT, login TEXT, savedAt INTEGER)',
  );

  database.run("INSERT INTO last VALUES (1, 'github.com', 'octocat', 0)");
  database.run('PRAGMA user_version = 1');
  database.close();

  const snapshot = makeSnapshot('octocat', ['a']);

  expect(loadValue()).toBeNull();
  expect(saveSnapshot(directory, snapshot).ok).toBe(true);
  expect(loadValue()).toEqual(snapshot);
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

test('a save under a permissive umask leaves the directory and file owner-only', () => {
  const previousUmask = process.umask(0);

  try {
    saveSnapshot(directory, makeSnapshot('octocat', ['a']));
  } finally {
    process.umask(previousUmask);
  }

  expect(modeOf(directory)).toBe(0o700);
  expect(modeOf(join(directory, 'cache.db'))).toBe(0o600);
});

test('a save tightens an existing wide directory and file without touching the parent', () => {
  const file = join(directory, 'cache.db');
  mkdirSync(directory);
  writeFileSync(file, '');
  chmodSync(root, 0o755);
  chmodSync(directory, 0o755);
  chmodSync(file, 0o644);

  saveSnapshot(directory, makeSnapshot('octocat', ['a']));
  loadSnapshot(directory);

  expect(modeOf(directory)).toBe(0o700);
  expect(modeOf(file)).toBe(0o600);
  expect(modeOf(root)).toBe(0o755);
});

test('a recreated cache file is owner-only', () => {
  const file = join(directory, 'cache.db');
  saveSnapshot(directory, makeSnapshot('octocat', ['a']));
  writeFileSync(file, 'garbage'.repeat(500));
  chmodSync(file, 0o644);

  saveSnapshot(directory, makeSnapshot('octocat', ['a']));

  expect(modeOf(file)).toBe(0o600);
});

const writeVersionTwoCache = (statements: string[]): void => {
  mkdirSync(directory);
  const database = new Database(join(directory, 'cache.db'));

  for (const statement of statements) {
    database.run(statement);
  }

  database.run('PRAGMA user_version = 2');
  database.close();
};

const expectRecreated = (): void => {
  const snapshot = makeSnapshot('octocat', ['a']);

  expect(loadValue()).toBeNull();
  expect(saveSnapshot(directory, snapshot).ok).toBe(true);
  expect(loadValue()).toEqual(snapshot);
};

const createLast =
  'CREATE TABLE last (id INTEGER PRIMARY KEY CHECK (id = 1), host TEXT NOT NULL, login TEXT NOT NULL, viewerEtag TEXT, savedAt INTEGER NOT NULL)';

const createPages =
  'CREATE TABLE pages (host TEXT NOT NULL, login TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, etag TEXT, next TEXT, body TEXT NOT NULL, PRIMARY KEY (host, login, position))';

test('recreates a cache whose savedAt is not a valid date', () => {
  writeVersionTwoCache([
    createLast,
    createPages,
    "INSERT INTO last VALUES (1, 'github.com', 'octocat', NULL, 9000000000000000000)",
  ]);

  expectRecreated();
});

test('recreates a cache at the current version with a missing table or column', () => {
  writeVersionTwoCache([createLast]);

  expectRecreated();

  rmSync(directory, { recursive: true, force: true });

  writeVersionTwoCache([
    createLast,
    'CREATE TABLE pages (host TEXT NOT NULL, login TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, etag TEXT, body TEXT NOT NULL)',
  ]);

  expectRecreated();
});

test('recreates a cache with an empty login', () => {
  writeVersionTwoCache([
    createLast,
    createPages,
    "INSERT INTO last VALUES (1, 'github.com', '', NULL, 0)",
  ]);

  expectRecreated();
});
