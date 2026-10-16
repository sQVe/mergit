import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import { messageWindowOf } from './messageWindow.ts';
import type { Palette } from './palette.ts';

type Message = Snapshot['messages'][number];

const timeColumns = 8;
const toneColumns = 5;

export const MessageOverlay = (props: {
  messages: readonly Message[];
  palette: Palette;
  width: number;
  height: number;
  top: number;
}): ReactNode => {
  const { palette } = props;

  const { rows, viewportRows, maximumTop, overflows } = messageWindowOf(
    props.messages,
    props.width,
    props.height,
  );

  const top = Math.min(props.top, maximumTop);
  const visible = rows.slice(top, top + viewportRows);
  const position = `${top + 1}-${top + visible.length} of ${rows.length}`;

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      height={props.height}
      border
      borderStyle="rounded"
      borderColor={palette.key}
      title=" Messages "
      backgroundColor={palette.overlayBackground}
      zIndex={10}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {visible.length === 0 ? <text fg={palette.dim}>No messages yet</text> : null}
      {visible.map((row) => {
        const toneColor = row.tone === 'error' ? palette.error : palette.dim;

        return (
          <box key={row.key} flexDirection="row" gap={1}>
            <text fg={palette.dim}>{row.time.padEnd(timeColumns)}</text>
            <text fg={toneColor}>{(row.tone ?? '').padEnd(toneColumns)}</text>
            <text fg={row.dim ? palette.dim : palette.text}>{row.text}</text>
          </box>
        );
      })}
      {overflows ? <text fg={palette.dim}>{position}</text> : null}
    </box>
  );
};
