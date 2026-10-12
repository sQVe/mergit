import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { Snapshot } from '../session/session.ts';
import { visibleRows } from '../session/session.ts';
import type { NodeRow, ThreadRow } from '../work/work.ts';
import type { Palette } from './palette.ts';
import {
  branchFor,
  formatAge,
  guideFor,
  guideWidth,
  numberLabelFor,
  scrollTop,
  truncate,
  typeLabelFor,
} from './threadRow.ts';

interface RowProps {
  palette: Palette;
  selected: boolean;
}

const typeWidth = 5;
const numberWidth = 7;
const ageWidth = 5;
const repositoryWidth = 24;
const minimumRepositoryWidth = 6;
const minimumFlatTitleWidth = 12;
const statusLineHeight = 1;

const NodeLine = (props: RowProps & { row: NodeRow; width: number }): ReactNode => {
  const { row, palette, selected } = props;
  const prefix = `${guideFor(row.depth)}${row.folded ? '▸ ' : '▾ '}`;
  const suffix = ` ${row.threads.length}`;
  const titleWidth = Math.max(1, props.width - prefix.length - suffix.length);

  return (
    <box
      flexDirection="row"
      height={1}
      backgroundColor={selected ? palette.selectedBackground : 'transparent'}
    >
      <text fg={palette.dim} width={prefix.length}>
        {prefix}
      </text>
      <text fg={palette.text}>{truncate(row.title, titleWidth)}</text>
      <text fg={palette.dim} width={suffix.length}>
        {suffix}
      </text>
    </box>
  );
};

const ThreadLine = (props: RowProps & { row: ThreadRow; width: number; now: Date }): ReactNode => {
  const { row, palette, selected, now } = props;
  const { thread } = row;
  const flat = row.nodeRowKey === null;
  const prefixWidth = flat ? 0 : row.depth * guideWidth + guideWidth;
  const fixedWidth = typeWidth + numberWidth + ageWidth + minimumFlatTitleWidth;
  const repositoryRoom = Math.min(repositoryWidth, props.width - fixedWidth);
  const repositoryFits = flat && repositoryRoom >= minimumRepositoryWidth;
  const repositoryColumn = repositoryFits ? repositoryRoom : 0;

  const titleWidth = Math.max(
    1,
    props.width - prefixWidth - typeWidth - numberWidth - repositoryColumn - ageWidth,
  );

  return (
    <box
      flexDirection="row"
      height={1}
      backgroundColor={selected ? palette.selectedBackground : 'transparent'}
    >
      {flat ? null : <text fg={palette.dim}>{`${guideFor(row.depth)}${branchFor(row.last)}`}</text>}
      <text fg={palette.typeLabel} width={typeWidth}>
        {typeLabelFor(thread)}
      </text>
      <text fg={palette.dim} width={numberWidth}>
        {numberLabelFor(thread)}
      </text>
      {repositoryColumn > 0 ? (
        <text fg={palette.dim} width={repositoryColumn}>
          {truncate(thread.repository, repositoryColumn - 1)}
        </text>
      ) : null}
      <text fg={palette.text} width={titleWidth}>
        {truncate(thread.title, titleWidth - 1)}
      </text>
      <text fg={palette.dim} width={ageWidth}>
        {formatAge(thread.updatedAt, now).padStart(ageWidth - 1)}
      </text>
    </box>
  );
};

export const ThreadList = (props: {
  snapshot: Snapshot;
  palette: Palette;
  width: number;
}): ReactNode => {
  const { snapshot, palette, width } = props;
  const { selectedRowKey, refreshedAt, savedAt } = snapshot;
  const rows = visibleRows(snapshot);
  const dimensions = useTerminalDimensions();
  const [top, setTop] = useState(0);
  const height = Math.max(1, dimensions.height - statusLineHeight);
  const selectedIndex = rows.findIndex((row) => row.key === selectedRowKey);
  const visibleTop = scrollTop(top, selectedIndex, height, rows.length);

  if (visibleTop !== top) {
    setTop(visibleTop);
  }

  const now = savedAt ?? refreshedAt ?? new Date(0);
  const visible = rows.slice(visibleTop, visibleTop + height);

  return (
    <box flexDirection="column" flexGrow={1} width={width}>
      {visible.map((row) => {
        const selected = row.key === selectedRowKey;

        if (row.kind === 'node') {
          return (
            <NodeLine key={row.key} row={row} palette={palette} selected={selected} width={width} />
          );
        }

        return (
          <ThreadLine
            key={row.key}
            row={row}
            palette={palette}
            selected={selected}
            width={width}
            now={now}
          />
        );
      })}
    </box>
  );
};
