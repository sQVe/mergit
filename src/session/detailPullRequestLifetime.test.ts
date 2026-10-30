import { expect, test } from 'bun:test';

import type { PullRequestDetailRead } from '../work/work.ts';
import { toViewerLogin } from '../work/work.ts';
import {
  answerPullRequest as answer,
  makePullRequestHarness as showPullRequest,
  pullRequestEntryOf as entryOf,
  pullRequestFilesOf as files,
  pullRequestOverviewOf,
  pullRequestThread as thread,
  switchPullRequestTab as switchTab,
  visitPullRequestFiles as visitFiles,
} from './pullRequestHarness.ts';
import { makeHarness, makeThread, settle, viewerIdOf } from './sessionHarness.ts';

const overview = (): PullRequestDetailRead => pullRequestOverviewOf('https://github.com');

test('a viewer mismatch clears every cached subject and all pull request content', async () => {
  const harness = await showPullRequest();

  harness.session.send({
    kind: 'showDetail',
    thread: makeThread('release', { subjectType: 'Release' }),
  });

  harness.session.send({ kind: 'showDetail', thread });
  expect(harness.session.getSnapshot().detail.entries.size).toBe(2);
  await visitFiles(harness);
  const login = toViewerLogin('hubot');
  const read = { ...files('base'), viewer: { id: viewerIdOf(login), login } };

  await answer(harness, 1, read);
  expect(harness.session.getSnapshot().detail.mismatch).toEqual({ login });
  expect(harness.session.getSnapshot().detail.entries.size).toBe(1);

  expect(entryOf(harness)).toMatchObject({
    anchors: {},
    fetchedAt: null,
    sources: {
      overview: { record: null, coverage: 'notRequested' },
      files: { records: [], coverage: 'notRequested' },
    },
  });
});

test('a late pull request result never publishes after leaving its subject', async () => {
  const harness = await showPullRequest();

  await visitFiles(harness);

  const other = makeThread('other', {
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/acme/app/issues/8',
  });

  harness.session.send({ kind: 'showDetail', thread: other });
  await settle();
  const before = harness.session.getSnapshot();

  await answer(harness, 1, files('base'));
  expect(harness.session.getSnapshot()).toBe(before);
  expect(harness.pullRequestDetails[1]?.signal.aborted).toBe(true);
});

for (const minutes of [0, 6]) {
  test(`feed completion revalidates only stale active Files after ${minutes} minutes`, async () => {
    const harness = await showPullRequest();

    await visitFiles(harness);
    await answer(harness, 1, files('base'));
    const overviewBefore = entryOf(harness)?.sources.overview;

    harness.advance(minutes * 60_000);
    await harness.loadWith('same-notifications', [thread]);
    expect(entryOf(harness)?.sources.overview).toBe(overviewBefore);
    expect(entryOf(harness)?.sources.commits.coverage).toBe('notRequested');
    expect(entryOf(harness)?.sources.checks.coverage).toBe('notRequested');

    if (minutes > 5) {
      expect(harness.pullRequestDetails).toHaveLength(3);
      expect(harness.pullRequestDetails[2]?.request.source).toBe('files');
      const updated = files('base');

      await answer(harness, 2, {
        ...updated,
        files: {
          records: [{ path: 'updated-file', additions: 1, deletions: 0, changeType: 'ADDED' }],
          totalCount: 1,
          hasNextPage: false,
          endCursor: null,
        },
      });

      expect(entryOf(harness)?.sources.files.records[0]?.path).toBe('updated-file');
    } else {
      expect(harness.pullRequestDetails).toHaveLength(2);
      expect(entryOf(harness)?.sources.files.records[0]?.path).toBe('base');
    }
  });
}

test('sources with older revisions reload only on their next visit', async () => {
  const harness = await showPullRequest();
  const firstFetch = harness.now();

  harness.advance(1000);
  await visitFiles(harness);
  await answer(harness, 1, files('new-base'));
  expect(harness.pullRequestDetails).toHaveLength(2);

  expect(entryOf(harness)).toMatchObject({
    fetchedAt: harness.now(),
    sources: {
      overview: { fetchedAt: firstFetch, baseOid: 'base', coverage: 'loaded' },
      files: { fetchedAt: harness.now(), baseOid: 'new-base', coverage: 'loaded' },
    },
  });

  await switchTab(harness, 1);
  expect(harness.pullRequestDetails[2]?.request.source).toBe('overview');
});

test('a cached source keeps its own freshness when another source is fetched', async () => {
  const harness = await showPullRequest();

  harness.advance(6 * 60_000);
  await visitFiles(harness);
  await answer(harness, 1, files('base'));
  await switchTab(harness, 1);
  expect(harness.pullRequestDetails[2]?.request.source).toBe('overview');
});

test('returning to a cached tab aborts the previous tab and drops its late result', async () => {
  const harness = await showPullRequest();

  await visitFiles(harness);
  await switchTab(harness, 1);
  const before = harness.session.getSnapshot();

  await answer(harness, 1, files('new-base'));
  expect(harness.session.getSnapshot()).toBe(before);
  expect(harness.pullRequestDetails[1]?.signal.aborted).toBe(true);
});

test('pull requests and issues share the two-process queue', async () => {
  const harness = await showPullRequest();

  const issue = makeThread('issue', {
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/acme/app/issues/8',
  });

  await visitFiles(harness);
  harness.session.send({ kind: 'showDetail', thread: issue });
  await settle();
  harness.session.send({ kind: 'showDetail', thread });
  await settle();
  expect(harness.pullRequestDetails).toHaveLength(2);
  expect(harness.details).toHaveLength(1);

  await answer(harness, 1, files('base'));
  expect(harness.pullRequestDetails).toHaveLength(3);

  expect(entryOf(harness)).toMatchObject({
    sources: { files: { records: [], coverage: 'loading' } },
  });

  await answer(harness, 2, files('base'));

  expect(entryOf(harness)).toMatchObject({
    sources: { files: { records: [{ path: 'base' }], coverage: 'loaded' } },
  });
});

test('a pull request waits for the feed viewer before reading', async () => {
  const harness = makeHarness();

  harness.session.send({ kind: 'showDetail', thread });
  await settle();
  expect(harness.pullRequestDetails).toHaveLength(0);
  await harness.load(thread);
  expect(harness.pullRequestDetails).toHaveLength(1);
  await answer(harness, 0, overview());
  expect(entryOf(harness)).toMatchObject({ sources: { overview: { coverage: 'loaded' } } });
});

test('a pull request rate limit pauses other tabs before they start', async () => {
  const harness = await showPullRequest();
  const resetAt = new Date(harness.now().getTime() + 60_000);

  await visitFiles(harness);
  harness.pullRequestDetails[1]?.resolve({ ok: false, failure: { kind: 'rateLimited', resetAt } });
  await settle();
  await switchTab(harness, 2);
  expect(harness.pullRequestDetails).toHaveLength(2);
  expect(harness.session.getSnapshot().pausedUntil).toEqual(resetAt);

  expect(entryOf(harness)).toMatchObject({
    tab: 'commits',
    sources: { commits: { coverage: 'notRequested' } },
  });
});

test('loaded pull request tabs and their anchors survive visits to another subject', async () => {
  const harness = await showPullRequest();

  const anchor = {
    recordId: 'base',
    digest: 'base',
    position: { kind: 'heading' as const },
    earlierRecordIds: [],
  };

  await visitFiles(harness);
  await answer(harness, 1, files('base'));
  harness.session.send({ kind: 'setDetailAnchor', tab: 'files', anchor });

  harness.session.send({
    kind: 'showDetail',
    thread: makeThread('release', { subjectType: 'Release' }),
  });

  harness.session.send({ kind: 'showDetail', thread });
  await settle();
  expect(entryOf(harness)).toMatchObject({ tab: 'files', anchors: { files: anchor } });
  expect(harness.pullRequestDetails).toHaveLength(2);
});

test('pull request rows count toward the cache byte budget', async () => {
  const harness = await showPullRequest();
  const firstKey = harness.session.getSnapshot().detail.activeKey;
  const largePath = 'x'.repeat(17 * 1024 * 1024);
  const read = files('base');

  const largePage = {
    ...read,
    files: {
      records: [{ path: largePath, changeType: 'ADDED', additions: 1, deletions: 0 }],
      totalCount: 1,
      hasNextPage: false,
      endCursor: null,
    },
  };

  await visitFiles(harness);
  await answer(harness, 1, largePage);
  const other = { ...thread, id: makeThread('other-pr').id };

  harness.session.send({ kind: 'showDetail', thread: other });
  await settle();
  await answer(harness, 2, overview());
  await visitFiles(harness);
  await answer(harness, 3, largePage);
  const { detail } = harness.session.getSnapshot();

  expect(detail.entries.size).toBe(1);
  expect(detail.activeKey).not.toBe(firstKey);
  expect(entryOf(harness)).toMatchObject({ sources: { files: { coverage: 'loaded' } } });
});
