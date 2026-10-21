import { expect, test } from 'bun:test';

import type { NotificationThread } from '../work/work.ts';
import { filterRowsOf } from './session.ts';
import type { FilterRow } from './session.ts';
import {
  addFilters,
  describeRow,
  factsOf,
  filterThreads,
  loadWithAuthors,
  makeHarness,
  makeThread,
  octocat,
  releaseOf,
  rowSummaryOf,
  rowTexts,
  seenFor,
  settle,
  stateWithSeen,
} from './sessionHarness.ts';

const medianRowsTime = async (segments: number): Promise<number> => {
  const { session, load } = makeHarness();
  const longName = 'segment-'.repeat(segments);

  const threads = Array.from({ length: 500 }, (_, index) =>
    makeThread(String(index), {
      repository: `org-${index % 50}/${longName}${index % 250}`,
    }),
  );

  await load(...threads);
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'rep seg tent' });
  filterRowsOf(session.getSnapshot());

  const times = [0, 1, 2].map(() => {
    const started = performance.now();

    filterRowsOf(session.getSnapshot());

    return performance.now() - started;
  });

  return times.toSorted((left, right) => left - right)[1] ?? Infinity;
};

const fieldOfRow = (row: FilterRow): string | undefined => {
  if (row.kind === 'field') {
    return row.field;
  }

  return row.kind === 'candidate' || row.kind === 'active' ? row.filter.field : undefined;
};

test('a token that differs only by letter case from a chip is that chip, not a second one', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:ACME/APP' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows.filter((row) => row.kind === 'active')).toHaveLength(1);
  expect(rows.some((row) => row.kind === 'typed')).toBe(false);
});

test('the typed token counts open threads over the whole inbox, ignoring search and filters', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'editSearch', text: 'thread 1' });
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:hups-co/web' });

  expect(rowTexts(session)[0]).toBe('typed repo:hups-co/web 1');
});

test('an empty draft lists active chips, then values by count, then field names', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { repository: 'hups-co/platform' }),
    makeThread('2', { repository: 'hups-co/web' }),
    makeThread('3', { repository: 'acme/app' }),
    makeThread('4', { repository: 'acme/app' }),
    makeThread('5', { repository: 'acme/app' }),
  );

  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:hups-co/web');

  const rows = filterRowsOf(session.getSnapshot());
  const kinds = rows.map((row) => row.kind);
  const firstField = kinds.indexOf('field');
  const counts = rows.flatMap((row) => (row.kind === 'candidate' ? [row.count] : []));

  expect(rowSummaryOf(rows[0] as FilterRow)).toBe('active repo:hups-co/web');
  expect(rows.slice(1).some((row) => row.kind === 'active')).toBe(false);
  expect(kinds.slice(1, firstField).every((kind) => kind === 'candidate')).toBe(true);
  expect(kinds.slice(firstField).every((kind) => kind === 'field')).toBe(true);
  expect(counts).toEqual(counts.toSorted((left, right) => right - left));
  expect(rowSummaryOf(rows[1] as FilterRow)).toMatch(/^candidate /);
  expect(counts[0]).toBeGreaterThanOrEqual(3);
});

test('a contiguous field match outranks separated initials in a long value', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { repository: 'acme/platform' }),
    makeThread('2', { repository: 'react-event-processing-operator/service' }),
  );

  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo' });

  const summaries = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(summaries[0]).toBe('field repo');

  expect(summaries).toContain('candidate repo:acme/platform');
  expect(summaries).not.toContain('candidate org:react-event-processing-operator');
});

test('a contiguous field match outranks initials spread over short words', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { repository: 'acme/platform' }),
    makeThread('2', { repository: 'red-env-prod-ops/service' }),
  );

  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo' });

  const summaries = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(summaries).toContain('candidate repo:acme/platform');
  expect(summaries).not.toContain('candidate org:red-env-prod-ops');
});

test('an emoji in the draft finds an active title chip that holds it', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'title:"🚀 release"');
  session.send({ kind: 'editFilterDraft', text: '🚀' });

  const summaries = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(summaries).toContain('active title:"🚀 release"');
});

test('filterRowsOf time grows linearly with the length of candidate values', async () => {
  const shortTime = await medianRowsTime(50);
  const longTime = await medianRowsTime(200);

  expect(longTime / shortTime).toBeLessThan(6);
});

test('typing age lists its field row first', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'age' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows[0]).toEqual({ kind: 'field', field: 'age' });
});

test('org:hups-co lists one row whose count is the number of matching threads', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'org:hups-co' });

  const rows = filterRowsOf(session.getSnapshot());
  const orgRows = rows.filter((row) => describeRow(row).includes(' org:hups-co '));

  expect(orgRows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'typed', count: 2 });
});

test('the typed row counts only threads the filter is known to match', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'author:octo' });

  expect(filterRowsOf(session.getSnapshot())[0]).toMatchObject({ kind: 'typed', count: 0 });
});

test.each(['author:', 'age:>3'])('%s shows no error row while it is typed', async (draft) => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: draft });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);
});

test('foo: shows an error row at once', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
});

test('field rows exist only for fields that take a typed value', async () => {
  const { session } = await loadWithAuthors();

  const fieldsOf = (): string[] =>
    filterRowsOf(session.getSnapshot()).flatMap((row) => (row.kind === 'field' ? [row.field] : []));

  for (const field of ['repo', 'org', 'author', 'reason', 'age']) {
    expect(fieldsOf()).toContain(field);
  }

  for (const draft of ['new', 'unread', 'state', 'kind']) {
    session.send({ kind: 'editFilterDraft', text: draft });

    expect(fieldsOf()).not.toContain(draft);
  }

  session.send({ kind: 'editFilterDraft', text: 'age' });

  expect(fieldsOf()).toContain('age');
});

test('state lists state: values before reason:state_change', async () => {
  const harness = makeHarness();
  const threads = [makeThread('1', { reason: 'state_change' }), makeThread('2')];

  await harness.load(...threads);
  harness.lookups[0]?.resolve(threads.map((thread) => factsOf(thread, 'octo')));
  await settle();
  harness.session.send({ kind: 'openFilters' });
  harness.session.send({ kind: 'editFilterDraft', text: 'state' });

  const rows = filterRowsOf(harness.session.getSnapshot()).map(rowSummaryOf);

  expect(rows[0]).toBe('candidate state:open');

  expect(rows).not.toContain('candidate reason:state_change');
});

test('text inside an open quote is not a field name, but foo: still errors at once', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'title:"fix foo:' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
});

test('a bare colon shows no error row while typed', async () => {
  const { session } = await loadWithAuthors();

  for (const draft of [':', '-:', ':x']) {
    session.send({ kind: 'editFilterDraft', text: draft });

    expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);
  }
});

test('boolean fields list their true value first whatever the counts', async () => {
  const threads = ['1', '2', '3', '4'].map((id) => releaseOf(id));
  const [first, second, third] = threads;
  const seen = [first, second, third].map((thread) => [thread, thread?.updatedAt] as const);

  const savedState = stateWithSeen(
    seenFor(
      octocat,
      ...(seen as [[NotificationThread, string], ...[NotificationThread, string][]]),
    ),
  );

  const { session, load } = makeHarness({ savedState });

  await load(...threads);
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'new' });

  const rows = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(rows.indexOf('candidate new:false')).toBeGreaterThan(-1);
  expect(rows[0]).toBe('candidate new:true');

  session.send({ kind: 'editFilterDraft', text: '' });

  const all = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(all.indexOf('candidate new:true')).toBeLessThan(all.indexOf('candidate new:false'));
});

test('a single term that starts a field name lists only that field, and several terms match across fields', async () => {
  const harness = makeHarness();

  const threads = [
    makeThread('1', { reason: 'state_change', repository: 'rep-platform/app' }),
    makeThread('2', { repository: 'hups-co/platform' }),
  ];

  await harness.load(...threads);
  harness.lookups[0]?.resolve(threads.map((thread) => factsOf(thread, 'octo')));
  await settle();
  harness.session.send({ kind: 'openFilters' });

  const { session } = harness;

  for (const [draft, field] of [
    ['age', 'age'],
    ['state', 'state'],
    ['rep', 'repo'],
    ['unr', 'unread'],
  ] as const) {
    session.send({ kind: 'editFilterDraft', text: draft });

    const fields = new Set(filterRowsOf(session.getSnapshot()).map(fieldOfRow));

    expect([...fields]).toEqual([field]);
  }

  session.send({ kind: 'editFilterDraft', text: 'rep plat' });

  const fields = new Set(filterRowsOf(session.getSnapshot()).map(fieldOfRow));

  expect(fields.has('repo')).toBe(true);
  expect(fields.has('org')).toBe(true);
});

test.each(['repo:a foo:', 'repo:a -foo:', 'title:"fix it" foo:'])(
  'an unknown field in a later token of %s shows an error row at once',
  async (draft) => {
    const { session } = await loadWithAuthors();

    session.send({ kind: 'editFilterDraft', text: draft });

    expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
  },
);

test('a field-like word in an open quote at the start of the draft shows no error row', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: '"fix foo:' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);
});

test('an active false chip does not move false before true when the field is typed', async () => {
  const threads = [
    makeThread('1', { unread: false, lastReadAt: '2026-01-02T11:00:00Z' }),
    makeThread('2', { unread: false, lastReadAt: '2026-01-02T11:00:00Z' }),
    makeThread('3', { unread: false, lastReadAt: '2026-01-02T11:00:00Z' }),
    makeThread('4'),
  ];

  const { session, load } = makeHarness();

  await load(...threads);
  session.send({ kind: 'openFilters' });
  addFilters(session, 'unread:false');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'unread' });

  const rows = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(rows.indexOf('candidate unread:true')).toBeGreaterThan(-1);
  expect(rows.indexOf('active unread:false')).toBeGreaterThan(-1);
  expect(rows.indexOf('candidate unread:true')).toBeLessThan(rows.indexOf('active unread:false'));
});

test('a negated chip is not listed as an active row for a draft without a minus', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, '-repo:acme/app');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'active')).toBe(false);

  session.send({ kind: 'editFilterDraft', text: '-repo' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'active')).toBe(true);
});

test('a field that matches without being a prefix is listed last', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'ae' });

  const rows = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(rows.at(-1)).toBe('field age');
});

test('a typed row with two tokens does not hide the candidate for one of them', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app repo:acme' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows[0]).toMatchObject({ kind: 'typed' });
  expect(rows.slice(1).map(rowSummaryOf)).toContain('candidate repo:acme/app');
});

test('an active chip typed in full is followed by the other matching candidates', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads(), makeThread('4', { repository: 'acme/app-two' }));
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });

  const rows = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(rows[0]).toBe('active repo:acme/app');
  expect(rows).toContain('candidate repo:acme/app-two');
  expect(rows).toHaveLength(2);
});
