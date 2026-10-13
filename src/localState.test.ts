import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { open, rename as renameFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocalSnapshot, StateWriterEffects } from './localState.ts';
import {
  cacheDirectory,
  createStateWriter,
  loadSnapshot,
  loadState,
  stateDirectory,
  saveSnapshot,
} from './localState.ts';
import { toThreadId, toViewerLogin } from './work/work.ts';

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

test('a saved grouping loads back after flush', async () => {
  const writer = createStateWriter(directory, {
    onFailure: () => undefined,
    onSaved: () => undefined,
  });

  writer.save({ grouping: 'type', done: new Map(), seen: new Map() });
  await writer.flush();

  expect(loadState(directory)).toEqual({
    kind: 'loaded',
    state: { grouping: 'type', done: new Map(), seen: new Map() },
  });
});

test('done records of two accounts load back and are written in the version 3 shape keyed by host and login', async () => {
  const writer = createStateWriter(directory, {
    onFailure: () => undefined,
    onSaved: () => undefined,
  });

  const done = new Map([
    [
      'github.com/octocat',
      new Map([
        [toThreadId('11'), '2026-01-02T10:00:00Z'],
        [toThreadId('12'), '2026-01-03T11:30:00Z'],
      ]),
    ],
    ['github.com/hubot', new Map([[toThreadId('11'), '2026-01-04T09:00:00Z']])],
  ]);

  writer.save({ grouping: 'none', done, seen: new Map() });
  await writer.flush();

  expect(loadState(directory)).toEqual({
    kind: 'loaded',
    state: { grouping: 'none', done, seen: new Map() },
  });

  expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))).toEqual({
    version: 3,
    grouping: 'none',
    done: {
      'github.com/octocat': { '11': '2026-01-02T10:00:00Z', '12': '2026-01-03T11:30:00Z' },
      'github.com/hubot': { '11': '2026-01-04T09:00:00Z' },
    },
    seen: {},
  });
});

const writeStateText = (text: string): string => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'state.json');
  writeFileSync(path, text);

  return path;
};

test('a version 1 file loads with its grouping and no done records, then is written as version 3', async () => {
  const path = writeStateText('{"version":1,"grouping":"reason"}');
  const loaded = loadState(directory);

  expect(loaded).toEqual({
    kind: 'loaded',
    state: { grouping: 'reason', done: new Map(), seen: new Map() },
  });

  expect(readFileSync(path, 'utf8')).toBe('{"version":1,"grouping":"reason"}');

  const writer = createStateWriter(directory, {
    onFailure: () => undefined,
    onSaved: () => undefined,
  });

  writer.save(
    loaded.kind === 'loaded'
      ? loaded.state
      : { grouping: 'none', done: new Map(), seen: new Map() },
  );

  await writer.flush();

  const body: unknown = JSON.parse(readFileSync(path, 'utf8'));

  expect(body).toEqual({ version: 3, grouping: 'reason', done: {}, seen: {} });
});

const realEffects = (): StateWriterEffects => ({
  makeDirectory: async (target, mode) => {
    mkdirSync(target, { recursive: true, mode });
  },
  openFile: (path, mode) => open(path, 'wx', mode),
  rename: (from, to) => renameFile(from, to),
  remove: (path) => rm(path, { force: true }),
});

test('the state file on disk has version 3', async () => {
  const writer = createStateWriter(directory, {
    onFailure: () => undefined,
    onSaved: () => undefined,
  });

  writer.save({ grouping: 'none', done: new Map(), seen: new Map() });
  await writer.flush();

  const body: unknown = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));

  expect(body).toEqual({ version: 3, grouping: 'none', done: {}, seen: {} });
});

test('a missing state file loads as missing', () => {
  expect(loadState(directory)).toEqual({ kind: 'missing' });
});

test.each([
  ['bad JSON', '{nope'],
  ['an unknown grouping', '{"version":3,"grouping":"owner","done":{},"seen":{}}'],
  ['a version 1 file with an unknown grouping', '{"version":1,"grouping":"owner"}'],
  ['a version 2 file without done records', '{"version":2,"grouping":"type"}'],
  ['a version 3 file without seen records', '{"version":3,"grouping":"type","done":{}}'],
  ['a missing version', '{"grouping":"type"}'],
])('%s loads as invalid and leaves the file unchanged', (_name, text) => {
  const path = writeStateText(text);

  const result = loadState(directory);

  expect(result.kind).toBe('invalid');
  expect(result.kind === 'invalid' ? result.path : null).toBe(path);
  expect(readFileSync(path, 'utf8')).toBe(text);
});

test('a version 4 file loads as newer with the path and version and stays unchanged', () => {
  const text = '{"version":4,"grouping":"type","done":{},"seen":{}}';
  const path = writeStateText(text);

  expect(loadState(directory)).toEqual({ kind: 'newer', path, version: 4 });
  expect(readFileSync(path, 'utf8')).toBe(text);
});

const failRename = async (error: Error) => {
  const failures: { reason: string; path: string }[] = [];

  const writer = createStateWriter(
    directory,
    { onFailure: (failure) => failures.push(failure), onSaved: () => undefined },
    { ...realEffects(), rename: () => Promise.reject(error) },
  );

  writer.save({ grouping: 'type', done: new Map(), seen: new Map() });
  await writer.flush();

  return failures;
};

test('a failed write with EACCES reports Permission denied and the state file, not the temporary file', async () => {
  const error = Object.assign(new Error("EACCES: permission denied, rename 'a.tmp'"), {
    code: 'EACCES',
  });

  expect(await failRename(error)).toEqual([
    { reason: 'Permission denied', path: join(directory, 'state.json') },
  ]);
});

test('a failed write with an unmapped error keeps its raw message', async () => {
  const error = Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });

  expect(await failRename(error)).toEqual([
    { reason: 'EIO: i/o error, write', path: join(directory, 'state.json') },
  ]);
});

test('a failed rename keeps the last valid file, leaves no temporary file, and reports', async () => {
  const failures: string[] = [];

  const writer = createStateWriter(
    directory,
    { onFailure: (failure) => failures.push(failure.reason), onSaved: () => undefined },
    { ...realEffects(), rename: () => Promise.reject(new Error('rename refused')) },
  );

  const first = createStateWriter(directory, {
    onFailure: () => undefined,
    onSaved: () => undefined,
  });

  first.save({ grouping: 'reason', done: new Map(), seen: new Map() });
  await first.flush();

  writer.save({ grouping: 'type', done: new Map(), seen: new Map() });
  await writer.flush();

  expect(failures).toEqual(['rename refused']);

  expect(loadState(directory)).toEqual({
    kind: 'loaded',
    state: { grouping: 'reason', done: new Map(), seen: new Map() },
  });

  expect(readdirSync(directory)).toEqual(['state.json']);
});

test('saves during a write collapse to the last one', async () => {
  const renamed: string[] = [];
  const gate = Promise.withResolvers<null>();
  const firstRenameStarted = Promise.withResolvers<null>();
  const effects = realEffects();

  const writer = createStateWriter(
    directory,
    { onFailure: () => undefined, onSaved: () => undefined },
    {
      ...effects,
      rename: async (from, to) => {
        if (renamed.length === 0) {
          renamed.push(readFileSync(from, 'utf8'));
          firstRenameStarted.resolve(null);
          await gate.promise;
        } else {
          renamed.push(readFileSync(from, 'utf8'));
        }

        await effects.rename(from, to);
      },
    },
  );

  writer.save({ grouping: 'reason', done: new Map(), seen: new Map() });
  await firstRenameStarted.promise;
  writer.save({ grouping: 'type', done: new Map(), seen: new Map() });
  writer.save({ grouping: 'none', done: new Map(), seen: new Map() });
  writer.save({ grouping: 'type', done: new Map(), seen: new Map() });
  gate.resolve(null);
  await writer.flush();

  expect(renamed.map((text): unknown => JSON.parse(text))).toEqual([
    { version: 3, grouping: 'reason', done: {}, seen: {} },
    { version: 3, grouping: 'type', done: {}, seen: {} },
  ]);

  expect(loadState(directory)).toEqual({
    kind: 'loaded',
    state: { grouping: 'type', done: new Map(), seen: new Map() },
  });
});

test('stateDirectory uses XDG_STATE_HOME, then HOME, then nothing', () => {
  expect(stateDirectory({ XDG_STATE_HOME: '/xdg', HOME: '/home/a' })).toBe('/xdg/zeta');
  expect(stateDirectory({ HOME: '/home/a' })).toBe('/home/a/.local/state/zeta');
  expect(stateDirectory({ XDG_STATE_HOME: '', HOME: '/home/a' })).toBe('/home/a/.local/state/zeta');
  expect(stateDirectory({})).toBeNull();
});

test('onSaved runs after a successful write, and not while a newer state is pending', async () => {
  let saved = 0;
  const gate = Promise.withResolvers<null>();
  const renameStarted = Promise.withResolvers<null>();
  const effects = realEffects();
  let renames = 0;

  const writer = createStateWriter(
    directory,
    { onFailure: () => undefined, onSaved: () => (saved += 1) },
    {
      ...effects,
      rename: async (from, to) => {
        renames += 1;

        if (renames === 1) {
          renameStarted.resolve(null);
          await gate.promise;
        }

        await effects.rename(from, to);
      },
    },
  );

  writer.save({ grouping: 'reason', done: new Map(), seen: new Map() });
  await renameStarted.promise;
  writer.save({ grouping: 'type', done: new Map(), seen: new Map() });
  gate.resolve(null);
  await writer.flush();

  expect(saved).toBe(1);
  expect(renames).toBe(2);

  writer.save({ grouping: 'none', done: new Map(), seen: new Map() });
  await writer.flush();

  expect(saved).toBe(2);
});

test('a version 2 file loads with its grouping and done records and no seen records, then is written as version 3', async () => {
  const text =
    '{"version":2,"grouping":"type","done":{"github.com/octocat":{"T1":"2026-10-01T10:00:00Z"}}}';

  const path = writeStateText(text);
  const loaded = loadState(directory);

  const done = new Map([
    ['github.com/octocat', new Map([[toThreadId('T1'), '2026-10-01T10:00:00Z']])],
  ]);

  expect(loaded).toEqual({ kind: 'loaded', state: { grouping: 'type', done, seen: new Map() } });
  expect(readFileSync(path, 'utf8')).toBe(text);

  const writer = createStateWriter(directory, {
    onFailure: () => undefined,
    onSaved: () => undefined,
  });

  writer.save(
    loaded.kind === 'loaded'
      ? loaded.state
      : { grouping: 'none', done: new Map(), seen: new Map() },
  );

  await writer.flush();

  const body: unknown = JSON.parse(readFileSync(path, 'utf8'));

  expect(body).toEqual({
    version: 3,
    grouping: 'type',
    done: { 'github.com/octocat': { T1: '2026-10-01T10:00:00Z' } },
    seen: {},
  });
});

test('seen records of two accounts, one empty, load back unchanged', async () => {
  const writer = createStateWriter(directory, {
    onFailure: () => undefined,
    onSaved: () => undefined,
  });

  const seen = new Map([
    ['github.com/octocat', new Map([[toThreadId('11'), '2026-01-02T10:00:00Z']])],
    ['github.com/hubot', new Map<ReturnType<typeof toThreadId>, string>()],
  ]);

  writer.save({ grouping: 'none', done: new Map(), seen });
  await writer.flush();

  expect(loadState(directory)).toEqual({
    kind: 'loaded',
    state: { grouping: 'none', done: new Map(), seen },
  });

  expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))).toEqual({
    version: 3,
    grouping: 'none',
    done: {},
    seen: { 'github.com/octocat': { '11': '2026-01-02T10:00:00Z' }, 'github.com/hubot': {} },
  });
});
