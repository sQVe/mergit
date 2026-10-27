import { expect, test } from 'bun:test';

import type { NotificationThread } from '../work/work.ts';
import { toThreadId, toViewerId, toViewerLogin } from '../work/work.ts';
import type { GhRun } from './ghApi.ts';
import type { GitHubEffects } from './github.ts';
import {
  markThreadDone,
  pollNotificationFeed,
  readNotificationFeed,
  readViewer,
  restoreNotificationFeed,
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
    host: 'github.com',
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
        body: JSON.stringify([rawThread('105')]),
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
    body: JSON.stringify([rawThread('105')]),
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

test('readNotificationFeed returns invalidResponse for an updated_at that is not a time', async () => {
  const { effects } = makeEffects({
    [firstUrl]: page([{ ...rawThread('301'), updated_at: 'yesterday' }]),
  });

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

test('readViewer reads the login and node ID from /user', async () => {
  const { effects, endpoints } = makeEffects({
    '/user': page({ login: 'octocat', node_id: 'U_kgDOACLctA' }),
  });

  const result = await readViewer(effects, null, signal);

  expect(result).toEqual({
    ok: true,
    value: { id: toViewerId('U_kgDOACLctA'), login: toViewerLogin('octocat'), etag: null },
  });

  expect(endpoints).toEqual(['/user']);
});

test('readViewer asks for the global node ID format', async () => {
  const { effects, calls } = makeEffects({
    '/user': page({ login: 'octocat', node_id: 'U_kgDOACLctA' }),
  });

  await readViewer(effects, null, signal);

  expect(calls[0]).toContain('X-Github-Next-Global-ID: 1');
});

test('readViewer returns the ETag of the response', async () => {
  const { effects, calls } = makeEffects({
    '/user': page({ login: 'octocat', node_id: 'U_1' }, undefined, '"viewer-1"'),
  });

  const result = await readViewer(effects, null, signal);

  expect(result).toEqual({
    ok: true,
    value: { id: toViewerId('U_1'), login: toViewerLogin('octocat'), etag: '"viewer-1"' },
  });

  expect(calls[0]?.some((arg) => arg.startsWith('If-None-Match'))).toBe(false);
});

test('readViewer sends the previous ETag and returns the previous viewer on 304', async () => {
  const { effects, calls } = makeEffects({ '/user': notModified() });
  const previous = { id: toViewerId('U_1'), login: toViewerLogin('octocat'), etag: '"viewer-1"' };

  const result = await readViewer(effects, previous, signal);

  expect(result).toEqual({ ok: true, value: previous });
  expect(calls[0] && conditionOf(calls[0])).toBe('If-None-Match: "viewer-1"');
});

test('readViewer takes the new login and ETag when the previous ETag is stale', async () => {
  const { effects } = makeEffects({
    '/user': page({ login: 'hubot', node_id: 'U_2' }, undefined, '"viewer-2"'),
  });

  const result = await readViewer(
    effects,
    { id: toViewerId('U_1'), login: toViewerLogin('octocat'), etag: '"viewer-1"' },
    signal,
  );

  expect(result).toEqual({
    ok: true,
    value: { id: toViewerId('U_2'), login: toViewerLogin('hubot'), etag: '"viewer-2"' },
  });
});

test('readViewer returns invalidResponse for a 304 without a previous viewer', async () => {
  const { effects } = makeEffects({ '/user': notModified() });

  const result = await readViewer(effects, null, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('readViewer returns invalidResponse for a body without login', async () => {
  const { effects } = makeEffects({ '/user': page({ node_id: 'U_1' }) });

  const result = await readViewer(effects, null, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('readViewer returns invalidResponse for a body without node_id', async () => {
  const { effects } = makeEffects({ '/user': page({ login: 'octocat' }) });

  const result = await readViewer(effects, null, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('readViewer returns invalidResponse for an empty login', async () => {
  const { effects } = makeEffects({ '/user': page({ login: '', node_id: 'U_1' }) });

  const result = await readViewer(effects, null, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('restoreNotificationFeed rebuilds the feed and threads that readNotificationFeed returned', async () => {
  const read = await firstFeed();

  const saved = read.feed.pages.map(({ endpoint, etag, next, body }) => ({
    path: endpoint,
    etag,
    next,
    body,
  }));

  const restored = restoreNotificationFeed(saved);

  expect(restored).toEqual({ ok: true, value: { feed: read.feed, threads: read.threads } });
  expect(read.feed.pages.map((entry) => entry.endpoint)).toEqual([firstUrl, secondUrl, thirdUrl]);
});

test('readNotificationFeed keeps the raw body text of each page', async () => {
  const { feed } = await firstFeed();

  expect(feed.pages[1]?.body).toBe(JSON.stringify([rawThread('103')]));
});

test.each([
  ['a body that is not JSON', 'not json'],
  ['a body that fails the schema', '{"id":"1"}'],
])('restoreNotificationFeed returns invalidResponse for %s', (_label, body) => {
  const result = restoreNotificationFeed([{ path: firstUrl, etag: null, next: null, body }]);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('markThreadDone sends a DELETE to the thread and accepts an empty 205', async () => {
  const { effects, calls } = makeEffects({
    '/notifications/threads/42': {
      kind: 'exited',
      exitCode: 0,
      stdout: 'HTTP/2.0 205 Reset Content\r\n\r\n',
      stderr: '',
    },
  });

  const result = await markThreadDone(effects, toThreadId('42'), signal);

  expect(result).toEqual({ ok: true, value: null });

  expect(calls).toEqual([
    [
      'api',
      '--hostname',
      'github.com',
      '--include',
      '--method',
      'DELETE',
      '/notifications/threads/42',
    ],
  ]);
});

test('markThreadDone maps a failed status to a failure', async () => {
  const { effects } = makeEffects({});

  const result = await markThreadDone(effects, toThreadId('42'), signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 500, message: 'Boom' },
  });
});

test('readViewer returns ghMissing when gh is missing', async () => {
  const effects: GitHubEffects = {
    runGh: async () => ({ kind: 'missing' }),
    now: () => new Date('2026-01-01T00:00:00Z'),
    host: 'github.com',
  };

  const result = await readViewer(effects, null, signal);

  expect(result).toEqual({ ok: false, failure: { kind: 'ghMissing' } });
});

test('pollNotificationFeed returns invalidResponse for a feed without pages', async () => {
  const { effects, calls } = makeEffects({});

  const result = await pollNotificationFeed(effects, { pages: [] }, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
  expect(calls).toEqual([]);
});

test('readNotificationFeed returns invalidResponse for a 304 on a page with no stored copy', async () => {
  const { effects } = makeEffects({ [firstUrl]: notModified() });

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(!result.ok && result.failure.kind).toBe('invalidResponse');
});

test('readNotificationFeed follows a next link with spaces around the semicolon', async () => {
  const spaced: GhRun = {
    kind: 'exited',
    exitCode: 0,
    stdout: `HTTP/2.0 200 OK\r\nLink: <${secondUrl}> ;rel="next"\r\n\r\n${JSON.stringify([rawThread('101')])}`,
    stderr: '',
  };

  const { effects, endpoints } = makeEffects({
    [firstUrl]: spaced,
    [secondUrl]: page([rawThread('102')]),
  });

  const result = await readNotificationFeed(effects, { previous: null }, signal);

  expect(endpoints).toEqual([firstUrl, secondUrl]);
  expect(result.ok && result.value.feed.pages[0]?.next).toBe(secondUrl);
  expect(result.ok && result.value.threads).toEqual([expectedThread('101'), expectedThread('102')]);
});
