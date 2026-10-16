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

  return (
    <CandidateList
      items={items}
      cursor={chosen ?? -1}
      height={rows}
      width={width}
      palette={palette}
    />
  );
};
