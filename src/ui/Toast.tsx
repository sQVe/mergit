import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import type { Palette } from './palette.ts';

const maximumWidth = 50;
const horizontalMargin = 4;
const maximumTextLines = 5;
const borderRows = 2;
const statusLineHeight = 1;

export const Toast = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const { snapshot, palette } = props;
  const { toast } = snapshot;
  const { width: terminalWidth } = useTerminalDimensions();

  if (toast === null) {
    return null;
  }

  const width = Math.min(maximumWidth, terminalWidth - horizontalMargin);

  return (
    <box
      position="absolute"
      bottom={statusLineHeight}
      right={1}
      width={width}
      maxHeight={maximumTextLines + borderRows}
      border
      borderStyle="rounded"
      borderColor={toast.tone === 'error' ? palette.error : palette.key}
      backgroundColor={palette.overlayBackground}
      zIndex={10}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={palette.text}>{toast.text}</text>
    </box>
  );
};
