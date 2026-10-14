import { expect, test } from 'bun:test';

import { evaluate, parse } from './query.ts';
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

const run = (text: string, overrides: Overrides = {}) => {
  const result = parse(text);

  if (!result.ok) {
    throw new Error(`Expected "${text}" to parse: ${result.error.message}`);
  }

  return evaluate(result.query, makeThread(overrides.thread), {
    facts: overrides.facts,
    isNew: overrides.isNew ?? false,
    viewerLogin: overrides.viewerLogin ?? null,
    now,
  });
};

const failure = (text: string) => {
  const result = parse(text);

  if (result.ok) {
    throw new Error(`Expected "${text}" to fail`);
  }

  return result.error;
};

const facts = (overrides: Partial<SubjectFacts> = {}): SubjectFacts => ({
  state: 'open',
  author: 'octocat',
  latestActor: null,
  ...overrides,
});

test('is:pr -repo:sqve/zeta is true only for pull requests outside sqve/zeta', () => {
  const text = 'is:pr -repo:sqve/zeta';

  expect(run(text, { thread: { repository: 'sqve/other' } })).toBe(true);
  expect(run(text, { thread: { repository: 'sqve/zeta' } })).toBe(false);
  expect(run(text, { thread: { repository: 'sqve/other', subjectType: 'Issue' } })).toBe(false);
});

test('state:merged and its negation are unknown without facts', () => {
  expect(run('state:merged')).toBe('unknown');
  expect(run('-state:merged')).toBe('unknown');
  expect(run('state:merged', { facts: facts({ state: 'merged' }) })).toBe(true);
  expect(run('-state:merged', { facts: facts({ state: 'merged' }) })).toBe(false);
  expect(run('state:merged', { facts: facts({ state: 'open' }) })).toBe(false);
});

test('parse reports the position just after the colon for an empty value', () => {
  const error = failure('repo:');

  expect(error.position).toBe(5);
  expect(failure('is:pr -org:').position).toBe(11);
});

test('a value must be complete, so kind:p fails at the value', () => {
  expect(failure('kind:p').position).toBe(5);
  expect(failure('state:ope').position).toBe(6);
  expect(failure('is:merg').position).toBe(3);
});

test('parse reports an unknown field at its start', () => {
  expect(failure('is:pr color:red').position).toBe(6);
});

test('parse reports parenthesis and OR errors with a position', () => {
  expect(failure('(is:pr').position).toBe(0);
  expect(failure('is:pr)').position).toBe(5);
  expect(failure('is:pr ()').position).toBe(6);
  expect(failure('OR is:pr').position).toBe(0);
  expect(failure('is:pr OR').position).toBe(6);
  expect(failure('is:pr OR )').position).toBe(6);
  expect(failure('kind:pr,').position).toBe(8);
});

test('a parenthesis at the end of the text fails at that parenthesis', () => {
  const unclosed = failure('(is:pr');

  expect(failure('is:pr (')).toEqual({ ...unclosed, position: 6 });
});

test('parse does not throw and gives each error its own message', () => {
  const messages = ['foo:bar', 'repo:', 'kind:x', '(a', 'a)', '()', 'OR a'].map(
    (text) => failure(text).message,
  );

  expect(new Set(messages).size).toBe(messages.length);
});

test('empty and whitespace-only text matches every thread', () => {
  expect(run('')).toBe(true);
  expect(run('   ')).toBe(true);
});

test('plain words match the title or the repository, ignoring case', () => {
  expect(run('PARSER')).toBe(true);
  expect(run('sqve/oth')).toBe(true);
  expect(run('parser other')).toBe(true);
  expect(run('missing')).toBe(false);
  expect(run('-parser')).toBe(false);
});

test('a space means AND and AND binds tighter than OR', () => {
  expect(run('is:issue OR is:pr unread:true')).toBe(true);
  expect(run('is:issue OR is:pr unread:false')).toBe(false);
  expect(run('is:pr OR is:issue')).toBe(true);
  expect(run('is:release OR is:issue')).toBe(false);
});

test('parentheses group terms', () => {
  expect(run('(is:issue OR is:pr) unread:false')).toBe(false);
  expect(run('(is:issue OR is:pr) unread:true')).toBe(true);
  expect(run('-(is:issue OR is:pr)')).toBe(false);
});

test('a comma inside a value means OR, and a negation excludes all of them', () => {
  expect(run('kind:issue,pr')).toBe(true);
  expect(run('kind:issue,release')).toBe(false);
  expect(run('-kind:pr,issue')).toBe(false);
  expect(run('-kind:release,issue')).toBe(true);
});

test('unknown stays unknown through AND, OR, and NOT', () => {
  expect(run('state:merged is:pr')).toBe('unknown');
  expect(run('state:merged is:issue')).toBe(false);
  expect(run('state:merged OR is:pr')).toBe(true);
  expect(run('state:merged OR is:issue')).toBe('unknown');
  expect(run('-(state:merged OR is:issue)')).toBe('unknown');
});

test('kind values map to subject types', () => {
  const types = {
    pr: 'PullRequest',
    issue: 'Issue',
    release: 'Release',
    discussion: 'Discussion',
    commit: 'Commit',
    ci: 'CheckSuite',
  };

  for (const [value, subjectType] of Object.entries(types)) {
    expect(run(`kind:${value.toUpperCase()}`, { thread: { subjectType } })).toBe(true);
    expect(run(`kind:${value}`, { thread: { subjectType: 'Other' } })).toBe(false);
  }
});

test('author matches a login and @me matches the viewer', () => {
  expect(run('author:octocat', { facts: facts() })).toBe(true);
  expect(run('author:hubot', { facts: facts() })).toBe(false);
  expect(run('author:@me', { facts: facts(), viewerLogin: 'octocat' })).toBe(true);
  expect(run('author:@me', { facts: facts(), viewerLogin: 'hubot' })).toBe(false);
  expect(run('author:@me', { facts: facts(), viewerLogin: null })).toBe('unknown');
  expect(run('author:octocat')).toBe('unknown');
  expect(run('author:octocat', { facts: facts({ author: null }) })).toBe('unknown');
});

test('is:new and is:unread compare with the new flag and the unread flag', () => {
  expect(run('is:new', { isNew: true })).toBe(true);
  expect(run('is:new', { isNew: false })).toBe(false);
  expect(run('new:false', { isNew: false })).toBe(true);
  expect(run('is:unread', { thread: { unread: true } })).toBe(true);
  expect(run('is:unread', { thread: { unread: false } })).toBe(false);
  expect(run('is:read', { thread: { unread: false } })).toBe(true);
});

test('org and reason compare exactly, ignoring case', () => {
  expect(run('org:sqve')).toBe(true);
  expect(run('org:SQVE')).toBe(true);
  expect(run('org:sq')).toBe(false);
  expect(run('reason:review_requested')).toBe(true);
  expect(run('reason:mention')).toBe(false);
});

test('age compares the time since the last update with now', () => {
  const old = { updatedAt: '2026-01-01T12:00:00Z' };
  const recent = { updatedAt: '2026-01-10T11:00:00Z' };

  expect(run('age:>7d', { thread: old })).toBe(true);
  expect(run('age:>7d', { thread: recent })).toBe(false);
  expect(run('age:<2h', { thread: recent })).toBe(true);
  expect(run('age:<2h', { thread: old })).toBe(false);
  expect(run('age:>1w', { thread: old })).toBe(true);
  expect(run('age:>30m', { thread: recent })).toBe(true);
});

test('age needs an operator, a number, and a unit', () => {
  expect(failure('age:7d').position).toBe(4);
  expect(failure('age:>7').position).toBe(4);
  expect(failure('age:>d').position).toBe(4);
});
