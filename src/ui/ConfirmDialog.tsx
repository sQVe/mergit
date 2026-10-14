import type { ReactNode } from 'react';

import type { Palette } from './palette.ts';

export const ConfirmDialog = (props: { repositories: number; palette: Palette }): ReactNode => {
  const { palette } = props;

  return (
    <box
      position="absolute"
      top={2}
      left={2}
      border
      borderStyle="rounded"
      borderColor={palette.key}
      title=" Open in browser "
      backgroundColor={palette.overlayBackground}
      zIndex={10}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={palette.text}>Open {props.repositories} repos in the browser?</text>
      <text fg={palette.dim}>y or Enter to open, n or Esc to cancel</text>
    </box>
  );
};
