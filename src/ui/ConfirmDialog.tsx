import type { ReactNode } from 'react';

import type { Command } from '../commands.ts';
import { keyHintOf } from '../commands.ts';
import type { Palette } from './palette.ts';

const hintPart = (keys: string | undefined, action: string): string | undefined =>
  keys === undefined ? undefined : `${keys} to ${action}`;

export const ConfirmDialog = (props: {
  repositories: number;
  palette: Palette;
  catalog: readonly Command[];
}): ReactNode => {
  const { palette, catalog } = props;

  const parts = [
    hintPart(keyHintOf(catalog, 'confirmOpen', ' or '), 'open'),
    hintPart(keyHintOf(catalog, 'cancelOpen', ' or '), 'cancel'),
  ];

  const hint = parts.filter((part) => part !== undefined).join(', ');

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
      <text fg={palette.dim}>{hint}</text>
    </box>
  );
};
