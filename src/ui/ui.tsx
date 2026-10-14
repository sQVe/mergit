import type { KeyEvent, Renderable } from '@opentui/core';
import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Command, Intent, TerminalIntent } from '../commands.ts';
import type { FilterRow, Session, Snapshot } from '../session/session.ts';
import {
  describeFilterRow,
  filterCursorOf,
  filterRowsOf,
  formatFilter,
  matchCountOf,
  visibleRows,
} from '../session/session.ts';
import type { BrowserPage } from '../work/work.ts';
import type { CandidateItem } from './CandidateList.tsx';
import { CandidateList, wrapText } from './CandidateList.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DetailPane } from './DetailPane.tsx';
import { FilterBar } from './FilterBar.tsx';
import { HelpOverlay } from './HelpOverlay.tsx';
import { InputLine } from './InputLine.tsx';
import { hasNotice, Notice } from './Notice.tsx';
import type { Palette } from './palette.ts';
import { pickPalette } from './palette.ts';
import { StatusLine } from './StatusLine.tsx';
import { ThreadList } from './ThreadList.tsx';
import { Toast } from './Toast.tsx';

type UiIntent = Extract<Intent, { kind: 'ui' }>;

type ThemeMode = 'light' | 'dark' | null;

export interface ThemeSource {
  getThemeMode: () => ThemeMode;
  subscribe: (listener: () => void) => () => void;
}

export interface AppProps {
  session: Session;
  catalog: readonly Command[];
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>;
  themeSource: ThemeSource;
  onTerminalIntent: (intent: TerminalIntent) => void;
}

interface OpenRequest {
  pages: readonly BrowserPage[];
}

interface KeysProps extends AppProps {
  openRequest: OpenRequest | null;
  setOpenRequest: (request: OpenRequest | null) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  sideLayout: boolean;
  searchOpen: boolean;
  filtersOpen: boolean;
  composerBlind: boolean;
}

interface ComposerLayout {
  candidateRows: number;
  hintRows: number;
  descriptionLines: string[];
}

const sidePaneMinimumWidth = 90;
const sidePaneMaximumWidth = 44;
const sidePaneShare = 0.36;

const isActive = (
  command: Command,
  state: {
    helpOpen: boolean;
    confirmOpen: boolean;
    detailOpen: boolean;
    searchOpen: boolean;
    filtersOpen: boolean;
  },
): boolean => {
  const { helpOpen, confirmOpen, detailOpen, searchOpen, filtersOpen } = state;

  if (searchOpen) {
    return command.scope === 'input';
  }

  if (filtersOpen) {
    return command.scope === 'filter';
  }

  if (command.scope === 'input' || command.scope === 'filter') {
    return false;
  }

  if (command.scope === 'help') {
    return helpOpen;
  }

  if (command.scope === 'confirm') {
    return confirmOpen;
  }

  if (command.scope === 'global') {
    return true;
  }

  if (helpOpen || confirmOpen) {
    return false;
  }

  return command.scope === 'preview' ? detailOpen : !detailOpen;
};

const isRowAction = (command: Command, snapshot: Snapshot): boolean => {
  const intent = command.intent(snapshot);

  if (intent.kind !== 'application') {
    return false;
  }

  return intent.intent.kind === 'applyFilterRow' || intent.intent.kind === 'takeFilterRow';
};

const Keys = (props: KeysProps): null => {
  const { session, onTerminalIntent, setHelpOpen, setDetailOpen } = props;

  const { openRequest, setOpenRequest } = props;
  const state = { ...props, confirmOpen: openRequest !== null };

  const confirmOpen = () => {
    setOpenRequest(null);

    if (openRequest !== null) {
      session.send({ kind: 'openInBrowser', pages: openRequest.pages });
    }
  };

  const runUiAction = (intent: UiIntent) => {
    const { action } = intent;

    if (intent.action === 'askOpen') {
      setOpenRequest({ pages: intent.pages });
    } else if (action === 'confirmOpen') {
      confirmOpen();
    } else if (action === 'cancelOpen') {
      setOpenRequest(null);
    } else if (action === 'openDetail') {
      setDetailOpen(!props.sideLayout);
    } else if (action === 'closeDetail') {
      setDetailOpen(false);
    } else if (openRequest === null) {
      setHelpOpen(action === 'toggleHelp' ? !props.helpOpen : false);
    }
  };

  const typeIntoPendingInput = (text: string): void => {
    const snapshot = session.getSnapshot();
    const filterPending = snapshot.filtersOpen && !props.filtersOpen;
    const searchPending = snapshot.searchOpen && !props.searchOpen;

    if (filterPending) {
      session.send({ kind: 'editFilterDraft', text: snapshot.filterDraft + text });
    } else if (searchPending) {
      session.send({ kind: 'editSearch', text: snapshot.searchText + text });
    }
  };

  const run = (command: Command) => {
    const snapshot = session.getSnapshot();

    if (command.disabledReason(snapshot) !== undefined) {
      return;
    }

    if (props.composerBlind && isRowAction(command, snapshot)) {
      return;
    }

    const intent = command.intent(snapshot);

    if (intent.kind === 'application') {
      session.send(intent.intent);
    } else if (intent.kind === 'ui') {
      runUiAction(intent);
    } else {
      onTerminalIntent(intent);
    }
  };

  // The scope comes from the live session, because keys in one burst arrive before React
  // renders what the first key changed.
  const commandFor = (key: string): Command | undefined => {
    const { searchOpen, filtersOpen } = session.getSnapshot();
    const live = { ...state, searchOpen, filtersOpen };

    return props.catalog.find((command) => command.keys.includes(key) && isActive(command, live));
  };

  // A key no command takes reaches here. Before the input takes focus, it is typed here.
  useKeyboard((event) => {
    const isOneVisibleCodePoint = /^[^\p{Cc}]$/u.test(event.sequence);
    const printable = isOneVisibleCodePoint && !event.ctrl && !event.meta;

    if (printable) {
      typeIntoPendingInput(event.sequence);
    }
  });

  const keyStrings = [...new Set(props.catalog.flatMap((command) => command.keys))];

  useBindings(
    () => ({
      bindings: keyStrings.map((key) => ({
        key,
        preventDefault: false,
        cmd: (context: CommandContext<Renderable, KeyEvent>) => {
          const command = commandFor(key);

          if (command === undefined) {
            return;
          }

          run(command);

          if (command.preventDefault ?? true) {
            context.event.preventDefault();
            context.event.stopPropagation();
          }
        },
      })),
    }),
    [
      props.helpOpen,
      openRequest,
      setOpenRequest,
      props.detailOpen,
      props.sideLayout,
      props.composerBlind,
      props.catalog,
      session,
      onTerminalIntent,
      setHelpOpen,
      setDetailOpen,
    ],
  );

  return null;
};

const searchLineRows = (snapshot: Snapshot): number => {
  if (!snapshot.searchOpen && snapshot.searchText === '') {
    return 0;
  }

  return 1;
};

const SearchLine = (props: {
  session: Session;
  snapshot: Snapshot;
  palette: Palette;
}): ReactNode => {
  const { session, snapshot, palette } = props;

  if (!snapshot.searchOpen && snapshot.searchText === '') {
    return null;
  }

  const count = matchCountOf(snapshot);
  const suffix = `${count} ${count === 1 ? 'match' : 'matches'}`;

  return (
    <InputLine
      prompt="/"
      value={snapshot.searchText}
      palette={palette}
      focused={snapshot.searchOpen}
      suffix={suffix}
      watch={session.subscribe}
      current={() => session.getSnapshot().searchText}
      onInput={(text) => {
        const live = session.getSnapshot();

        if (live.searchOpen && live.searchText !== text) {
          session.send({ kind: 'editSearch', text });
        }
      }}
    />
  );
};

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

const filterBarRows = (snapshot: Snapshot): number => (snapshot.filters.length === 0 ? 0 : 1);

const boxChromeRows = 3;
const composerChromeWidth = 4;
const statusRows = 1;

const showsNoMatches = (snapshot: Snapshot, rows: FilterRow[]): boolean =>
  rows.length === 0 && snapshot.filterDraft.trim() !== '' && !snapshot.filterDraft.includes(':');

const descriptionOf = (snapshot: Snapshot, rows: FilterRow[]): string =>
  describeFilterRow(snapshot, rows[filterCursorOf(snapshot)]);

const maxDescriptionLines = 3;

const composerLayoutOf = (
  snapshot: Snapshot,
  rows: FilterRow[],
  size: { width: number; height: number },
): ComposerLayout => {
  const rowCount = showsNoMatches(snapshot, rows) ? 1 : rows.length;
  const taken = statusRows + boxChromeRows + searchLineRows(snapshot) + filterBarRows(snapshot);
  const room = Math.max(0, size.height - taken);
  const wanted = Math.min(composerListRows, rowCount);
  const lineRoom = Math.min(maxDescriptionLines, Math.max(0, room - wanted));
  const text = lineRoom === 0 ? '' : descriptionOf(snapshot, rows);
  const descriptionLines = wrapText(text, size.width - composerChromeWidth, lineRoom);
  const hintRows = room > wanted + descriptionLines.length ? 1 : 0;
  const candidateRows = Math.min(wanted, room - hintRows - descriptionLines.length);

  return { candidateRows, hintRows, descriptionLines };
};

const FilterComposer = (props: {
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

const Body = (props: {
  snapshot: Snapshot;
  palette: Palette;
  width: number;
  paneWidth: number;
  fullDetail: boolean;
}): ReactNode => {
  const { snapshot, palette, width, paneWidth } = props;
  const selectedRow = visibleRows(snapshot).find((row) => row.key === snapshot.selectedRowKey);

  const facts =
    selectedRow?.kind === 'thread' ? snapshot.subjectFacts.get(selectedRow.thread.id) : undefined;

  const now = snapshot.savedAt ?? snapshot.refreshedAt ?? new Date(0);

  if (hasNotice(snapshot)) {
    return <Notice snapshot={snapshot} palette={palette} />;
  }

  if (props.fullDetail) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <DetailPane
          row={selectedRow}
          facts={facts}
          newThreadIds={snapshot.newThreadIds}
          palette={palette}
          now={now}
          width={width}
        />
      </box>
    );
  }

  return (
    <box flexDirection="row" flexGrow={1}>
      <ThreadList
        snapshot={snapshot}
        palette={palette}
        width={width - paneWidth}
        reservedRows={searchLineRows(snapshot) + filterBarRows(snapshot)}
      />
      {paneWidth > 0 ? (
        <DetailPane
          row={selectedRow}
          facts={facts}
          newThreadIds={snapshot.newThreadIds}
          palette={palette}
          now={now}
          width={paneWidth}
        />
      ) : null}
    </box>
  );
};

export const App = (props: AppProps): ReactNode => {
  const [helpOpen, setHelpOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);

  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);

  const themeMode = useSyncExternalStore(
    props.themeSource.subscribe,
    props.themeSource.getThemeMode,
  );

  const palette = pickPalette(themeMode);
  const { width, height } = useTerminalDimensions();

  const sideLayout = width >= sidePaneMinimumWidth;
  const fullDetail = detailOpen && !sideLayout;

  useEffect(() => {
    if (sideLayout) {
      setDetailOpen(false);
    }
  }, [sideLayout]);

  const composerRows = snapshot.filtersOpen ? filterRowsOf(snapshot) : [];

  const composerLayout = composerLayoutOf(snapshot, composerRows, { width, height });
  const composerBlind = composerRows.length > 0 && composerLayout.candidateRows === 0;

  const widestPane = Math.floor(width * sidePaneShare);
  const paneWidth = sideLayout ? Math.min(sidePaneMaximumWidth, widestPane) : 0;

  return (
    <KeymapProvider keymap={props.keymap}>
      <Keys
        {...props}
        openRequest={openRequest}
        setOpenRequest={setOpenRequest}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
        detailOpen={fullDetail}
        setDetailOpen={setDetailOpen}
        sideLayout={sideLayout}
        searchOpen={snapshot.searchOpen}
        filtersOpen={snapshot.filtersOpen}
        composerBlind={composerBlind}
      />
      <box flexDirection="column" flexGrow={1}>
        {filterBarRows(snapshot) === 0 ? null : (
          <FilterBar filters={snapshot.filters} palette={palette} width={width} />
        )}
        <FilterComposer
          session={props.session}
          snapshot={snapshot}
          palette={palette}
          rows={composerRows}
          layout={composerLayout}
          width={width}
        />
        <Body
          snapshot={snapshot}
          palette={palette}
          width={width}
          paneWidth={paneWidth}
          fullDetail={fullDetail}
        />
        <SearchLine session={props.session} snapshot={snapshot} palette={palette} />
        <StatusLine snapshot={snapshot} palette={palette} />
      </box>
      <Toast snapshot={snapshot} palette={palette} />
      {openRequest === null ? null : (
        <ConfirmDialog repositories={openRequest.pages.length} palette={palette} />
      )}
      {helpOpen ? <HelpOverlay catalog={props.catalog} palette={palette} /> : null}
    </KeymapProvider>
  );
};
