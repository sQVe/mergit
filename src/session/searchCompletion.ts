import { filterQuery, searchQuery } from '../query.ts';
import { editSearch } from './searchTransitions.ts';
import type { Snapshot } from './sessionState.ts';
import { openThreads, threadsMatching } from './sessionState.ts';

export interface SearchCandidate {
  value: string;
  count: number;
}

export interface SearchCompletion {
  typedText: string;
  chosen: string;
}

const maxCandidates = 6;

const splitLastWord = (text: string): { before: string; word: string } => {
  const start = text.search(/\S*$/);

  return { before: text.slice(0, start), word: text.slice(start) };
};

const titleWordsOf = (title: string): string[] =>
  title
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word !== '');

const compareCandidates = (left: SearchCandidate, right: SearchCandidate): number => {
  if (left.count !== right.count) {
    return right.count - left.count;
  }

  return left.value.localeCompare(right.value);
};

const candidatesFor = (snapshot: Snapshot, text: string): SearchCandidate[] => {
  const { before, word } = splitLastWord(text);

  if (word === '') {
    return [];
  }

  const needle = word.toLowerCase();
  const narrowed = threadsMatching(snapshot, openThreads(snapshot), filterQuery(snapshot.filters));
  const threads = threadsMatching(snapshot, narrowed, searchQuery(before));
  const found = new Map<string, SearchCandidate>();

  for (const thread of threads) {
    const values = new Map<string, string>();

    for (const titleWord of titleWordsOf(thread.title)) {
      values.set(titleWord, titleWord);
    }

    values.set(thread.repository.toLowerCase(), thread.repository);

    for (const [key, value] of values) {
      if (!key.includes(needle)) {
        continue;
      }

      const entry = found.get(key) ?? { value, count: 0 };

      entry.count += 1;
      found.set(key, entry);
    }
  }

  return [...found.values()].toSorted(compareCandidates).slice(0, maxCandidates);
};

const typedTextOf = (snapshot: Snapshot): string =>
  snapshot.searchCompletion?.typedText ?? snapshot.searchText;

export const searchCandidatesOf = (snapshot: Snapshot): SearchCandidate[] =>
  candidatesFor(snapshot, typedTextOf(snapshot));

export const chosenCandidateIndexOf = (snapshot: Snapshot): number | null => {
  const chosen = snapshot.searchCompletion?.chosen;

  if (chosen === undefined) {
    return null;
  }

  const index = searchCandidatesOf(snapshot).findIndex((candidate) => candidate.value === chosen);

  return index === -1 ? null : index;
};

export const moveSearchCompletion = (snapshot: Snapshot, direction: 1 | -1): Snapshot => {
  const candidates = searchCandidatesOf(snapshot);
  const { length } = candidates;

  if (!snapshot.searchOpen || length === 0) {
    return snapshot;
  }

  const typedText = typedTextOf(snapshot);
  const previousIndex = chosenCandidateIndexOf(snapshot);
  const firstIndex = direction === 1 ? 0 : length - 1;
  const index = previousIndex === null ? firstIndex : (previousIndex + direction + length) % length;
  const chosen = candidates[index]?.value ?? '';
  const { before } = splitLastWord(typedText);
  const edited = editSearch(snapshot, `${before}${chosen}`);

  return { ...edited, searchCompletion: { typedText, chosen } };
};
