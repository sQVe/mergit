import { expect, test } from 'bun:test';

import {
  evaluate,
  filterCandidates,
  filterQuery,
  formatFilter,
  parseFilters,
  searchQuery,
} from './query.ts';
import type { Filter, Query } from './query.ts';
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

const repoMergit: Query = { type: 'repo', value: 'sqve/mergit' };

const pullRequest: Query = { type: 'kind', subjectType: 'PullRequest' };

const merged: Query = { type: 'state', value: 'merged' };

test('a pull request outside sqve/mergit is true only for pull requests in other repositories', () => {
  const query: Query = { type: 'and', terms: [pullRequest, not(repoMergit)] };

  expect(run(query, { thread: { repository: 'sqve/other' } })).toBe(true);
  expect(run(query, { thread: { repository: 'sqve/mergit' } })).toBe(false);
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
  const thread = { repository: 'Sqve/Mergit' };

  expect(run(repoMergit, { thread })).toBe(true);
  expect(run({ type: 'repo', value: 'sqve/merg' }, { thread })).toBe(false);
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

const filtersOf = (filterText: string): Filter[] => {
  const parsed = parseFilters(filterText);

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  return parsed.filters;
};

const runFilters = (filterText: string, overrides: Overrides = {}) => {
  const query = filterQuery(filtersOf(filterText));

  return query === null ? null : run(query, overrides);
};

test('negated filters of one field exclude each value', () => {
  const filterText = '-repo:a/x -repo:b/x';

  expect(runFilters(filterText, { thread: { repository: 'a/x' } })).toBe(false);
  expect(runFilters(filterText, { thread: { repository: 'b/x' } })).toBe(false);
  expect(runFilters(filterText, { thread: { repository: 'c/x' } })).toBe(true);
});

test('positive filters of one field match any value and fields must all match', () => {
  const filterText = 'repo:a/x repo:b/x kind:pr';

  expect(runFilters(filterText, { thread: { repository: 'a/x' } })).toBe(true);
  expect(runFilters(filterText, { thread: { repository: 'b/x' } })).toBe(true);
  expect(runFilters(filterText, { thread: { repository: 'c/x' } })).toBe(false);
  const issue = { repository: 'a/x', subjectType: 'Issue' };

  expect(runFilters(filterText, { thread: issue })).toBe(false);
});

test('an empty filter list gives no query', () => {
  expect(filterQuery([])).toBeNull();
  expect(filtersOf('  ')).toEqual([]);
});

test('a bot pattern excludes bot authors and keeps unknown authors unknown', () => {
  const filterText = '-author:*[bot]';

  expect(runFilters(filterText, { facts: facts({ author: 'dependabot[bot]' }) })).toBe(false);
  expect(runFilters(filterText, { facts: facts({ author: 'octocat' }) })).toBe(true);
  expect(runFilters(filterText)).toBe('unknown');
});

test('title keeps titles that contain the value, ignoring case', () => {
  const thread = { title: 'Chore: bump deps' };

  expect(runFilters('title:chore', { thread })).toBe(true);
  expect(runFilters('-title:chore', { thread })).toBe(false);
  expect(runFilters('-title:chore')).toBe(true);
  expect(runFilters('title:"fix the"')).toBe(true);
});

test('age compares with now', () => {
  const thread = { updatedAt: '2026-01-05T12:00:00Z' };

  expect(runFilters('age:>3d', { thread })).toBe(true);
  expect(runFilters('age:>3d')).toBe(false);
  expect(runFilters('age:<3d', { thread })).toBe(false);
});

test('an age without a unit is an error', () => {
  expect(parseFilters('age:>3').ok).toBe(false);
});

test('GitHub spellings parse to the same filters as the Mergit form', () => {
  expect(filtersOf('is:pr reason:review-requested')).toEqual([
    { field: 'kind', value: 'pr', negated: false },
    { field: 'reason', value: 'review_requested', negated: false },
  ]);

  expect(filtersOf('is:merged is:unread is:read author:app/dependabot')).toEqual([
    { field: 'state', value: 'merged', negated: false },
    { field: 'unread', value: 'true', negated: false },
    { field: 'unread', value: 'false', negated: false },
    { field: 'author', value: 'dependabot[bot]', negated: false },
  ]);
});

test('several tokens give several filters', () => {
  expect(filtersOf('author:@me state:open')).toEqual([
    { field: 'author', value: '@me', negated: false },
    { field: 'state', value: 'open', negated: false },
  ]);
});

test('one invalid token gives only an error that names it', () => {
  const parsed = parseFilters('state:open kind:bogus repo:a');

  expect(parsed.ok).toBe(false);
  expect(parsed.ok ? '' : parsed.error).toContain('kind:bogus');
});

test('invalid tokens are errors', () => {
  const invalid = ['nope:1', 'plain', 'repo:a*b*c', 'new:maybe', 'state:gone', 'reason:', 'kind:x'];

  for (const token of invalid) {
    expect(parseFilters(token).ok).toBe(false);
  }

  const unknownField = parseFilters('nope:1');

  expect(unknownField.ok ? '' : unknownField.error).toContain('author');
});

test('state:merged is unknown for a thread with no facts', () => {
  expect(runFilters('state:merged')).toBe('unknown');
  expect(runFilters('state:merged', { facts: facts({ state: 'merged' }) })).toBe(true);
});

test('a pattern with one star matches any run of characters', () => {
  expect(runFilters('repo:sqve/*')).toBe(true);
  expect(runFilters('repo:*/other')).toBe(true);
  expect(runFilters('org:SQ*')).toBe(true);
  expect(runFilters('repo:sqve/other*other')).toBe(false);
});

test('formatFilter prints text that parses to the same filter', () => {
  const filterText =
    '-repo:a/x kind:pr is:read reason:review-requested author:app/renovate title:"fix the" -title:chore age:>3d author:@me org:sqve';

  const filters = filtersOf(filterText);
  const printed = filters.map(formatFilter).join(' ');

  expect(filtersOf(printed)).toEqual(filters);
  expect(formatFilter(filters[1] as Filter)).toBe('kind:pr');
  expect(formatFilter(filters[2] as Filter)).toBe('unread:false');
  expect(formatFilter(filters[4] as Filter)).toBe('author:renovate[bot]');
  expect(formatFilter(filters[5] as Filter)).toBe('title:"fix the"');
});

test('candidates list fields, then values with whole-list counts', () => {
  const threads = [
    makeThread({ id: toThreadId('1'), repository: 'a/x' }),
    makeThread({ id: toThreadId('2'), repository: 'a/y', subjectType: 'Issue', unread: false }),
    makeThread({ id: toThreadId('3'), repository: 'a/y' }),
  ];

  const candidates = filterCandidates(threads, {
    factsOf: (thread) => (thread.id === toThreadId('3') ? facts({ author: 'mona' }) : undefined),
    isNew: (thread) => thread.id === toThreadId('1'),
    viewerLogin: 'mona',
  });

  const texts = candidates.values.map(
    (candidate) => `${candidate.field}:${candidate.value}=${candidate.count}`,
  );

  expect(candidates.fields).toContain('author');
  expect(texts).toContain('kind:pr=2');
  expect(texts).toContain('kind:issue=1');
  expect(texts).toContain('repo:a/y=2');
  expect(texts).toContain('org:a=3');
  expect(texts).toContain('author:mona=1');
  expect(texts).toContain('author:@me=1');
  expect(texts).toContain('state:open=1');
  expect(texts).toContain('new:true=1');
  expect(texts).toContain('unread:false=1');
  expect(texts).toContain('reason:review_requested=3');
  expect(texts).not.toContain('kind:release=0');
  expect(texts).not.toContain('state:merged=0');
});

test('inherited object keys are not kinds', () => {
  expect(parseFilters('kind:constructor').ok).toBe(false);
  expect(parseFilters('is:__proto__').ok).toBe(false);
  expect(parseFilters('is:constructor').ok).toBe(false);
});

test('an unterminated quote gives only an error that names the token', () => {
  const parsed = parseFilters('author:a title:"fix state:open');

  expect(parsed.ok).toBe(false);
  expect(parsed.ok ? '' : parsed.error).toContain('title:"fix state:open');
  expect('filters' in parsed).toBe(false);
});

test('reason matches exactly, ignoring case, and * is a literal character', () => {
  const reason = { type: 'reason', value: '*' } as const;

  expect(run(reason)).toBe(false);

  expect(
    run({ type: 'reason', value: 'review_requested' }, { thread: { reason: 'REVIEW_requested' } }),
  ).toBe(true);

  expect(runFilters('reason:*')).toBe(false);
  expect(runFilters('reason:review*')).toBe(false);
  expect(runFilters('reason:*', { thread: { reason: '*' } })).toBe(true);
});

test('filterQuery refuses filters with invalid values', () => {
  const invalid: Filter[] = [
    { field: 'kind', value: 'bogus', negated: false },
    { field: 'state', value: 'gone', negated: false },
    { field: 'age', value: '>3', negated: false },
    { field: 'new', value: 'maybe', negated: false },
    { field: 'unread', value: 'maybe', negated: false },
  ];

  for (const filter of invalid) {
    expect(() => filterQuery([filter])).toThrow();
  }
});

test('positive age chips combine as a range and positive title chips need both words', () => {
  const week = { thread: { updatedAt: '2026-01-02T12:00:00Z' } };
  const day = { thread: { updatedAt: '2026-01-09T12:00:00Z' } };
  const old = { thread: { updatedAt: '2025-11-01T12:00:00Z' } };

  expect(runFilters('age:>7d age:<30d', week)).toBe(true);
  expect(runFilters('age:>7d age:<30d', day)).toBe(false);
  expect(runFilters('age:>7d age:<30d', old)).toBe(false);

  const both = { thread: { title: 'fix auth bug' } };
  const one = { thread: { title: 'fix parser' } };

  expect(runFilters('title:fix title:auth', both)).toBe(true);
  expect(runFilters('title:fix title:auth', one)).toBe(false);
});

test('positive repo chips still match either repo', () => {
  expect(runFilters('repo:a/x repo:b/x', { thread: { repository: 'a/x' } })).toBe(true);
  expect(runFilters('repo:a/x repo:b/x', { thread: { repository: 'b/x' } })).toBe(true);
  expect(runFilters('repo:a/x repo:b/x', { thread: { repository: 'c/x' } })).toBe(false);
});

test('is:new parses to new:true and -is:new to -new:true', () => {
  expect(filtersOf('is:new')).toEqual([{ field: 'new', value: 'true', negated: false }]);
  expect(filtersOf('-is:new')).toEqual([{ field: 'new', value: 'true', negated: true }]);
});

test('a star matches an empty run', () => {
  expect(runFilters('repo:sqve/mergit*', { thread: { repository: 'sqve/mergit' } })).toBe(true);
});

test('an age filter without a clock is unknown', () => {
  const query: Query = { type: 'age', operator: '>', milliseconds: 7_200_000 };

  const result = evaluate(query, makeThread(), {
    facts: undefined,
    isNew: false,
    viewerLogin: null,
    now: null,
  });

  expect(result).toBe('unknown');
});

test('a thread exactly as old as the age filter is neither older nor newer', () => {
  const thread = { updatedAt: '2026-01-10T10:00:00Z' };
  const older: Query = { type: 'age', operator: '>', milliseconds: 7_200_000 };
  const newer: Query = { type: 'age', operator: '<', milliseconds: 7_200_000 };

  expect(run(older, { thread })).toBe(false);
  expect(run(newer, { thread })).toBe(false);
});

test('age text with extra characters is an error', () => {
  expect(parseFilters('age:x>3d').ok).toBe(false);
  expect(parseFilters('age:>3dx').ok).toBe(false);
});

test('an age amount of 0 is an error and 1 is a filter', () => {
  expect(parseFilters('age:>0d').ok).toBe(false);
  expect(parseFilters('age:>1d').ok).toBe(true);
});

test('only repo, org, and author take at most one star', () => {
  expect(parseFilters('org:a*b*c').ok).toBe(false);
  expect(parseFilters('author:a*b*c').ok).toBe(false);
  expect(parseFilters('repo:a*b*c').ok).toBe(false);
  expect(parseFilters('title:a*b*c').ok).toBe(true);
});

test('an unread value other than true or false is an error', () => {
  expect(parseFilters('unread:maybe').ok).toBe(false);
});

test('the app/ rewrite applies only to author', () => {
  expect(filtersOf('repo:app/x')).toEqual([{ field: 'repo', value: 'app/x', negated: false }]);
  expect(filtersOf('author:app/x')).toEqual([{ field: 'author', value: 'x[bot]', negated: false }]);
});

test('a token without a colon that starts with a field name is an error', () => {
  expect(parseFilters('titlex').ok).toBe(false);
  expect(parseFilters('repox').ok).toBe(false);
});

test('is: aliases apply only to is:', () => {
  expect(filtersOf('repo:unread')).toEqual([{ field: 'repo', value: 'unread', negated: false }]);
  expect(filtersOf('is:unread')).toEqual([{ field: 'unread', value: 'true', negated: false }]);
});

test('parsed new and unread filters keep their false value when evaluated', () => {
  expect(runFilters('unread:false', { thread: { unread: true } })).toBe(false);
  expect(runFilters('unread:false', { thread: { unread: false } })).toBe(true);
  expect(runFilters('new:false', { isNew: true })).toBe(false);
  expect(runFilters('new:false', { isNew: false })).toBe(true);
});

test('the @me author candidate counts only the viewer threads and needs a login', () => {
  const threads = [
    makeThread({ id: toThreadId('1') }),
    makeThread({ id: toThreadId('2') }),
    makeThread({ id: toThreadId('3') }),
  ];

  const factsOf = (thread: NotificationThread) =>
    facts({ author: thread.id === toThreadId('3') ? 'someone' : 'Mona' });

  const countsFor = (viewerLogin: string | null) =>
    filterCandidates(threads, { factsOf, isNew: () => false, viewerLogin }).values.filter(
      (candidate) => candidate.field === 'author' && candidate.value === '@me',
    );

  expect(countsFor('mona').map((candidate) => candidate.count)).toEqual([2]);
  expect(countsFor(null)).toEqual([]);
});

test('parsed new:true and unread:true match only a thread with the flag set', () => {
  expect(runFilters('unread:true', { thread: { unread: true } })).toBe(true);
  expect(runFilters('unread:true', { thread: { unread: false } })).toBe(false);
  expect(runFilters('new:true', { isNew: true })).toBe(true);
  expect(runFilters('new:true', { isNew: false })).toBe(false);
});
