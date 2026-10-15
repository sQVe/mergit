import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';

import type { Session, Snapshot } from '../session/session.ts';
import { matchCountOf } from '../session/session.ts';
import { InputLine } from './InputLine.tsx';
import type { Palette } from './palette.ts';
import { SearchCompletion, searchCompletionRows } from './SearchCompletion.tsx';

export const searchLineRows = (snapshot: Snapshot): number => {
  if (!snapshot.searchOpen && snapshot.searchText === '') {
    return 0;
  }

  return 1 + searchCompletionRows(snapshot);
};

export const SearchLine = (props: {
  session: Session;
  snapshot: Snapshot;
  palette: Palette;
}): ReactNode => {
  const { session, snapshot, palette } = props;
  const { width } = useTerminalDimensions();

  if (!snapshot.searchOpen && snapshot.searchText === '') {
    return null;
  }

  const count = matchCountOf(snapshot);
  const suffix = `${count} ${count === 1 ? 'match' : 'matches'}`;

  return (
    <box flexDirection="column" flexShrink={0}>
      <InputLine
        prompt="/"
        value={snapshot.searchText}
        palette={palette}
        focused={snapshot.searchOpen}
        suffix={suffix}
        watch={session.subscribe}
        current={() => session.getSnapshot().searchText}
        onInput={(text) => {
          const live = session.getSnapshot();

          if (live.searchOpen && live.searchText !== text) {
            session.send({ kind: 'editSearch', text });
          }
        }}
      />
      <SearchCompletion snapshot={snapshot} width={width} palette={palette} />
    </box>
  );
};
