import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import type { Palette } from './palette.ts';

const maximumWidth = 50;
const horizontalMargin = 4;
const maximumTextLines = 5;
const barColumns = 1;
const paddingColumns = 2;
const paddingRows = 2;
const statusLineHeight = 1;

const wrapLine = (line: string, columns: number): string[] => {
  const step = Math.max(1, columns);
  const chunks: string[] = [];

  for (let start = 0; start < line.length; start += step) {
    chunks.push(line.slice(start, start + step));
  }

  return chunks.length === 0 ? [''] : chunks;
};

export const Toast = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const { snapshot, palette } = props;
  const { toast } = snapshot;
  const { width: terminalWidth } = useTerminalDimensions();

  if (toast === null) {
    return null;
  }

  const isError = toast.tone === 'error';
  const toneColor = isError ? palette.error : palette.typeLabel;
  const background = isError ? palette.errorBackground : palette.infoBackground;
  const title = isError ? `✗ ${toast.title}` : toast.title;
  const lines = [title, ...toast.lines];
  const longest = Math.max(...lines.map((line) => line.length));
  const widthLimit = Math.min(maximumWidth, terminalWidth - horizontalMargin);
  const textColumns = Math.min(longest, widthLimit - barColumns - paddingColumns);

  if (textColumns < 1) {
    return null;
  }

  const width = textColumns + barColumns + paddingColumns;
  const titleRows = wrapLine(title, textColumns);

  const bodyRows = toast.lines
    .flatMap((line) => wrapLine(line, textColumns))
    .slice(0, maximumTextLines - titleRows.length);

  const textRows = titleRows.length + bodyRows.length;
  const height = textRows + paddingRows;
  const bar = Array.from({ length: height }, () => '▌').join('\n');

  return (
    <box
      position="absolute"
      bottom={statusLineHeight}
      right={1}
      width={width}
      height={height}
      flexDirection="row"
      backgroundColor={background}
      zIndex={10}
    >
      <text fg={toneColor} bg={background} width={barColumns}>
        {bar}
      </text>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
        <text fg={toneColor} bg={background}>
          <b>{titleRows.join('\n')}</b>
        </text>
        <text fg={palette.text} bg={background}>
          {bodyRows.join('\n')}
        </text>
      </box>
    </box>
  );
};
