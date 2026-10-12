import { useTerminalDimensions, useTimeline } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import type { Palette } from './palette.ts';

interface ToastMotion {
  slide: number;
  remaining: number;
}

type ToastContent = NonNullable<Snapshot['toast']>;

const maximumWidth = 50;
const horizontalMargin = 4;
const maximumTextLines = 5;
const barColumns = 1;
const paddingColumns = 2;
const paddingRows = 2;
const statusLineHeight = 1;
const restingRight = 1;
const slideMilliseconds = 150;

const toastKeys = new WeakMap<ToastContent, number>();
let nextToastKey = 0;

const keyOf = (toast: ToastContent): number => {
  const existing = toastKeys.get(toast);

  if (existing !== undefined) {
    return existing;
  }

  nextToastKey += 1;
  toastKeys.set(toast, nextToastKey);

  return nextToastKey;
};

const wrapLine = (line: string, columns: number): string[] => {
  const step = Math.max(1, columns);
  const chunks: string[] = [];

  for (let start = 0; start < line.length; start += step) {
    chunks.push(line.slice(start, start + step));
  }

  return chunks.length === 0 ? [''] : chunks;
};

const useToastMotion = (durationMilliseconds: number): ToastMotion => {
  const [motion, setMotion] = useState<ToastMotion>({ slide: 0, remaining: 1 });
  const timeline = useTimeline({ duration: durationMilliseconds });

  useEffect(() => {
    const target = { slide: 0, remaining: 1 };

    const publish = () => {
      setMotion({ slide: target.slide, remaining: target.remaining });
    };

    timeline.add(target, {
      slide: 1,
      duration: slideMilliseconds,
      ease: 'outQuad',
      onUpdate: publish,
    });

    timeline.add(target, {
      remaining: 0,
      duration: durationMilliseconds,
      ease: 'linear',
      onUpdate: publish,
    });
  }, [timeline, durationMilliseconds]);

  return motion;
};

const ToastCard = (props: { toast: ToastContent; palette: Palette }): ReactNode => {
  const { toast, palette } = props;
  const { width: terminalWidth } = useTerminalDimensions();
  const motion = useToastMotion(toast.durationMilliseconds);

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
  const remainingColumns = Math.round(textColumns * motion.remaining);
  const timeLeft = '▁'.repeat(remainingColumns);
  const hiddenRight = -width;
  const right = Math.round(hiddenRight + (restingRight - hiddenRight) * motion.slide);

  return (
    <box
      position="absolute"
      bottom={statusLineHeight}
      right={right}
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
      <text
        position="absolute"
        left={barColumns + 1}
        bottom={0}
        fg={toneColor}
        bg={background}
        width={textColumns}
      >
        {timeLeft}
      </text>
    </box>
  );
};

export const Toast = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const { toast } = props.snapshot;

  if (toast === null) {
    return null;
  }

  return <ToastCard key={keyOf(toast)} toast={toast} palette={props.palette} />;
};
