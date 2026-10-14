import type { InputRenderable } from '@opentui/core';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import type { Palette } from './palette.ts';

export const InputLine = (props: {
  prompt: string | null;
  value: string;
  palette: Palette;
  focused: boolean;
  suffix: string | null;
  onInput: (value: string) => void;
  // Reads the live session text and returns an unsubscribe function for its changes.
  watch: (apply: () => void) => () => void;
  current: () => string;
}): ReactNode => {
  const input = useRef<InputRenderable>(null);
  const { watch, current } = props;

  // The input keeps its own buffer until the next render, so a command that replaces the
  // text must reach it before the next key in the same burst does.
  useEffect(
    () =>
      watch(() => {
        const field = input.current;
        const text = current();

        if (field !== null && field.value !== text) {
          field.value = text;
        }
      }),
    [watch, current],
  );

  return (
    <box height={1} flexShrink={0} flexDirection="row">
      {props.prompt === null ? null : <text fg={props.palette.dim}>{props.prompt}</text>}
      <input
        flexGrow={1}
        ref={input}
        value={props.value}
        focused={props.focused}
        textColor={props.palette.text}
        onInput={props.onInput}
      />
      {props.suffix === null ? null : <text fg={props.palette.dim}>{props.suffix}</text>}
    </box>
  );
};
