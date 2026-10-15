import type { ReactNode } from 'react';

import type { Command } from '../commands.ts';
import { helpWindowOf, suffixOf } from './helpWindow.ts';
import type { Palette } from './palette.ts';

const firstKeyOf = (catalog: readonly Command[], id: string): string =>
  catalog.find((command) => command.id === id)?.keys[0] ?? '';

export const HelpOverlay = (props: {
  catalog: readonly Command[];
  palette: Palette;
  height: number;
  top: number;
}): ReactNode => {
  const { palette, catalog } = props;

  const { commands, viewportRows, maximumTop, overflows, boxWidth } = helpWindowOf(
    catalog,
    props.height,
  );

  const top = Math.min(props.top, maximumTop);
  const visible = commands.slice(top, top + viewportRows);
  const position = `${top + 1}-${top + visible.length} of ${commands.length}`;
  const scrollKeys = [firstKeyOf(catalog, 'scrollHelpDown'), firstKeyOf(catalog, 'scrollHelpUp')];
  const hint = `${position}  ${scrollKeys.join('/')} scroll  ${firstKeyOf(catalog, 'closeHelp')} close`;

  return (
    <box
      position="absolute"
      top={0}
      left={2}
      width={boxWidth}
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
      {visible.map((command) => {
        const suffix = suffixOf(command);

        return (
          <box key={command.id} flexDirection="row" gap={2}>
            {command.keys.length === 0 ? null : (
              <text fg={palette.key}>{command.keys.join(' ')}</text>
            )}
            <text fg={palette.text}>{command.label}</text>
            {suffix === undefined ? null : <text fg={palette.dim}>{suffix}</text>}
          </box>
        );
      })}
      {overflows ? <text fg={palette.dim}>{hint}</text> : null}
    </box>
  );
};
