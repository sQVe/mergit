import type { ReactNode } from 'react';

import type { Palette } from './palette.ts';

export interface CandidateItem {
  label: string;
  count: number | null;
  marked: boolean;
  failed: boolean;
}

const markerWidth = 2;

const windowStart = (cursor: number, height: number): number => Math.max(0, cursor - height + 1);

export const CandidateList = (props: {
  items: CandidateItem[];
  cursor: number;
  height: number;
  palette: Palette;
}): ReactNode => {
  const { items, cursor, height, palette } = props;
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
            <text fg={item.failed ? palette.error : palette.text} flexGrow={1}>
              {item.label}
            </text>
            {item.count === null ? null : <text fg={palette.dim}>{` ${item.count}`}</text>}
          </box>
        );
      })}
    </box>
  );
};
