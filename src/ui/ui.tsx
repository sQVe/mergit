import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Command, Intent, TerminalIntent } from '../commands.ts';
import type { FilterRow, Session, Snapshot } from '../session/session.ts';
import {
  filterCursorOf,
  filterRowsOf,
  formatFilter,
  matchCountOf,
  visibleRows,
} from '../session/session.ts';
import type { BrowserPage } from '../work/work.ts';
import type { CandidateItem } from './CandidateList.tsx';
import { CandidateList } from './CandidateList.tsx';
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

const Keys = (props: KeysProps): null => {
  const { session, onTerminalIntent, setHelpOpen, setDetailOpen } = props;

  const { openRequest, setOpenRequest } = props;
  const state = { ...props, confirmOpen: openRequest !== null };
  const commands = props.catalog.filter((command) => isActive(command, state));

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

  const run = (command: Command) => {
    const snapshot = session.getSnapshot();

    if (command.disabledReason(snapshot) !== undefined) {
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

  useBindings(
    () => ({
      bindings: commands.flatMap((command) =>
        command.keys.map((key) => ({
          key,
          preventDefault: command.preventDefault ?? true,
          cmd: () => {
            run(command);
          },
        })),
      ),
    }),
    [
      props.helpOpen,
      openRequest,
      setOpenRequest,
      props.detailOpen,
      props.sideLayout,
      props.searchOpen,
      props.filtersOpen,
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
      onInput={(text) => {
        session.send({ kind: 'editSearch', text });
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

const hintOf = (snapshot: Snapshot, rows: FilterRow[]): string => {
  const field = snapshot.filterDraft.trim().replace(/^-/, '').split(':')[0]?.toLowerCase() ?? '';
  const hasValue = snapshot.filterDraft.includes(':');
  const valueHint = hasValue ? valueHints.get(field) : undefined;

  if (valueHint !== undefined) {
    return valueHint;
  }

  const fields = rows.flatMap((row) => (row.kind === 'field' ? [row.field] : []));

  return fields.join(' ');
};

const itemOf = (row: FilterRow): CandidateItem => {
  if (row.kind === 'error') {
    return { label: row.message, count: null, marked: false, failed: true };
  }

  if (row.kind === 'typed') {
    const label = row.filters.map((filter) => formatFilter(filter)).join(' ');

    return { label, count: row.count, marked: false, failed: false };
  }

  if (row.kind === 'field') {
    return { label: `${row.field}:`, count: null, marked: false, failed: false };
  }

  return {
    label: formatFilter(row.filter),
    count: row.count,
    marked: row.kind === 'active',
    failed: false,
  };
};

const filterBarRows = (snapshot: Snapshot): number => (snapshot.filters.length === 0 ? 0 : 1);

const fixedComposerRows = 2;
const statusRows = 1;
const minimumListRows = 1;

const candidateRowsOf = (snapshot: Snapshot, height: number): number => {
  if (!snapshot.filtersOpen) {
    return 0;
  }

  const taken =
    statusRows +
    fixedComposerRows +
    minimumListRows +
    searchLineRows(snapshot) +
    filterBarRows(snapshot);

  const room = Math.max(0, height - taken);

  return Math.min(composerListRows, room, filterRowsOf(snapshot).length);
};

const composerRows = (snapshot: Snapshot, height: number): number =>
  snapshot.filtersOpen ? candidateRowsOf(snapshot, height) + fixedComposerRows : 0;

const FilterComposer = (props: {
  session: Session;
  snapshot: Snapshot;
  palette: Palette;
  height: number;
}): ReactNode => {
  const { session, snapshot, palette } = props;

  if (!snapshot.filtersOpen) {
    return null;
  }

  const rows = filterRowsOf(snapshot);

  return (
    <box flexDirection="column" flexShrink={0}>
      <CandidateList
        items={rows.map((row) => itemOf(row))}
        cursor={filterCursorOf(snapshot)}
        height={candidateRowsOf(snapshot, props.height)}
        palette={palette}
      />
      <box height={1} flexShrink={0}>
        <text fg={palette.dim}>{hintOf(snapshot, rows)}</text>
      </box>
      <InputLine
        prompt="f"
        value={snapshot.filterDraft}
        palette={palette}
        focused
        suffix={null}
        onInput={(text) => {
          session.send({ kind: 'editFilterDraft', text });
        }}
      />
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
  const { height } = useTerminalDimensions();

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
        reservedRows={
          searchLineRows(snapshot) + composerRows(snapshot, height) + filterBarRows(snapshot)
        }
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
      />
      <box flexDirection="column" flexGrow={1}>
        {filterBarRows(snapshot) === 0 ? null : (
          <FilterBar filters={snapshot.filters} palette={palette} width={width} />
        )}
        <Body
          snapshot={snapshot}
          palette={palette}
          width={width}
          paneWidth={paneWidth}
          fullDetail={fullDetail}
        />
        <SearchLine session={props.session} snapshot={snapshot} palette={palette} />
        <FilterComposer
          session={props.session}
          snapshot={snapshot}
          palette={palette}
          height={height}
        />
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
