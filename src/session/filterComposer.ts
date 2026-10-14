import type { Filter, FilterField } from '../query.ts';
import { filterCandidates, filterQuery, formatFilter, parseFilters } from '../query.ts';
import { keepSelectionVisible, openThreads, threadsMatching } from './sessionState.ts';
import type { Snapshot } from './sessionState.ts';

export type FilterRow =
  | { kind: 'typed'; filters: Filter[]; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'active'; filter: Filter; count: number | null }
  | { kind: 'candidate'; filter: Filter; count: number }
  | { kind: 'field'; field: FilterField };

const sameFilter = (left: Filter, right: Filter): boolean =>
  left.field === right.field &&
  left.negated === right.negated &&
  left.value.toLowerCase() === right.value.toLowerCase();

const includesFilter = (filters: Filter[], filter: Filter): boolean =>
  filters.some((candidate) => sameFilter(candidate, filter));

const withoutDuplicates = (filters: Filter[]): Filter[] =>
  filters.filter((filter, index) => !includesFilter(filters.slice(0, index), filter));

const typedRowsOf = (snapshot: Snapshot): FilterRow[] => {
  if (snapshot.filterDraft.trim() === '') {
    return [];
  }

  const parsed = parseFilters(snapshot.filterDraft);

  if (!parsed.ok) {
    return [{ kind: 'error', message: parsed.error }];
  }

  const matching = threadsMatching(snapshot, openThreads(snapshot), filterQuery(parsed.filters));

  return [{ kind: 'typed', filters: parsed.filters, count: matching.length }];
};

const matchesDraft = (filter: Filter, text: string): boolean => {
  const negated = text.startsWith('-');
  const body = negated ? text.slice(1) : text;

  if (filter.negated !== negated) {
    return false;
  }

  const value = filter.value.toLowerCase();

  return `${filter.field}:${value}`.startsWith(body) || value.startsWith(body);
};

const candidateRowsOf = (snapshot: Snapshot, text: string): FilterRow[] => {
  const negated = text.startsWith('-');
  const body = negated ? text.slice(1) : text;

  const candidates = filterCandidates(openThreads(snapshot), {
    factsOf: (thread) => snapshot.subjectFacts.get(thread.id),
    isNew: (thread) => snapshot.newThreadIds.has(thread.id),
    viewerLogin: snapshot.viewerLogin,
  });

  const fields: FilterRow[] = candidates.fields
    .filter((field) => field.startsWith(body))
    .map((field) => ({ kind: 'field', field }));

  const matching = candidates.values.filter(
    ({ field, value }) =>
      `${field}:${value}`.toLowerCase().startsWith(body) || value.toLowerCase().startsWith(body),
  );

  const values: FilterRow[] = matching
    .toSorted((left, right) => right.count - left.count)
    .map(({ field, value, count }) => {
      const filter = { field, value, negated };
      const active = snapshot.filters.find((candidate) => sameFilter(candidate, filter));

      if (active !== undefined) {
        return { kind: 'active', filter: active, count };
      }

      return { kind: 'candidate', filter, count };
    });

  const listed = values.flatMap((row) => (row.kind === 'active' ? [row.filter] : []));

  const unlisted: FilterRow[] = snapshot.filters
    .filter((filter) => !includesFilter(listed, filter) && matchesDraft(filter, text))
    .map((filter) => ({ kind: 'active', filter, count: null }));

  return [...unlisted, ...values, ...fields];
};

export const filterRowsOf = (snapshot: Snapshot): FilterRow[] => {
  const text = snapshot.filterDraft.trim().toLowerCase();

  if (text === '') {
    const active: FilterRow[] = snapshot.filters.map((filter) => ({
      kind: 'active',
      filter,
      count: null,
    }));

    const fields = candidateRowsOf(snapshot, '').filter((row) => row.kind === 'field');

    return [...active, ...fields];
  }

  return [...typedRowsOf(snapshot), ...candidateRowsOf(snapshot, text)];
};

const clampedCursorOf = (snapshot: Snapshot, rows: FilterRow[]): number =>
  Math.max(0, Math.min(snapshot.filterCursor, rows.length - 1));

export const filterCursorOf = (snapshot: Snapshot): number =>
  clampedCursorOf(snapshot, filterRowsOf(snapshot));

const rowUnderCursor = (snapshot: Snapshot): FilterRow | undefined => {
  const rows = filterRowsOf(snapshot);

  return rows[clampedCursorOf(snapshot, rows)];
};

const withFilters = (snapshot: Snapshot, filters: Filter[]): Snapshot =>
  keepSelectionVisible(snapshot, { ...snapshot, filters });

const withDraft = (snapshot: Snapshot, filterDraft: string): Snapshot => {
  const drafted = { ...snapshot, filterDraft, filterCursor: 0 };
  const startsOnError = filterRowsOf(drafted)[0]?.kind === 'error';

  return startsOnError ? { ...drafted, filterCursor: 1 } : drafted;
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
  const next = clampedCursorOf(snapshot, rows) + (direction === 'down' ? 1 : -1);

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

export const applyFilterRow = (snapshot: Snapshot): Snapshot => {
  const row = rowUnderCursor(snapshot);

  if (row?.kind === 'typed') {
    return finishRow(snapshot, replaceOrAdd(snapshot, row.filters));
  }

  if (row?.kind === 'candidate') {
    return finishRow(snapshot, replaceOrAdd(snapshot, [row.filter]));
  }

  if (row?.kind === 'active') {
    return finishRow(
      snapshot,
      snapshot.filters.filter((filter) => !sameFilter(filter, row.filter)),
    );
  }

  if (row?.kind === 'field') {
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
