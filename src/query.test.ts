import { expect, test } from 'bun:test';

import { evaluate, searchQuery } from './query.ts';
import type { Query } from './query.ts';
import type { NotificationThread, SubjectFacts } from './work/work.ts';
import { toThreadId } from './work/work.ts';

interface Overrides {
  thread?: Partial<NotificationThread>;
  facts?: SubjectFacts;
  isNew?: boolean;
  viewerLogin?: string | null;
}

const now = new Date('2026-01-10T12:00:00Z');

const makeThread = (overrides: Partial<NotificationThread> = {}): NotificationThread => ({
  id: toThreadId('1'),
  reason: 'review_requested',
  unread: true,
  updatedAt: '2026-01-10T11:00:00Z',
  lastReadAt: null,
  title: 'Fix the parser',
  subjectType: 'PullRequest',
  subjectUrl: null,
  repository: 'sqve/other',
  ...overrides,
});

const run = (query: Query, overrides: Overrides = {}) =>
  evaluate(query, makeThread(overrides.thread), {
    facts: overrides.facts,
    isNew: overrides.isNew ?? false,
    viewerLogin: overrides.viewerLogin ?? null,
    now,
  });

const facts = (overrides: Partial<SubjectFacts> = {}): SubjectFacts => ({
  state: 'open',
  author: 'octocat',
  latestActor: null,
  ...overrides,
});

const text = (value: string): Query => ({ type: 'text', value });

const not = (term: Query): Query => ({ type: 'not', term });

const repoZeta: Query = { type: 'repo', value: 'sqve/zeta' };

const pullRequest: Query = { type: 'kind', subjectType: 'PullRequest' };

const merged: Query = { type: 'state', value: 'merged' };

test('a pull request outside sqve/zeta is true only for pull requests in other repositories', () => {
  const query: Query = { type: 'and', terms: [pullRequest, not(repoZeta)] };

  expect(run(query, { thread: { repository: 'sqve/other' } })).toBe(true);
  expect(run(query, { thread: { repository: 'sqve/zeta' } })).toBe(false);
  expect(run(query, { thread: { repository: 'sqve/other', subjectType: 'Issue' } })).toBe(false);
});

test('text matches the title or the repository', () => {
  expect(run(text('parser'))).toBe(true);
  expect(run(text('sqve/other'))).toBe(true);
  expect(run(text('missing'))).toBe(false);
});

test('kind matches the subject type', () => {
  expect(run(pullRequest)).toBe(true);
  expect(run(pullRequest, { thread: { subjectType: 'Issue' } })).toBe(false);
});

test('repo and org compare exactly, ignoring case', () => {
  const thread = { repository: 'Sqve/Zeta' };

  expect(run(repoZeta, { thread })).toBe(true);
  expect(run({ type: 'repo', value: 'sqve/zet' }, { thread })).toBe(false);
  expect(run({ type: 'org', value: 'sqve' }, { thread })).toBe(true);
  expect(run({ type: 'org', value: 'sq' }, { thread })).toBe(false);
});

test('reason compares exactly, ignoring case', () => {
  expect(run({ type: 'reason', value: 'review_requested' })).toBe(true);
  expect(run({ type: 'reason', value: 'mention' })).toBe(false);
});

test('state is unknown without facts and compares with known facts', () => {
  expect(run(merged)).toBe('unknown');
  expect(run(not(merged))).toBe('unknown');
  expect(run(merged, { facts: facts({ state: 'merged' }) })).toBe(true);
  expect(run(not(merged), { facts: facts({ state: 'merged' }) })).toBe(false);
  expect(run(merged, { facts: facts({ state: 'open' }) })).toBe(false);
});

test('author matches a login and @me matches the viewer', () => {
  const known = { facts: facts({ author: 'Octocat' }), viewerLogin: 'octocat' };

  expect(run({ type: 'author', value: 'octocat' }, known)).toBe(true);
  expect(run({ type: 'author', value: 'other' }, known)).toBe(false);
  expect(run({ type: 'author', value: '@me' }, known)).toBe(true);
  expect(run({ type: 'author', value: '@me' }, { facts: facts() })).toBe('unknown');
  expect(run({ type: 'author', value: 'octocat' })).toBe('unknown');

  expect(run({ type: 'author', value: 'octocat' }, { facts: facts({ author: null }) })).toBe(
    'unknown',
  );
});

test('new and unread compare with the new flag and the unread flag', () => {
  expect(run({ type: 'new', value: true }, { isNew: true })).toBe(true);
  expect(run({ type: 'new', value: true })).toBe(false);
  expect(run({ type: 'unread', value: true })).toBe(true);
  expect(run({ type: 'unread', value: true }, { thread: { unread: false } })).toBe(false);
});

test('age compares the time since the last update with now', () => {
  const olderThanTwoHours: Query = { type: 'age', operator: '>', milliseconds: 7_200_000 };
  const newerThanTwoHours: Query = { type: 'age', operator: '<', milliseconds: 7_200_000 };

  expect(run(newerThanTwoHours)).toBe(true);
  expect(run(olderThanTwoHours)).toBe(false);
  expect(run(olderThanTwoHours, { thread: { updatedAt: '2026-01-10T09:00:00Z' } })).toBe(true);
  expect(run(olderThanTwoHours, { thread: { updatedAt: 'not a date' } })).toBe('unknown');
});

test('AND is false with one false term, unknown with an unknown term, and true otherwise', () => {
  expect(run({ type: 'and', terms: [pullRequest, text('parser')] })).toBe(true);
  expect(run({ type: 'and', terms: [pullRequest, text('missing')] })).toBe(false);
  expect(run({ type: 'and', terms: [pullRequest, merged] })).toBe('unknown');
  expect(run({ type: 'and', terms: [text('missing'), merged] })).toBe(false);
});

test('OR is true with one true term, unknown with an unknown term, and false otherwise', () => {
  expect(run({ type: 'or', terms: [text('missing'), text('parser')] })).toBe(true);
  expect(run({ type: 'or', terms: [text('missing'), text('absent')] })).toBe(false);
  expect(run({ type: 'or', terms: [text('missing'), merged] })).toBe('unknown');
  expect(run({ type: 'or', terms: [text('parser'), merged] })).toBe(true);
});

test('negation flips known values and keeps unknown', () => {
  expect(run(not(text('parser')))).toBe(false);
  expect(run(not(text('missing')))).toBe(true);
  expect(run(not(merged))).toBe('unknown');
});

test('searchQuery gives no query for blank text', () => {
  expect(searchQuery('')).toBeNull();
  expect(searchQuery('  \t ')).toBeNull();
});

test('searchQuery requires every word in the title or repository, ignoring case', () => {
  const query = searchQuery(' PARSER  Sqve/other ');

  expect(query).not.toBeNull();
  expect(run(query ?? text(''))).toBe(true);
  expect(run(searchQuery('parser missing') ?? text(''))).toBe(false);
});

test('searchQuery treats field syntax as plain text', () => {
  const query = searchQuery('repo:') ?? text('');

  expect(run(query)).toBe(false);
  expect(run(query, { thread: { title: 'Explain repo: syntax' } })).toBe(true);
});
