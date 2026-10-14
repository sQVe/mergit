import type { Filter, FilterField } from '../query.ts';
import {
  filterCandidates,
  filterFields,
  filterQuery,
  formatFilter,
  parseFilters,
} from '../query.ts';
import { keepSelectionVisible, openThreads, threadsKnownMatching } from './sessionState.ts';
import type { Snapshot } from './sessionState.ts';

export type FilterRow =
  | { kind: 'typed'; filters: Filter[]; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'active'; filter: Filter; count: number | null }
  | { kind: 'candidate'; filter: Filter; count: number }
  | { kind: 'field'; field: FilterField };

interface Scored {
  row: FilterRow;
  field: FilterField;
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

const knownNames = new Set([...filterFields, 'is']);

const tokenStartsOf = (draft: string): string[] => {
  const starts: string[] = [];
  let quoted = false;
  let atStart = true;

  for (let index = 0; index < draft.length; index += 1) {
    const character = draft.charAt(index);

    if (atStart && !quoted && !/\s/.test(character)) {
      starts.push(draft.slice(index));
    }

    if (character === '"') {
      quoted = !quoted;
    }

    atStart = !quoted && /\s/.test(character);
  }

  return starts;
};

const namesUnknownField = (draft: string): boolean =>
  tokenStartsOf(draft).some((start) => {
    const name = /^-?([^\s:"]*):/.exec(start)?.[1];

    return name !== undefined && name !== '' && !knownNames.has(name.toLowerCase());
  });

const typedRowsOf = (snapshot: Snapshot): FilterRow[] => {
  if (snapshot.filterDraft.trim() === '') {
    return [];
  }

  const parsed = parseFilters(snapshot.filterDraft);

  if (!parsed.ok) {
    const shown =
      snapshot.filterError ?? (namesUnknownField(snapshot.filterDraft) ? parsed.error : null);

    return shown === null ? [] : [{ kind: 'error', message: shown }];
  }

  const query = filterQuery(parsed.filters);
  const open = openThreads(snapshot);
  const matching = query === null ? open : threadsKnownMatching(snapshot, open, query);

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

const isFieldPrefix = (field: string, terms: string[][]): boolean => {
  const first = terms[0]?.join('') ?? '';

  return first !== '' && field.startsWith(first);
};

const booleanFields = new Set<FilterField>(['new', 'unread']);

const booleanFieldOf = (row: FilterRow): FilterField | undefined => {
  const field = row.kind === 'candidate' || row.kind === 'active' ? row.filter.field : undefined;

  return field !== undefined && booleanFields.has(field) ? field : undefined;
};

const isFalseValue = (row: FilterRow): boolean => {
  const filter = row.kind === 'candidate' || row.kind === 'active' ? row.filter : undefined;

  return filter?.value === 'false';
};

// Within each boolean field, the rows keep their slots but `true` takes the earlier one.
const trueFirst = (rows: FilterRow[]): FilterRow[] => {
  const result = [...rows];

  for (const field of booleanFields) {
    const slots = result.flatMap((row, index) => (booleanFieldOf(row) === field ? [index] : []));

    const ordered = slots
      .map((index) => result[index])
      .filter((row): row is FilterRow => row !== undefined)
      .toSorted((left, right) => Number(isFalseValue(left)) - Number(isFalseValue(right)));

    slots.forEach((slot, position) => {
      const row = ordered[position];

      if (row !== undefined) {
        result[slot] = row;
      }
    });
  }

  return result;
};

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

    return score === null ? [] : [{ row: { kind: 'field', field }, field, score, count: 0 }];
  });

  const values = candidates.values.flatMap(({ field, value, count }): Scored[] => {
    const score = draftScore(terms, `${field}:${value}`);

    if (score === null) {
      return [];
    }

    const filter = { field, value, negated };
    const active = snapshot.filters.find((candidate) => sameFilter(candidate, filter));

    if (active !== undefined) {
      return [{ row: { kind: 'active', filter: active, count }, field, score, count }];
    }

    return [{ row: { kind: 'candidate', filter, count }, field, score, count }];
  });

  const listed = values.flatMap(({ row }) => (row.kind === 'active' ? [row.filter] : []));

  const unlisted = snapshot.filters.flatMap((filter): Scored[] => {
    const score = draftScore(terms, `${filter.field}:${filter.value}`);
    const wanted = listAll || filter.negated === negated;

    if (includesFilter(listed, filter) || score === null || !wanted) {
      return [];
    }

    return [{ row: { kind: 'active', filter, count: null }, field: filter.field, score, count: 0 }];
  });

  if (listAll) {
    const active: FilterRow[] = snapshot.filters.map((filter) => ({
      kind: 'active',
      filter,
      count: null,
    }));

    const rest = values.filter(({ row }) => row.kind !== 'active');
    const fieldRows = fields.toSorted(byScoreThenCount).map(({ row }) => row);

    const valueRows = rest.toSorted(byScoreThenCount).map(({ row }) => row);

    return [...active, ...trueFirst(valueRows), ...fieldRows];
  }

  const leads = (scored: Scored): boolean => isFieldPrefix(scored.field, terms);
  const sortedValues = [...unlisted, ...values].toSorted(byScoreThenCount);
  const sortedFields = fields.toSorted(byScoreThenCount);

  const prefixOnly =
    terms.length === 1 && filterFields.some((field) => isFieldPrefix(field, terms));

  const ranked = [
    ...sortedFields.filter(leads),
    ...sortedValues.filter(leads),
    ...(prefixOnly ? [] : sortedValues.filter((scored) => !leads(scored))),
    ...(prefixOnly ? [] : sortedFields.filter((scored) => !leads(scored))),
  ];

  return trueFirst(ranked.map(({ row }) => row));
};

const twinOf = (row: FilterRow, typed: FilterRow): boolean => {
  if (typed.kind !== 'typed' || typed.filters.length !== 1) {
    return false;
  }

  const [only] = typed.filters;
  const filter = row.kind === 'candidate' || row.kind === 'active' ? row.filter : undefined;

  return only !== undefined && filter !== undefined && sameFilter(filter, only);
};

export const filterRowsOf = (snapshot: Snapshot): FilterRow[] => {
  const draft = snapshot.filterDraft.trim().toLowerCase();
  const candidates = candidateRowsOf(snapshot, draft);
  const [typed] = typedRowsOf(snapshot);

  if (typed === undefined) {
    return candidates;
  }

  const activeTwin = candidates.find((row) => row.kind === 'active' && twinOf(row, typed));

  if (activeTwin !== undefined) {
    return [activeTwin, ...candidates.filter((row) => row !== activeTwin)];
  }

  return [typed, ...candidates.filter((row) => !twinOf(row, typed))];
};

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
  const parsed = parseFilters(snapshot.filterDraft);

  if (parsed.ok || snapshot.filterDraft.trim() === '') {
    return snapshot;
  }

  return { ...snapshot, filterError: parsed.error, filterCursor: -1 };
};

export const applyFilterRow = (snapshot: Snapshot): Snapshot => {
  const row = rowUnderCursor(snapshot);

  if (row === undefined) {
    return withDraftError(snapshot);
  }

  if (row.kind === 'typed') {
    return finishRow(snapshot, replaceOrAdd(snapshot, row.filters));
  }

  if (row.kind === 'candidate') {
    return finishRow(snapshot, replaceOrAdd(snapshot, [row.filter]));
  }

  if (row.kind === 'active' && snapshot.filterEditing !== null) {
    return finishRow(snapshot, replaceOrAdd(snapshot, [row.filter]));
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
