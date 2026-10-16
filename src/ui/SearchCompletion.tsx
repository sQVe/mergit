import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import { chosenCandidateIndexOf, searchCandidatesOf } from '../session/session.ts';
import { CandidateList } from './CandidateList.tsx';
import type { CandidateItem } from './CandidateList.tsx';
import type { Palette } from './palette.ts';

export const searchCompletionRows = (snapshot: Snapshot, room: number): number => {
  if (!snapshot.searchOpen) {
    return 0;
  }

  return Math.min(searchCandidatesOf(snapshot).length, Math.max(0, room));
};

const windowStartOf = (chosen: number | null, rows: number): number =>
  chosen === null ? 0 : Math.max(0, chosen - rows + 1);

export const SearchCompletion = (props: {
  snapshot: Snapshot;
  width: number;
  room: number;
  palette: Palette;
}): ReactNode => {
  const { snapshot, width, room, palette } = props;
  const rows = searchCompletionRows(snapshot, room);

  if (rows === 0) {
    return null;
  }

  const items: CandidateItem[] = searchCandidatesOf(snapshot).map((candidate) => ({
    label: candidate.value,
    count: candidate.count,
    marked: false,
    failed: false,
    muted: false,
  }));

  const chosen = chosenCandidateIndexOf(snapshot);
  const start = windowStartOf(chosen, rows);

  // The list sits above the / line, so the best candidate goes last, next to the line.
  const shown = items.slice(start, start + rows).toReversed();
  const cursor = chosen === null ? -1 : rows - 1 - (chosen - start);

  return (
    <CandidateList items={shown} cursor={cursor} height={rows} width={width} palette={palette} />
  );
};
