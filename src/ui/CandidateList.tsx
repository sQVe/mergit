import type { ReactNode } from 'react';

import type { Palette } from './palette.ts';

export interface CandidateItem {
  label: string;
  count: number | null;
  marked: boolean;
  failed: boolean;
  muted: boolean;
}

const markerWidth = 2;

const ellipsis = '…';

export const ellipsized = (text: string, width: number): string => {
  if (text.length <= width) {
    return text;
  }

  return `${text.slice(0, Math.max(0, width - 1))}${ellipsis}`;
};

const fitted = (item: CandidateItem, width: number): string => {
  const countWidth = item.count === null ? 0 : String(item.count).length + 1;

  return ellipsized(item.label, width - markerWidth - countWidth);
};

const windowStart = (cursor: number, height: number): number => Math.max(0, cursor - height + 1);

const textColorOf = (item: CandidateItem, palette: Palette): string => {
  if (item.failed) {
    return palette.error;
  }

  return item.muted ? palette.dim : palette.text;
};

export const CandidateList = (props: {
  items: CandidateItem[];
  cursor: number;
  height: number;
  width: number;
  palette: Palette;
}): ReactNode => {
  const { items, cursor, height, width, palette } = props;
  const start = windowStart(cursor, height);

  return (
    <box flexDirection="column" flexShrink={0}>
      {items.slice(start, start + height).map((item, offset) => {
        const index = start + offset;
        const selected = index === cursor;

        return (
          <box
            key={index}
            height={1}
            flexDirection="row"
            backgroundColor={selected ? palette.selectedBackground : 'transparent'}
          >
            <text fg={palette.newMarker} width={markerWidth}>
              {item.marked ? '✓' : ' '}
            </text>
            <text fg={textColorOf(item, palette)} flexGrow={1}>
              {fitted(item, width)}
            </text>
            {item.count === null ? null : <text fg={palette.dim}>{` ${item.count}`}</text>}
          </box>
        );
      })}
    </box>
  );
};
