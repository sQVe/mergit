import { expect, test } from 'bun:test';

import type { NotificationThread } from '../work/work.ts';
import { toThreadId, toViewerLogin } from '../work/work.ts';
import type { GhRun } from './ghApi.ts';
import type { GitHubEffects } from './github.ts';
import {
  pollNotificationFeed,
  readNotificationFeed,
  readViewer,
  verifyNotificationFeed,
} from './github.ts';

const signal = new AbortController().signal;

const firstUrl = '/notifications?all=true&per_page=50';
const secondUrl = 'https://api.github.com/notifications?all=true&per_page=50&page=2';
const thirdUrl = 'https://api.github.com/notifications?all=true&per_page=50&page=3';

const page = (body: unknown, next?: string, etag?: string): GhRun => {
  const link = next === undefined ? '' : `Link: <${next}>; rel="next"\r\n`;
  const etagLine = etag === undefined ? '' : `ETag: ${etag}\r\n`;

  return {
    kind: 'exited',
    exitCode: 0,
    stdout: `HTTP/2.0 200 OK\r\n${link}${etagLine}X-Poll-Interval: 60\r\n\r\n${JSON.stringify(body)}`,
    stderr: '',
  };
};

const notModified = (next?: string): GhRun => {
  const link = next === undefined ? '' : `Link: <${next}>; rel="next"\r\n`;

  return {
    kind: 'exited',
    exitCode: 0,
    stdout: `HTTP/2.0 304 Not Modified\r\n${link}X-Poll-Interval: 90\r\n\r\n`,
    stderr: '',
  };
};

const failedPage: GhRun = {
  kind: 'exited',
  exitCode: 1,
  stdout: 'HTTP/2.0 500 Internal Server Error\r\n\r\n{"message":"Boom"}',
  stderr: '',
};

const makeEffects = (pages: Record<string, GhRun>) => {
  const endpoints: string[] = [];
  const calls: (readonly string[])[] = [];

  const effects: GitHubEffects = {
    runGh: async (args) => {
      const endpoint = args.at(-1) ?? '';
      endpoints.push(endpoint);
      calls.push(args);

      return pages[endpoint] ?? failedPage;
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
  };

  return { effects, endpoints, calls };
};

const rawThread = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  unread: true,
  reason: 'review_requested',
  updated_at: '2026-01-02T03:04:05Z',
  last_read_at: null,
  subject: {
    title: `Change ${id}`,
    type: 'PullRequest',
    url: `https://api.github.com/repos/octo/widgets/pulls/${id}`,
  },
  repository: { full_name: 'octo/widgets', private: false },
  ...overrides,
});

const expectedThread = (id: string): NotificationThread => ({
  id: toThreadId(id),
  reason: 'review_requested',
  unread: true,
  updatedAt: '2026-01-02T03:04:05Z',
  lastReadAt: null,
  title: `Change ${id}`,
  subjectType: 'PullRequest',
  subjectUrl: `https://api.github.com/repos/octo/widgets/pulls/${id}`,
  repository: 'octo/widgets',
});

const conditionOf = (args: readonly string[]) =>
  args.find((arg) => arg.startsWith('If-None-Match'));

const threePageBodies = (): Record<string, GhRun> => ({
  [firstUrl]: page([rawThread('101'), rawThread('102')], secondUrl, '"a"'),
  [secondUrl]: page([rawThread('103')], thirdUrl, '"b"'),
  [thirdUrl]: page([rawThread('104')], undefined, '"c"'),
});

const firstFeed = async () => {
  const { effects } = makeEffects(threePageBodies());
  const result = await readNotificationFeed(effects, { previous: null }, signal);

  if (!result.ok) {
    throw new Error('first pass failed');
  }

  return result.value;
};

test('pollNotificationFeed sends one request with the stored ETag and reports a 304 as unchanged', async () => {
  const { feed } = await firstFeed();
  const { effects, calls } = makeEffects({ [firstUrl]: notModified() });

  const result = await pollNotificationFeed(effects, feed, signal);

  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('If-None-Match: "a"');
  expect(result).toEqual({ ok: true, value: { kind: 'unchanged', pollInterval: 90 } });
});

test('pollNotificationFeed returns the new page 1 when it changed', async () => {
  const { feed } = await firstFeed();

  const { effects, calls } = makeEffects({
    [firstUrl]: page([rawThread('105')], secondUrl, '"a2"'),
  });

  const result = await pollNotificationFeed(effects, feed, signal);

  expect(calls).toHaveLength(1);

  expect(result).toEqual({
    ok: true,
    value: {
      kind: 'changed',
      page: {
        endpoint: firstUrl,
        etag: '"a2"',
        threads: [expectedThread('105')],
        next: secondUrl,
      },
      pollInterval: 60,
    },
  });
});

test.each([
  ['a 400-digit value', '9'.repeat(400)],
  ['86401', '86401'],
  ['0', '0'],
])(
  'pollNotificationFeed reports a null poll interval for X-Poll-Interval %s',
  async (_label, value) => {
    const { feed } = await firstFeed();

    const response: GhRun = {
      kind: 'exited',
      exitCode: 0,
      stdout: `HTTP/2.0 304 Not Modified\r\nX-Poll-Interval: ${value}\r\n\r\n`,
      stderr: '',
    };

    const { effects } = makeEffects({ [firstUrl]: response });
    const result = await pollNotificationFeed(effects, feed, signal);

    expect(result).toEqual({ ok: true, value: { kind: 'unchanged', pollInterval: null } });
  },
);

test('pollNotificationFeed accepts the largest poll interval of 86400 seconds', async () => {
  const { feed } = await firstFeed();

  const response: GhRun = {
    kind: 'exited',
    exitCode: 0,
    stdout: 'HTTP/2.0 304 Not Modified\r\nX-Poll-Interval: 86400\r\n\r\n',
    stderr: '',
  };

  const { effects } = makeEffects({ [firstUrl]: response });
  const result = await pollNotificationFeed(effects, feed, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'unchanged', pollInterval: 86_400 } });
});

test('pollNotificationFeed returns the failure of the request', async () => {
  const { feed } = await firstFeed();
  const { effects } = makeEffects({});

  const result = await pollNotificationFeed(effects, feed, signal);

  expect(!result.ok && result.failure.kind).toBe('requestFailed');
});

test('readNotificationFeed follows every next link and returns all threads in order', async () => {
  const { effects, endpoints, calls } = makeEffects(threePageBodies());

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(result.ok && result.value.threads).toEqual([
    expectedThread('101'),
    expectedThread('102'),
    expectedThread('103'),
    expectedThread('104'),
  ]);

  expect(result.ok && result.value.feed.pages.map((entry) => entry.etag)).toEqual([
    '"a"',
    '"b"',
    '"c"',
  ]);

  expect(result.ok && result.value.pollInterval).toBe(60);
  expect(endpoints).toEqual([firstUrl, secondUrl, thirdUrl]);
  expect(calls.some((args) => conditionOf(args) !== undefined)).toBe(false);
});

test('readNotificationFeed reuses a stored page that answers 304', async () => {
  const { feed } = await firstFeed();

  const { effects, calls } = makeEffects({
    [firstUrl]: notModified(),
    [secondUrl]: page([rawThread('113')], thirdUrl, '"b2"'),
    [thirdUrl]: notModified(),
  });

  const result = await readNotificationFeed(effects, { previous: feed }, signal);

  expect(result.ok && result.value.threads).toEqual([
    expectedThread('101'),
    expectedThread('102'),
    expectedThread('113'),
    expectedThread('104'),
  ]);

  expect(calls.map(conditionOf)).toEqual([
    'If-None-Match: "a"',
    'If-None-Match: "b"',
    'If-None-Match: "c"',
  ]);
});

test('readNotificationFeed reuses page 1 from a poll without requesting it', async () => {
  const { feed } = await firstFeed();

  const polled = {
    endpoint: firstUrl,
    etag: '"a2"',
    threads: [expectedThread('105')],
    next: secondUrl,
  };

  const { effects, endpoints } = makeEffects({
    [secondUrl]: notModified(),
    [thirdUrl]: notModified(),
  });

  const result = await readNotificationFeed(effects, { previous: feed, firstPage: polled }, signal);

  expect(endpoints).toEqual([secondUrl, thirdUrl]);

  expect(result.ok && result.value.threads).toEqual([
    expectedThread('105'),
    expectedThread('103'),
    expectedThread('104'),
  ]);

  expect(result.ok && result.value.feed.pages[0]?.etag).toBe('"a2"');
});

test('readNotificationFeed takes next from a 304 Link header without a next page', async () => {
  const { feed } = await firstFeed();

  const withoutNext: GhRun = {
    kind: 'exited',
    exitCode: 0,
    stdout: `HTTP/2.0 304 Not Modified\r\nLink: <${firstUrl}>; rel="first"\r\n\r\n`,
    stderr: '',
  };

  const { effects, endpoints } = makeEffects({ [firstUrl]: withoutNext });
  const result = await readNotificationFeed(effects, { previous: feed }, signal);

  expect(result.ok && result.value.feed.pages).toHaveLength(1);
  expect(result.ok && result.value.feed.pages[0]?.next).toBeNull();
  expect(result.ok && result.value.feed.pages[0]?.etag).toBe('"a"');
  expect(result.ok && result.value.threads).toEqual([expectedThread('101'), expectedThread('102')]);
  expect(endpoints).toEqual([firstUrl]);
});

test('readNotificationFeed returns the failure of page 2', async () => {
  const { effects } = makeEffects({ [firstUrl]: page([rawThread('101')], secondUrl, '"a"') });

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(!result.ok && result.failure).toEqual({
    kind: 'requestFailed',
    status: 500,
    message: 'Boom',
  });
});

test('readNotificationFeed parses a thread with a null subject url', async () => {
  const checkSuite = rawThread('201', {
    subject: { title: 'Run failed', type: 'CheckSuite', url: null },
  });

  const { effects } = makeEffects({ [firstUrl]: page([checkSuite]) });

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(result.ok && result.value.threads[0]).toEqual({
    ...expectedThread('201'),
    title: 'Run failed',
    subjectType: 'CheckSuite',
    subjectUrl: null,
  });
});

test('readNotificationFeed returns invalidResponse for a thread without id', async () => {
  const { id: _id, ...withoutId } = rawThread('301');
  const { effects } = makeEffects({ [firstUrl]: page([withoutId]) });

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('readNotificationFeed returns invalidResponse for an empty id', async () => {
  const { effects } = makeEffects({ [firstUrl]: page([rawThread('')]) });

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('readNotificationFeed reports a null poll interval when the header is invalid', async () => {
  const invalid: GhRun = {
    kind: 'exited',
    exitCode: 0,
    stdout: 'HTTP/2.0 200 OK\r\nX-Poll-Interval: soon\r\n\r\n[]',
    stderr: '',
  };

  const { effects } = makeEffects({ [firstUrl]: invalid });

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(result.ok && result.value.pollInterval).toBeNull();
});

test('verifyNotificationFeed is stable when every page answers 304', async () => {
  const { feed } = await firstFeed();

  const { effects, endpoints } = makeEffects({
    [firstUrl]: notModified(secondUrl),
    [secondUrl]: notModified(thirdUrl),
    [thirdUrl]: notModified(),
  });

  const result = await verifyNotificationFeed(effects, feed, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'stable', pollInterval: 90 } });
  expect(endpoints).toEqual([firstUrl, secondUrl, thirdUrl]);
});

test('verifyNotificationFeed returns changed at the first 200 and stops', async () => {
  const { feed } = await firstFeed();

  const { effects, endpoints } = makeEffects({
    [firstUrl]: notModified(),
    [secondUrl]: page([rawThread('999')], thirdUrl, '"b2"'),
  });

  const result = await verifyNotificationFeed(effects, feed, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'changed', pollInterval: 60 } });
  expect(endpoints).toEqual([firstUrl, secondUrl]);
});

test('verifyNotificationFeed returns changed when a 304 names a different next link', async () => {
  const { feed } = await firstFeed();

  const { effects } = makeEffects({
    [firstUrl]: notModified(secondUrl),
    [secondUrl]: notModified(thirdUrl),
    [thirdUrl]: notModified('https://api.github.com/notifications?all=true&per_page=50&page=4'),
  });

  const result = await verifyNotificationFeed(effects, feed, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'changed', pollInterval: 90 } });
});

test('verifyNotificationFeed returns the failure of a request', async () => {
  const { feed } = await firstFeed();
  const { effects } = makeEffects({ [firstUrl]: notModified() });

  const result = await verifyNotificationFeed(effects, feed, signal);

  expect(!result.ok && result.failure.kind).toBe('requestFailed');
});

test('readViewer reads the login from /user', async () => {
  const { effects, endpoints } = makeEffects({ '/user': page({ login: 'octocat', id: 1 }) });

  const result = await readViewer(effects, signal);

  expect(result).toEqual({ ok: true, value: toViewerLogin('octocat') });
  expect(endpoints).toEqual(['/user']);
});

test('readViewer returns invalidResponse for a body without login', async () => {
  const { effects } = makeEffects({ '/user': page({ id: 1 }) });

  const result = await readViewer(effects, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('readViewer returns invalidResponse for an empty login', async () => {
  const { effects } = makeEffects({ '/user': page({ login: '' }) });

  const result = await readViewer(effects, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});
