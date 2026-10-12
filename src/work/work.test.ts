import { expect, test } from 'bun:test';

import type { NotificationThread } from './work.ts';
import {
  buildTree,
  flattenTree,
  groupings,
  isDoneOnGitHub,
  readSubjectNumber,
  selectOpenThreads,
  toThreadId,
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

  const open = selectOpenThreads([unread, done, readWithTimestamp, unreadWithTimestamp]);

  expect(open).toEqual([unread, readWithTimestamp, unreadWithTimestamp]);
});

test('selectOpenThreads keeps a thread without a subject URL', () => {
  const checkSuite = makeThread('5', { subjectType: 'CheckSuite', subjectUrl: null });

  expect(selectOpenThreads([checkSuite])).toEqual([checkSuite]);
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

test('buildTree by repo sorts repos by thread count, then by name', () => {
  const threads = [
    makeThread('1', { repository: 'acme/zed' }),
    makeThread('2', { repository: 'acme/beta' }),
    makeThread('3', { repository: 'acme/alpha' }),
    makeThread('4', { repository: 'acme/zed' }),
  ];

  const tree = buildTree(threads, 'repo');

  expect(tree.map((node) => node.key)).toEqual(['acme/zed', 'acme/alpha', 'acme/beta']);
  expect(readIds(tree[0]?.threads ?? [])).toEqual(['1', '4']);
});

test('buildTree with no grouping sorts repos by their newest thread', () => {
  const threads = [
    makeThread('1', { repository: 'acme/old', updatedAt: '2026-01-01T00:00:00Z' }),
    makeThread('2', { repository: 'acme/new', updatedAt: '2026-01-03T00:00:00Z' }),
    makeThread('3', { repository: 'acme/old', updatedAt: '2026-01-02T00:00:00Z' }),
  ];

  const tree = buildTree(threads, 'none');

  expect(tree.map((node) => node.key)).toEqual(['acme/new', 'acme/old']);
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
    const rows = flattenTree(buildTree(reasonFixture(), grouping), new Set());
    const keys = rows.map((row) => row.key);

    expect(new Set(keys).size).toBe(keys.length);
  }
});
