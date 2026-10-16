import type { Snapshot } from './sessionState.ts';
import { keepSelectionVisible } from './sessionState.ts';

export const openSearch = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  searchOpen: true,
  searchTextBefore: snapshot.searchText,
});

export const editSearch = (snapshot: Snapshot, text: string): Snapshot =>
  keepSelectionVisible(snapshot, { ...snapshot, searchText: text, searchCompletion: null });

export const keepSearch = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  searchOpen: false,
  searchCompletion: null,
});

export const restoreSearch = (snapshot: Snapshot): Snapshot => {
  const restored = editSearch(snapshot, snapshot.searchTextBefore);

  return { ...restored, searchOpen: false };
};

export const clearSearch = (snapshot: Snapshot): Snapshot => editSearch(snapshot, '');
