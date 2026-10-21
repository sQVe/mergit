import type { Filter, FilterField } from '../query.ts';
import { analyzeFilterDraft, filterCandidates, filterFields, filterQuery } from '../query.ts';
import { openThreads, threadsKnownMatching } from './sessionState.ts';
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

export const sameFilter = (left: Filter, right: Filter): boolean =>
  left.field === right.field &&
  left.negated === right.negated &&
  left.value.toLowerCase() === right.value.toLowerCase();

export const includesFilter = (filters: Filter[], filter: Filter): boolean =>
  filters.some((candidate) => sameFilter(candidate, filter));

const typedRowsOf = (snapshot: Snapshot): FilterRow[] => {
  if (snapshot.filterDraft.trim() === '') {
    return [];
  }

  const { parsed, hasUnknownField: unknownName } = analyzeFilterDraft(snapshot.filterDraft);

  if (!parsed.ok) {
    const shown = snapshot.filterError ?? (unknownName ? parsed.error : null);

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

  // Each thread has one known value per field, so the field's known threads are the sum of its
  // value counts, and a negated value keeps the rest. `@me` repeats the viewer's own login.
  const knownByField = new Map<FilterField, number>();

  for (const { field, value, count } of candidates.values) {
    if (value !== '@me') {
      knownByField.set(field, (knownByField.get(field) ?? 0) + count);
    }
  }

  const fields = candidates.fields.flatMap((field): Scored[] => {
    const score = draftScore(terms, field);

    return score === null ? [] : [{ row: { kind: 'field', field }, field, score, count: 0 }];
  });

  const values = candidates.values.flatMap(({ field, value, count: matched }): Scored[] => {
    const score = draftScore(terms, `${field}:${value}`);

    if (score === null) {
      return [];
    }

    const count = negated ? (knownByField.get(field) ?? 0) - matched : matched;
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

  if (activeTwin?.kind === 'active' && typed.kind === 'typed') {
    const counted = { ...activeTwin, count: typed.count };

    return [counted, ...candidates.filter((row) => row !== activeTwin)];
  }

  return [typed, ...candidates.filter((row) => !twinOf(row, typed))];
};
