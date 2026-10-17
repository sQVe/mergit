import { expect, test } from 'bun:test';

import type { NotificationThread } from '../work/work.ts';
import { filterCursorOf, filterRowsOf, formatFilter } from './session.ts';
import type { FilterRow } from './session.ts';
import {
  addFilters,
  describeRow,
  factsOf,
  makeHarness,
  makeThread,
  octocat,
  releaseOf,
  seenFor,
  settle,
  sortedThreadKeysOf,
  stateWithSeen,
} from './sessionHarness.ts';

const filterThreads = () => [
  makeThread('1', { repository: 'hups-co/platform' }),
  makeThread('2', { repository: 'hups-co/web' }),
  makeThread('3', { repository: 'acme/app' }),
];

test('applyFilterRow on a negated repo token hides that repo and keeps the others', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, '-repo:hups-co/platform');

  expect(session.getSnapshot().filters).toEqual([
    { field: 'repo', value: 'hups-co/platform', negated: true },
  ]);

  expect(sortedThreadKeysOf(session)).toEqual(['thread:2', 'thread:3']);
  expect(session.getSnapshot().filterDraft).toBe('');
  expect(session.getSnapshot().filtersOpen).toBe(false);
});

test('applyFilterRow on a candidate row adds the chip and closes the composer', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'down' });

  const snapshot = session.getSnapshot();
  const row = filterRowsOf(snapshot)[filterCursorOf(snapshot)];

  expect(row?.kind).toBe('candidate');

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual(row?.kind === 'candidate' ? [row.filter] : []);

  expect(session.getSnapshot().filtersOpen).toBe(false);
});

test('applyFilterRow while editing replaces the chip and closes the composer', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'repo:hups-co/web' });
  session.send({ kind: 'applyFilterRow' });

  const snapshot = session.getSnapshot();

  expect(snapshot.filters).toEqual([{ field: 'repo', value: 'hups-co/web', negated: false }]);
  expect(snapshot.filterEditing).toBeNull();
  expect(snapshot.filtersOpen).toBe(false);
});

test('applyFilterRow on an invalid entry keeps the composer open with an error', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'nope:1');

  const snapshot = session.getSnapshot();

  expect(snapshot.filters).toEqual([]);
  expect(snapshot.filtersOpen).toBe(true);
  expect(filterRowsOf(snapshot)[0]?.kind).toBe('error');
});

test('applyFilterRow on an active filter removes it and keeps the composer open', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filtersOpen).toBe(true);
});

test('applyFilterRow on an active filter removes it', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');

  expect(sortedThreadKeysOf(session)).toEqual(['thread:3']);

  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
});

test('age:>3d keeps only older threads, and the list does not change while it is typed', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { updatedAt: '2026-01-02T10:00:00Z' }),
    makeThread('2', { updatedAt: '2026-01-31T12:00:00Z' }),
    makeThread('3', { updatedAt: '2026-01-20T12:00:00Z' }),
  );

  session.send({ kind: 'openFilters' });

  const before = sortedThreadKeysOf(session);
  const token = 'age:>3d';

  for (let length = 1; length <= token.length; length += 1) {
    session.send({ kind: 'editFilterDraft', text: token.slice(0, length) });

    expect(sortedThreadKeysOf(session)).toEqual(before);
  }

  session.send({ kind: 'applyFilterRow' });

  expect(before).toEqual(['thread:1', 'thread:2', 'thread:3']);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:3']);
});

test('editing age:>3d to age:>14d replaces the filter', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('age:>3d');

  addFilters(session, 'age:>14d');

  expect(session.getSnapshot().filters).toEqual([
    { field: 'age', value: '>14d', negated: false },
    { field: 'repo', value: 'acme/app', negated: false },
  ]);

  expect(session.getSnapshot().filterEditing).toBeNull();
});

test('closeFilters during an edit cancels the edit and keeps age:>3d', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'age:>14d' });
  session.send({ kind: 'closeFilters' });

  const snapshot = session.getSnapshot();

  expect(snapshot.filters).toEqual([{ field: 'age', value: '>3d', negated: false }]);
  expect(snapshot.filterEditing).toBeNull();
  expect(snapshot.filterDraft).toBe('');
  expect(snapshot.filtersOpen).toBe(true);

  session.send({ kind: 'closeFilters' });

  expect(session.getSnapshot().filtersOpen).toBe(false);
});

test('leaveFilters during an edit closes the composer and keeps the old chip', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: '' });
  session.send({ kind: 'leaveFilters' });

  const snapshot = session.getSnapshot();

  expect(snapshot.filters).toEqual([{ field: 'age', value: '>3d', negated: false }]);
  expect(snapshot.filtersOpen).toBe(false);
  expect(snapshot.filterEditing).toBeNull();
  expect(snapshot.filterDraft).toBe('');
});

test('typing an invalid token changes neither filters nor rows and applyFilterRow adds nothing', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');

  const before = sortedThreadKeysOf(session);

  session.send({ kind: 'editFilterDraft', text: 'age:>3' });

  expect(session.getSnapshot().filters).toHaveLength(1);
  expect(sortedThreadKeysOf(session)).toEqual(before);

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(1);
  expect(sortedThreadKeysOf(session)).toEqual(before);
});

test('two tokens in one draft add two filters', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'org:hups-co -repo:hups-co/web');

  expect(session.getSnapshot().filters).toHaveLength(2);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1']);
});

test('the same filter is not added twice', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'org:hups-co org:hups-co');

  expect(session.getSnapshot().filters).toHaveLength(1);
});

test('clearFilters empties the filters and shows every thread', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'clearFilters' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
});

test('a thread with unknown state stays visible under state:merged', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'state:merged');

  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
});

test('composer rows list active filters, then values, then fields when the draft is empty', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');

  const rows = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(rows[0]).toBe('active repo:acme/app');
  expect(rows[1]).toMatch(/^candidate /);
  expect(rows).toContain('field repo');
  expect(rows).not.toContain('field kind');
  expect(rows.at(-1)).toMatch(/^field /);
  expect(filterCursorOf(session.getSnapshot())).toBe(-1);
});

test('composer rows start with the typed token and its count, then matching candidates', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:hups' });

  const rows = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(rows[0]).toBe('typed repo:hups 0');
  expect(rows).toContain('candidate repo:hups-co/platform 1');
  expect(rows).not.toContain('candidate repo:acme/app 1');

  session.send({ kind: 'editFilterDraft', text: 'age:>3' });

  expect(filterRowsOf(session.getSnapshot()).map(describeRow)).toEqual([]);

  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });

  const typed = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(typed[0]).toBe('active repo:acme/app 1');
  expect(typed.filter((row) => row.includes('repo:acme/app'))).toHaveLength(1);
  expect(filterCursorOf(session.getSnapshot())).toBe(0);
});

test('takeFilterRow on a field puts the field name in the draft and moveFilterCursor stays in range', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'up' });

  expect(filterCursorOf(session.getSnapshot())).toBe(
    filterRowsOf(session.getSnapshot()).length - 1,
  );

  session.send({ kind: 'editFilterDraft', text: 'rep' });

  const rows = filterRowsOf(session.getSnapshot());
  const fieldAt = rows.findIndex((row) => row.kind === 'field' && row.field === 'repo');

  for (let step = 0; step < fieldAt; step += 1) {
    session.send({ kind: 'moveFilterCursor', direction: 'down' });
  }

  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('repo:');
  expect(session.getSnapshot().filters).toEqual([]);
});

test('completing a field name with Tab keeps a leading minus, so the filter excludes', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-age' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('-age:');

  session.send({ kind: 'editFilterDraft', text: '-age:>3d' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([{ field: 'age', value: '>3d', negated: true }]);
});

test('completing a field name with Enter keeps a leading minus', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-ag' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('-age:');
  expect(session.getSnapshot().filters).toEqual([]);
});

const rowTexts = (session: ReturnType<typeof makeHarness>['session']) =>
  filterRowsOf(session.getSnapshot()).map(describeRow);

const moveCursorTo = (session: ReturnType<typeof makeHarness>['session'], text: string) => {
  for (
    let step = 0;
    step < 50 && rowTexts(session)[filterCursorOf(session.getSnapshot())] !== text;
    step += 1
  ) {
    session.send({ kind: 'moveFilterCursor', direction: 'down' });
  }

  expect(rowTexts(session)[filterCursorOf(session.getSnapshot())]).toBe(text);
};

test('typing a field name lists a matching active filter that is not an inbox value, and it can be edited', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  session.send({ kind: 'editFilterDraft', text: 'age:' });

  expect(rowTexts(session)).toContain('active age:>3d');

  moveCursorTo(session, 'active age:>3d');
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('age:>3d');

  addFilters(session, 'age:>14d');

  expect(session.getSnapshot().filters).toEqual([{ field: 'age', value: '>14d', negated: false }]);
});

test('an active inbox value reached by typing is taken as an edit and applied as a removal', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:acme' });
  moveCursorTo(session, 'active repo:acme/app 1');
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterEditing).toEqual({
    field: 'repo',
    value: 'acme/app',
    negated: false,
  });

  session.send({ kind: 'closeFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme' });
  moveCursorTo(session, 'active repo:acme/app 1');
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
});

test('picking a completion during an edit replaces the edited filter', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'repo:' });
  moveCursorTo(session, 'candidate repo:hups-co/web 1');
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'repo', value: 'hups-co/web', negated: false },
  ]);
});

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

const rowSummaryOf = (row: FilterRow): string => {
  if (row.kind === 'candidate' || row.kind === 'active') {
    return `${row.kind} ${formatFilter(row.filter)}`;
  }

  return row.kind === 'field' ? `field ${row.field}` : row.kind;
};

test.each(['repplat', 'rep plat'])(
  '%s lists repo:hups-co/platform first and adds it',
  async (draft) => {
    const { session, load } = makeHarness();

    await load(...filterThreads());
    session.send({ kind: 'openFilters' });
    session.send({ kind: 'editFilterDraft', text: draft });

    const rows = filterRowsOf(session.getSnapshot());

    expect(rows.map(rowSummaryOf)[0]).toBe('candidate repo:hups-co/platform');

    session.send({ kind: 'applyFilterRow' });

    expect(session.getSnapshot().filters).toEqual([
      { field: 'repo', value: 'hups-co/platform', negated: false },
    ]);
  },
);

test('-rep plat lists the negated candidate first and adds a negated filter', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-rep plat' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows.map(rowSummaryOf)[0]).toBe('candidate -repo:hups-co/platform');

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'repo', value: 'hups-co/platform', negated: true },
  ]);
});

test('loose text shows no error row, a bad token does, and a miss starts on the best candidate', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'rep plat' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');

  session.send({ kind: 'editFilterDraft', text: 'repo:plat' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows[0]).toMatchObject({ kind: 'typed', count: 0 });
  expect(rowSummaryOf(rows[1] as FilterRow)).toBe('candidate repo:hups-co/platform');
  expect(filterCursorOf(session.getSnapshot())).toBe(1);
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

test('filterRowsOf time grows linearly with the length of candidate values', async () => {
  const shortTime = await medianRowsTime(50);
  const longTime = await medianRowsTime(200);

  expect(longTime / shortTime).toBeLessThan(6);
});

const loadWithAuthors = async () => {
  const harness = makeHarness();
  const threads = filterThreads();

  await harness.load(...threads);
  harness.lookups[0]?.resolve(threads.map((thread) => factsOf(thread, 'octo')));
  await settle();
  harness.session.send({ kind: 'openFilters' });

  return harness;
};

test('Enter on the error row of foo: adds no chip', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');

  session.send({ kind: 'applyFilterRow' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filterDraft).toBe('foo:');
});

test('with an empty draft Enter and Tab do nothing, and Down then Enter applies the first row', async () => {
  const { session } = await loadWithAuthors();
  const first = filterRowsOf(session.getSnapshot())[0];

  session.send({ kind: 'applyFilterRow' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filterDraft).toBe('');

  session.send({ kind: 'moveFilterCursor', direction: 'down' });

  expect(first?.kind).toBe('candidate');

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(1);
});

test('with an empty draft Up selects the last row, and clearing the draft drops the selection', async () => {
  const { session } = await loadWithAuthors();
  const rows = filterRowsOf(session.getSnapshot());

  session.send({ kind: 'moveFilterCursor', direction: 'up' });

  expect(filterCursorOf(session.getSnapshot())).toBe(rows.length - 1);

  session.send({ kind: 'editFilterDraft', text: 'kind' });
  session.send({ kind: 'editFilterDraft', text: '' });

  expect(filterCursorOf(session.getSnapshot())).toBe(-1);
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

test('author: starts on its first candidate and Enter adds it', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'author:' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows[filterCursorOf(session.getSnapshot())]).toMatchObject({ kind: 'candidate' });

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'author', value: 'octo', negated: false },
  ]);
});

test('Enter on age:>3 with no row selected shows an error row and adds no chip', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'age:>3' });
  session.send({ kind: 'applyFilterRow' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
  expect(session.getSnapshot().filters).toEqual([]);

  session.send({ kind: 'editFilterDraft', text: 'age:>3d' });

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

test('typing an active chip token shows one marked row; Tab edits it and Enter removes it', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });

  const rows = filterRowsOf(session.getSnapshot());
  const matching = rows.filter((row) => rowSummaryOf(row) === 'active repo:acme/app');

  expect(matching).toHaveLength(1);
  expect(rows.filter((row) => row.kind === 'typed')).toEqual([]);
  expect(rows[filterCursorOf(session.getSnapshot())]).toBe(matching[0]);

  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterEditing).toEqual({
    field: 'repo',
    value: 'acme/app',
    negated: false,
  });

  session.send({ kind: 'closeFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
});

test('Enter on another active chip while editing replaces the edited chip with it', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'author:mona');
  addFilters(session, 'author:octo');
  session.send({ kind: 'editFilterDraft', text: 'author:mona' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'author:octo' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'author', value: 'octo', negated: false },
  ]);
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

const fieldOfRow = (row: FilterRow): string | undefined => {
  if (row.kind === 'field') {
    return row.field;
  }

  return row.kind === 'candidate' || row.kind === 'active' ? row.filter.field : undefined;
};

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

test('after Enter removes an active chip the next Enter removes the chip now under the cursor', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'repo:acme/app');
  addFilters(session, 'repo:hups-co/web');
  addFilters(session, 'kind:pr');
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(2);

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(1);

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
});

test('Enter on age:<0m adds no chip and shows an error row', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'age:<0m' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
});

test('a chip is a duplicate only when field, sign, and value all match', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'openFilters' });
  addFilters(session, '-repo:acme/app');

  expect(session.getSnapshot().filters).toEqual([
    { field: 'repo', value: 'acme/app', negated: false },
    { field: 'repo', value: 'acme/app', negated: true },
  ]);

  session.send({ kind: 'openFilters' });
  addFilters(session, 'org:acme/app');

  expect(session.getSnapshot().filters).toHaveLength(3);

  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:hups-co/web');

  expect(session.getSnapshot().filters).toHaveLength(4);
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

test('a whitespace-only draft lists the same rows as an empty draft', async () => {
  const { session } = await loadWithAuthors();

  const empty = filterRowsOf(session.getSnapshot());

  session.send({ kind: 'editFilterDraft', text: '  ' });

  expect(filterRowsOf(session.getSnapshot())).toEqual(empty);
  expect(filterCursorOf(session.getSnapshot())).toBe(-1);
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

test('the cursor stays on the last row when a refresh removes a candidate', async () => {
  const harness = makeHarness();
  const { session, load } = harness;

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'up' });

  const before = filterRowsOf(session.getSnapshot()).length;

  expect(filterCursorOf(session.getSnapshot())).toBe(before - 1);

  await load(...filterThreads().slice(0, 2));

  const after = filterRowsOf(session.getSnapshot()).length;

  expect(after).toBeLessThan(before);
  expect(filterCursorOf(session.getSnapshot())).toBe(after - 1);
});

test('moveFilterCursor up from a selected row selects the row above', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'moveFilterCursor', direction: 'down' });

  expect(filterCursorOf(session.getSnapshot())).toBe(1);

  session.send({ kind: 'moveFilterCursor', direction: 'up' });

  expect(filterCursorOf(session.getSnapshot())).toBe(0);

  session.send({ kind: 'moveFilterCursor', direction: 'up' });

  expect(filterCursorOf(session.getSnapshot())).toBe(0);
});

test('Tab on a field row after a leading space and a minus keeps the minus', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: ' -rep' });

  const snapshot = session.getSnapshot();

  expect(filterRowsOf(snapshot)[filterCursorOf(snapshot)]).toEqual({
    kind: 'field',
    field: 'repo',
  });

  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('-repo:');
});

test('Tab on a candidate value row puts the filter in the draft without editing a chip', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme' });
  session.send({ kind: 'moveFilterCursor', direction: 'down' });

  const snapshot = session.getSnapshot();
  const row = filterRowsOf(snapshot)[filterCursorOf(snapshot)];

  expect(row).toMatchObject({ kind: 'candidate' });

  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('repo:acme/app');
  expect(session.getSnapshot().filterEditing).toBeNull();
});

test('Enter on an invalid draft with no row selected leaves no row selected', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'age:>3' });

  expect(filterCursorOf(session.getSnapshot())).toBe(-1);

  session.send({ kind: 'applyFilterRow' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
  expect(filterCursorOf(session.getSnapshot())).toBe(-1);
});

test('Enter on a field row while editing a chip completes the field and keeps the chip', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'rep' });

  const snapshot = session.getSnapshot();

  expect(filterRowsOf(snapshot)[filterCursorOf(snapshot)]).toEqual({
    kind: 'field',
    field: 'repo',
  });

  session.send({ kind: 'applyFilterRow' });

  const applied = session.getSnapshot();

  expect(applied.filterDraft).toBe('repo:');
  expect(applied.filters).toEqual([{ field: 'repo', value: 'acme/app', negated: false }]);
  expect(applied.filtersOpen).toBe(true);
  expect(applied.filterEditing).not.toBeNull();
});

test('Enter on a chip being edited with the draft unchanged keeps the chip', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'applyFilterRow' });

  const snapshot = session.getSnapshot();

  expect(snapshot.filters).toEqual([{ field: 'repo', value: 'acme/app', negated: false }]);
  expect(snapshot.filterEditing).toBeNull();
  expect(snapshot.filtersOpen).toBe(false);
});
