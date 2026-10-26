import type { Snapshot } from './sessionState.ts';

export interface CommandLineCompletion {
  typedText: string;
  chosen: string;
}

export const openCommandLine = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  commandLineOpen: true,
  commandLineText: '',
  commandLineCompletion: null,
});

export const editCommandLine = (snapshot: Snapshot, text: string): Snapshot => ({
  ...snapshot,
  commandLineText: text,
  commandLineCompletion: null,
});

export const closeCommandLine = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  commandLineOpen: false,
  commandLineText: '',
  commandLineCompletion: null,
});

export const commandLineCandidatesOf = (snapshot: Snapshot, names: readonly string[]): string[] => {
  const text = snapshot.commandLineCompletion?.typedText ?? snapshot.commandLineText;

  if (!snapshot.commandLineOpen || text === '' || /\s/.test(text)) {
    return [];
  }

  return [...new Set(names)].filter((name) => name.startsWith(text));
};

export const moveCommandLineCompletion = (
  snapshot: Snapshot,
  names: readonly string[],
  direction: 1 | -1,
): Snapshot => {
  const candidates = commandLineCandidatesOf(snapshot, names);
  const { length } = candidates;

  if (length === 0) {
    return snapshot;
  }

  const typedText = snapshot.commandLineCompletion?.typedText ?? snapshot.commandLineText;
  const previousIndex = candidates.indexOf(snapshot.commandLineCompletion?.chosen ?? '');
  const firstIndex = direction === 1 ? 0 : length - 1;
  const index = previousIndex === -1 ? firstIndex : (previousIndex + direction + length) % length;
  const chosen = candidates[index] ?? '';

  return {
    ...snapshot,
    commandLineText: chosen,
    commandLineCompletion: { typedText, chosen },
  };
};
