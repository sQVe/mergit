import type { ReactNode } from 'react';

import type { Command } from '../commands.ts';
import { commandLineCandidatesOf } from '../session/session.ts';
import type { Session, Snapshot } from '../session/session.ts';
import { CandidateList } from './CandidateList.tsx';
import { InputLine } from './InputLine.tsx';
import type { Palette } from './palette.ts';

export const commandLineNamesOf = (catalog: readonly Command[]): string[] =>
  catalog.flatMap((command) => command.names ?? []);

export const commandLineRows = (
  snapshot: Snapshot,
  names: readonly string[],
  room: number,
): number => {
  if (!snapshot.commandLineOpen) {
    return 0;
  }

  return 1 + Math.min(commandLineCandidatesOf(snapshot, names).length, Math.max(0, room - 1));
};

export const CommandLine = (props: {
  session: Session;
  snapshot: Snapshot;
  palette: Palette;
  names: readonly string[];
  room: number;
  width: number;
}): ReactNode => {
  const { session, snapshot, palette } = props;

  if (!snapshot.commandLineOpen) {
    return null;
  }

  const candidates = commandLineCandidatesOf(snapshot, props.names);
  const rows = commandLineRows(snapshot, props.names, props.room) - 1;
  const chosen = candidates.indexOf(snapshot.commandLineCompletion?.chosen ?? '');
  const start = Math.max(0, chosen - rows + 1);

  const items = candidates
    .slice(start, start + rows)
    .toReversed()
    .map((label) => ({
      label,
      count: null,
      marked: false,
      failed: false,
      muted: false,
    }));

  const cursor = chosen === -1 ? -1 : items.length - 1 - (chosen - start);

  return (
    <box flexDirection="column" flexShrink={0}>
      <CandidateList
        items={items}
        cursor={cursor}
        height={rows}
        width={props.width}
        palette={palette}
      />
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
    </box>
  );
};
