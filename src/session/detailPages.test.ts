import { expect, test } from 'bun:test';

import type { PullRequestCheck, PullRequestDetailRead } from '../work/work.ts';
import { toPullRequestId } from '../work/work.ts';
import { pullRequestPagesOf } from './detailPages.ts';
import { checkRecordId } from './detailPullRequestRecords.ts';
import type { PullRequestTab } from './detailTransitions.ts';
import {
  pullRequestOverviewOf,
  pullRequestThread as thread,
  switchPullRequestTab,
  pullRequestViewer,
  showPullRequestOverview,
} from './pullRequestHarness.ts';
import { activePullRequestEntry } from './session.ts';
import type { Harness } from './sessionHarness.ts';
import { makeHarness, settle } from './sessionHarness.ts';

const host = 'ghe.example.com';

const pullRequest = { id: toPullRequestId('PR_7'), headOid: 'a', baseOid: 'base' };

const page = <Record>(records: Record[]) => ({
  records,
  totalCount: records.length,
  hasNextPage: false,
  endCursor: null,
});

const overview = (): PullRequestDetailRead => pullRequestOverviewOf('https://ghe.example.com');

const commits = (): PullRequestDetailRead => ({
  kind: 'commits',
  viewer: pullRequestViewer,
  pullRequest,
  commits: page([
    {
      oid: 'c0ffee',
      headline: 'First',
      author: 'octocat',
      authoredDate: '2026-01-01T00:00:00Z',
      url: 'https://ghe.example.com/acme/app/commit/c0ffee',
    },
  ]),
});

const files = (): PullRequestDetailRead => ({
  kind: 'files',
  viewer: pullRequestViewer,
  pullRequest,
  totals: { changedFiles: 1, additions: 1, deletions: 0 },
  files: page([{ path: 'src/a.ts', changeType: 'MODIFIED', additions: 1, deletions: 0 }]),
});

const jobRun = (detailsUrl: string | null, url: string): PullRequestCheck => ({
  kind: 'checkRun',
  name: 'test',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  detailsUrl,
  url,
  databaseId: 1,
});

const checks = (...records: PullRequestCheck[]): PullRequestDetailRead => ({
  kind: 'checks',
  viewer: pullRequestViewer,
  pullRequest,
  rollup: { state: 'SUCCESS', commitOid: 'a', checks: page(records) },
});

const jobUrl = 'https://ghe.example.com/acme/app/actions/runs/9/job/555';

const answerLoad = async (
  harness: Harness,
  source: PullRequestTab,
  value: PullRequestDetailRead,
) => {
  const call = harness.pullRequestDetails.findLast(
    (candidate) => candidate.request.source === source,
  );

  call?.resolve({ ok: true, value });
  await settle();
};

const showPullRequestOn = async (tab: PullRequestTab, value: PullRequestDetailRead) => {
  const harness = makeHarness({ host });

  await showPullRequestOverview(harness, thread, overview());

  const tabs: PullRequestTab[] = ['overview', 'commits', 'checks', 'files'];

  const tabIndex = tabs.indexOf(tab);

  await switchPullRequestTab(harness, tabIndex);

  if (tab !== 'overview') {
    await answerLoad(harness, tab, value);
  }

  return harness;
};

const openedBy = async (harness: Harness) => {
  const entry = activePullRequestEntry(harness.session.getSnapshot());

  harness.session.send({
    kind: 'openInBrowser',
    pages: entry === null ? [] : pullRequestPagesOf(thread, entry),
  });

  await settle();

  return harness.opens;
};

const anchorOn = (harness: Harness, tab: PullRequestTab, recordId: string) => {
  harness.session.send({
    kind: 'setDetailAnchor',
    tab,
    anchor: { recordId, digest: recordId, position: { kind: 'heading' }, earlierRecordIds: [] },
  });
};

test('Files opens the PR files page on the session host', async () => {
  const harness = await showPullRequestOn('files', files());

  expect(activePullRequestEntry(harness.session.getSnapshot())?.host).toBe(host);

  expect(await openedBy(harness)).toEqual([
    { kind: 'pullRequestFiles', repository: 'acme/app', number: 7 },
  ]);
});

test('Overview opens the PR item page', async () => {
  const harness = await showPullRequestOn('overview', overview());

  expect(await openedBy(harness)).toEqual([{ kind: 'item', repository: 'acme/app', number: 7 }]);
});

test('Commits opens the anchored commit that is loaded', async () => {
  const harness = await showPullRequestOn('commits', commits());

  anchorOn(harness, 'commits', 'c0ffee');

  expect(await openedBy(harness)).toEqual([
    { kind: 'commit', repository: 'acme/app', sha: 'c0ffee' },
  ]);
});

test('Commits opens the PR item page with no anchor', async () => {
  const harness = await showPullRequestOn('commits', commits());

  expect(await openedBy(harness)).toEqual([{ kind: 'item', repository: 'acme/app', number: 7 }]);
});

test('Commits opens the PR item page when the anchored commit is gone', async () => {
  const harness = await showPullRequestOn('commits', commits());

  anchorOn(harness, 'commits', 'gone');

  expect(await openedBy(harness)).toEqual([{ kind: 'item', repository: 'acme/app', number: 7 }]);
});

test('Checks opens the anchored Actions job on the session host as checkJob', async () => {
  const run = jobRun(jobUrl, 'https://ghe.example.com/acme/app/actions/runs/9');
  const harness = await showPullRequestOn('checks', checks(run));

  anchorOn(harness, 'checks', checkRecordId(run));

  expect(await openedBy(harness)).toEqual([
    { kind: 'checkJob', repository: 'acme/app', jobId: '555' },
  ]);
});

test('Checks opens the job from url when detailsUrl does not qualify', async () => {
  const run = jobRun('https://ghe.example.com/acme/app/pull/7/checks', jobUrl);
  const harness = await showPullRequestOn('checks', checks(run));

  anchorOn(harness, 'checks', checkRecordId(run));

  expect(await openedBy(harness)).toEqual([
    { kind: 'checkJob', repository: 'acme/app', jobId: '555' },
  ]);
});

test('Checks opens the PR checks page for a check on another host', async () => {
  const otherHostUrl = 'https://github.com/acme/app/actions/runs/9/job/555';
  const run = jobRun(otherHostUrl, otherHostUrl);
  const harness = await showPullRequestOn('checks', checks(run));

  anchorOn(harness, 'checks', checkRecordId(run));

  expect(await openedBy(harness)).toEqual([
    { kind: 'pullRequestChecks', repository: 'acme/app', number: 7 },
  ]);
});

test('Checks opens the PR checks page for an anchored status context', async () => {
  const status: PullRequestCheck = {
    kind: 'statusContext',
    context: 'ci/lint',
    state: 'SUCCESS',
    description: null,
    targetUrl: jobUrl,
  };

  const harness = await showPullRequestOn('checks', checks(status));

  anchorOn(harness, 'checks', checkRecordId(status));

  expect(await openedBy(harness)).toEqual([
    { kind: 'pullRequestChecks', repository: 'acme/app', number: 7 },
  ]);
});

test('Checks opens the PR checks page with no anchor', async () => {
  const harness = await showPullRequestOn('checks', checks(jobRun(jobUrl, jobUrl)));

  expect(await openedBy(harness)).toEqual([
    { kind: 'pullRequestChecks', repository: 'acme/app', number: 7 },
  ]);
});
