import { expect, test } from 'bun:test';

import type { GitHubResult } from '../github/github.ts';
import type {
  IssueComment,
  IssueDetailRead,
  NotificationThread,
  ViewerLogin,
} from '../work/work.ts';
import { toIssueCommentId, toIssueId, toViewerLogin } from '../work/work.ts';
import type { Harness } from './sessionHarness.ts';
import {
  makeHarness,
  makeThread,
  octocat,
  readOf,
  releaseOf,
  settle,
  stable,
  viewerIdOf,
  viewerOf,
} from './sessionHarness.ts';

interface PageOptions {
  title?: string;
  comments?: IssueComment[];
  hasNextPage?: boolean;
  viewer?: ViewerLogin;
  totalCount?: number;
  overviewUpdatedAt?: string;
}

const hubot = toViewerLogin('hubot');

const issueOf = (number: number): NotificationThread =>
  makeThread(`issue-${number}`, {
    subjectType: 'Issue',
    subjectUrl: `https://api.github.com/repos/acme/app/issues/${number}`,
  });

const pageOf = (
  number: number,
  {
    title = `Issue ${number}`,
    comments = [],
    hasNextPage = false,
    viewer = octocat,
    totalCount = comments.length,
    overviewUpdatedAt = '2026-01-01T10:00:00Z',
  }: PageOptions = {},
): GitHubResult<IssueDetailRead> => {
  const url = `https://github.com/acme/app/issues/${number}`;
  const id = toIssueId(`I_${number}`);

  return {
    ok: true,
    value: {
      kind: 'issue',
      viewer: { id: viewerIdOf(viewer), login: viewer },
      subject: { id, number, url },
      overview: {
        id,
        number,
        url,
        title,
        body: `Body of ${title}`,
        state: 'open',
        author: 'hubot',
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: overviewUpdatedAt,
        lastEditedAt: null,
        labels: { names: [], totalCount: 0 },
        assignees: { logins: [], totalCount: 0 },
        digest: `digest-${title}`,
      },
      comments: {
        records: comments,
        totalCount,
        hasNextPage,
        endCursor: hasNextPage ? `cursor-${title}` : null,
      },
    },
  };
};

const commentOf = (id: string, updatedAt = '2026-01-02T10:00:00Z'): IssueComment => ({
  id: toIssueCommentId(id),
  author: 'hubot',
  body: `Comment ${id} at ${updatedAt}`,
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt,
  lastEditedAt: null,
  url: `https://github.com/acme/app/issues/1#${id}`,
  digest: `digest-${id}-${updatedAt}`,
});

const activeEntryOf = (harness: Harness) => {
  const { detail } = harness.session.getSnapshot();

  return detail.activeKey === null ? undefined : detail.entries.get(detail.activeKey);
};

const issueEntryOf = (harness: Harness) => {
  const entry = activeEntryOf(harness);

  return entry?.kind === 'issue' ? entry : undefined;
};

const titleOf = (harness: Harness): string | undefined =>
  issueEntryOf(harness)?.sources.overview.record?.title;

const answerDetail = async (
  harness: Harness,
  index: number,
  result: GitHubResult<IssueDetailRead>,
) => {
  harness.details[index]?.resolve(result);
  await settle();
};

test('a late read of a subject shown again never reaches the snapshot', async () => {
  const harness = makeHarness();
  const [first, second] = [issueOf(1), issueOf(2)];

  await harness.load(first, second);

  for (const thread of [first, second, first]) {
    harness.session.send({ kind: 'showDetail', thread });
    await settle();
  }

  const titles: (string | undefined)[] = [];

  harness.session.subscribe(() => {
    titles.push(titleOf(harness));
  });

  await answerDetail(harness, 1, pageOf(2, { title: 'Second subject' }));
  await answerDetail(harness, 2, pageOf(1, { title: 'Latest load' }));
  await answerDetail(harness, 0, pageOf(1, { title: 'First load' }));

  expect(titles).not.toContain('First load');
  expect(titles).not.toContain('Second subject');
  expect(titleOf(harness)).toBe('Latest load');
});

const anchorOf = (recordId: string) => ({ recordId, digest: `digest-${recordId}`, offset: 4 });

const readNumber = (thread: NotificationThread): number => Number(thread.id.replace('issue-', ''));

const failedPage = (message: string): GitHubResult<IssueDetailRead> => ({
  ok: false,
  failure: { kind: 'requestFailed', status: 502, message },
});

const commentIdsOf = (harness: Harness): string[] =>
  issueEntryOf(harness)?.sources.discussion.records.map((record) => record.id) ?? [];

const loadedHarness = async (...threads: NotificationThread[]): Promise<Harness> => {
  const harness = makeHarness();

  await harness.load(...threads);

  return harness;
};

const showLoaded = async (
  harness: Harness,
  thread: NotificationThread,
  result: GitHubResult<IssueDetailRead>,
) => {
  harness.session.send({ kind: 'showDetail', thread });
  await settle();
  await answerDetail(harness, harness.details.length - 1, result);
};

const entryFor = (harness: Harness, thread: NotificationThread) =>
  [...harness.session.getSnapshot().detail.entries.values()].find(
    (entry) => entry.threadId === thread.id,
  );

const titleFor = (harness: Harness, thread: NotificationThread): string | undefined => {
  const entry = entryFor(harness, thread);

  return entry?.kind === 'issue' ? entry.sources.overview.record?.title : undefined;
};

const commentsOver = (count: number): IssueComment[] =>
  Array.from({ length: count }, (_, index) => commentOf(`C${index}`));

test('a read of a subject the reader left never reaches the snapshot', async () => {
  const [first, second] = [issueOf(1), issueOf(2)];
  const harness = await loadedHarness(first, second);

  harness.session.send({ kind: 'showDetail', thread: first });
  await settle();
  harness.session.send({ kind: 'showDetail', thread: second });
  await settle();
  await answerDetail(harness, 0, pageOf(1, { title: 'Left subject' }));

  expect(harness.details[0]?.signal.aborted).toBe(true);
  expect(titleFor(harness, first)).toBeUndefined();
  expect(issueEntryOf(harness)?.sources.overview.coverage).toBe('loading');
});

test('an account change drops a read that started before it and loads for the new account', async () => {
  const issue = issueOf(1);
  const harness = makeHarness({}, { holdViewer: true });

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerViewer(viewerOf(octocat));
  await harness.answerRead(readOf('feed', [issue]));
  await harness.answerVerify(stable);
  await showLoaded(harness, issue, pageOf(1, { title: 'Cached' }));
  harness.session.send({ kind: 'refreshDetail', thread: issue });
  await settle();
  await harness.answerViewer(viewerOf(hubot));
  await answerDetail(harness, 1, pageOf(1, { title: 'Late octocat read' }));

  expect(harness.details[1]?.signal.aborted).toBe(true);
  expect(titleOf(harness)).toBeUndefined();
  expect(issueEntryOf(harness)?.sources.overview.coverage).toBe('loading');
  expect(harness.details).toHaveLength(2);

  await harness.answerRead(readOf('feed', [issue]));
  await harness.answerVerify(stable);
  await answerDetail(harness, 2, pageOf(1, { title: 'Hubot read', viewer: hubot }));

  expect(titleOf(harness)).toBe('Hubot read');
});

test('stop aborts a read, clears detail content, and drops the late result', async () => {
  const [first, second] = [issueOf(1), issueOf(2)];
  const harness = await loadedHarness(first, second);

  await showLoaded(harness, first, pageOf(1));
  harness.session.send({ kind: 'showDetail', thread: second });
  await settle();
  await harness.session.stop(new AbortController().signal);
  await answerDetail(harness, 1, pageOf(2, { title: 'After stop' }));

  expect(harness.details[1]?.signal.aborted).toBe(true);
  expect(harness.session.getSnapshot().detail.entries.size).toBe(0);
  expect(harness.session.getSnapshot().detail.activeKey).toBeNull();
});

test('a read from another viewer clears all detail content and names that account', async () => {
  const [first, second] = [issueOf(1), issueOf(2)];
  const harness = await loadedHarness(first, second);

  await showLoaded(harness, first, pageOf(1, { comments: [commentOf('X')] }));
  harness.session.send({ kind: 'setDetailAnchor', tab: 'overview', anchor: anchorOf('I_1') });
  await showLoaded(harness, second, pageOf(2, { viewer: hubot }));

  const { detail } = harness.session.getSnapshot();

  expect(detail.mismatch).toEqual({ login: hubot });
  expect(entryFor(harness, first)).toBeUndefined();
  expect(titleFor(harness, second)).toBeUndefined();
  expect(issueEntryOf(harness)?.anchors).toEqual({});

  await showLoaded(harness, first, pageOf(1));

  expect(harness.details).toHaveLength(3);
  expect(harness.session.getSnapshot().detail.mismatch).toBeNull();
  expect(titleOf(harness)).toBe('Issue 1');
});

test('an older revision on a later page never replaces the newer one', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);
  const newer = commentOf('X', '2026-01-03T10:00:00Z');
  const older = commentOf('X', '2026-01-02T10:00:00Z');

  harness.session.send({ kind: 'showDetail', thread: issue });
  await settle();
  harness.session.send({ kind: 'showDetail', thread: issue });
  await settle();

  expect(harness.details).toHaveLength(1);
  expect(harness.details[0]?.signal.aborted).toBe(false);

  await answerDetail(harness, 0, pageOf(1, { comments: [newer], hasNextPage: true }));

  expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('loading');

  await answerDetail(harness, 1, pageOf(1, { comments: [older, commentOf('Y')] }));

  expect(harness.details[1]?.request).toEqual({
    coordinates: { subjectId: toIssueId('I_1') },
    commentsAfter: 'cursor-Issue 1',
    pageSize: 50,
  });

  expect(issueEntryOf(harness)?.sources.discussion.records).toEqual([newer, commentOf('Y')]);
  expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('loaded');
});

test('a failed later page keeps the loaded comments with partial Discussion coverage', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);

  await showLoaded(harness, issue, pageOf(1, { comments: [commentOf('X')], hasNextPage: true }));
  await answerDetail(harness, 1, failedPage('Bad gateway'));

  const sources = issueEntryOf(harness)?.sources;

  expect(harness.details).toHaveLength(2);
  expect(commentIdsOf(harness)).toEqual(['X']);
  expect(sources?.discussion.coverage).toBe('partial');
  expect(sources?.discussion.message).toContain('Bad gateway');
  expect(sources?.overview.coverage).toBe('loaded');
});

test('a failed first page with nothing loaded fails both sources', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);

  await showLoaded(harness, issue, failedPage('Bad gateway'));

  const sources = issueEntryOf(harness)?.sources;

  expect(sources?.overview.coverage).toBe('failed');
  expect(sources?.discussion.coverage).toBe('failed');
});

test('refreshDetail publishes an edited comment while the thread is unchanged', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);
  const edited = commentOf('X', '2026-01-04T10:00:00Z');

  await showLoaded(harness, issue, pageOf(1, { comments: [commentOf('X'), commentOf('Y')] }));
  harness.session.send({ kind: 'showDetail', thread: issue });
  await settle();

  expect(harness.details).toHaveLength(1);

  const readsBefore = harness.countOf('read');

  harness.session.send({ kind: 'refreshDetail', thread: issue });
  await settle();
  await answerDetail(harness, 1, pageOf(1, { comments: [edited] }));

  expect(harness.countOf('read')).toBe(readsBefore + 1);
  expect(issueEntryOf(harness)?.sources.discussion.records).toEqual([edited]);
});

test('a response over the byte limit gives partial coverage', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);

  await showLoaded(harness, issue, {
    ok: false,
    failure: { kind: 'responseTooLarge', limitBytes: 4_194_304 },
  });

  expect(issueEntryOf(harness)?.sources.overview.coverage).toBe('partial');
  expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('partial');
});

test('a load of 501 comments over 11 pages stops at the request limit with partial coverage', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);
  const comments = commentsOver(501);

  const pageAt = (index: number) =>
    pageOf(1, {
      comments: comments.slice(index * 50, index * 50 + 50),
      hasNextPage: index < 10,
      totalCount: 501,
    });

  harness.session.send({ kind: 'showDetail', thread: issue });
  await settle();

  for (let index = 0; index < 11; index += 1) {
    await answerDetail(harness, index, pageAt(index));
  }

  const discussion = issueEntryOf(harness)?.sources.discussion;

  expect(harness.details).toHaveLength(8);
  expect(discussion?.coverage).toBe('partial');
  expect(discussion?.records).toHaveLength(400);
  expect(discussion?.totalCount).toBe(501);
});

test('a rate limited read pauses admission, and a paused admission starts no read', async () => {
  const [first, second] = [issueOf(1), issueOf(2)];
  const harness = await loadedHarness(first, second);
  const resetAt = new Date(harness.now().getTime() + 60_000);

  await showLoaded(harness, first, { ok: false, failure: { kind: 'rateLimited', resetAt } });
  harness.session.send({ kind: 'showDetail', thread: second });
  await settle();

  expect(harness.session.getSnapshot().pausedUntil).toEqual(resetAt);
  expect(harness.details).toHaveLength(1);
  expect(issueEntryOf(harness)?.sources.overview.coverage).toBe('notRequested');
  expect(issueEntryOf(harness)?.sources.discussion.message).toContain('Rate limited');
});

test('a subject shown again more than 5 minutes after its fetch revalidates, and one shown at 5 minutes does not', async () => {
  const [first, second] = [issueOf(1), issueOf(2)];
  const harness = await loadedHarness(first, second);

  await showLoaded(harness, first, pageOf(1));
  await showLoaded(harness, second, pageOf(2));
  harness.advance(5 * 60_000);
  harness.session.send({ kind: 'showDetail', thread: first });
  await settle();

  expect(harness.details).toHaveLength(2);

  harness.advance(1);
  harness.session.send({ kind: 'showDetail', thread: second });
  await settle();

  expect(harness.details).toHaveLength(3);
  expect(titleFor(harness, second)).toBe('Issue 2');
});

test('a release thread is unsupported and starts no read', async () => {
  const release = releaseOf('9');
  const harness = await loadedHarness(release);

  harness.session.send({ kind: 'showDetail', thread: release });
  await settle();

  harness.session.send({ kind: 'refreshDetail', thread: release });
  await settle();

  const entry = activeEntryOf(harness);

  expect(entry?.kind === 'unsupported' ? entry.coverage : undefined).toBe('unsupported');
  expect(entry?.tabs).toEqual(['overview']);
  expect(harness.details).toHaveLength(0);
});

test('a read waits for the feed viewer, then loads the shown subject', async () => {
  const issue = issueOf(1);
  const harness = makeHarness();

  harness.session.send({ kind: 'showDetail', thread: issue });
  await settle();

  expect(harness.details).toHaveLength(0);
  expect(issueEntryOf(harness)?.sources.overview.coverage).toBe('loading');

  await harness.load(issue);
  await answerDetail(harness, 0, pageOf(1, { title: 'After viewer' }));

  expect(titleOf(harness)).toBe('After viewer');
});

test('at most two detail reads run, and the next starts when one settles', async () => {
  const [first, second, third] = [issueOf(1), issueOf(2), issueOf(3)];
  const harness = await loadedHarness(first, second, third);

  for (const thread of [first, second, third]) {
    harness.session.send({ kind: 'showDetail', thread });
    await settle();
  }

  expect(harness.details).toHaveLength(2);

  await answerDetail(harness, 0, pageOf(1));
  await answerDetail(harness, 2, pageOf(3));

  expect(harness.details).toHaveLength(3);
  expect(titleOf(harness)).toBe('Issue 3');
});

test('each subject keeps its tab and anchors across visits', async () => {
  const [first, second] = [issueOf(1), issueOf(2)];
  const harness = await loadedHarness(first, second);

  await showLoaded(harness, first, pageOf(1, { comments: [commentOf('X')] }));
  harness.session.send({ kind: 'switchDetailTab', direction: 1 });
  harness.session.send({ kind: 'setDetailAnchor', tab: 'discussion', anchor: anchorOf('X') });
  await showLoaded(harness, second, pageOf(2));
  harness.session.send({ kind: 'switchDetailTab', direction: -1 });

  expect(activeEntryOf(harness)?.tab).toBe('discussion');

  harness.session.send({ kind: 'showDetail', thread: first });

  expect(activeEntryOf(harness)?.tab).toBe('discussion');
  expect(activeEntryOf(harness)?.anchors).toEqual({ discussion: anchorOf('X') });
});

test('the cache keeps 20 subjects and evicts the one shown longest ago', async () => {
  const issues = Array.from({ length: 21 }, (_, index) => issueOf(index + 1));
  const harness = await loadedHarness(...issues);

  const [oldest, second] = issues as [NotificationThread, NotificationThread];

  for (const issue of issues.slice(0, 20)) {
    await showLoaded(harness, issue, pageOf(readNumber(issue)));
  }

  harness.session.send({ kind: 'showDetail', thread: oldest });
  await showLoaded(harness, issues[20] as NotificationThread, pageOf(21));

  expect(harness.session.getSnapshot().detail.entries.size).toBe(20);
  expect(entryFor(harness, second)).toBeUndefined();
  expect(titleFor(harness, oldest)).toBe('Issue 1');
});

test('an issue that is gone shows unavailable coverage', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);

  await showLoaded(harness, issue, {
    ok: true,
    value: { kind: 'unavailable', viewer: { id: viewerIdOf(octocat), login: octocat } },
  });

  expect(issueEntryOf(harness)?.sources.overview.coverage).toBe('unavailable');
  expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('unavailable');
});

test('a read the reader left before it started never runs and holds no process', async () => {
  const [first, second, third] = [issueOf(1), issueOf(2), issueOf(3)];
  const harness = await loadedHarness(first, second, third);

  harness.session.send({ kind: 'showDetail', thread: first });
  harness.session.send({ kind: 'showDetail', thread: second });
  await settle();
  harness.session.send({ kind: 'showDetail', thread: third });
  await settle();

  expect(harness.details.map((call) => call.request.coordinates)).toEqual([
    { owner: 'acme', name: 'app', number: 2 },
    { owner: 'acme', name: 'app', number: 3 },
  ]);
});

test('the cache evicts by body bytes and never evicts the shown subject', async () => {
  const [first, second] = [issueOf(1), issueOf(2)];
  const harness = await loadedHarness(first, second);
  const large = { ...commentOf('X'), body: 'x'.repeat(17 * 1024 * 1024) };

  await showLoaded(harness, first, pageOf(1, { comments: [large] }));

  await showLoaded(
    harness,
    second,
    pageOf(2, { comments: [{ ...large, id: toIssueCommentId('Y') }] }),
  );

  expect(entryFor(harness, first)).toBeUndefined();
  expect(commentIdsOf(harness)).toEqual(['Y']);
  expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('loaded');
});

test('a load stops at 500 comments with partial coverage', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);
  const comments = commentsOver(600);

  harness.session.send({ kind: 'showDetail', thread: issue });
  await settle();

  for (let index = 0; index < 6; index += 1) {
    const records = comments.slice(index * 100, index * 100 + 100);

    await answerDetail(harness, index, pageOf(1, { comments: records, hasNextPage: true }));
  }

  expect(harness.details).toHaveLength(5);
  expect(commentIdsOf(harness)).toHaveLength(500);
  expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('partial');
});

test('a later page for another issue stops the load and keeps the first page', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);

  await showLoaded(harness, issue, pageOf(1, { comments: [commentOf('X')], hasNextPage: true }));
  await answerDetail(harness, 1, pageOf(2, { comments: [commentOf('Z')], hasNextPage: true }));

  const sources = issueEntryOf(harness)?.sources;

  expect(harness.details).toHaveLength(2);
  expect(commentIdsOf(harness)).toEqual(['X']);
  expect(sources?.overview.record?.title).toBe('Issue 1');
  expect(sources?.discussion.coverage).toBe('partial');
});

const cacheBudgetBytes = 32 * 1024 * 1024;

const storedBytesOf = (harness: Harness): number => {
  const sources = issueEntryOf(harness)?.sources;

  const bodies = [
    sources?.overview.record?.body ?? '',
    ...(sources?.discussion.records ?? []).map((record) => record.body),
  ];

  return bodies.reduce((total, body) => total + Buffer.byteLength(body), 0);
};

const rateLimitedRead = (harness: Harness) => ({
  ok: false as const,
  failure: { kind: 'rateLimited' as const, resetAt: new Date(harness.now().getTime() + 60_000) },
});

test('repeated refreshes of a partial subject keep its content within the cache budget', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);
  const body = 'x'.repeat(3 * 1024 * 1024);
  let answered = 0;

  for (let traversal = 0; traversal < 6; traversal += 1) {
    harness.session.send({ kind: 'refreshDetail', thread: issue });
    await settle();

    while (answered < harness.details.length) {
      const comment = { ...commentOf(`C-${traversal}-${answered}`), body };

      await answerDetail(harness, answered, pageOf(1, { comments: [comment], hasNextPage: true }));
      answered += 1;
    }

    expect(storedBytesOf(harness)).toBeLessThanOrEqual(cacheBudgetBytes);
    expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('partial');
  }
});

test('a complete page over the cache budget keeps whole comments with partial coverage', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);
  const body = 'x'.repeat(17 * 1024 * 1024);

  const comments = [
    { ...commentOf('X'), body },
    { ...commentOf('Y'), body },
  ];

  await showLoaded(harness, issue, pageOf(1, { comments }));

  expect(commentIdsOf(harness)).toEqual(['X']);
  expect(storedBytesOf(harness)).toBeLessThanOrEqual(cacheBudgetBytes);
  expect(issueEntryOf(harness)?.sources.discussion.coverage).toBe('partial');
});

test('a queued read that gets its process during the shared pause never starts', async () => {
  const issues = [issueOf(1), issueOf(2), issueOf(3)];
  const harness = await loadedHarness(...issues);

  for (const thread of issues) {
    harness.session.send({ kind: 'showDetail', thread });
    await settle();
  }

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerRead(rateLimitedRead(harness));
  await answerDetail(harness, 0, pageOf(1));

  expect(harness.details).toHaveLength(2);
  expect(issueEntryOf(harness)?.sources.overview.coverage).toBe('notRequested');
  expect(issueEntryOf(harness)?.sources.overview.message).toContain('Rate limited');
});

test('a feed refresh that hits a rate limit does not resume a waiting read', async () => {
  const harness = makeHarness();

  harness.session.send({ kind: 'showDetail', thread: issueOf(1) });
  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerRead(rateLimitedRead(harness));

  expect(harness.session.getSnapshot().pausedUntil).not.toBeNull();
  expect(harness.details).toHaveLength(0);
});

test('an older Overview on a later page or a refresh never replaces the newer one', async () => {
  const issue = issueOf(1);
  const harness = await loadedHarness(issue);
  const newer = { title: 'Newer', overviewUpdatedAt: '2026-01-04T10:00:00Z' };
  const older = { title: 'Older', overviewUpdatedAt: '2026-01-02T10:00:00Z' };

  await showLoaded(harness, issue, pageOf(1, { ...newer, hasNextPage: true }));
  await answerDetail(harness, 1, pageOf(1, older));

  expect(titleOf(harness)).toBe('Newer');

  harness.session.send({ kind: 'refreshDetail', thread: issue });
  await settle();
  await answerDetail(harness, 2, pageOf(1, older));

  expect(titleOf(harness)).toBe('Newer');
});

test('an account change leaves no anchor on an unsupported subject', async () => {
  const release = releaseOf('9');
  const harness = makeHarness({}, { holdViewer: true });

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerViewer(viewerOf(octocat));
  await harness.answerRead(readOf('feed', [release]));
  await harness.answerVerify(stable);
  harness.session.send({ kind: 'showDetail', thread: release });
  harness.session.send({ kind: 'setDetailAnchor', tab: 'overview', anchor: anchorOf('R') });

  expect(activeEntryOf(harness)?.anchors).toEqual({ overview: anchorOf('R') });

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerViewer(viewerOf(hubot));

  expect(activeEntryOf(harness)?.kind).toBe('unsupported');
  expect(activeEntryOf(harness)?.anchors).toEqual({});
});
