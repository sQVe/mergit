import type { ReactNode } from 'react';

import type { Session, Snapshot } from '../session/session.ts';
import { InputLine } from './InputLine.tsx';
import type { Palette } from './palette.ts';

export const commandLineRows = (snapshot: Snapshot): number => (snapshot.commandLineOpen ? 1 : 0);

export const CommandLine = (props: {
  session: Session;
  snapshot: Snapshot;
  palette: Palette;
}): ReactNode => {
  const { session, snapshot, palette } = props;

  if (!snapshot.commandLineOpen) {
    return null;
  }

  return (
    <InputLine
      prompt=":"
      value={snapshot.commandLineText}
      palette={palette}
      focused
      suffix={null}
      watch={session.subscribe}
      current={() => session.getSnapshot().commandLineText}
      onInput={(text) => {
        const live = session.getSnapshot();

        if (live.commandLineOpen && live.commandLineText !== text) {
          session.send({ kind: 'editCommandLine', text });
        }
      }}
    />
  );
};
