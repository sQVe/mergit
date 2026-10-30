import { expect, test } from 'bun:test';

import type {
  PullRequestCheck,
  PullRequestCommit,
  PullRequestDetailRead,
  PullRequestFile,
} from '../work/work.ts';
import { toPullRequestId } from '../work/work.ts';
import {
  answerPullRequest,
  makePullRequestHarness,
  pullRequestEntryOf,
  pullRequestThread,
  pullRequestViewer,
} from './pullRequestHarness.ts';
import type { Harness } from './sessionHarness.ts';
import { settle } from './sessionHarness.ts';

type RowSource = 'files' | 'commits' | 'checks';
type RowsRead = Extract<PullRequestDetailRead, { kind: RowSource }>;

const recordKey = (record: PullRequestCheck | PullRequestCommit | PullRequestFile): string => {
  if ('path' in record) {
    return record.path;
  }

  if ('oid' in record) {
    return record.oid;
  }

  return record.kind === 'statusContext' ? record.context : record.name;
};

const sourcePage = (
  source: RowSource,
  keys: string[],
  hasNextPage: boolean,
  headOid = 'a',
): RowsRead => {
  const pullRequest = { id: toPullRequestId('PR_7'), headOid, baseOid: 'base' };
  const page = { totalCount: 51, hasNextPage, endCursor: hasNextPage ? 'next' : null };

  if (source === 'files') {
    return {
      kind: source,
      viewer: pullRequestViewer,
      pullRequest,
      totals: { changedFiles: 51, additions: 51, deletions: 0 },
      files: {
        ...page,
        records: keys.map((path) => ({ path, changeType: 'MODIFIED', additions: 1, deletions: 0 })),
      },
    };
  }

  if (source === 'commits') {
    return {
      kind: source,
      viewer: pullRequestViewer,
      pullRequest,
      commits: {
        ...page,
        records: keys.map((oid) => ({
          oid,
          headline: oid,
          author: 'octocat',
          authoredDate: '2026-01-01T00:00:00Z',
          url: `https://github.com/acme/app/commit/${oid}`,
        })),
      },
    };
  }

  return {
    kind: source,
    viewer: pullRequestViewer,
    pullRequest,
    rollup: {
      state: 'SUCCESS',
      commitOid: headOid,
      checks: {
        ...page,
        records: keys.map((context) => ({
          kind: 'statusContext',
          context,
          state: 'SUCCESS',
          description: null,
          targetUrl: null,
        })),
      },
    },
  };
};

const visitSource = async (harness: Harness, source: RowSource) => {
  while (pullRequestEntryOf(harness)?.tab !== source) {
    harness.session.send({ kind: 'switchDetailTab', direction: 1 });
    await settle();
    const request = harness.pullRequestDetails.at(-1);

    if (request?.request.source !== source) {
      request?.resolve({ ok: true, value: { kind: 'unavailable', viewer: pullRequestViewer } });
      await settle();
    }
  }
};

const answerLatest = async (harness: Harness, value: PullRequestDetailRead) => {
  await answerPullRequest(harness, harness.pullRequestDetails.length - 1, value);
};

const cachedSource = async (source: RowSource) => {
  const harness = await makePullRequestHarness();
  const keys = Array.from({ length: 50 }, (_, index) => `row-${index}`);

  await visitSource(harness, source);
  await answerLatest(harness, sourcePage(source, keys, true));
  await answerLatest(harness, sourcePage(source, ['cached-tail'], false));

  return { harness, keys };
};

const startRefresh = async (harness: Harness) => {
  harness.session.send({ kind: 'refreshDetail', thread: pullRequestThread });
  await settle();
};

const failLatest = async (harness: Harness) => {
  harness.pullRequestDetails.at(-1)?.resolve({
    ok: false,
    failure: { kind: 'requestFailed', status: 502, message: 'Bad gateway' },
  });

  await settle();
};

for (const source of ['files', 'commits', 'checks'] as const) {
  for (const acceptedFirstPage of [false, true]) {
    test(`${source} retains its same-revision cached tail after refresh failure with first page accepted ${acceptedFirstPage}`, async () => {
      const { harness, keys } = await cachedSource(source);

      await startRefresh(harness);

      if (acceptedFirstPage) {
        await answerLatest(harness, sourcePage(source, keys, true));
      }

      await failLatest(harness);
      const state = pullRequestEntryOf(harness)?.sources[source];

      expect(state?.coverage).toBe('partial');
      expect(state?.message).toBe('Bad gateway');
      expect(state?.records.map(recordKey)).toEqual([...keys, 'cached-tail']);
    });
  }

  test(`${source} keeps refreshed row values ahead of same-revision cached values`, async () => {
    const { harness } = await cachedSource(source);
    const page = sourcePage(source, ['row-0'], true);

    if (page.kind === 'files' && page.files !== null) {
      page.files.records = page.files.records.map((record) => ({ ...record, additions: 9 }));
    }

    if (page.kind === 'commits') {
      page.commits.records = page.commits.records.map((record) => ({
        ...record,
        headline: 'Updated',
      }));
    }

    if (page.kind === 'checks' && page.rollup !== null) {
      page.rollup.checks.records = page.rollup.checks.records.map((record) => ({
        ...record,
        state: 'FAILURE',
      }));
    }

    await startRefresh(harness);
    await answerLatest(harness, page);
    await failLatest(harness);
    const state = pullRequestEntryOf(harness)?.sources[source];

    const changed = {
      files: { additions: 9 },
      commits: { headline: 'Updated' },
      checks: { state: 'FAILURE' },
    };

    expect(state?.records).toHaveLength(51);
    expect(state?.records[0]).toMatchObject(changed[source]);
    expect(state?.records.map(recordKey)).toContain('cached-tail');
  });

  test(`${source} removes obsolete cached rows when replacement completes`, async () => {
    const { harness } = await cachedSource(source);

    await startRefresh(harness);
    await answerLatest(harness, sourcePage(source, ['replacement-first'], true));
    await answerLatest(harness, sourcePage(source, ['replacement-last'], false));
    const state = pullRequestEntryOf(harness)?.sources[source];

    expect(state?.coverage).toBe('loaded');
    expect(state?.records.map(recordKey)).toEqual(['replacement-first', 'replacement-last']);
  });

  for (const changed of ['base', 'subject'] as const) {
    test(`${source} drops cached rows when the first refresh page changes ${changed}`, async () => {
      const { harness } = await cachedSource(source);
      const page = sourcePage(source, ['different-revision'], true);

      page.pullRequest =
        changed === 'base'
          ? { ...page.pullRequest, baseOid: 'new-base' }
          : { ...page.pullRequest, id: toPullRequestId('PR_other') };

      await startRefresh(harness);
      await answerLatest(harness, page);
      await failLatest(harness);

      expect(pullRequestEntryOf(harness)?.sources[source].records.map(recordKey)).toEqual([
        'different-revision',
      ]);
    });
  }

  test(`${source} never retains cached rows from another revision after refresh failure`, async () => {
    const { harness } = await cachedSource(source);

    await startRefresh(harness);
    await answerLatest(harness, sourcePage(source, ['new-head-row'], true, 'b'));
    await failLatest(harness);
    const state = pullRequestEntryOf(harness)?.sources[source];

    expect(state?.headOid).toBe('b');
    expect(state?.coverage).toBe('partial');
    expect(state?.records.map(recordKey)).toEqual(['new-head-row']);
  });
}

test('cached Files rows do not consume the replacement traversal record budget', async () => {
  const { harness } = await cachedSource('files');
  const keys = Array.from({ length: 500 }, (_, index) => `cached-${index}`);

  await startRefresh(harness);
  await answerLatest(harness, sourcePage('files', keys, false));
  await startRefresh(harness);
  const firstRequest = harness.pullRequestDetails.length;

  await answerLatest(harness, sourcePage('files', ['new-first'], true));
  expect(harness.pullRequestDetails).toHaveLength(firstRequest + 1);
  expect(pullRequestEntryOf(harness)?.sources.files.records).toHaveLength(500);
  await answerLatest(harness, sourcePage('files', ['new-last'], false));

  expect(pullRequestEntryOf(harness)?.sources.files.records.map(recordKey)).toEqual([
    'new-first',
    'new-last',
  ]);
});
