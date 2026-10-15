import type { ReactNode } from 'react';

import type { FilterRow, Session, Snapshot } from '../session/session.ts';
import { describeFilterRow, filterCursorOf, formatFilter } from '../session/session.ts';
import type { CandidateItem } from './CandidateList.tsx';
import { CandidateList, wrapText } from './CandidateList.tsx';
import { filterBarRows } from './FilterBar.tsx';
import { InputLine } from './InputLine.tsx';
import type { Palette } from './palette.ts';

export interface ComposerLayout {
  candidateRows: number;
  hintRows: number;
  descriptionLines: string[];
}

const composerListRows = 8;

const valueHints = new Map([
  ['kind', 'pr, issue, release, discussion, commit, or ci'],
  ['repo', 'owner/name, one * allowed'],
  ['org', 'owner, one * allowed'],
  ['author', 'login, one * allowed'],
  ['reason', 'a reason such as mention'],
  ['state', 'open, closed, or merged'],
  ['new', 'true or false'],
  ['unread', 'true or false'],
  ['age', '<N or >N with m h d w'],
  ['title', 'words in the title'],
]);

const keyHints = 'Enter apply · Tab edit · - exclude · Esc close';

const hintOf = (snapshot: Snapshot): string => {
  const field = snapshot.filterDraft.trim().replace(/^-/, '').split(':')[0]?.toLowerCase() ?? '';
  const hasValue = snapshot.filterDraft.includes(':');
  const valueHint = hasValue ? valueHints.get(field) : undefined;

  return valueHint ?? keyHints;
};

const itemOf = (row: FilterRow): CandidateItem => {
  if (row.kind === 'error') {
    return { label: row.message, count: null, marked: false, failed: true, muted: false };
  }

  if (row.kind === 'typed') {
    const label = row.filters.map((filter) => formatFilter(filter)).join(' ');

    return { label, count: row.count, marked: false, failed: false, muted: false };
  }

  if (row.kind === 'field') {
    return { label: `${row.field}:`, count: null, marked: false, failed: false, muted: false };
  }

  return {
    label: formatFilter(row.filter),
    count: row.count,
    marked: row.kind === 'active',
    failed: false,
    muted: false,
  };
};

const noMatchesItem: CandidateItem = {
  label: 'No matches. Use / to search titles.',
  count: null,
  marked: false,
  failed: false,
  muted: true,
};

const titleOf = (snapshot: Snapshot): string => {
  const { filterEditing } = snapshot;

  return filterEditing === null ? ' Filter ' : ` Filter · editing ${formatFilter(filterEditing)} `;
};

const composerChromeWidth = 4;

const showsNoMatches = (snapshot: Snapshot, rows: FilterRow[]): boolean =>
  rows.length === 0 && snapshot.filterDraft.trim() !== '' && !snapshot.filterDraft.includes(':');

const descriptionOf = (snapshot: Snapshot, rows: FilterRow[]): string =>
  describeFilterRow(snapshot, rows[filterCursorOf(snapshot)]);

const maxDescriptionLines = 3;

export const composerLayoutOf = (
  snapshot: Snapshot,
  rows: FilterRow[],
  size: { width: number; height: number; otherRows: number },
): ComposerLayout => {
  const rowCount = showsNoMatches(snapshot, rows) ? 1 : rows.length;
  const room = Math.max(0, size.height - size.otherRows);
  const wanted = Math.min(composerListRows, rowCount);
  const lineRoom = Math.min(maxDescriptionLines, Math.max(0, room - wanted));
  const text = lineRoom === 0 ? '' : descriptionOf(snapshot, rows);
  const descriptionLines = wrapText(text, size.width - composerChromeWidth, lineRoom);
  const hintRows = room > wanted + descriptionLines.length ? 1 : 0;
  const candidateRows = Math.min(wanted, room - hintRows - descriptionLines.length);

  return { candidateRows, hintRows, descriptionLines };
};

export const FilterComposer = (props: {
  session: Session;
  snapshot: Snapshot;
  palette: Palette;
  rows: FilterRow[];
  layout: ComposerLayout;
  width: number;
}): ReactNode => {
  const { session, snapshot, palette, rows, layout, width } = props;

  if (!snapshot.filtersOpen) {
    return null;
  }

  const cursor = filterCursorOf(snapshot);
  const items = showsNoMatches(snapshot, rows) ? [noMatchesItem] : rows.map((row) => itemOf(row));

  return (
    <box
      position="absolute"
      top={filterBarRows(snapshot)}
      left={0}
      right={0}
      border
      borderStyle="rounded"
      borderColor={palette.key}
      title={titleOf(snapshot)}
      backgroundColor={palette.overlayBackground}
      zIndex={5}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <InputLine
        prompt={null}
        value={snapshot.filterDraft}
        palette={palette}
        focused
        suffix={null}
        watch={session.subscribe}
        current={() => session.getSnapshot().filterDraft}
        onInput={(text) => {
          const live = session.getSnapshot();

          if (live.filtersOpen && live.filterDraft !== text) {
            session.send({ kind: 'editFilterDraft', text });
          }
        }}
      />
      {layout.hintRows === 0 ? null : (
        <box height={1} flexShrink={0}>
          <text fg={palette.dim}>{hintOf(snapshot)}</text>
        </box>
      )}
      <CandidateList
        items={items}
        cursor={cursor}
        height={layout.candidateRows}
        width={width - composerChromeWidth}
        palette={palette}
      />
      {layout.descriptionLines.map((line, index) => (
        <box key={index} height={1} flexShrink={0}>
          <text fg={palette.dim}>{line}</text>
        </box>
      ))}
    </box>
  );
};
