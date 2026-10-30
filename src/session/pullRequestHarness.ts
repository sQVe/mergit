import type { NotificationThread, PullRequestDetailRead } from '../work/work.ts';
import { toPullRequestId } from '../work/work.ts';
import type { PullRequestEntry } from './session.ts';
import type { Harness } from './sessionHarness.ts';
import { makeHarness, makeThread, octocat, settle, viewerIdOf } from './sessionHarness.ts';

export const pullRequestThread = makeThread('pull-request', {
  subjectType: 'PullRequest',
  subjectUrl: 'https://api.github.com/repos/acme/app/pulls/7',
});

export const pullRequestViewer = { id: viewerIdOf(octocat), login: octocat };

export const pullRequestOverviewOf = (origin: string): PullRequestDetailRead => ({
  kind: 'overview',
  viewer: pullRequestViewer,
  pullRequest: { id: toPullRequestId('PR_7'), headOid: 'a', baseOid: 'base' },
  overview: {
    number: 7,
    url: `${origin}/acme/app/pull/7`,
    title: 'A pull request',
    body: 'Description',
    state: 'open',
    isDraft: false,
    author: 'octocat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastEditedAt: null,
    base: { refName: 'main', oid: 'base' },
    head: { refName: 'feature', oid: 'a' },
    labels: { names: [], totalCount: 0 },
    assignees: { logins: [], totalCount: 0 },
    reviewRequests: { reviewers: [], totalCount: 0 },
    reviewDecision: null,
    mergeable: 'unknown',
    mergeStateStatus: 'unknown',
    checksUrl: `${origin}/acme/app/pull/7/checks`,
    digest: 'overview',
  },
});

export const pullRequestFilesOf = (
  baseOid: string,
  hasNextPage = false,
): Extract<PullRequestDetailRead, { kind: 'files' }> => ({
  kind: 'files',
  viewer: pullRequestViewer,
  pullRequest: { id: toPullRequestId('PR_7'), headOid: 'a', baseOid },
  totals: { changedFiles: 2, additions: 2, deletions: 0 },
  files: {
    records: [{ path: baseOid, changeType: 'MODIFIED', additions: 1, deletions: 0 }],
    totalCount: 2,
    hasNextPage,
    endCursor: hasNextPage ? 'next' : null,
  },
});

export const pullRequestEntryOf = (harness: Harness): PullRequestEntry | undefined => {
  const { detail } = harness.session.getSnapshot();
  const entry = detail.activeKey === null ? undefined : detail.entries.get(detail.activeKey);

  return entry?.kind === 'pullRequest' ? entry : undefined;
};

export const answerPullRequest = async (
  harness: Harness,
  index: number,
  value: PullRequestDetailRead,
): Promise<void> => {
  harness.pullRequestDetails[index]?.resolve({ ok: true, value });
  await settle();
};

export const switchPullRequestTab = async (harness: Harness, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    harness.session.send({ kind: 'switchDetailTab', direction: 1 });
    // oxlint-disable-next-line no-await-in-loop -- each tab visit must settle before the next load starts
    await settle();
  }
};

export const visitPullRequestFiles = async (harness: Harness): Promise<void> => {
  harness.session.send({ kind: 'switchDetailTab', direction: -1 });
  await settle();
};

export const showPullRequestOverview = async (
  harness: Harness,
  thread: NotificationThread,
  value: PullRequestDetailRead,
): Promise<void> => {
  await harness.load(thread);
  harness.session.send({ kind: 'showDetail', thread });
  await settle();

  await answerPullRequest(harness, 0, value);
};

export const makePullRequestHarness = async (): Promise<Harness> => {
  const harness = makeHarness();
  const overview = pullRequestOverviewOf('https://github.com');

  await showPullRequestOverview(harness, pullRequestThread, overview);

  return harness;
};
