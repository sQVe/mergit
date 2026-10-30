import { expect, test } from 'bun:test';

import type { PullRequestDetailRead } from '../work/work.ts';
import { toPullRequestId } from '../work/work.ts';
import {
  answerPullRequest as answer,
  makePullRequestHarness as showPullRequest,
  pullRequestEntryOf as entryOf,
  pullRequestFilesOf as files,
  pullRequestOverviewOf,
  pullRequestThread as thread,
  pullRequestViewer,
  switchPullRequestTab as switchTab,
  visitPullRequestFiles as visitFiles,
} from './pullRequestHarness.ts';
import { makeHarness, settle } from './sessionHarness.ts';

const overview = (): PullRequestDetailRead => pullRequestOverviewOf('https://github.com');

const checks = (
  headOid: string,
  hasNextPage = false,
): Extract<PullRequestDetailRead, { kind: 'checks' }> => ({
  kind: 'checks',
  viewer: pullRequestViewer,
  pullRequest: { id: toPullRequestId('PR_7'), headOid, baseOid: 'base' },
  rollup: {
    state: 'SUCCESS',
    commitOid: headOid,
    checks: {
      records: [
        {
          kind: 'statusContext',
          context: headOid,
          state: 'SUCCESS',
          description: null,
          targetUrl: null,
        },
      ],
      totalCount: 2,
      hasNextPage,
      endCursor: hasNextPage ? 'next' : null,
    },
  },
});

test('Checks restarts after a head change without mixing heads', async () => {
  const harness = makeHarness();

  await harness.load(thread);
  harness.session.send({ kind: 'showDetail', thread });
  await settle();
  await answer(harness, 0, overview());
  await switchTab(harness, 2);

  const firstChecks = harness.pullRequestDetails.findIndex(
    (call) => call.request.source === 'checks',
  );

  expect(firstChecks).toBeGreaterThan(0);
  await answer(harness, firstChecks, checks('a', true));
  await answer(harness, firstChecks + 1, checks('b', true));

  expect(harness.pullRequestDetails.at(-1)?.request).toMatchObject({
    source: 'checks',
    after: null,
  });

  expect(entryOf(harness)).toMatchObject({
    headOid: 'b',
    sources: { checks: { records: [], coverage: 'loading' } },
  });

  await answer(harness, firstChecks + 2, checks('b'));

  expect(entryOf(harness)).toMatchObject({
    kind: 'pullRequest',
    sources: { checks: { coverage: 'loaded', records: [{ context: 'b' }] } },
  });
});

test('Files restarts after a base change without mixing bases', async () => {
  const harness = await showPullRequest();

  await visitFiles(harness);
  await answer(harness, 1, files('base', true));
  await answer(harness, 2, files('new-base', true));

  expect(entryOf(harness)).toMatchObject({
    baseOid: 'new-base',
    sources: { files: { records: [], coverage: 'loading' } },
  });

  expect(harness.pullRequestDetails[3]?.request).toMatchObject({ source: 'files', after: null });
  await answer(harness, 3, files('new-base'));

  expect(entryOf(harness)).toMatchObject({
    sources: { files: { coverage: 'loaded', records: [{ path: 'new-base' }] } },
  });
});

test('showing a pull request loads only Overview and visiting Files loads only Files', async () => {
  const harness = await showPullRequest();

  expect(harness.pullRequestDetails.map((call) => call.request.source)).toEqual(['overview']);

  expect(entryOf(harness)).toMatchObject({
    host: 'github.com',
    sources: {
      overview: { coverage: 'loaded', record: { title: 'A pull request' } },
      files: { coverage: 'notRequested' },
      commits: { coverage: 'notRequested' },
      checks: { coverage: 'notRequested' },
    },
  });

  await visitFiles(harness);

  expect(harness.pullRequestDetails.map((call) => call.request.source)).toEqual([
    'overview',
    'files',
  ]);

  await answer(harness, 1, files('base'));

  expect(entryOf(harness)).toMatchObject({
    tab: 'files',
    sources: { files: { coverage: 'loaded' } },
  });
});

test('a failed Files read leaves Overview loaded and keeps the failure message', async () => {
  const harness = await showPullRequest();

  await visitFiles(harness);

  harness.pullRequestDetails[1]?.resolve({
    ok: false,
    failure: {
      kind: 'requestFailed',
      status: null,
      message: 'Files could not be read',
    },
  });

  await settle();

  expect(entryOf(harness)).toMatchObject({
    sources: {
      overview: { coverage: 'loaded', record: { body: 'Description' } },
      files: { coverage: 'failed', message: 'Files could not be read', records: [] },
    },
  });
});

test('a null rollup loads Checks with no rows', async () => {
  const harness = await showPullRequest();

  await switchTab(harness, 2);
  const read = checks('a');

  await answer(harness, 2, { ...read, rollup: null });

  expect(entryOf(harness)).toMatchObject({
    sources: { checks: { coverage: 'loaded', records: [], state: null, totalCount: 0 } },
  });
});

test('a second revision change stops with partial coverage and no mixed rows', async () => {
  const harness = await showPullRequest();

  await visitFiles(harness);
  await answer(harness, 1, files('a', true));
  await answer(harness, 2, files('b', true));
  await answer(harness, 3, files('b', true));
  await answer(harness, 4, files('c', true));
  expect(harness.pullRequestDetails).toHaveLength(5);

  expect(entryOf(harness)).toMatchObject({
    sources: {
      files: {
        coverage: 'partial',
        records: [],
        message: 'The pull request changed while loading',
      },
    },
  });
});

test('a complete Files page over the record budget keeps 500 rows with partial coverage', async () => {
  const harness = await showPullRequest();
  const read = files('base');

  const records = Array.from({ length: 501 }, (_, index) => ({
    path: `file-${index}`,
    changeType: 'MODIFIED',
    additions: 1,
    deletions: 0,
  }));

  await visitFiles(harness);

  await answer(harness, 1, {
    ...read,
    files: { records, hasNextPage: false, endCursor: null, totalCount: 501 },
  });

  const entry = entryOf(harness);

  const recordsCount = entry?.sources.files.records.length ?? 0;

  expect(recordsCount).toBe(500);
  expect(entry).toMatchObject({ sources: { files: { coverage: 'partial' } } });
});

test('a failed source is retried on its next visit without reloading Overview', async () => {
  const harness = await showPullRequest();

  await visitFiles(harness);
  harness.pullRequestDetails[1]?.resolve({ ok: false, failure: { kind: 'ghMissing' } });
  await settle();
  await switchTab(harness, 1);
  expect(harness.pullRequestDetails).toHaveLength(2);
  await visitFiles(harness);
  expect(harness.pullRequestDetails[2]?.request.source).toBe('files');
  await answer(harness, 2, files('base'));

  expect(entryOf(harness)).toMatchObject({
    sources: { files: { coverage: 'loaded', message: null } },
  });
});

test('a second page with another pull request ID restarts from the first page', async () => {
  const harness = await showPullRequest();

  const changed = {
    ...files('base', true),
    pullRequest: { id: toPullRequestId('PR_other'), headOid: 'a', baseOid: 'base' },
  };

  await visitFiles(harness);
  await answer(harness, 1, files('base', true));
  await answer(harness, 2, changed);

  expect(entryOf(harness)).toMatchObject({
    subjectId: toPullRequestId('PR_other'),
    sources: { files: { records: [] } },
  });

  expect(harness.pullRequestDetails[3]?.request).toMatchObject({ source: 'files', after: null });
});

test('Commits loads pages in order and records the revision it loaded', async () => {
  const harness = await showPullRequest();

  const commit = {
    oid: 'first',
    headline: 'First commit',
    author: 'octocat',
    authoredDate: '2026-01-01T00:00:00Z',
    url: 'https://github.com/acme/app/commit/first',
  };

  const read: PullRequestDetailRead = {
    kind: 'commits',
    viewer: pullRequestViewer,
    pullRequest: { id: toPullRequestId('PR_7'), headOid: 'a', baseOid: 'base' },
    commits: { records: [commit], totalCount: 2, hasNextPage: true, endCursor: 'next' },
  };

  await switchTab(harness, 1);
  await answer(harness, 1, read);

  expect(harness.pullRequestDetails[2]?.request).toMatchObject({
    source: 'commits',
    after: 'next',
    coordinates: { subjectId: toPullRequestId('PR_7') },
  });

  await answer(harness, 2, {
    ...read,
    commits: {
      records: [{ ...commit, oid: 'second' }],
      totalCount: 2,
      hasNextPage: false,
      endCursor: null,
    },
  });

  expect(entryOf(harness)?.sources.commits).toMatchObject({
    coverage: 'loaded',
    headOid: 'a',
    baseOid: 'base',
    fetchedAt: harness.now(),
    records: [{ oid: 'first' }, { oid: 'second' }],
  });
});

test('Files stops at eight requests with partial coverage', async () => {
  const harness = await showPullRequest();

  await visitFiles(harness);

  for (let index = 1; index <= 8; index += 1) {
    await answer(harness, index, files('base', true));
  }

  expect(harness.pullRequestDetails).toHaveLength(9);
  expect(entryOf(harness)).toMatchObject({ sources: { files: { coverage: 'partial' } } });
});
