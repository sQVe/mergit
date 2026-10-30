import { expect, test } from 'bun:test';

import { toPullRequestId, toViewerId, toViewerLogin } from '../work/work.ts';
import type { GhRun } from './ghApi.ts';
import type { GitHubEffects, PullRequestDetailRequest } from './github.ts';
import { readPullRequestDetail } from './github.ts';

const host = 'ghe.example.com';
const signal = new AbortController().signal;
const globalNodeIdHeader = 'X-Github-Next-Global-ID: 1';
const viewer = { id: toViewerId('U_1'), login: toViewerLogin('me') };
const pullRequestUrl = 'https://github.com/octo/widgets/pull/7';
const viewerBody = { id: 'U_1', login: 'me' };
const emptyPageInfo = { hasNextPage: false, endCursor: null };

const httpResponse = (body: unknown, headerLines: string[] = []): GhRun => ({
  kind: 'exited',
  exitCode: 0,
  stdout: ['HTTP/2.0 200 OK', ...headerLines, '', JSON.stringify(body)].join('\r\n'),
  stderr: '',
});

const readQuery = (args: readonly string[]): string =>
  args.find((argument) => argument.startsWith('query='))?.slice('query='.length) ?? '';

const isNodeQuery = (args: readonly string[]): boolean => readQuery(args).includes('node(id: $id)');

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

const pullRequestAnswer =
  (fields: Record<string, unknown>) =>
  (args: readonly string[]): GhRun => {
    const pullRequest = { id: 'PR_1', headRefOid: 'head1', baseRefOid: 'base1', ...fields };

    return httpResponse(
      isNodeQuery(args)
        ? { data: { viewer: viewerBody, node: { typeName: 'PullRequest', ...pullRequest } } }
        : { data: { viewer: viewerBody, repository: { pullRequest } } },
    );
  };

const overviewFields = {
  number: 7,
  url: pullRequestUrl,
  title: 'Add widgets',
  body: 'Adds widgets',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'octo' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T03:04:05Z',
  lastEditedAt: null,
  baseRefName: 'main',
  headRefName: 'widgets',
  labels: { totalCount: 1, nodes: [{ name: 'feature' }] },
  assignees: { totalCount: 0, nodes: [] },
  reviewRequests: { totalCount: 0, nodes: [] },
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  checksUrl: `${pullRequestUrl}/checks`,
};

const commitsFields = {
  commits: { totalCount: 0, pageInfo: emptyPageInfo, nodes: [] },
};

const checksFields = (statusCheckRollup: unknown) => ({
  commits: { nodes: [{ commit: { statusCheckRollup } }] },
});

const filesFields = {
  changedFiles: 0,
  additions: 0,
  deletions: 0,
  files: { totalCount: 0, pageInfo: emptyPageInfo, nodes: [] },
};

const fieldsBySource = {
  overview: overviewFields,
  commits: commitsFields,
  checks: checksFields(null),
  files: filesFields,
} as const;

const coordinates = { owner: 'octo', name: 'widgets', number: 7 };

const firstPage = (source: PullRequestDetailRequest['source']): PullRequestDetailRequest =>
  source === 'overview'
    ? { coordinates, source, pageSize: 1 }
    : { coordinates, source, after: null, pageSize: 1 };

const checkRunNode = {
  typeName: 'CheckRun',
  name: 'build',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  detailsUrl: 'https://ci.example.com/runs/1',
  url: 'https://github.com/octo/widgets/runs/1',
  databaseId: 1,
};

const statusContextNode = {
  typeName: 'StatusContext',
  context: 'ci/legacy',
  state: 'FAILURE',
  description: 'Build failed',
  targetUrl: 'https://ci.example.com/legacy',
};

const readOverviewValue = (result: Awaited<ReturnType<typeof readPullRequestDetail>>) => {
  if (!result.ok || result.value.kind !== 'overview') {
    throw new Error('Expected an overview result');
  }

  return result.value.overview;
};

test('normalizes populated Overview branches, nullable author and reviewer lists', async () => {
  for (const author of [null, { login: 'octo' }]) {
    const fields = {
      ...overviewFields,
      author,
      baseRefOid: '1111111111111111111111111111111111111111',
      headRefOid: '2222222222222222222222222222222222222222',
      baseRefName: 'release/widgets',
      headRefName: 'feature/widget-colors',
      labels: { totalCount: 3, nodes: [{ name: 'feature' }, null, { name: 'ui' }] },
      assignees: { totalCount: 2, nodes: [{ login: 'octo' }, { login: 'reviewer' }] },
      reviewRequests: {
        totalCount: 5,
        nodes: [
          { requestedReviewer: { typeName: 'User', login: 'reviewer' } },
          { requestedReviewer: { typeName: 'Bot', login: 'review-bot' } },
          { requestedReviewer: { typeName: 'Mannequin', login: 'former-reviewer' } },
          { requestedReviewer: { typeName: 'Team', name: 'Widget maintainers' } },
          { requestedReviewer: null },
        ],
      },
    };

    const { effects } = makeEffects(pullRequestAnswer(fields));
    const result = await readPullRequestDetail(effects, firstPage('overview'), signal);
    const overview = readOverviewValue(result);

    expect(overview).toMatchObject({
      author: author?.login ?? null,
      base: { refName: 'release/widgets', oid: '1111111111111111111111111111111111111111' },
      head: { refName: 'feature/widget-colors', oid: '2222222222222222222222222222222222222222' },
      labels: { names: ['feature', 'ui'], totalCount: 3 },
      assignees: { logins: ['octo', 'reviewer'], totalCount: 2 },
      reviewRequests: {
        totalCount: 5,
        reviewers: [
          { kind: 'account', typeName: 'User', login: 'reviewer' },
          { kind: 'account', typeName: 'Bot', login: 'review-bot' },
          { kind: 'account', typeName: 'Mannequin', login: 'former-reviewer' },
          { kind: 'team', name: 'Widget maintainers' },
        ],
      },
    });
  }
});

test('normalizes populated Commits with ordered headlines, author fallback, dates and URLs', async () => {
  const commits = [
    {
      oid: '1111111111111111111111111111111111111111',
      messageHeadline: 'Add widgets',
      author: { name: 'Octo Author', user: { login: 'octo' } },
      authoredDate: '2026-01-01T10:00:00Z',
      url: 'https://ghe.example.com/octo/widgets/commit/1111111111111111111111111111111111111111',
    },
    {
      oid: '2222222222222222222222222222222222222222',
      messageHeadline: 'Color widgets',
      author: { name: 'Offline Author', user: null },
      authoredDate: '2026-01-02T11:00:00Z',
      url: 'https://ghe.example.com/octo/widgets/commit/2222222222222222222222222222222222222222',
    },
    {
      oid: '3333333333333333333333333333333333333333',
      messageHeadline: 'Test widgets',
      author: null,
      authoredDate: '2026-01-03T12:00:00Z',
      url: 'https://ghe.example.com/octo/widgets/commit/3333333333333333333333333333333333333333',
    },
    {
      oid: '4444444444444444444444444444444444444444',
      messageHeadline: 'Ship widgets',
      author: { name: null, user: null },
      authoredDate: '2026-01-04T13:00:00Z',
      url: 'https://ghe.example.com/octo/widgets/commit/4444444444444444444444444444444444444444',
    },
  ];

  const fields = {
    commits: {
      totalCount: 4,
      pageInfo: emptyPageInfo,
      nodes: commits.map((commit) => ({ commit })),
    },
  };

  const { effects } = makeEffects(pullRequestAnswer(fields));
  const request = { ...firstPage('commits'), pageSize: 50 };
  const result = await readPullRequestDetail(effects, request, signal);

  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: 'commits',
      commits: {
        totalCount: 4,
        hasNextPage: false,
        endCursor: null,
        records: [
          {
            oid: '1111111111111111111111111111111111111111',
            headline: 'Add widgets',
            author: 'octo',
            authoredDate: '2026-01-01T10:00:00Z',
            url: 'https://ghe.example.com/octo/widgets/commit/1111111111111111111111111111111111111111',
          },
          {
            oid: '2222222222222222222222222222222222222222',
            headline: 'Color widgets',
            author: 'Offline Author',
            authoredDate: '2026-01-02T11:00:00Z',
            url: 'https://ghe.example.com/octo/widgets/commit/2222222222222222222222222222222222222222',
          },
          {
            oid: '3333333333333333333333333333333333333333',
            headline: 'Test widgets',
            author: null,
            authoredDate: '2026-01-03T12:00:00Z',
            url: 'https://ghe.example.com/octo/widgets/commit/3333333333333333333333333333333333333333',
          },
          {
            oid: '4444444444444444444444444444444444444444',
            headline: 'Ship widgets',
            author: null,
            authoredDate: '2026-01-04T13:00:00Z',
            url: 'https://ghe.example.com/octo/widgets/commit/4444444444444444444444444444444444444444',
          },
        ],
      },
    },
  });
});

test('normalizes populated Files with paths, change types, counts and totals', async () => {
  const fields = {
    changedFiles: 2,
    additions: 12,
    deletions: 5,
    files: {
      totalCount: 2,
      pageInfo: emptyPageInfo,
      nodes: [
        { path: 'src/widgets.ts', changeType: 'ADDED', additions: 12, deletions: 0 },
        { path: 'src/old.ts', changeType: 'DELETED', additions: 0, deletions: 5 },
      ],
    },
  };

  const { effects } = makeEffects(pullRequestAnswer(fields));
  const request = { ...firstPage('files'), pageSize: 50 };
  const result = await readPullRequestDetail(effects, request, signal);

  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: 'files',
      totals: { changedFiles: 2, additions: 12, deletions: 5 },
      files: {
        totalCount: 2,
        hasNextPage: false,
        endCursor: null,
        records: [
          { path: 'src/widgets.ts', changeType: 'ADDED', additions: 12, deletions: 0 },
          { path: 'src/old.ts', changeType: 'DELETED', additions: 0, deletions: 5 },
        ],
      },
    },
  });
});

test('returns rollup null for a null statusCheckRollup, with the head OID', async () => {
  const { effects } = makeEffects(pullRequestAnswer(checksFields(null)));

  const result = await readPullRequestDetail(effects, firstPage('checks'), signal);

  expect(result).toEqual({
    ok: true,
    value: {
      kind: 'checks',
      viewer,
      pullRequest: { id: toPullRequestId('PR_1'), headOid: 'head1', baseOid: 'base1' },
      rollup: null,
    },
  });
});

test.each(['overview', 'commits', 'checks', 'files'] as const)(
  'returns the viewer, PR ID, head OID, and base OID for the %s source',
  async (source) => {
    const { effects } = makeEffects(pullRequestAnswer(fieldsBySource[source]));

    const result = await readPullRequestDetail(effects, firstPage(source), signal);

    expect(result.ok).toBe(true);

    expect(result).toMatchObject({
      value: {
        viewer,
        pullRequest: { id: toPullRequestId('PR_1'), headOid: 'head1', baseOid: 'base1' },
      },
    });
  },
);

test('normalizes a CheckRun and a StatusContext with their links', async () => {
  const rollup = {
    state: 'FAILURE',
    commit: { oid: 'head1' },
    contexts: {
      totalCount: 2,
      pageInfo: emptyPageInfo,
      nodes: [checkRunNode, statusContextNode],
    },
  };

  const { effects } = makeEffects(pullRequestAnswer(checksFields(rollup)));

  const result = await readPullRequestDetail(effects, firstPage('checks'), signal);

  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: 'checks',
      rollup: {
        state: 'FAILURE',
        commitOid: 'head1',
        checks: {
          records: [
            {
              kind: 'checkRun',
              name: 'build',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              detailsUrl: 'https://ci.example.com/runs/1',
              url: 'https://github.com/octo/widgets/runs/1',
              databaseId: 1,
            },
            {
              kind: 'statusContext',
              context: 'ci/legacy',
              state: 'FAILURE',
              description: 'Build failed',
              targetUrl: 'https://ci.example.com/legacy',
            },
          ],
          totalCount: 2,
          hasNextPage: false,
          endCursor: null,
        },
      },
    },
  });
});

test('keeps UNKNOWN and null merge values as unknown', async () => {
  const fields = { ...overviewFields, mergeable: 'UNKNOWN', mergeStateStatus: null };
  const { effects } = makeEffects(pullRequestAnswer(fields));

  const overview = readOverviewValue(
    await readPullRequestDetail(effects, firstPage('overview'), signal),
  );

  expect(overview.mergeable).toBe('unknown');
  expect(overview.mergeStateStatus).toBe('unknown');
});

test('keeps a review request from a reviewer type it does not name', async () => {
  const fields = {
    ...overviewFields,
    reviewRequests: {
      totalCount: 2,
      nodes: [
        { requestedReviewer: { typeName: 'Team', name: 'core' } },
        { requestedReviewer: { typeName: 'EnterpriseUserAccount' } },
      ],
    },
  };

  const { effects } = makeEffects(pullRequestAnswer(fields));

  const overview = readOverviewValue(
    await readPullRequestDetail(effects, firstPage('overview'), signal),
  );

  expect(overview.reviewRequests).toEqual({
    reviewers: [
      { kind: 'team', name: 'core' },
      { kind: 'other', typeName: 'EnterpriseUserAccount' },
    ],
    totalCount: 2,
  });
});

test('returns files null for a null files connection', async () => {
  const { effects } = makeEffects(pullRequestAnswer({ ...filesFields, files: null }));

  const result = await readPullRequestDetail(effects, firstPage('files'), signal);

  expect(result).toMatchObject({ ok: true, value: { kind: 'files', files: null } });
});

test('returns a failure for HTTP 200 with GraphQL errors', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({ data: null, errors: [{ message: 'Something went wrong' }] }),
  );

  const result = await readPullRequestDetail(effects, firstPage('commits'), signal);

  expect(result).toEqual({
    ok: false,
    failure: { kind: 'requestFailed', status: 200, message: 'Something went wrong' },
  });
});

test('sends the host, the global ID header, the cursor, and the PR node ID on a later page', async () => {
  const { effects, calls } = makeEffects(pullRequestAnswer(commitsFields));

  const laterPage: PullRequestDetailRequest = {
    coordinates: { subjectId: toPullRequestId('PR_1') },
    source: 'commits',
    after: 'C1',
    pageSize: 1,
  };

  await readPullRequestDetail(effects, laterPage, signal);

  const args = calls[0] ?? [];

  expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', host]);
  expect(args).toContain(globalNodeIdHeader);
  expect(args).toContain('id=PR_1');
  expect(args).toContain('after=C1');
  expect(readQuery(args)).toContain('viewer { id login }');
  expect(readQuery(args)).toContain('node(id: $id)');
});

test('returns unsupported when the later node is not a pull request', async () => {
  const { effects } = makeEffects(() =>
    httpResponse({ data: { viewer: viewerBody, node: { typeName: 'Issue' } } }),
  );

  const laterPage: PullRequestDetailRequest = {
    coordinates: { subjectId: toPullRequestId('PR_1') },
    source: 'commits',
    after: 'C1',
    pageSize: 1,
  };

  const result = await readPullRequestDetail(effects, laterPage, signal);

  expect(result).toEqual({ ok: true, value: { kind: 'unsupported', viewer } });
});
