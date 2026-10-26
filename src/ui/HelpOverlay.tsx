import type { ReactNode } from 'react';

import type { Command } from '../commands.ts';
import { keyHintOf } from '../commands.ts';
import { boxChromeColumns, footerOf } from './helpWindow.ts';
import type { HelpLine, HelpWindow } from './helpWindow.ts';
import { InputLine } from './InputLine.tsx';
import type { Palette } from './palette.ts';
import { fitText } from './textLayout.ts';
import type { HelpSearchInput, Overlay, UiIntent } from './uiState.ts';

const lineOf = (line: HelpLine, index: number, palette: Palette): ReactNode => {
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
  search: Extract<Overlay, { kind: 'help' }>;
  input: HelpSearchInput;
  runUiAction: (intent: UiIntent) => void;
}): ReactNode => {
  const { palette, catalog } = props;

  const { lines, viewportRows, maximumTop, overflows, boxWidth, boxHeight } = props.helpWindow;

  const top = Math.min(props.top, maximumTop);
  const visible = lines.slice(top, top + viewportRows);
  const position = `${top + 1}-${top + visible.length} of ${lines.length}`;
  const innerWidth = boxWidth - boxChromeColumns;

  const hint = props.search.editing
    ? fitText(position, innerWidth)
    : footerOf(catalog, position, innerWidth);

  const searchKey = keyHintOf(catalog, 'openHelpSearch');
  const retainedSearch = fitText(`${searchKey} search ${props.search.text}`, innerWidth);

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
      {visible.map((line, index) => lineOf(line, index, palette))}
      {overflows ? <text fg={palette.dim}>{hint}</text> : null}
      {props.search.editing ? (
        <InputLine
          prompt="Search: "
          value={props.search.text}
          focused
          palette={palette}
          suffix={null}
          watch={props.input.watch}
          current={props.input.current}
          onInput={(text) => {
            props.runUiAction({ kind: 'ui', action: 'editHelpSearch', text });
          }}
        />
      ) : (
        <text fg={palette.dim}>{retainedSearch}</text>
      )}
    </box>
  );
};
