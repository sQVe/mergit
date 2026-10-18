import { expect, test } from 'bun:test';

import type { NotificationThread } from '../work/work.ts';
import { toThreadId } from '../work/work.ts';
import type { GhRun } from './ghApi.ts';
import type { GitHubEffects } from './github.ts';
import { lookUpSubjects } from './github.ts';

const signal = new AbortController().signal;

const makeThread = (
  id: number,
  overrides: Partial<NotificationThread> = {},
): NotificationThread => ({
  id: toThreadId(String(id)),
  reason: 'subscribed',
  unread: true,
  updatedAt: '2026-01-02T03:04:05Z',
  lastReadAt: null,
  title: `Change ${id}`,
  subjectType: 'PullRequest',
  subjectUrl: `https://api.github.com/repos/octo/widgets/pulls/${id}`,
  repository: 'octo/widgets',
  ...overrides,
});

const httpResponse = (body: unknown, status = '200 OK'): GhRun => ({
  kind: 'exited',
  exitCode: 0,
  stdout: `HTTP/2.0 ${status}\r\n\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`,
  stderr: '',
});

const readQuery = (args: readonly string[]): string =>
  args.find((argument) => argument.startsWith('query='))?.slice('query='.length) ?? '';

const countAliases = (args: readonly string[]): number =>
  readQuery(args).match(/t\d+: repository/g)?.length ?? 0;

const pullRequestFacts = {
  state: 'MERGED',
  author: { login: 'octo' },
  timelineItems: { nodes: [{ actor: { login: 'mona' } }] },
};

const repositoryWith = (subject: unknown, kind: 'pullRequest' | 'issue' = 'pullRequest') => ({
  [kind]: subject,
});

const makeEffects = (answer: (args: readonly string[], call: number) => GhRun) => {
  const calls: (readonly string[])[] = [];

  const effects: GitHubEffects = {
    runGh: async (args) => {
      calls.push(args);

      return answer(args, calls.length - 1);
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
  };

  return { effects, calls };
};

const subject = (node: unknown) => ({
  state: 'OPEN',
  author: { login: 'octo' },
  timelineItems: { nodes: [node] },
});

const answerEveryAlias = (args: readonly string[]): GhRun => {
  const data: Record<string, unknown> = {};

  for (let index = 0; index < countAliases(args); index += 1) {
    data[`t${index}`] = repositoryWith(pullRequestFacts);
  }

  return httpResponse({ data });
};

test('looks up pull requests and issues in one request', async () => {
  const { effects, calls } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith(pullRequestFacts),
        t1: repositoryWith({
          state: 'OPEN',
          author: { login: 'hubot' },
          timelineItems: { nodes: [] },
        }),
        t2: repositoryWith(
          { state: 'CLOSED', author: { login: 'monalisa' }, timelineItems: { nodes: [] } },
          'issue',
        ),
      },
    }),
  );

  const threads = [
    makeThread(1),
    makeThread(2),
    makeThread(3, {
      subjectType: 'Issue',
      subjectUrl: 'https://api.github.com/repos/octo/widgets/issues/3',
    }),
  ];

  const result = await lookUpSubjects(effects, threads, signal);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 3)).toEqual(['api', 'graphql', '--include']);
  expect(readQuery(calls[0] ?? [])).toContain('issue(number: $n2)');

  expect(result).toEqual([
    {
      threadId: toThreadId('1'),
      updatedAt: '2026-01-02T03:04:05Z',
      facts: { state: 'merged', author: 'octo', latestActor: 'mona' },
    },
    {
      threadId: toThreadId('2'),
      updatedAt: '2026-01-02T03:04:05Z',
      facts: { state: 'open', author: 'hubot', latestActor: null },
    },
    {
      threadId: toThreadId('3'),
      updatedAt: '2026-01-02T03:04:05Z',
      facts: { state: 'closed', author: 'monalisa', latestActor: null },
    },
  ]);
});

test('sends 120 pull requests as batches of 50, 50, and 20', async () => {
  const { effects, calls } = makeEffects(answerEveryAlias);
  const threads = Array.from({ length: 120 }, (_, index) => makeThread(index + 1));

  const result = await lookUpSubjects(effects, threads, signal);

  expect(calls.map(countAliases)).toEqual([50, 50, 20]);
  expect(result).toHaveLength(120);
});

test('skips other subject types and threads without a subject URL', async () => {
  const { effects, calls } = makeEffects(answerEveryAlias);

  const threads = [
    makeThread(1),
    makeThread(2, { subjectType: 'Discussion' }),
    makeThread(3, { subjectUrl: null }),
    makeThread(4, { subjectUrl: 'https://example.com/not-a-subject' }),
    makeThread(5, { subjectType: 'Release' }),
  ];

  const result = await lookUpSubjects(effects, threads, signal);

  expect(calls.map(countAliases)).toEqual([1]);
  expect(result.map((entry) => String(entry.threadId))).toEqual(['1']);
});

test('keeps other facts when one alias has a GraphQL error', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith(pullRequestFacts),
        t1: null,
        t2: repositoryWith(pullRequestFacts),
      },
      errors: [{ type: 'NOT_FOUND', path: ['t1', 'pullRequest'], message: 'Missing' }],
    }),
  );

  const threads = [makeThread(1), makeThread(2), makeThread(3)];

  const result = await lookUpSubjects(effects, threads, signal);

  expect(result.map((entry) => entry.facts?.state ?? null)).toEqual(['merged', null, 'merged']);
  expect(result.map((entry) => String(entry.threadId))).toEqual(['1', '2', '3']);
});

test('gives no entry for an alias with an error other than not found', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith(pullRequestFacts),
        t1: null,
        t2: null,
      },
      errors: [
        { type: 'NOT_FOUND', path: ['t1', 'pullRequest'], message: 'Missing' },
        { path: ['t2', 'pullRequest', 'timelineItems'], message: 'Something went wrong' },
      ],
    }),
  );

  const threads = [makeThread(1), makeThread(2), makeThread(3)];

  const result = await lookUpSubjects(effects, threads, signal);

  expect(result.map((entry) => String(entry.threadId))).toEqual(['1', '2']);
  expect(result.map((entry) => entry.facts?.state ?? null)).toEqual(['merged', null]);
});

test('gives no entries for a failed batch and keeps the other batches', async () => {
  const { effects } = makeEffects((args, call) => {
    if (call === 0) {
      return httpResponse({ message: 'Boom' }, '502 Bad Gateway');
    }

    return answerEveryAlias(args);
  });

  const threads = Array.from({ length: 60 }, (_, index) => makeThread(index + 1));

  const result = await lookUpSubjects(effects, threads, signal);

  expect(result).toHaveLength(10);

  expect(result.map((entry) => String(entry.threadId))).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index + 51)),
  );
});

test('gives no entries for a batch with an invalid body', async () => {
  const { effects } = makeEffects((args, call) => {
    if (call === 0) {
      return httpResponse({ data: 'nope' });
    }

    return answerEveryAlias(args);
  });

  const threads = Array.from({ length: 51 }, (_, index) => makeThread(index + 1));

  const result = await lookUpSubjects(effects, threads, signal);

  expect(result.map((entry) => String(entry.threadId))).toEqual(['51']);
});

test('gives no entries when gh is missing', async () => {
  const effects: GitHubEffects = {
    runGh: async () => ({ kind: 'missing' }),
    now: () => new Date('2026-01-01T00:00:00Z'),
  };

  const result = await lookUpSubjects(effects, [makeThread(1)], signal);

  expect(result).toEqual([]);
});

test('reports a null author with the state', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith({ state: 'CLOSED', author: null, timelineItems: { nodes: [] } }),
      },
    }),
  );

  const result = await lookUpSubjects(effects, [makeThread(1)], signal);

  expect(result[0]?.facts).toEqual({ state: 'closed', author: null, latestActor: null });
});

test('reads the latest actor and gives null for an unread event type', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith(subject({ author: { login: 'reviewer' } })),
        t1: repositoryWith(subject({ commit: { author: { user: { login: 'committer' } } } })),
        t2: repositoryWith(subject({})),
        t3: repositoryWith(subject({ actor: null })),
      },
    }),
  );

  const threads = [makeThread(1), makeThread(2), makeThread(3), makeThread(4)];

  const result = await lookUpSubjects(effects, threads, signal);

  expect(result.map((entry) => entry.facts?.latestActor)).toEqual([
    'reviewer',
    'committer',
    null,
    null,
  ]);
});

test('stores a bot author login with the bot suffix', async () => {
  const { effects, calls } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith({
          state: 'OPEN',
          author: { __typename: 'Bot', login: 'dependabot' },
          timelineItems: { nodes: [] },
        }),
      },
    }),
  );

  const result = await lookUpSubjects(effects, [makeThread(1)], signal);
  const sentQuery = readQuery(calls[0] ?? []);

  expect(sentQuery).toContain('author { __typename login }');
  expect(result[0]?.facts?.author).toBe('dependabot[bot]');
});

const readVariables = (args: readonly string[], flag: '-f' | '-F'): Map<string, string> => {
  const variables = new Map<string, string>();

  for (const [index, argument] of args.entries()) {
    const assignment = args[index + 1] ?? '';
    const separator = assignment.indexOf('=');

    if (argument === flag && separator > 0) {
      variables.set(assignment.slice(0, separator), assignment.slice(separator + 1));
    }
  }

  return variables;
};

const answerWithSentSubject = (args: readonly string[]): GhRun => {
  const strings = readVariables(args, '-f');
  const integers = readVariables(args, '-F');
  const data: Record<string, unknown> = {};

  for (let index = 0; index < countAliases(args); index += 1) {
    const sent = `${strings.get(`o${index}`)}/${strings.get(`r${index}`)}#${integers.get(`n${index}`)}`;

    data[`t${index}`] = repositoryWith({ ...pullRequestFacts, author: { login: sent } });
  }

  return httpResponse({ data });
};

test('sends each owner and name as a string and each number as an integer to gh', async () => {
  const { effects } = makeEffects(answerWithSentSubject);

  const threads = [
    makeThread(1),
    makeThread(2, { subjectUrl: 'https://api.github.com/repos/mona/lisa/pulls/42' }),
  ];

  const result = await lookUpSubjects(effects, threads, signal);

  expect(result.map((entry) => entry.facts?.author)).toEqual(['octo/widgets#1', 'mona/lisa#42']);
});

test('makes no lookup for a subject URL with a suffix', async () => {
  const { effects, calls } = makeEffects(answerEveryAlias);

  const thread = makeThread(12, {
    subjectUrl: 'https://api.github.com/repos/o/r/pulls/12/comments',
  });

  const result = await lookUpSubjects(effects, [thread], signal);

  expect(calls).toEqual([]);
  expect(result).toEqual([]);
});

test('sends no empty batch for exactly 50 threads', async () => {
  const { effects, calls } = makeEffects(answerEveryAlias);
  const threads = Array.from({ length: 50 }, (_, index) => makeThread(index + 1));

  const result = await lookUpSubjects(effects, threads, signal);

  expect(calls.map(countAliases)).not.toContain(0);
  expect(result).toHaveLength(50);
});

test('makes no call for zero threads', async () => {
  const { effects, calls } = makeEffects(answerEveryAlias);

  const result = await lookUpSubjects(effects, [], signal);

  expect(calls).toEqual([]);
  expect(result).toEqual([]);
});

test('gives a null latest actor when the last timeline node is null', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith({
          state: 'OPEN',
          author: { login: 'octo' },
          timelineItems: { nodes: [null] },
        }),
      },
    }),
  );

  const result = await lookUpSubjects(effects, [makeThread(1)], signal);

  expect(result[0]?.facts).toEqual({ state: 'open', author: 'octo', latestActor: null });
});

test('gives a null latest actor for a commit without an author or user', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith(subject({ commit: { author: null } })),
        t1: repositoryWith(subject({ commit: { author: { user: null } } })),
      },
    }),
  );

  const result = await lookUpSubjects(effects, [makeThread(1), makeThread(2)], signal);

  expect(result.map((entry) => entry.facts?.latestActor)).toEqual([null, null]);
});

test('gives facts null for an alias with null data and no errors', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: null,
        t1: { pullRequest: null },
        t2: repositoryWith(pullRequestFacts),
      },
    }),
  );

  const threads = [makeThread(1), makeThread(2), makeThread(3)];

  const result = await lookUpSubjects(effects, threads, signal);

  expect(result.map((entry) => String(entry.threadId))).toEqual(['1', '2', '3']);
  expect(result[0]?.facts).toBeNull();
  expect(result[1]?.facts).toBeNull();
  expect(result[2]?.facts?.state).toBe('merged');
});

test('keeps other facts when a GraphQL error has no path', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: {
        t0: repositoryWith(pullRequestFacts),
        t1: repositoryWith(pullRequestFacts),
      },
      errors: [{ type: 'RATE_LIMITED', message: 'Slow down' }],
    }),
  );

  const result = await lookUpSubjects(effects, [makeThread(1), makeThread(2)], signal);

  expect(result.map((entry) => entry.facts?.state)).toEqual(['merged', 'merged']);
});
