import { expect, test } from 'bun:test';

import type { ReaderContext } from '../src/commands.ts';
import { catalog } from '../src/commands.ts';
import { invariant } from '../src/invariant.ts';
import { visibleRows } from '../src/session/session.ts';
import type { Harness } from '../src/session/sessionHarness.ts';
import {
  makeHarness,
  makeThread,
  octocat,
  settle,
  viewerIdOf,
} from '../src/session/sessionHarness.ts';
import type { PullRequestDetailRead, ThreadRow } from '../src/work/work.ts';
import { toPullRequestId } from '../src/work/work.ts';

const thread = makeThread('pull-request', {
  subjectType: 'PullRequest',
  subjectUrl: 'https://api.github.com/repos/acme/app/pulls/7',
});

const viewer = { id: viewerIdOf(octocat), login: octocat };

const overview = (): PullRequestDetailRead => ({
  kind: 'overview',
  viewer,
  pullRequest: { id: toPullRequestId('PR_7'), headOid: 'a', baseOid: 'base' },
  overview: {
    number: 7,
    url: 'https://ghe.example.com/acme/app/pull/7',
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
    checksUrl: 'https://ghe.example.com/acme/app/pull/7/checks',
    digest: 'overview',
  },
});

const files = (): PullRequestDetailRead => ({
  kind: 'files',
  viewer,
  pullRequest: { id: toPullRequestId('PR_7'), headOid: 'a', baseOid: 'base' },
  totals: { changedFiles: 1, additions: 1, deletions: 0 },
  files: {
    records: [{ path: 'src/a.ts', changeType: 'MODIFIED', additions: 1, deletions: 0 }],
    totalCount: 1,
    hasNextPage: false,
    endCursor: null,
  },
});

const answerLoad = async (
  harness: Harness,
  source: 'overview' | 'files',
  value: PullRequestDetailRead,
) => {
  const call = harness.pullRequestDetails.findLast(
    (candidate) => candidate.request.source === source,
  );

  call?.resolve({ ok: true, value });
  await settle();
};

test('Open on the Files tab of a PR on ghe.example.com opens its files page', async () => {
  const harness = makeHarness({ host: 'ghe.example.com' });

  await harness.load(thread);
  harness.session.send({ kind: 'showDetail', thread });
  await settle();
  await answerLoad(harness, 'overview', overview());

  for (let step = 0; step < 3; step += 1) {
    harness.session.send({ kind: 'switchDetailTab', direction: 1 });
    await settle();
  }

  await answerLoad(harness, 'files', files());

  const snapshot = harness.session.getSnapshot();

  const row = visibleRows(snapshot).find(
    (candidate): candidate is ThreadRow => candidate.kind === 'thread',
  );

  invariant(row !== undefined, 'The shown pull request has a thread row.');

  const reader: ReaderContext = { kind: 'reader', row };
  const command = catalog.find((candidate) => candidate.id === 'readerOpenInBrowser');
  const intent = command?.intent(snapshot, reader);

  expect(intent).toEqual({
    kind: 'application',
    intent: {
      kind: 'openInBrowser',
      pages: [{ kind: 'pullRequestFiles', repository: 'acme/app', number: 7 }],
    },
  });

  if (intent?.kind === 'application') {
    harness.session.send(intent.intent);
  }

  await settle();

  expect(harness.opens).toEqual([{ kind: 'pullRequestFiles', repository: 'acme/app', number: 7 }]);
});
