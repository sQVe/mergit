import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GhResponse, GhRun, GitHubEffects, GitHubResult } from './ghApi.ts';
import { createGhRunner, requestGh } from './ghApi.ts';

const exited = (exitCode: number, stdout: string, stderr = ''): GhRun => ({
  kind: 'exited',
  exitCode,
  stdout,
  stderr,
});

const makeEffects = (run: GhRun, now = new Date('2026-01-01T00:00:00Z')) => {
  const calls: (readonly string[])[] = [];

  const effects: GitHubEffects = {
    runGh: async (args) => {
      calls.push(args);

      return run;
    },
    now: () => now,
  };

  return { effects, calls };
};

const signal = new AbortController().signal;

test('requestGh returns the status, lower case headers, and JSON body', async () => {
  const text =
    'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/notifications?page=2>; rel="next"\r\n\r\n[]';

  const { effects, calls } = makeEffects(exited(0, text));

  const result = await requestGh(effects, '/notifications', signal);

  expect(result).toEqual({
    ok: true,
    value: {
      status: 200,
      headers: new Map([['link', '<https://api.github.com/notifications?page=2>; rel="next"']]),
      body: [],
    },
  });

  expect(calls).toEqual([['api', '--include', '/notifications']]);
});

const failureOf = async (run: GhRun, now?: Date) => {
  const { effects } = makeEffects(run, now);

  return requestGh(effects, '/notifications', signal);
};

test('requestGh reports ghMissing when gh cannot start', async () => {
  expect(await failureOf({ kind: 'missing' })).toEqual({
    ok: false,
    failure: { kind: 'ghMissing' },
  });
});

test('requestGh reports notSignedIn for exit 4 with no output', async () => {
  const result = await failureOf(
    exited(4, '', 'To get started with GitHub CLI, run: gh auth login'),
  );

  expect(result).toEqual({ ok: false, failure: { kind: 'notSignedIn' } });
});

test('requestGh reports rateLimited from x-ratelimit-reset', async () => {
  const text =
    'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1767225600\r\n\r\n{"message":"rate limit"}';

  const result = await failureOf(exited(1, text, 'gh: rate limit (HTTP 403)'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date('2026-01-01T00:00:00Z') },
  });
});

const oneMinuteOut: GitHubResult<GhResponse> = {
  ok: false,
  failure: { kind: 'rateLimited', resetAt: new Date('2026-01-01T00:01:00Z') },
};

test('requestGh reports rateLimited one minute out for a 429 without rate limit headers', async () => {
  const text = 'HTTP/2.0 429 Too Many Requests\r\n\r\n{}';

  const result = await failureOf(exited(1, text), new Date('2026-01-01T00:00:00Z'));

  expect(result).toEqual(oneMinuteOut);
});

test('requestGh reports rateLimited one minute out for a 403 secondary rate limit', async () => {
  const text =
    'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 5\r\n\r\n{"message":"You have exceeded a secondary rate limit."}';

  const result = await failureOf(exited(1, text), new Date('2026-01-01T00:00:00Z'));

  expect(result).toEqual(oneMinuteOut);
});

test('requestGh reports requestFailed for a 403 permission error', async () => {
  const text = 'HTTP/2.0 403 Forbidden\r\n\r\n{"message":"Resource not accessible by integration"}';

  const result = await failureOf(exited(1, text));

  expect(result).toEqual({
    ok: false,
    failure: {
      kind: 'requestFailed',
      status: 403,
      message: 'Resource not accessible by integration',
    },
  });
});

test('requestGh reports rateLimited from retry-after relative to now', async () => {
  const text = 'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n{}';

  const result = await failureOf(exited(1, text), new Date('2026-01-01T00:00:00Z'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date('2026-01-01T00:01:00Z') },
  });
});

test('requestGh reports requestFailed with the status for a 404', async () => {
  const text =
    'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}';

  const result = await failureOf(exited(1, text, 'gh: Not Found (HTTP 404)'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 404, message: 'Not Found' },
  });
});

test('requestGh reports requestFailed without a status for a network error', async () => {
  const result = await failureOf(exited(1, '', 'error connecting to api.github.com\n'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: null, message: 'error connecting to api.github.com' },
  });
});

test('requestGh reports invalidResponse for output that is not HTTP', async () => {
  const result = await failureOf(exited(0, 'hello'));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('requestGh reports invalidResponse for a 2xx body that is not JSON', async () => {
  const result = await failureOf(exited(0, 'HTTP/2.0 200 OK\r\n\r\n<html>'));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('requestGh accepts bare newlines', async () => {
  const result = await failureOf(exited(0, 'HTTP/1.1 200 OK\nETag: "abc"\n\n{"a":1}'));

  expect(result).toEqual({
    ok: true,
    value: { status: 200, headers: new Map([['etag', '"abc"']]), body: { a: 1 } },
  });
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const withPath = async <T>(directory: string, action: () => Promise<T>): Promise<T> => {
  const original = process.env.PATH;
  process.env.PATH = directory;

  try {
    return await action();
  } finally {
    process.env.PATH = original;
  }
};

test('createGhRunner returns missing when gh is not on PATH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zeta-gh-'));
  directories.push(directory);

  const run = await withPath(directory, () => createGhRunner()(['api'], signal));

  expect(run).toEqual({ kind: 'missing' });
});

test('createGhRunner returns the exit code and output of gh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zeta-gh-'));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  const script = join(directory, 'gh');
  await writeFile(script, '#!/bin/sh\necho "args: $*"\necho oops >&2\nexit 3\n', { mode: 0o755 });

  const run = await withPath(directory, () => createGhRunner()(['api', '--include', '/x'], signal));

  expect(run).toEqual({
    kind: 'exited',
    exitCode: 3,
    stdout: 'args: api --include /x\n',
    stderr: 'oops\n',
  });
});

test('requestGh sends the ETag as If-None-Match before the endpoint', async () => {
  const { effects, calls } = makeEffects(exited(0, 'HTTP/2.0 200 OK\r\n\r\n[]'));

  await requestGh(effects, '/notifications', signal, '"a"');

  expect(calls).toEqual([['api', '--include', '-H', 'If-None-Match: "a"', '/notifications']]);
});

test('requestGh reports a 304 with an empty body as a success', async () => {
  const text = 'HTTP/2.0 304 Not Modified\r\nETag: "a"\r\n\r\n';

  const { effects } = makeEffects(exited(0, text));

  const result = await requestGh(effects, '/notifications', signal, '"a"');

  expect(result).toEqual({
    ok: true,
    value: { status: 304, headers: new Map([['etag', '"a"']]), body: null },
  });
});

test('requestGh still reports rateLimited for a 403 when it sends an ETag', async () => {
  const text =
    'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1767225600\r\n\r\n{"message":"rate limit"}';

  const { effects } = makeEffects(exited(1, text, 'gh: rate limit (HTTP 403)'));

  const result = await requestGh(effects, '/notifications', signal, '"a"');

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date('2026-01-01T00:00:00Z') },
  });
});
