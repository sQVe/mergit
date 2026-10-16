import type { KeyEvent, Renderable } from '@opentui/core';
import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { Command, Intent, TerminalIntent } from '../commands.ts';
import type { Session, Snapshot } from '../session/session.ts';
import { filterRowsOf, visibleRows } from '../session/session.ts';
import type { BrowserPage } from '../work/work.ts';
import { CommandLine, commandLineRows } from './CommandLine.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DetailPane } from './DetailPane.tsx';
import { FilterBar, filterBarRows } from './FilterBar.tsx';
import { FilterComposer, composerLayoutOf } from './FilterComposer.tsx';
import { HelpOverlay } from './HelpOverlay.tsx';
import { helpWindowOf } from './helpWindow.ts';
import { MessageOverlay } from './MessageOverlay.tsx';
import { messageWindowOf } from './messageWindow.ts';
import { hasNotice, Notice } from './Notice.tsx';
import type { Palette } from './palette.ts';
import { pickPalette } from './palette.ts';
import { SearchLine, searchLineRows } from './SearchLine.tsx';
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

interface ModalState {
  helpOpen: boolean;
  messagesOpen: boolean;
  detailOpen: boolean;
  openRequest: OpenRequest | null;
}

interface KeysProps extends AppProps {
  modal: RefObject<ModalState>;
  openRequest: OpenRequest | null;
  setOpenRequest: (request: OpenRequest | null) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  messagesOpen: boolean;
  setMessagesOpen: (open: boolean) => void;
  helpMaximumTop: number;
  setHelpTop: (update: (top: number) => number) => void;
  messagesMaximumTop: number;
  setMessagesTop: (update: (top: number) => number) => void;
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  sideLayout: boolean;
  searchOpen: boolean;
  filtersOpen: boolean;
  commandLineOpen: boolean;
  composerBlind: boolean;
}

const boxChromeRows = 3;
const statusRows = 1;
const sidePaneMinimumWidth = 90;
const sidePaneMaximumWidth = 44;
const sidePaneShare = 0.36;

const inputScopes = new Set<Command['scope']>(['input', 'filter', 'command']);

const isActive = (
  command: Command,
  state: {
    helpOpen: boolean;
    messagesOpen: boolean;
    confirmOpen: boolean;
    detailOpen: boolean;
    searchOpen: boolean;
    filtersOpen: boolean;
    commandLineOpen: boolean;
  },
): boolean => {
  const { helpOpen, messagesOpen, confirmOpen, detailOpen } = state;
  const { searchOpen, filtersOpen, commandLineOpen } = state;

  if (commandLineOpen) {
    return command.scope === 'command';
  }

  if (searchOpen) {
    return command.scope === 'input';
  }

  if (filtersOpen) {
    return command.scope === 'filter';
  }

  if (inputScopes.has(command.scope)) {
    return false;
  }

  const modalScopes: Partial<Record<Command['scope'], boolean>> = {
    help: helpOpen,
    messages: messagesOpen,
    confirm: confirmOpen,
  };

  const modalScopeOpen = modalScopes[command.scope];

  if (modalScopeOpen !== undefined) {
    return modalScopeOpen;
  }

  if (command.scope === 'global') {
    return true;
  }

  if (helpOpen || confirmOpen || messagesOpen) {
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
  const { session, onTerminalIntent, setHelpOpen, setMessagesOpen, setDetailOpen } = props;

  const { setOpenRequest, modal } = props;

  const confirmOpen = () => {
    const { openRequest } = modal.current;

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
    } else if (action === 'openMessages') {
      props.setMessagesTop(() => 0);
      setHelpOpen(false);
      setMessagesOpen(true);
    } else if (action === 'closeMessages') {
      setMessagesOpen(false);
    } else if (intent.action === 'scrollMessages') {
      const { messagesMaximumTop } = props;

      props.setMessagesTop((top) =>
        Math.min(messagesMaximumTop, Math.max(0, Math.min(top, messagesMaximumTop) + intent.lines)),
      );
    } else if (intent.action === 'scrollHelp') {
      const { lines } = intent;

      const { helpMaximumTop } = props;

      props.setHelpTop((top) =>
        Math.min(helpMaximumTop, Math.max(0, Math.min(top, helpMaximumTop) + lines)),
      );
    } else if (modal.current.openRequest === null) {
      props.setHelpTop(() => 0);
      setMessagesOpen(false);
      setHelpOpen(action === 'toggleHelp' ? !modal.current.helpOpen : false);
    }
  };

  const typeIntoPendingInput = (text: string): void => {
    const snapshot = session.getSnapshot();
    const filterPending = snapshot.filtersOpen && !props.filtersOpen;
    const searchPending = snapshot.searchOpen && !props.searchOpen;
    const commandPending = snapshot.commandLineOpen && !props.commandLineOpen;

    if (filterPending) {
      session.send({ kind: 'editFilterDraft', text: snapshot.filterDraft + text });
    } else if (searchPending) {
      session.send({ kind: 'editSearch', text: snapshot.searchText + text });
    } else if (commandPending) {
      session.send({ kind: 'editCommandLine', text: snapshot.commandLineText + text });
    }
  };

  const runCommandLine = (runNamed: (command: Command) => void) => {
    const name = session.getSnapshot().commandLineText.trim();

    session.send({ kind: 'closeCommandLine' });

    if (name === '') {
      return;
    }

    const named = props.catalog.find((command) => command.name === name);

    if (named === undefined) {
      session.send({ kind: 'reportUnknownCommand', name });
    } else {
      runNamed(named);
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
    } else if (intent.kind === 'ui' && intent.action === 'runCommandLine') {
      runCommandLine(run);
    } else if (intent.kind === 'ui') {
      runUiAction(intent);
    } else {
      onTerminalIntent(intent);
    }
  };

  // The scope comes from the live session, because keys in one burst arrive before React
  // renders what the first key changed.
  const commandFor = (key: string): Command | undefined => {
    const { searchOpen, filtersOpen, commandLineOpen } = session.getSnapshot();
    const { helpOpen, messagesOpen, detailOpen, openRequest } = modal.current;

    const live = {
      helpOpen,
      messagesOpen,
      confirmOpen: openRequest !== null,
      detailOpen: detailOpen && !props.sideLayout,
      searchOpen,
      filtersOpen,
      commandLineOpen,
    };

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
      props.messagesOpen,
      props.helpMaximumTop,
      props.messagesMaximumTop,
      props.openRequest,
      setOpenRequest,
      props.detailOpen,
      props.sideLayout,
      props.composerBlind,
      props.catalog,
      session,
      onTerminalIntent,
      setHelpOpen,
      setMessagesOpen,
      setDetailOpen,
    ],
  );

  return null;
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
        reservedRows={
          searchLineRows(snapshot) + commandLineRows(snapshot) + filterBarRows(snapshot)
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
  const [helpOpen, setHelpOpenState] = useState(false);
  const [messagesOpen, setMessagesOpenState] = useState(false);
  const [helpTop, setHelpTop] = useState(0);
  const [messagesTop, setMessagesTop] = useState(0);
  const [detailOpen, setDetailOpenState] = useState(false);
  const [openRequest, setOpenRequestState] = useState<OpenRequest | null>(null);

  // Keys in one burst arrive before React renders, so key handling reads this copy, which each
  // setter updates at once.
  const modal = useRef<ModalState>({
    helpOpen: false,
    messagesOpen: false,
    detailOpen: false,
    openRequest: null,
  });

  const setHelpOpen = (open: boolean) => {
    modal.current.helpOpen = open;
    setHelpOpenState(open);
  };

  const setMessagesOpen = (open: boolean) => {
    modal.current.messagesOpen = open;
    setMessagesOpenState(open);
  };

  const setDetailOpen = (open: boolean) => {
    modal.current.detailOpen = open;
    setDetailOpenState(open);
  };

  const setOpenRequest = (request: OpenRequest | null) => {
    modal.current.openRequest = request;
    setOpenRequestState(request);
  };

  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);

  const themeMode = useSyncExternalStore(
    props.themeSource.subscribe,
    props.themeSource.getThemeMode,
  );

  const palette = pickPalette(themeMode);
  const { width, height } = useTerminalDimensions();

  const helpWindow = helpWindowOf(props.catalog, height);

  const sideLayout = width >= sidePaneMinimumWidth;
  const fullDetail = detailOpen && !sideLayout;

  useEffect(() => {
    if (sideLayout) {
      setDetailOpen(false);
    }
  }, [sideLayout]);

  const composerRows = snapshot.filtersOpen ? filterRowsOf(snapshot) : [];

  const otherRows =
    statusRows +
    boxChromeRows +
    searchLineRows(snapshot) +
    commandLineRows(snapshot) +
    filterBarRows(snapshot);

  const composerLayout = composerLayoutOf(snapshot, composerRows, { width, height, otherRows });
  const composerBlind = composerRows.length > 0 && composerLayout.candidateRows === 0;

  const widestPane = Math.floor(width * sidePaneShare);
  const paneWidth = sideLayout ? Math.min(sidePaneMaximumWidth, widestPane) : 0;

  return (
    <KeymapProvider keymap={props.keymap}>
      <Keys
        {...props}
        modal={modal}
        openRequest={openRequest}
        setOpenRequest={setOpenRequest}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
        messagesOpen={messagesOpen}
        setMessagesOpen={setMessagesOpen}
        helpMaximumTop={helpWindow.maximumTop}
        setHelpTop={setHelpTop}
        messagesMaximumTop={messageWindowOf(snapshot.messages, width, height).maximumTop}
        setMessagesTop={setMessagesTop}
        detailOpen={fullDetail}
        setDetailOpen={setDetailOpen}
        sideLayout={sideLayout}
        searchOpen={snapshot.searchOpen}
        filtersOpen={snapshot.filtersOpen}
        commandLineOpen={snapshot.commandLineOpen}
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
        <CommandLine session={props.session} snapshot={snapshot} palette={palette} />
        <StatusLine snapshot={snapshot} palette={palette} />
      </box>
      <Toast snapshot={snapshot} palette={palette} />
      {openRequest === null ? null : (
        <ConfirmDialog repositories={openRequest.pages.length} palette={palette} />
      )}
      {messagesOpen ? (
        <MessageOverlay
          messages={snapshot.messages}
          palette={palette}
          width={width}
          height={height}
          top={messagesTop}
        />
      ) : null}
      {helpOpen ? (
        <HelpOverlay catalog={props.catalog} palette={palette} height={height} top={helpTop} />
      ) : null}
    </KeymapProvider>
  );
};
