import { expect, test } from 'bun:test';

import type { BrowserPage, NodeRow, NotificationThread, ThreadRow } from './work.ts';
import {
  buildTree,
  flattenTree,
  groupings,
  isDoneLocally,
  isDoneOnGitHub,
  pagesOfRow,
  pageOfThread,
  readSubjectNumber,
  selectOpenThreads,
  toThreadId,
  treeRows,
  toViewerLogin,
} from './work.ts';

const makeThread = (
  id: string,
  overrides: Partial<NotificationThread> = {},
): NotificationThread => ({
  id: toThreadId(id),
  reason: 'review_requested',
  unread: true,
  updatedAt: '2026-01-02T10:00:00Z',
  lastReadAt: null,
  title: `Thread ${id}`,
  subjectType: 'PullRequest',
  subjectUrl: `https://api.github.com/repos/acme/app/pulls/${id}`,
  repository: 'acme/app',
  ...overrides,
});

test('selectOpenThreads leaves out threads GitHub shows as done and keeps the rest in order', () => {
  const done = makeThread('1', { unread: false, lastReadAt: null });
  const unread = makeThread('2', { unread: true, lastReadAt: null });

  const readWithTimestamp = makeThread('3', {
    unread: false,
    lastReadAt: '2026-01-01T10:00:00Z',
  });

  const unreadWithTimestamp = makeThread('4', {
    unread: true,
    lastReadAt: '2026-01-01T10:00:00Z',
  });

  const open = selectOpenThreads([unread, done, readWithTimestamp, unreadWithTimestamp], new Map());

  expect(open).toEqual([unread, readWithTimestamp, unreadWithTimestamp]);
});

test('selectOpenThreads hides a thread whose done record matches its updated_at and shows one that changed', () => {
  const recorded = makeThread('6');
  const changed = makeThread('7', { updatedAt: '2026-01-03T10:00:00Z' });

  const doneRecords = new Map([
    [recorded.id, recorded.updatedAt],
    [changed.id, '2026-01-02T10:00:00Z'],
  ]);

  expect(isDoneLocally(recorded, doneRecords)).toBe(true);
  expect(isDoneLocally(changed, doneRecords)).toBe(false);
  expect(selectOpenThreads([recorded, changed], doneRecords)).toEqual([changed]);
});

test('selectOpenThreads keeps a thread without a subject URL', () => {
  const checkSuite = makeThread('5', { subjectType: 'CheckSuite', subjectUrl: null });

  expect(selectOpenThreads([checkSuite], new Map())).toEqual([checkSuite]);
});

test('toThreadId and toViewerLogin reject empty values', () => {
  expect(() => toThreadId('')).toThrow();
  expect(() => toViewerLogin('')).toThrow();
});

test('isDoneOnGitHub is true only for a read thread with no last read time', () => {
  expect(isDoneOnGitHub(makeThread('6', { unread: false, lastReadAt: null }))).toBe(true);
  expect(isDoneOnGitHub(makeThread('7', { unread: true, lastReadAt: null }))).toBe(false);
});

test('readSubjectNumber reads pull request and issue numbers and returns null without one', () => {
  const base = 'https://api.github.com/repos/o/r';

  expect(readSubjectNumber(`${base}/pulls/12`)).toBe(12);
  expect(readSubjectNumber(`${base}/issues/7`)).toBe(7);
  expect(readSubjectNumber(`${base}/releases/555`)).toBeNull();
  expect(readSubjectNumber(`${base}/commits/abc123def`)).toBeNull();
  expect(readSubjectNumber(null)).toBeNull();
});

const reasonFixture = (): NotificationThread[] => [
  makeThread('1', { reason: 'ci_activity', subjectType: 'CheckSuite', repository: 'acme/app' }),
  makeThread('2', { reason: 'review_requested', repository: 'acme/app' }),
  makeThread('3', { reason: 'team_mention', repository: 'acme/lib' }),
  makeThread('4', { reason: 'banana', subjectType: 'Issue', repository: 'acme/lib' }),
  makeThread('5', { reason: 'subscribed', subjectType: 'Release', repository: 'acme/lib' }),
  makeThread('6', { reason: 'review_requested', repository: 'acme/app' }),
  makeThread('7', { reason: 'review_requested', repository: 'acme/lib' }),
];

const readIds = (threads: NotificationThread[]): string[] => threads.map((thread) => thread.id);

test('buildTree by reason orders the groups, sends releases to Release, and keeps input order', () => {
  const tree = buildTree(reasonFixture(), 'reason');

  expect(tree.map((node) => node.title)).toEqual([
    'Review requested',
    'Mention',
    'CI activity',
    'Release',
    'Other',
  ]);

  const review = tree[0];
  const release = tree[3];

  expect(review?.children.map((node) => node.key)).toEqual(['review/acme/app', 'review/acme/lib']);

  expect(review?.children.map((node) => readIds(node.threads))).toEqual([['2', '6'], ['7']]);
  expect(readIds(review?.threads ?? [])).toEqual(['2', '6', '7']);
  expect(readIds(release?.threads ?? [])).toEqual(['5']);
});

test('buildTree by type orders the groups and leaves out empty ones', () => {
  const tree = buildTree(reasonFixture(), 'type');

  expect(tree.map((node) => node.title)).toEqual([
    'Pull requests',
    'Issues',
    'CI runs',
    'Releases',
  ]);

  expect(readIds(tree[0]?.threads ?? [])).toEqual(['2', '3', '6', '7']);

  expect(tree[0]?.children.map((node) => node.key)).toEqual([
    'pull-requests/acme/app',
    'pull-requests/acme/lib',
  ]);
});

test('buildTree by type puts unknown types in Other', () => {
  const tree = buildTree([makeThread('1', { subjectType: 'Discussion' })], 'type');

  expect(tree.map((node) => node.title)).toEqual(['Other']);
});

test('groupings cycle reason, type, none', () => {
  expect([...groupings]).toEqual(['reason', 'type', 'none']);
});

test('treeRows with no grouping gives only thread rows in input order, with no holder', () => {
  const threads = [
    makeThread('3', { repository: 'acme/zed', updatedAt: '2026-01-01T00:00:00Z' }),
    makeThread('1', { repository: 'acme/alpha', updatedAt: '2026-01-03T00:00:00Z' }),
    makeThread('2', { repository: 'acme/zed', updatedAt: '2026-01-02T00:00:00Z' }),
  ];

  const rows = treeRows(threads, 'none', new Set(['acme/zed']));

  expect(rows.map((row) => row.key)).toEqual(['thread:3', 'thread:1', 'thread:2']);
  expect(rows.every((row) => row.kind === 'thread')).toBe(true);

  expect(rows).toMatchObject([
    { depth: 0, nodeRowKey: null, last: false },
    { depth: 0, nodeRowKey: null, last: false },
    { depth: 0, nodeRowKey: null, last: false },
  ]);

  expect(buildTree(threads, 'none')).toEqual([]);
});

test('flattenTree hides the children of a folded node but keeps its row and threads', () => {
  const tree = buildTree(reasonFixture(), 'reason');
  const open = flattenTree(tree, new Set());
  const folded = flattenTree(tree, new Set(['review']));
  const reviewRow = folded.find((row) => row.kind === 'node' && row.nodeKey === 'review');

  expect(open.some((row) => row.key === 'thread:2')).toBe(true);
  expect(folded.some((row) => row.key === 'thread:2')).toBe(false);
  expect(folded.some((row) => row.key === 'node:review/acme/app')).toBe(false);
  expect(reviewRow).toMatchObject({ depth: 0, topLevel: true, folded: true });

  if (reviewRow?.kind === 'node') {
    expect(readIds(reviewRow.threads)).toEqual(['2', '6', '7']);
  }
});

test('flattenTree marks depth, the holding node, and the last thread of a node', () => {
  const tree = buildTree(reasonFixture(), 'reason');
  const rows = flattenTree(tree, new Set());
  const first = rows.find((row) => row.key === 'thread:2');
  const second = rows.find((row) => row.key === 'thread:6');

  expect(first).toMatchObject({ depth: 2, nodeRowKey: 'node:review/acme/app', last: false });
  expect(second).toMatchObject({ depth: 2, nodeRowKey: 'node:review/acme/app', last: true });
});

test('flattenTree gives every row a unique key in each grouping', () => {
  for (const grouping of groupings) {
    const rows = treeRows(reasonFixture(), grouping, new Set());
    const keys = rows.map((row) => row.key);

    expect(new Set(keys).size).toBe(keys.length);
  }
});

const pageOf = (overrides: Partial<NotificationThread>): BrowserPage =>
  pageOfThread(makeThread('1', { repository: 'octo/zeta', ...overrides }));

test('pageOfThread maps a pull request or issue to its number', () => {
  expect(pageOf({ subjectUrl: 'https://api.github.com/repos/octo/zeta/pulls/42' })).toEqual({
    kind: 'item',
    repository: 'octo/zeta',
    number: 42,
  });

  expect(
    pageOf({
      subjectType: 'Issue',
      subjectUrl: 'https://api.github.com/repos/octo/zeta/issues/7',
    }),
  ).toEqual({ kind: 'item', repository: 'octo/zeta', number: 7 });
});

test('pageOfThread maps a commit to its SHA', () => {
  expect(
    pageOf({
      subjectType: 'Commit',
      subjectUrl: 'https://api.github.com/repos/octo/zeta/commits/0a1b2c3d4e5f',
    }),
  ).toEqual({ kind: 'commit', repository: 'octo/zeta', sha: '0a1b2c3d4e5f' });
});

test('pageOfThread maps a release and a check suite to the repo pages that list them', () => {
  expect(pageOf({ subjectType: 'Release', subjectUrl: null })).toEqual({
    kind: 'releases',
    repository: 'octo/zeta',
  });

  expect(pageOf({ subjectType: 'CheckSuite', subjectUrl: null })).toEqual({
    kind: 'actions',
    repository: 'octo/zeta',
  });
});

test('pageOfThread falls back to the repo for other types and unreadable numbers or SHAs', () => {
  const repo = { kind: 'repo', repository: 'octo/zeta' } as const;

  expect(pageOf({ subjectType: 'Discussion', subjectUrl: null })).toEqual(repo);
  expect(pageOf({ subjectType: 'PullRequest', subjectUrl: null })).toEqual(repo);

  expect(
    pageOf({ subjectType: 'Issue', subjectUrl: 'https://api.github.com/x/issues/abc' }),
  ).toEqual(repo);

  expect(pageOf({ subjectType: 'Commit', subjectUrl: null })).toEqual(repo);

  expect(
    pageOf({
      subjectType: 'Commit',
      subjectUrl: 'https://api.github.com/repos/octo/zeta/commits/xyz',
    }),
  ).toEqual(repo);
});

const nodeRowOf = (threads: NotificationThread[]): NodeRow => ({
  kind: 'node',
  key: 'node:test',
  nodeKey: 'test',
  title: 'Test',
  depth: 0,
  topLevel: true,
  folded: false,
  threads,
});

test('pagesOfRow maps a thread row to its one page', () => {
  const thread = makeThread('1', { repository: 'octo/zeta' });

  const row: ThreadRow = {
    kind: 'thread',
    key: 'thread:1',
    thread,
    depth: 1,
    nodeRowKey: null,
    last: true,
  };

  expect(pagesOfRow(row)).toEqual([pageOfThread(thread)]);
});

test('pagesOfRow maps a repo node to its repo', () => {
  const row = nodeRowOf([
    makeThread('1', { repository: 'octo/zeta' }),
    makeThread('2', { repository: 'octo/zeta' }),
  ]);

  expect(pagesOfRow(row)).toEqual([{ kind: 'repo', repository: 'octo/zeta' }]);
});

test('pagesOfRow maps a group node to one repo page per distinct repo in listed order', () => {
  const row = nodeRowOf([
    makeThread('1', { repository: 'octo/b' }),
    makeThread('2', { repository: 'octo/a' }),
    makeThread('3', { repository: 'octo/a' }),
    makeThread('4', { repository: 'octo/c' }),
    makeThread('5', { repository: 'octo/b' }),
    makeThread('6', { repository: 'octo/a' }),
  ]);

  expect(pagesOfRow(row)).toEqual([
    { kind: 'repo', repository: 'octo/a' },
    { kind: 'repo', repository: 'octo/b' },
    { kind: 'repo', repository: 'octo/c' },
  ]);
});
