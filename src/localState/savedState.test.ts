import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename as renameFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toThreadId } from '../work/work.ts';
import type { StateWriterEffects } from './savedState.ts';
import { createStateWriter, loadState, stateDirectory } from './savedState.ts';

let root = '';
let directory = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mergit-local-state-'));
  directory = join(root, 'mergit');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
  [
    'a version 3 file with a seen value that is not a time',
    '{"version":3,"grouping":"type","done":{},"seen":{"github.com/octocat":{"1":"yesterday"}}}',
  ],
  ['a missing version', '{"grouping":"type"}'],
  ['an array', '[]'],
  ['unquoted JSON', '{not json'],
])('%s loads as invalid and leaves the file unchanged', (_name, text) => {
  const path = writeStateText(text);

  const result = loadState(directory);

  expect(result.kind).toBe('invalid');
  expect(result.kind === 'invalid' ? result.path : null).toBe(path);
  expect(readFileSync(path, 'utf8')).toBe(text);
});

test.each([['[]'], ['{"version":3,"grouping":"owner","done":{},"seen":{}}'], ['{not json']])(
  'the reason for invalid state %s is one short line',
  (text) => {
    writeStateText(text);

    const result = loadState(directory);
    const reason = result.kind === 'invalid' ? result.reason : '';

    expect(reason).not.toBe('');
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThan(80);
  },
);

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
  expect(stateDirectory({ XDG_STATE_HOME: '/xdg', HOME: '/home/a' })).toBe('/xdg/mergit');
  expect(stateDirectory({ HOME: '/home/a' })).toBe('/home/a/.local/state/mergit');

  expect(stateDirectory({ XDG_STATE_HOME: '', HOME: '/home/a' })).toBe(
    '/home/a/.local/state/mergit',
  );

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

test('a state file that cannot be read loads as invalid, not missing', () => {
  const path = join(directory, 'state.json');
  mkdirSync(path, { recursive: true });

  const result = loadState(directory);

  expect(result.kind).toBe('invalid');
  expect(result.kind === 'invalid' ? result.path : null).toBe(path);
  expect(result.kind === 'invalid' ? result.reason : '').not.toBe('');
});

test('an empty HOME gives no state directory', () => {
  expect(stateDirectory({ HOME: '' })).toBeNull();
});

test('a version 3 file written as text loads with its grouping, done, and seen records', () => {
  writeStateText(
    '{"version":3,"grouping":"type","done":{"github.com/octocat":{"1":"2026-10-12T06:00:00Z"}},"seen":{"github.com/octocat":{"2":"2026-10-12T07:00:00Z"}}}',
  );

  expect(loadState(directory)).toEqual({
    kind: 'loaded',
    state: {
      grouping: 'type',
      done: new Map([['github.com/octocat', new Map([[toThreadId('1'), '2026-10-12T06:00:00Z']])]]),
      seen: new Map([['github.com/octocat', new Map([[toThreadId('2'), '2026-10-12T07:00:00Z']])]]),
    },
  });
});
