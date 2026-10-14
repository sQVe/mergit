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

interface Scored {
  row: FilterRow;
  score: number;
  count: number;
}

interface ScoreRow {
  scores: Float64Array;
  runBonuses: Float64Array;
}

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
    return snapshot.filterDraft.includes(':') ? [{ kind: 'error', message: parsed.error }] : [];
  }

  const matching = threadsMatching(snapshot, openThreads(snapshot), filterQuery(parsed.filters));

  return [{ kind: 'typed', filters: parsed.filters, count: matching.length }];
};

// Scores follow fzf: a run of consecutive letters keeps the bonus of its first letter, and
// opening a gap costs more than extending one, so an exact run beats scattered word starts.
const wordBoundaries = new Set([':', '/', '-', '_', ' ']);
const matchScore = 16;
const boundaryBonus = 8;
const consecutiveBonus = 4;
const firstLetterMultiplier = 2;
const gapStartPenalty = 3;
const gapExtensionPenalty = 1;

const boundaryBonusAt = (letters: string[], index: number): number => {
  const previous = letters[index - 1];

  return previous === undefined || wordBoundaries.has(previous) ? boundaryBonus : 0;
};

const isSubsequence = (term: string[], letters: string[]): boolean => {
  let found = 0;

  for (let index = 0; index < letters.length && found < term.length; index += 1) {
    if (letters[index] === term[found]) {
      found += 1;
    }
  }

  return found === term.length;
};

const firstScoreRow = (letters: string[], letter: string): ScoreRow => {
  const scores = new Float64Array(letters.length).fill(-Infinity);
  const runBonuses = new Float64Array(letters.length);

  for (let index = 0; index < letters.length; index += 1) {
    if (letters[index] === letter) {
      const bonus = boundaryBonusAt(letters, index);

      scores[index] = matchScore + bonus * firstLetterMultiplier;
      runBonuses[index] = bonus;
    }
  }

  return { scores, runBonuses };
};

const nextScoreRow = (previous: ScoreRow, letters: string[], letter: string): ScoreRow => {
  const scores = new Float64Array(letters.length).fill(-Infinity);
  const runBonuses = new Float64Array(letters.length);
  let afterGap = -Infinity;

  for (let index = 0; index < letters.length; index += 1) {
    const beforeGap = previous.scores[index - 2] ?? -Infinity;

    afterGap = Math.max(afterGap - gapExtensionPenalty, beforeGap - gapStartPenalty);

    if (letters[index] === letter) {
      const bonus = boundaryBonusAt(letters, index);
      const adjacent = previous.scores[index - 1] ?? -Infinity;
      const runBonus = Math.max(bonus, previous.runBonuses[index - 1] ?? 0, consecutiveBonus);
      const consecutive = adjacent + matchScore + runBonus;
      const gapped = afterGap + matchScore + bonus;
      const keepsRun = consecutive >= gapped;

      scores[index] = keepsRun ? consecutive : gapped;
      runBonuses[index] = keepsRun ? runBonus : bonus;
    }
  }

  return { scores, runBonuses };
};

const termScore = (term: string[], letters: string[]): number | null => {
  const [first, ...rest] = term;

  if (first === undefined || !isSubsequence(term, letters)) {
    return null;
  }

  let row = firstScoreRow(letters, first);

  for (const letter of rest) {
    row = nextScoreRow(row, letters, letter);
  }

  const best = Math.max(...row.scores);

  return Number.isFinite(best) ? best : null;
};

const draftScore = (terms: string[][], text: string): number | null => {
  const letters = Array.from(text.toLowerCase());
  let total = 0;

  for (const term of terms) {
    const score = termScore(term, letters);

    if (score === null) {
      return null;
    }

    total += score;
  }

  return total;
};

const termsOf = (draft: string): { negated: boolean; terms: string[][] } => {
  const negated = draft.startsWith('-');
  const body = negated ? draft.slice(1) : draft;

  const words = body.split(/\s+/).filter((term) => term !== '');

  return { negated, terms: words.map((word) => Array.from(word)) };
};

const byScoreThenCount = (left: Scored, right: Scored): number =>
  right.score - left.score || right.count - left.count;

const candidateRowsOf = (snapshot: Snapshot, draft: string): FilterRow[] => {
  const { negated, terms } = termsOf(draft);
  const listAll = draft === '';

  const candidates = filterCandidates(openThreads(snapshot), {
    factsOf: (thread) => snapshot.subjectFacts.get(thread.id),
    isNew: (thread) => snapshot.newThreadIds.has(thread.id),
    viewerLogin: snapshot.viewerLogin,
  });

  const fields = candidates.fields.flatMap((field): Scored[] => {
    const score = draftScore(terms, field);

    return score === null ? [] : [{ row: { kind: 'field', field }, score, count: 0 }];
  });

  const values = candidates.values.flatMap(({ field, value, count }): Scored[] => {
    const score = draftScore(terms, `${field}:${value}`);

    if (score === null) {
      return [];
    }

    const filter = { field, value, negated };
    const active = snapshot.filters.find((candidate) => sameFilter(candidate, filter));

    if (active !== undefined) {
      return [{ row: { kind: 'active', filter: active, count }, score, count }];
    }

    return [{ row: { kind: 'candidate', filter, count }, score, count }];
  });

  const listed = values.flatMap(({ row }) => (row.kind === 'active' ? [row.filter] : []));

  const unlisted = snapshot.filters.flatMap((filter): Scored[] => {
    const score = draftScore(terms, `${filter.field}:${filter.value}`);
    const wanted = listAll || filter.negated === negated;

    if (includesFilter(listed, filter) || score === null || !wanted) {
      return [];
    }

    return [{ row: { kind: 'active', filter, count: null }, score, count: 0 }];
  });

  const fieldRows = fields.toSorted(byScoreThenCount).map(({ row }) => row);

  if (listAll) {
    const active: FilterRow[] = snapshot.filters.map((filter) => ({
      kind: 'active',
      filter,
      count: null,
    }));

    const rest = values.filter(({ row }) => row.kind !== 'active');

    return [...active, ...rest.toSorted(byScoreThenCount).map(({ row }) => row), ...fieldRows];
  }

  const valueRows = [...unlisted, ...values].toSorted(byScoreThenCount).map(({ row }) => row);

  return [...valueRows, ...fieldRows];
};

export const filterRowsOf = (snapshot: Snapshot): FilterRow[] => {
  const draft = snapshot.filterDraft.trim().toLowerCase();

  return [...typedRowsOf(snapshot), ...candidateRowsOf(snapshot, draft)];
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
  const rows = filterRowsOf(drafted);
  const first = rows[0];
  const emptyTyped = first?.kind === 'typed' && first.count === 0;
  const skipsFirst = first?.kind === 'error' || emptyTyped;

  return skipsFirst ? { ...drafted, filterCursor: 1 } : drafted;
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
