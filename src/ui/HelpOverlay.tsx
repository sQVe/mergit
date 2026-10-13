import type { ReactNode } from 'react';

import type { Command } from '../commands.ts';
import type { Palette } from './palette.ts';

export const HelpOverlay = (props: {
  catalog: readonly Command[];
  palette: Palette;
}): ReactNode => {
  const { palette } = props;

  return (
    <box
      position="absolute"
      top={2}
      left={2}
      border
      borderStyle="rounded"
      borderColor={palette.key}
      title=" Help "
      backgroundColor={palette.overlayBackground}
      zIndex={10}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {props.catalog.map((command) => (
        <box key={command.id} flexDirection="row" gap={2}>
          <text fg={palette.key}>{command.keys.join(' ')}</text>
          <text fg={palette.text}>{command.label}</text>
        </box>
      ))}
    </box>
  );
};
