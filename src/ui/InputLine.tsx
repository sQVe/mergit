import type { ReactNode } from 'react';

import type { Palette } from './palette.ts';

export const InputLine = (props: {
  prompt: string;
  value: string;
  palette: Palette;
  focused: boolean;
  suffix: string | null;
  onInput: (value: string) => void;
}): ReactNode => (
  <box height={1} flexShrink={0} flexDirection="row">
    <text fg={props.palette.dim}>{props.prompt}</text>
    <input
      flexGrow={1}
      value={props.value}
      focused={props.focused}
      textColor={props.palette.text}
      onInput={props.onInput}
    />
    {props.suffix === null ? null : <text fg={props.palette.dim}>{props.suffix}</text>}
  </box>
);
