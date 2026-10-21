import { expect, test } from 'bun:test';

import type { NotificationThread } from './work.ts';
import { toThreadId } from './work.ts';
import { buildTree, flattenTree, groupings, treeRows } from './workTree.ts';

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

test('buildTree by reason puts each reason in its own group', () => {
  const reasons = [
    ['mention', 'mention'],
    ['assign', 'assigned'],
    ['author', 'author'],
    ['comment', 'comment'],
    ['state_change', 'state'],
    ['subscribed', 'subscribed'],
    ['manual', 'subscribed'],
    ['ci_activity', 'ci'],
  ] as const;

  for (const [reason, key] of reasons) {
    const tree = buildTree([makeThread('1', { reason })], 'reason');

    expect(tree.map((node) => node.key)).toEqual([key]);
    expect(readIds(tree[0]?.threads ?? [])).toEqual(['1']);
  }
});

test('buildTree sorts repo nodes by thread count, then by name', () => {
  const threads = [
    makeThread('1', { repository: 'acme/zed' }),
    makeThread('2', { repository: 'acme/zed' }),
    makeThread('3', { repository: 'acme/mid' }),
    makeThread('4', { repository: 'acme/alpha' }),
  ];

  const [group] = buildTree(threads, 'reason');

  expect(group?.children.map((node) => node.title)).toEqual(['acme/zed', 'acme/alpha', 'acme/mid']);
});
