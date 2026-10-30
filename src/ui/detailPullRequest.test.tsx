import { afterEach, expect, test } from 'bun:test';

import type { SessionEffects } from '../session/session.ts';
import type {
  NotificationThread,
  PullRequestCheck,
  PullRequestDetailRead,
  PullRequestOverview,
} from '../work/work.ts';
import { toPullRequestId, toViewerId, toViewerLogin } from '../work/work.ts';
import type { frameLines } from './uiHarness.tsx';
import {
  makeThread,
  pressAll,
  threadsEffects,
  track,
  mount as untrackedMount,
} from './uiHarness.tsx';

type PullRequestSource = PullRequestDetailRead['kind'];

type PullRequestReply = Awaited<ReturnType<SessionEffects['readPullRequestDetail']>>;

interface PullRequestFixtures {
  overview?: PullRequestOverview;
  checksRollup?: 'none' | 'reported';
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const viewerOf = (login: string) => ({
  id: toViewerId(`U_${login}`),
  login: toViewerLogin(login),
});

const frameOf = (setup: Parameters<typeof frameLines>[0]): string => setup.captureCharFrame();

const pullRequestThread: NotificationThread = {
  ...makeThread(3, 'Add retry budget to the sync worker'),
  subjectType: 'PullRequest',
  subjectUrl: 'https://api.github.com/repos/harbor/console/pulls/412',
  repository: 'harbor/console',
  reason: 'review_requested',
};

const pullRequestRef = {
  id: toPullRequestId('PR_412'),
  headOid: '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  baseOid: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const pullRequestOverview = (
  overrides: Partial<PullRequestOverview> = {},
): PullRequestOverview => ({
  number: 412,
  url: 'https://github.com/harbor/console/pull/412',
  title: 'Add retry budget to the sync worker',
  body: 'Caps retries per job so a flaky upstream cannot starve the queue.',
  state: 'open',
  isDraft: false,
  author: 'nora',
  createdAt: '1970-01-01T00:00:00Z',
  updatedAt: '1970-01-01T00:00:00Z',
  lastEditedAt: null,
  base: { refName: 'main', oid: pullRequestRef.baseOid },
  head: { refName: 'retry-budget', oid: pullRequestRef.headOid },
  labels: { names: ['backend'], totalCount: 1 },
  assignees: { logins: ['mira'], totalCount: 1 },
  reviewRequests: {
    reviewers: [{ kind: 'account', typeName: 'User', login: 'sam' }],
    totalCount: 1,
  },
  reviewDecision: 'reviewRequired',
  mergeable: 'mergeable',
  mergeStateStatus: 'clean',
  checksUrl: 'https://github.com/harbor/console/pull/412/checks',
  digest: 'overview-digest',
  ...overrides,
});

const commitOf = (oid: string, headline: string) => ({
  oid,
  headline,
  author: 'nora',
  authoredDate: '1970-01-01T00:00:00Z',
  url: `https://github.com/harbor/console/commit/${oid}`,
});

const unitCheck: PullRequestCheck = {
  kind: 'checkRun',
  name: 'unit',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  detailsUrl: 'https://github.com/harbor/console/actions/runs/77/job/88',
  url: 'https://github.com/harbor/console/actions/runs/77/job/88',
  databaseId: 88,
};

const pullRequestPage = <Record,>(records: Record[]) => ({
  records,
  totalCount: records.length,
  hasNextPage: false,
  endCursor: null,
});

const pullRequestReadOf = (
  source: PullRequestSource,
  fixtures: PullRequestFixtures = {},
): PullRequestDetailRead => {
  const viewer = viewerOf('octocat');

  if (source === 'overview') {
    return {
      kind: 'overview',
      viewer,
      pullRequest: pullRequestRef,
      overview: fixtures.overview ?? pullRequestOverview(),
    };
  }

  if (source === 'commits') {
    const commits = [
      commitOf('aaaa111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Cap retries per job'),
      commitOf('bbbb222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Expose the retry budget setting'),
    ];

    return {
      kind: 'commits',
      viewer,
      pullRequest: pullRequestRef,
      commits: pullRequestPage(commits),
    };
  }

  if (source === 'checks') {
    const rollup =
      fixtures.checksRollup === 'none'
        ? null
        : {
            state: 'SUCCESS',
            commitOid: pullRequestRef.headOid,
            checks: pullRequestPage<PullRequestCheck>([unitCheck]),
          };

    return { kind: 'checks', viewer, pullRequest: pullRequestRef, rollup };
  }

  return {
    kind: 'files',
    viewer,
    pullRequest: pullRequestRef,
    totals: { changedFiles: 1, additions: 12, deletions: 3 },
    files: pullRequestPage([
      { path: 'src/sync/retry.ts', changeType: 'MODIFIED', additions: 12, deletions: 3 },
    ]),
  };
};

const pullRequestEffects = (
  readOf: (request: Parameters<SessionEffects['readPullRequestDetail']>[0]) => PullRequestReply,
): SessionEffects => ({
  ...threadsEffects([pullRequestThread]),
  readPullRequestDetail: (request) => Promise.resolve(readOf(request)),
});

const pullRequestEffectsWith = (fixtures: PullRequestFixtures = {}): SessionEffects =>
  pullRequestEffects((request) => ({
    ok: true,
    value: pullRequestReadOf(request.source, fixtures),
  }));

const openPullRequest = async (press: (key: string) => Promise<void>) => {
  await pressAll(press, ['r', 'j', 'j', 'return']);
};

test('a closed PR reader stays cached on feed completion and revalidates on re-entry', async () => {
  let milliseconds = 0;
  let reads = 0;

  const effects = {
    ...pullRequestEffects((request) => {
      reads += 1;

      return { ok: true, value: pullRequestReadOf(request.source) };
    }),
    now: () => new Date(milliseconds),
  };

  const { setup, press, session } = await mount({ effects, width: 60, height: 24 });

  await openPullRequest(press);
  expect(reads).toBe(1);
  const cached = session.getSnapshot().detail.entries;

  await press('escape');
  milliseconds = 6 * 60_000;
  await press('r');
  expect(frameOf(setup)).not.toContain('[Overview*]');
  expect(reads).toBe(1);
  expect(session.getSnapshot().detail.entries).toBe(cached);
  await press('return');
  expect(reads).toBe(2);
  expect(frameOf(setup)).toContain('[Overview*]');
  await press('r');
  expect(reads).toBe(3);
});

for (const closeReader of [true, false]) {
  test(`pending PR pagination follows reader lifetime with reader closed ${closeReader}`, async () => {
    const pending: { signal: AbortSignal; resolve: (reply: PullRequestReply) => void }[] = [];

    const effects: SessionEffects = {
      ...pullRequestEffectsWith(),
      readPullRequestDetail: (request, signal) =>
        request.source === 'overview'
          ? Promise.resolve({ ok: true, value: pullRequestReadOf('overview') })
          : new Promise((resolve) => {
              pending.push({ signal, resolve });
            }),
    };

    const { press, settle, session } = await mount({ effects, width: 60, height: 24 });

    await openPullRequest(press);
    await press('h');
    expect(pending).toHaveLength(1);
    const closeKey = closeReader ? 'escape' : '?';

    await press(closeKey);
    const before = session.getSnapshot().detail;

    const value: PullRequestDetailRead = {
      kind: 'files',
      viewer: viewerOf('octocat'),
      pullRequest: pullRequestRef,
      totals: { changedFiles: 2, additions: 2, deletions: 0 },
      files: {
        ...pullRequestPage([
          { path: 'src/first.ts', changeType: 'ADDED', additions: 1, deletions: 0 },
        ]),
        hasNextPage: true,
        endCursor: 'next',
      },
    };

    pending[0]?.resolve({ ok: true, value });
    await settle();
    const expectedRequests = closeReader ? 1 : 2;

    expect(pending).toHaveLength(expectedRequests);
    expect(pending[0]?.signal.aborted).toBe(closeReader);

    if (closeReader) {
      expect(session.getSnapshot().detail).toBe(before);
      await press('return');
      expect(pending).toHaveLength(2);
    } else {
      await press('escape');
    }

    expect(pending[1]?.signal.aborted).toBe(false);
  });
}

for (const field of ['labels', 'assignees', 'reviewRequests'] as const) {
  test(`Overview shows loaded and total counts for capped ${field}`, async () => {
    const names = Array.from({ length: 10 }, (_, index) => `item${index}`);

    const overview = pullRequestOverview({
      labels: { names, totalCount: field === 'labels' ? 11 : 10 },
      assignees: { logins: names, totalCount: field === 'assignees' ? 11 : 10 },
      reviewRequests: {
        reviewers: names.map((login) => ({ kind: 'account', typeName: 'User', login })),
        totalCount: field === 'reviewRequests' ? 11 : 10,
      },
    });

    const { setup, press } = await mount({
      effects: pullRequestEffectsWith({ overview }),
      width: 120,
      height: 40,
    });

    await openPullRequest(press);

    const label = { labels: 'Labels', assignees: 'Assignees', reviewRequests: 'Review requests' }[
      field
    ];

    expect(frameOf(setup)).toContain(`${label} (10/11 loaded):`);
    expect(frameOf(setup)).toContain('item9');
  });
}

for (const source of ['files', 'checks'] as const) {
  for (const empty of [false, true]) {
    test(`${source} shows its fetched head rather than Overview head with empty source ${empty}`, async () => {
      const effects = pullRequestEffects((request) => {
        const read = pullRequestReadOf(request.source, {
          checksRollup: empty ? 'none' : 'reported',
        });

        if (read.kind === 'files') {
          return {
            ok: true,
            value: {
              ...read,
              pullRequest: {
                ...read.pullRequest,
                headOid: 'deadbeefffffffffffffffffffffffffffffffff',
              },
              files: empty ? pullRequestPage([]) : read.files,
            },
          };
        }

        if (read.kind === 'checks') {
          return {
            ok: true,
            value: {
              ...read,
              pullRequest: {
                ...read.pullRequest,
                headOid: 'deadbeefffffffffffffffffffffffffffffffff',
              },
            },
          };
        }

        return { ok: true, value: read };
      });

      const { setup, press } = await mount({ effects, width: 80, height: 24 });

      await openPullRequest(press);
      const keys = source === 'files' ? ['l', 'l', 'l'] : ['l', 'l'];

      await pressAll(press, keys);
      expect(frameOf(setup)).toContain('Head: deadbee');
    });
  }
}

for (const [width, height] of [
  [80, 24],
  [120, 40],
] as const) {
  test(`at ${width}x${height}, a focused PR shows the four tabs and readable content on each`, async () => {
    const { setup, press } = await mount({ effects: pullRequestEffectsWith(), width, height });

    await openPullRequest(press);

    const overview = frameOf(setup);

    expect(overview).toContain('harbor/console');
    expect(overview).toContain('Pull request #412 / open / @nora');
    expect(overview).toContain('Add retry budget to the sync worker');
    expect(overview).toContain('review_requested');
    expect(overview).toContain('[Overview*] Commits Checks Files');
    expect(overview).toContain('Caps retries per job so a flaky upstream');

    await press('l');

    const commits = frameOf(setup);

    expect(commits).toContain('Overview [Commits*] Checks Files');
    expect(commits).toContain('aaaa111');
    expect(commits).toContain('Cap retries per job');
    expect(commits).toContain('Expose the retry budget setting');

    await press('l');

    const checks = frameOf(setup);

    expect(checks).toContain('Overview Commits [Checks*] Files');
    expect(checks).toContain('unit');

    await press('l');

    const files = frameOf(setup);

    expect(files).toContain('Overview Commits Checks [Files*]');
    expect(files).toContain('src/sync/retry.ts');
    expect(files).toContain('+12 -3');
  });
}

test('a null rollup shows No checks reported and no passing state', async () => {
  const { setup, press } = await mount({
    effects: pullRequestEffectsWith({ checksRollup: 'none' }),
    width: 80,
    height: 24,
  });

  await openPullRequest(press);
  await pressAll(press, ['l', 'l']);

  const checks = frameOf(setup);

  expect(checks).toContain('Overview Commits [Checks*] Files');
  expect(checks).toContain('No checks reported');
  expect(checks).not.toContain('SUCCESS');
  expect(checks).not.toContain('passing');
});

test('a failed Files source shows the failure and the open line', async () => {
  const failure = { kind: 'requestFailed' as const, status: 502, message: 'Bad gateway' };

  const { setup, press } = await mount({
    effects: pullRequestEffects((request) =>
      request.source === 'files'
        ? { ok: false, failure }
        : { ok: true, value: pullRequestReadOf(request.source) },
    ),
    width: 80,
    height: 24,
  });

  await openPullRequest(press);
  await pressAll(press, ['l', 'l', 'l']);

  const files = frameOf(setup);

  expect(files).toContain('Overview Commits Checks [Files*]');
  expect(files).toContain('Failed: ');
  expect(files).toContain('Bad gateway');
  expect(files).toContain('Press o/gx to open it on GitHub.');
});

test('an UNKNOWN merge state shows unknown for mergeability and merge state', async () => {
  const overview = pullRequestOverview({ mergeable: 'unknown', mergeStateStatus: 'unknown' });

  const { setup, press } = await mount({
    effects: pullRequestEffectsWith({ overview }),
    width: 120,
    height: 40,
  });

  await openPullRequest(press);

  const frame = frameOf(setup);

  expect(frame).toContain('Mergeable: unknown');
  expect(frame).toContain('Merge state: unknown');
});
