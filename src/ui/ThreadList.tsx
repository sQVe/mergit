import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { Snapshot } from '../session/session.ts';
import type { Palette } from './palette.ts';
import { formatAge, numberLabelFor, scrollTop, truncate, typeLabelFor } from './threadRow.ts';

const typeWidth = 5;
const numberWidth = 7;
const ageWidth = 5;
const statusLineHeight = 1;

export const ThreadList = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const { snapshot, palette } = props;
  const { threads, selectedThreadId, refreshedAt, savedAt } = snapshot;
  const dimensions = useTerminalDimensions();
  const [top, setTop] = useState(0);
  const height = Math.max(1, dimensions.height - statusLineHeight);
  const selectedIndex = threads.findIndex((thread) => thread.id === selectedThreadId);
  const visibleTop = scrollTop(top, selectedIndex, height, threads.length);

  if (visibleTop !== top) {
    setTop(visibleTop);
  }

  const titleWidth = Math.max(1, dimensions.width - typeWidth - numberWidth - ageWidth);
  const now = savedAt ?? refreshedAt ?? new Date(0);
  const visible = threads.slice(visibleTop, visibleTop + height);

  return (
    <box flexDirection="column" flexGrow={1}>
      {visible.map((thread) => {
        const selected = thread.id === selectedThreadId;

        return (
          <box
            key={thread.id}
            flexDirection="row"
            height={1}
            backgroundColor={selected ? palette.selectedBackground : 'transparent'}
          >
            <text fg={palette.typeLabel} width={typeWidth}>
              {typeLabelFor(thread)}
            </text>
            <text fg={palette.dim} width={numberWidth}>
              {numberLabelFor(thread)}
            </text>
            <text fg={palette.text} width={titleWidth}>
              {truncate(thread.title, titleWidth - 1)}
            </text>
            <text fg={palette.dim} width={ageWidth}>
              {formatAge(thread.updatedAt, now).padStart(ageWidth - 1)}
            </text>
          </box>
        );
      })}
    </box>
  );
};
