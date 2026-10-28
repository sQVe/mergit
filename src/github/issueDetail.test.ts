import { expect, test } from 'bun:test';

import { toIssueId, toViewerId, toViewerLogin } from '../work/work.ts';
import type { GhRun } from './ghApi.ts';
import type { GitHubEffects, IssueDetailRequest } from './github.ts';
import { readIssueDetail } from './github.ts';

const host = 'ghe.example.com';
const signal = new AbortController().signal;
const globalNodeIdHeader = 'X-Github-Next-Global-ID: 1';
const viewer = { id: toViewerId('U_1'), login: toViewerLogin('me') };
const issueUrl = 'https://github.com/octo/widgets/issues/7';

const httpResponse = (body: unknown, headerLines: string[] = []): GhRun => ({
  kind: 'exited',
  exitCode: 0,
  stdout: ['HTTP/2.0 200 OK', ...headerLines, '', JSON.stringify(body)].join('\r\n'),
  stderr: '',
});

const readQuery = (args: readonly string[]): string =>
  args.find((argument) => argument.startsWith('query='))?.slice('query='.length) ?? '';

const isNodeQuery = (args: readonly string[]): boolean => readQuery(args).includes('node(id: $id)');

const viewerBody = { id: 'U_1', login: 'me' };

const repositoryBody = (issue: unknown) => ({
  data: { viewer: viewerBody, repository: { issue } },
});

const nodeBody = (node: unknown) => ({ data: { viewer: viewerBody, node } });

const makeEffects = (answer: (args: readonly string[]) => GhRun) => {
  const calls: (readonly string[])[] = [];

  const effects: GitHubEffects = {
    runGh: async (args) => {
      calls.push(args);

      return answer(args);
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    host,
  };

  return { effects, calls };
};

const commentNode = (overrides: Record<string, unknown> = {}) => ({
  id: 'IC_1',
  author: { login: 'mona' },
  body: 'Looks broken',
  createdAt: '2026-01-02T03:04:05Z',
  updatedAt: '2026-01-02T03:04:05Z',
  lastEditedAt: null,
  url: `${issueUrl}#issuecomment-1`,
  ...overrides,
});

const issueNode = (comments: unknown[]) => ({
  id: 'I_7',
  number: 7,
  url: issueUrl,
  title: 'Crash on start',
  body: 'Steps to reproduce',
  state: 'OPEN',
  author: { login: 'octo' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T03:04:05Z',
  lastEditedAt: null,
  labels: { totalCount: 1, nodes: [{ name: 'bug' }] },
  assignees: { totalCount: 0, nodes: [] },
  comments: { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: comments },
});

// The node query aliases __typename as typeName, so the fake answers it the same way.
const issueAnswer = (issue: unknown) => (args: readonly string[]) =>
  httpResponse(
    isNodeQuery(args)
      ? nodeBody({ typeName: 'Issue', ...(issue as object) })
      : repositoryBody(issue),
  );

const firstPage: IssueDetailRequest = {
  coordinates: { owner: 'octo', name: 'widgets', number: 7 },
  commentsAfter: null,
  pageSize: 1,
};

const continuationPage: IssueDetailRequest = {
  coordinates: { subjectId: toIssueId('I_7') },
  commentsAfter: 'C1',
  pageSize: 1,
};

const readComments = (result: Awaited<ReturnType<typeof readIssueDetail>>) => {
  if (!result.ok || result.value.kind !== 'issue') {
    throw new Error('Expected an issue result');
  }

  return result.value.comments.records;
};

test('sends the host, the global ID header, and the viewer on the first page', async () => {
  const { effects, calls } = makeEffects(issueAnswer(issueNode([commentNode()])));

  await readIssueDetail(effects, firstPage, signal);

  const args = calls[0] ?? [];

  expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', host]);
  expect(args).toContain(globalNodeIdHeader);
  expect(readQuery(args)).toContain('viewer { id login }');
  expect(readQuery(args)).toContain('repository(owner: $owner, name: $name)');
});

test('sends the host, the global ID header, and the viewer on a node continuation page', async () => {
  const { effects, calls } = makeEffects(issueAnswer(issueNode([commentNode()])));

  await readIssueDetail(effects, continuationPage, signal);

  const args = calls[0] ?? [];

  expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', host]);
  expect(args).toContain(globalNodeIdHeader);
  expect(args).toContain('id=I_7');
  expect(args).toContain('after=C1');
  expect(readQuery(args)).toContain('viewer { id login }');
  expect(readQuery(args)).toContain('node(id: $id)');
});

test('returns the subject, overview, and one comment page of the first page', async () => {
  const { effects } = makeEffects(issueAnswer(issueNode([commentNode(), null])));

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: 'issue',
      viewer,
      subject: { id: 'I_7', number: 7, url: issueUrl },
      overview: {
        title: 'Crash on start',
        state: 'open',
        author: 'octo',
        labels: { names: ['bug'], totalCount: 1 },
        assignees: { logins: [], totalCount: 0 },
      },
      comments: {
        totalCount: 2,
        hasNextPage: true,
        endCursor: 'C1',
        records: [
          { id: 'IC_1', author: 'mona', body: 'Looks broken', url: `${issueUrl}#issuecomment-1` },
        ],
      },
    },
  });
});

test('gives the same comment the same digest on a first page and a continuation page', async () => {
  const first = makeEffects(issueAnswer(issueNode([commentNode()])));
  const continuation = makeEffects(issueAnswer(issueNode([commentNode()])));

  const firstRecords = readComments(await readIssueDetail(first.effects, firstPage, signal));

  const continuationRecords = readComments(
    await readIssueDetail(continuation.effects, continuationPage, signal),
  );

  expect(firstRecords[0]?.digest).toMatch(/^v1:[0-9a-f]{64}$/);
  expect(continuationRecords[0]?.digest).toBe(firstRecords[0]?.digest);
});

test('gives a comment a new digest when its lastEditedAt changes', async () => {
  const original = makeEffects(issueAnswer(issueNode([commentNode()])));

  const edited = makeEffects(
    issueAnswer(issueNode([commentNode({ lastEditedAt: '2026-01-05T00:00:00Z' })])),
  );

  const originalRecords = readComments(await readIssueDetail(original.effects, firstPage, signal));
  const editedRecords = readComments(await readIssueDetail(edited.effects, firstPage, signal));

  expect(editedRecords[0]?.digest).not.toBe(originalRecords[0]?.digest);
});

test('returns a failure for HTTP 200 with GraphQL errors', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({ data: null, errors: [{ message: 'Something went wrong' }] }),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 200, message: 'Something went wrong' },
  });
});

test('returns rateLimited for a RATE_LIMITED GraphQL error', async () => {
  const { effects } = makeEffects(() =>
    httpResponse(
      { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
      ['X-RateLimit-Reset: 1767225600'],
    ),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date(1767225600000) },
  });
});

test('returns a failure for errors with a null viewer, not invalidResponse', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: { viewer: null, repository: null },
      errors: [{ message: 'Something went wrong' }],
    }),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 200, message: 'Something went wrong' },
  });
});

test('returns rateLimited for RATE_LIMITED errors with a null viewer', async () => {
  const { effects } = makeEffects(() =>
    httpResponse(
      {
        data: { viewer: null, repository: null },
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
      },
      ['X-RateLimit-Reset: 1767225600'],
    ),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date(1767225600000) },
  });
});

test('returns rateLimited for a body with errors and no data', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, [
      'X-RateLimit-Reset: 1767225600',
    ]),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date(1767225600000) },
  });
});

test('returns rateLimited when a generic error comes before RATE_LIMITED', async () => {
  const { effects } = makeEffects(() =>
    httpResponse(
      {
        data: { viewer: viewerBody, repository: null },
        errors: [
          { message: 'Something went wrong' },
          { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
        ],
      },
      ['X-RateLimit-Reset: 1767225600'],
    ),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date(1767225600000) },
  });
});

test('returns rateLimited when RATE_LIMITED comes before a generic error', async () => {
  const { effects } = makeEffects(() =>
    httpResponse(
      {
        data: { viewer: viewerBody, repository: null },
        errors: [
          { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
          { message: 'Something went wrong' },
        ],
      },
      ['X-RateLimit-Reset: 1767225600'],
    ),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date(1767225600000) },
  });
});

test('returns unavailable when the repository has no such issue', async () => {
  const { effects } = makeEffects(() => httpResponse(repositoryBody(null)));

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'unavailable', viewer } });
});

test('returns unavailable for a NOT_FOUND GraphQL error', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({
      data: { viewer: viewerBody, repository: null },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }],
    }),
  );

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'unavailable', viewer } });
});

test('returns unsupported when the continuation node is not an issue', async () => {
  const { effects } = makeEffects(() => httpResponse(nodeBody({ typeName: 'PullRequest' })));

  const result = await readIssueDetail(effects, continuationPage, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'unsupported', viewer } });
});

test('returns responseTooLarge when gh output exceeds its limit', async () => {
  const { effects } = makeEffects(() => ({ kind: 'tooLarge', limitBytes: 10 }));

  const result = await readIssueDetail(effects, firstPage, signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'responseTooLarge', limitBytes: 10 },
  });
});
