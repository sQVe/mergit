import type { Filter } from '../query.ts';
import { analyzeFilterDraft, formatFilter } from '../query.ts';
import { filterRowsOf, includesFilter, sameFilter } from './filterRows.ts';
import type { FilterRow } from './filterRows.ts';
import { keepSelectionVisible } from './sessionState.ts';
import type { Snapshot } from './sessionState.ts';

const withoutDuplicates = (filters: Filter[]): Filter[] =>
  filters.filter((filter, index) => !includesFilter(filters.slice(0, index), filter));

const clampedCursorOf = (snapshot: Snapshot, rows: FilterRow[]): number => {
  if (snapshot.filterCursor < 0) {
    return -1;
  }

  return Math.min(snapshot.filterCursor, rows.length - 1);
};

export const filterCursorOf = (snapshot: Snapshot): number =>
  clampedCursorOf(snapshot, filterRowsOf(snapshot));

const rowUnderCursor = (snapshot: Snapshot): FilterRow | undefined => {
  const rows = filterRowsOf(snapshot);

  return rows[clampedCursorOf(snapshot, rows)];
};

const withFilters = (snapshot: Snapshot, filters: Filter[]): Snapshot =>
  keepSelectionVisible(snapshot, { ...snapshot, filters });

const withDraft = (snapshot: Snapshot, filterDraft: string): Snapshot => {
  const cleared = { ...snapshot, filterDraft, filterError: null };

  if (filterDraft.trim() === '') {
    return { ...cleared, filterCursor: -1 };
  }

  const rows = filterRowsOf(cleared);
  const first = rows[0];
  const emptyTyped = first?.kind === 'typed' && first.count === 0;

  if (rows.length === 0) {
    return { ...cleared, filterCursor: -1 };
  }

  return { ...cleared, filterCursor: emptyTyped && rows.length > 1 ? 1 : 0 };
};

const finishRow = (snapshot: Snapshot, filters: Filter[]): Snapshot => {
  const changed = withFilters(snapshot, filters);

  return { ...withDraft(changed, ''), filterEditing: null };
};

export const openFilters = (snapshot: Snapshot): Snapshot => ({
  ...withDraft(snapshot, ''),
  filtersOpen: true,
  filterEditing: null,
});

export const editFilterDraft = (snapshot: Snapshot, text: string): Snapshot =>
  withDraft(snapshot, text);

export const moveFilterCursor = (snapshot: Snapshot, direction: 'up' | 'down'): Snapshot => {
  const rows = filterRowsOf(snapshot);
  const current = clampedCursorOf(snapshot, rows);

  if (current === -1) {
    return { ...snapshot, filterCursor: direction === 'down' ? 0 : rows.length - 1 };
  }

  const next = current + (direction === 'down' ? 1 : -1);

  return { ...snapshot, filterCursor: Math.max(0, Math.min(next, rows.length - 1)) };
};

export const takeFilterRow = (snapshot: Snapshot): Snapshot => {
  const row = rowUnderCursor(snapshot);

  if (row?.kind === 'field') {
    const sign = snapshot.filterDraft.trimStart().startsWith('-') ? '-' : '';

    return withDraft(snapshot, `${sign}${row.field}:`);
  }

  if (row?.kind === 'active') {
    return { ...withDraft(snapshot, formatFilter(row.filter)), filterEditing: row.filter };
  }

  if (row?.kind === 'candidate') {
    return withDraft(snapshot, formatFilter(row.filter));
  }

  return snapshot;
};

const replaceOrAdd = (snapshot: Snapshot, added: Filter[]): Filter[] => {
  const { filterEditing, filters } = snapshot;
  const at = filterEditing === null ? -1 : filters.findIndex((f) => sameFilter(f, filterEditing));

  if (at === -1) {
    return withoutDuplicates([...filters, ...added]);
  }

  return withoutDuplicates([...filters.slice(0, at), ...added, ...filters.slice(at + 1)]);
};

const withDraftError = (snapshot: Snapshot): Snapshot => {
  const { parsed } = analyzeFilterDraft(snapshot.filterDraft);

  if (parsed.ok || snapshot.filterDraft.trim() === '') {
    return snapshot;
  }

  return { ...snapshot, filterError: parsed.error, filterCursor: -1 };
};

const closeWithFilters = (snapshot: Snapshot, filters: Filter[]): Snapshot => ({
  ...finishRow(snapshot, filters),
  filtersOpen: false,
});

export const applyFilterRow = (snapshot: Snapshot): Snapshot => {
  const row = rowUnderCursor(snapshot);

  if (row === undefined) {
    return withDraftError(snapshot);
  }

  if (row.kind === 'typed') {
    return closeWithFilters(snapshot, replaceOrAdd(snapshot, row.filters));
  }

  if (row.kind === 'candidate') {
    return closeWithFilters(snapshot, replaceOrAdd(snapshot, [row.filter]));
  }

  if (row.kind === 'active' && snapshot.filterEditing !== null) {
    return closeWithFilters(snapshot, replaceOrAdd(snapshot, [row.filter]));
  }

  if (row.kind === 'active') {
    const removed = finishRow(
      snapshot,
      snapshot.filters.filter((filter) => !sameFilter(filter, row.filter)),
    );

    const remaining = filterRowsOf(removed).length;
    const stays = Math.min(clampedCursorOf(snapshot, filterRowsOf(snapshot)), remaining - 1);

    return { ...removed, filterCursor: stays };
  }

  if (row.kind === 'field') {
    return takeFilterRow(snapshot);
  }

  return snapshot;
};

export const closeFilters = (snapshot: Snapshot): Snapshot => {
  if (snapshot.filterEditing !== null) {
    return { ...withDraft(snapshot, ''), filterEditing: null };
  }

  return { ...withDraft(snapshot, ''), filtersOpen: false };
};

export const leaveFilters = (snapshot: Snapshot): Snapshot => ({
  ...withDraft(snapshot, ''),
  filtersOpen: false,
  filterEditing: null,
});

export const clearFilters = (snapshot: Snapshot): Snapshot => withFilters(snapshot, []);
