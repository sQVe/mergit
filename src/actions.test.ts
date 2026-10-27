import { expect, test } from 'bun:test';

import type { ActionEffects, GhRun } from './actions.ts';
import { openInBrowser } from './actions.ts';
import type { BrowserPage } from './work/work.ts';

const exitedClean: GhRun = { kind: 'exited', exitCode: 0, stdout: '', stderr: '' };

const makeEffects = (run: GhRun = exitedClean) => {
  const calls: (readonly string[])[] = [];

  const effects: ActionEffects = {
    runGh: (args) => {
      calls.push(args);

      return Promise.resolve(run);
    },
    host: 'ghe.example.com',
  };

  return { effects, calls };
};

const signal = new AbortController().signal;
const repository = 'octo/mergit';
const hostRepository = 'ghe.example.com/octo/mergit';

test('each page kind runs gh browse with its own arguments', async () => {
  const pages: [BrowserPage, string[]][] = [
    [{ kind: 'item', repository, number: 42 }, ['browse', '42', '--repo', hostRepository]],
    [
      { kind: 'commit', repository, sha: '0a1b2c3' },
      ['browse', '0a1b2c3', '--repo', hostRepository],
    ],
    [{ kind: 'releases', repository }, ['browse', '--releases', '--repo', hostRepository]],
    [{ kind: 'actions', repository }, ['browse', '--actions', '--repo', hostRepository]],
    [{ kind: 'repo', repository }, ['browse', '--repo', hostRepository]],
  ];

  for (const [page, expected] of pages) {
    const { effects, calls } = makeEffects();

    const result = await openInBrowser(effects, page, signal);

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([expected]);
  }
});

test('a missing gh returns a failure with a message', async () => {
  const { effects } = makeEffects({ kind: 'missing' });

  const result = await openInBrowser(effects, { kind: 'repo', repository }, signal);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.message !== '').toBe(true);
});

test('a non-zero exit returns the trimmed stderr as the message', async () => {
  const { effects } = makeEffects({
    kind: 'exited',
    exitCode: 1,
    stdout: '',
    stderr: ' no such repository\n',
  });

  const result = await openInBrowser(effects, { kind: 'repo', repository }, signal);

  expect(result).toEqual({ ok: false, message: 'no such repository' });
});

test('a non-zero exit with empty stderr names the exit code', async () => {
  const { effects } = makeEffects({ kind: 'exited', exitCode: 3, stdout: '', stderr: '  ' });

  const result = await openInBrowser(effects, { kind: 'repo', repository }, signal);

  expect(result).toEqual({ ok: false, message: 'gh exited with code 3' });
});

test('a gh run with too much output returns a failure with a message', async () => {
  const { effects } = makeEffects({ kind: 'tooLarge', limitBytes: 1024 });

  const result = await openInBrowser(effects, { kind: 'repo', repository }, signal);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.message !== '').toBe(true);
});
