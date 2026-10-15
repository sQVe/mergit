import type { Snapshot } from './sessionState.ts';

export const openCommandLine = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  commandLineOpen: true,
  commandLineText: '',
});

export const editCommandLine = (snapshot: Snapshot, text: string): Snapshot => ({
  ...snapshot,
  commandLineText: text,
});

export const closeCommandLine = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  commandLineOpen: false,
  commandLineText: '',
});
