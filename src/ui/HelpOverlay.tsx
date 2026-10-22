import type { ReactNode } from 'react';

import type { Command } from '../commands.ts';
import { boxChromeColumns, footerOf } from './helpWindow.ts';
import type { HelpLine, HelpWindow } from './helpWindow.ts';
import type { Palette } from './palette.ts';

const lineOf = (line: HelpLine, index: number, palette: Palette): ReactNode => {
  if (line.kind === 'blank') {
    return <text key={index}> </text>;
  }

  if (line.kind === 'heading') {
    return (
      <text key={index} fg={palette.heading}>
        {line.text}
      </text>
    );
  }

  return (
    <box key={index} flexDirection="row" justifyContent="space-between">
      <text fg={palette.key}>{line.keys}</text>
      <text fg={palette.text}>{line.label}</text>
    </box>
  );
};

export const HelpOverlay = (props: {
  catalog: readonly Command[];
  palette: Palette;
  height: number;
  helpWindow: HelpWindow;
  top: number;
}): ReactNode => {
  const { palette, catalog } = props;

  const { lines, viewportRows, maximumTop, overflows, boxWidth, boxHeight } = props.helpWindow;

  const top = Math.min(props.top, maximumTop);
  const visible = lines.slice(top, top + viewportRows);
  const position = `${top + 1}-${top + visible.length} of ${lines.length}`;
  const hint = footerOf(catalog, position, boxWidth - boxChromeColumns);

  return (
    <box
      position="absolute"
      top={props.height - 1 - boxHeight}
      left={2}
      width={boxWidth}
      height={boxHeight}
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
      {visible.map((line, index) => lineOf(line, top + index, palette))}
      {overflows ? <text fg={palette.dim}>{hint}</text> : null}
    </box>
  );
};
