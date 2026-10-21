import { expect, test } from 'bun:test';

import { filterCursorOf, filterRowsOf } from './session.ts';
import type { FilterRow } from './session.ts';
import {
  addFilters,
  describeRow,
  filterThreads,
  loadWithAuthors,
  makeHarness,
  makeThread,
  rowSummaryOf,
  rowTexts,
  sortedThreadKeysOf,
} from './sessionHarness.ts';

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

test('a whitespace-only draft lists the same rows as an empty draft', async () => {
  const { session } = await loadWithAuthors();

  const empty = filterRowsOf(session.getSnapshot());

  session.send({ kind: 'editFilterDraft', text: '  ' });

  expect(filterRowsOf(session.getSnapshot())).toEqual(empty);
  expect(filterCursorOf(session.getSnapshot())).toBe(-1);
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
