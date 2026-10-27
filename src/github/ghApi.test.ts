import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GhResponse, GhRun, GitHubEffects, GitHubResult } from './ghApi.ts';
import { createGhRunner, requestGh, requestGhDelete, requestGraphql } from './ghApi.ts';

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
    host: 'ghe.example.com',
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
      bodyText: '[]',
    },
  });

  expect(calls).toEqual([['api', '--hostname', 'ghe.example.com', '--include', '/notifications']]);
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
    value: {
      status: 200,
      headers: new Map([['etag', '"abc"']]),
      body: { a: 1 },
      bodyText: '{"a":1}',
    },
  });
});

const directories: string[] = [];

// A runner that fails to end a fake gh would leave it running after the test times out.
const killFakeGh = async (directory: string): Promise<void> => {
  const pidFile = Bun.file(join(directory, 'pid'));

  if (!(await pidFile.exists())) {
    return;
  }

  try {
    process.kill(Number((await pidFile.text()).trim()), 'SIGKILL');
  } catch {
    // The fake gh has already exited.
  }
};

afterEach(async () => {
  const finished = directories.splice(0);

  await Promise.all(finished.map(killFakeGh));
  await Promise.all(finished.map((directory) => rm(directory, { recursive: true })));
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
  const directory = await mkdtemp(join(tmpdir(), 'mergit-gh-'));
  directories.push(directory);

  const run = await withPath(directory, () => createGhRunner()(['api'], signal));

  expect(run).toEqual({ kind: 'missing' });
});

test('createGhRunner returns the exit code and output of gh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergit-gh-'));
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

  expect(calls).toEqual([
    [
      'api',
      '--hostname',
      'ghe.example.com',
      '--include',
      '-H',
      'If-None-Match: "a"',
      '/notifications',
    ],
  ]);
});

test('requestGh reports a 304 with an empty body as a success', async () => {
  const text = 'HTTP/2.0 304 Not Modified\r\nETag: "a"\r\n\r\n';

  const { effects } = makeEffects(exited(0, text));

  const result = await requestGh(effects, '/notifications', signal, '"a"');

  expect(result).toEqual({
    ok: true,
    value: { status: 304, headers: new Map([['etag', '"a"']]), body: null, bodyText: '' },
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

test('createGhRunner returns missing when gh on PATH cannot be executed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergit-gh-'));
  directories.push(directory);
  await writeFile(join(directory, 'gh'), 'not an executable format\n', { mode: 0o755 });

  const run = await withPath(directory, () => createGhRunner()(['api'], signal));

  expect(run).toEqual({ kind: 'missing' });
});

test('requestGh reports invalidResponse for a header line without a colon', async () => {
  const result = await failureOf(exited(0, 'HTTP/2.0 200 OK\r\nnot a header\r\n\r\n{}'));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('requestGh reports the status as the message when the error body has no message', async () => {
  const result = await failureOf(exited(1, 'HTTP/2.0 404 Not Found\r\n\r\n{}'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 404, message: 'HTTP 404' },
  });
});

test('requestGh reports requestFailed for a 503 that carries retry-after', async () => {
  const text = 'HTTP/2.0 503 Service Unavailable\r\nRetry-After: 30\r\n\r\n{}';

  const result = await failureOf(exited(1, text));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 503, message: 'HTTP 503' },
  });
});

test('requestGh reports requestFailed for a 403 with remaining quota and a reset header', async () => {
  const text =
    'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 5\r\nX-RateLimit-Reset: 1767225600\r\n\r\n{"message":"Resource not accessible by integration"}';

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

test('requestGh reports rateLimited two minutes out for retry-after 120', async () => {
  const text = 'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{}';

  const result = await failureOf(exited(1, text), new Date('2026-01-01T00:00:00Z'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date('2026-01-01T00:02:00Z') },
  });
});

test('requestGh reports a success with a null body for a whitespace-only body', async () => {
  const result = await failureOf(exited(0, 'HTTP/2.0 204 No Content\r\n\r\n\n'));

  expect(result).toEqual({
    ok: true,
    value: { status: 204, headers: new Map(), body: null, bodyText: '\n' },
  });
});

test('requestGh reports notSignedIn for exit 4 with only a newline as output', async () => {
  const result = await failureOf(exited(4, '\n'));

  expect(result).toEqual({ ok: false, failure: { kind: 'notSignedIn' } });
});

test('requestGh reports requestFailed without a status for exit 4 with other output', async () => {
  const result = await failureOf(exited(4, 'oops', 'broken\n'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: null, message: 'broken' },
  });
});

test('requestGh reports requestFailed for a 300 response with a JSON body', async () => {
  const result = await failureOf(exited(0, 'HTTP/2.0 300 Multiple Choices\r\n\r\n{"a":1}'));

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 300, message: 'HTTP 300' },
  });
});

test('requestGhDelete names the host of the effects', async () => {
  const { effects, calls } = makeEffects(exited(0, 'HTTP/2.0 205 Reset Content\r\n\r\n'));

  await requestGhDelete(effects, '/notifications/threads/42', signal);

  expect(calls).toEqual([
    [
      'api',
      '--hostname',
      'ghe.example.com',
      '--include',
      '--method',
      'DELETE',
      '/notifications/threads/42',
    ],
  ]);
});

test('requestGraphql names the host of the effects', async () => {
  const { effects, calls } = makeEffects(exited(0, 'HTTP/2.0 200 OK\r\n\r\n{}'));

  await requestGraphql(effects, '{ viewer { login } }', { strings: {}, integers: {} }, signal);

  expect(calls).toEqual([
    [
      'api',
      'graphql',
      '--hostname',
      'ghe.example.com',
      '--include',
      '-f',
      'query={ viewer { login } }',
    ],
  ]);
});

test('requestGh reports responseTooLarge when gh output passes the limit', async () => {
  const result = await failureOf({ kind: 'tooLarge', limitBytes: 1024 });

  expect(result).toEqual({ ok: false, failure: { kind: 'responseTooLarge', limitBytes: 1024 } });
});

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const runOverLimitGh = async (body: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'mergit-gh-'));
  directories.push(directory);
  const pidFile = join(directory, 'pid');

  await writeFile(join(directory, 'gh'), `#!/bin/sh\necho $$ > '${pidFile}'\n${body}\n`, {
    mode: 0o755,
  });

  const run = await withPath(directory, () => createGhRunner(4096)(['api'], signal));
  const pid = Number((await Bun.file(pidFile).text()).trim());

  return { run, pid, directory };
};

test('createGhRunner returns tooLarge and ends gh when stdout passes the limit', async () => {
  const { run, pid } = await runOverLimitGh('while :; do echo 0123456789abcdef; done');

  expect(run).toEqual({ kind: 'tooLarge', limitBytes: 4096 });
  expect(isRunning(pid)).toBe(false);
});

test('createGhRunner returns tooLarge and ends gh when stderr passes the limit', async () => {
  const { run, pid } = await runOverLimitGh('while :; do echo 0123456789abcdef >&2; done');

  expect(run).toEqual({ kind: 'tooLarge', limitBytes: 4096 });
  expect(isRunning(pid)).toBe(false);
});

test('createGhRunner ends gh that waits after it passes the limit', async () => {
  const { run, pid } = await runOverLimitGh('head -c 5000 /dev/zero\nexec sleep 30');

  expect(run).toEqual({ kind: 'tooLarge', limitBytes: 4096 });
  expect(isRunning(pid)).toBe(false);
});

test('createGhRunner ends gh that ignores SIGTERM after it passes the limit', async () => {
  const { run, pid } = await runOverLimitGh("trap '' TERM\nhead -c 5000 /dev/zero\nexec sleep 30");

  expect(run).toEqual({ kind: 'tooLarge', limitBytes: 4096 });
  expect(isRunning(pid)).toBe(false);
});

test('createGhRunner returns tooLarge while another process keeps the output open', async () => {
  const helperPids: number[] = [];

  try {
    const { run, pid, directory } = await runOverLimitGh(
      `sleep 30 &\necho $! > "$(dirname "$0")/helper"\nwhile :; do echo 0123456789abcdef; done`,
    );

    helperPids.push(Number((await Bun.file(join(directory, 'helper')).text()).trim()));

    expect(run).toEqual({ kind: 'tooLarge', limitBytes: 4096 });
    expect(isRunning(pid)).toBe(false);
  } finally {
    for (const helperPid of helperPids) {
      process.kill(helperPid);
    }
  }
});

test('createGhRunner returns output that fills the limit unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergit-gh-'));
  directories.push(directory);

  await writeFile(
    join(directory, 'gh'),
    "#!/bin/sh\nprintf '0123456789'\nprintf 'é界' >&2\nexit 2\n",
    { mode: 0o755 },
  );

  const run = await withPath(directory, () => createGhRunner(10)(['api'], signal));

  expect(run).toEqual({ kind: 'exited', exitCode: 2, stdout: '0123456789', stderr: 'é界' });
});
