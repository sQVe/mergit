import type { KeyEvent, Renderable } from '@opentui/core';
import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings, useKeymap } from '@opentui/keymap/react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { Command, Intent, TerminalIntent } from '../commands.ts';
import { keyHintOf, scopePriority } from '../commands.ts';
import type { FilterRow, Session, Snapshot } from '../session/session.ts';
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
import { Notice, readNoticeMessage } from './Notice.tsx';
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

type Overlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'messages' }
  | { kind: 'confirm'; pages: readonly BrowserPage[] };

interface ModalState {
  overlay: Overlay;
  detailOpen: boolean;
}

interface KeysProps extends AppProps {
  modal: RefObject<ModalState>;
  overlay: Overlay;
  setOverlay: (overlay: Overlay) => void;
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
  width: number;
  height: number;
}

const boxChromeRows = 3;
const statusRows = 1;
const sidePaneMinimumWidth = 90;
const sidePaneMaximumWidth = 44;
const sidePaneShare = 0.36;

const inputScopes = new Set<Command['scope']>(['input', 'filter', 'command']);

const isActive = (
  scope: Command['scope'],
  state: {
    overlay: Overlay['kind'];
    detailOpen: boolean;
    searchOpen: boolean;
    filtersOpen: boolean;
    commandLineOpen: boolean;
  },
): boolean => {
  const { overlay, detailOpen } = state;
  const { searchOpen, filtersOpen, commandLineOpen } = state;

  if (commandLineOpen) {
    return scope === 'command';
  }

  if (searchOpen) {
    return scope === 'input';
  }

  if (filtersOpen) {
    return scope === 'filter';
  }

  if (inputScopes.has(scope)) {
    return false;
  }

  const modalScopes: Partial<Record<Command['scope'], boolean>> = {
    help: overlay === 'help',
    messages: overlay === 'messages',
    confirm: overlay === 'confirm',
  };

  const modalScopeOpen = modalScopes[scope];

  if (modalScopeOpen !== undefined) {
    return modalScopeOpen;
  }

  if (scope === 'global') {
    return true;
  }

  if (overlay !== 'none') {
    return false;
  }

  return scope === 'preview' ? detailOpen : !detailOpen;
};

const composerRowsOf = (snapshot: Snapshot) => (snapshot.filtersOpen ? filterRowsOf(snapshot) : []);

const searchRoomOf = (snapshot: Snapshot, height: number): number =>
  Math.max(
    0,
    height - statusRows - boxChromeRows - commandLineRows(snapshot) - filterBarRows(snapshot),
  );

const composerLayoutFor = (
  snapshot: Snapshot,
  rows: FilterRow[],
  size: { width: number; height: number },
) => {
  const { width, height } = size;
  const searchRoom = searchRoomOf(snapshot, height);

  const otherRows =
    statusRows +
    boxChromeRows +
    searchLineRows(snapshot, searchRoom) +
    commandLineRows(snapshot) +
    filterBarRows(snapshot);

  return composerLayoutOf(snapshot, rows, { width, height, otherRows });
};

const isComposerBlind = (snapshot: Snapshot, width: number, height: number): boolean => {
  const rows = composerRowsOf(snapshot);

  return (
    rows.length > 0 && composerLayoutFor(snapshot, rows, { width, height }).candidateRows === 0
  );
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- scopePriority is a Record over Command['scope']
const scopeOrder = Object.keys(scopePriority) as Command['scope'][];

const isFilterRowIntent = (intent: ReturnType<Command['intent']>): boolean => {
  if (intent.kind !== 'application') {
    return false;
  }

  return intent.intent.kind === 'applyFilterRow' || intent.intent.kind === 'takeFilterRow';
};

const isPlainKey = (event: KeyEvent): boolean => !event.ctrl && !event.meta && !event.shift;

const leadDigitOf = (event: KeyEvent): { value: number } | undefined =>
  isPlainKey(event) && /^[1-9]$/.test(event.name) ? { value: Number(event.name) } : undefined;

const moreDigitOf = (event: KeyEvent): { value: number } | undefined =>
  isPlainKey(event) && /^[0-9]$/.test(event.name) ? { value: Number(event.name) } : undefined;

const countOf = (payload: unknown): number | undefined => {
  if (typeof payload !== 'object' || payload === null || !('lead' in payload)) {
    return undefined;
  }

  const more = 'more' in payload ? String(payload.more) : '';

  return Number(`${String(payload.lead)}${more}`);
};

const countPrefixes = ['{lead}', '{lead}{more}'];

// A child of Keys: React runs a child's effects first on mount and last on unmount, so the
// patterns exist before the layers register and outlive them.
const CountPatterns = (): null => {
  const keymap = useKeymap();

  useEffect(() => {
    const removeLead = keymap.registerSequencePattern({
      name: 'lead',
      max: 1,
      match: leadDigitOf,
      finalize: (values) => String(values[0]),
    });

    const removeMore = keymap.registerSequencePattern({
      name: 'more',
      match: moreDigitOf,
      finalize: (values) => values.join(''),
    });

    return () => {
      removeMore();
      removeLead();
    };
  }, [keymap]);

  return null;
};

const keymapIds = new WeakMap<AppProps['keymap'], number>();

let keymapsSeen = 0;

// Keys remounts when the keymap changes, so its layers leave before its count patterns do.
const keymapKeyOf = (keymap: AppProps['keymap']): number => {
  const known = keymapIds.get(keymap);

  if (known !== undefined) {
    return known;
  }

  keymapsSeen += 1;
  keymapIds.set(keymap, keymapsSeen);

  return keymapsSeen;
};

const Keys = (props: KeysProps): ReactNode => {
  const { session, onTerminalIntent, setOverlay, setDetailOpen, modal } = props;

  const confirmOpen = () => {
    const { overlay } = modal.current;

    setOverlay({ kind: 'none' });

    if (overlay.kind === 'confirm') {
      session.send({ kind: 'openInBrowser', pages: overlay.pages });
    }
  };

  const openMessages = () => {
    if (modal.current.overlay.kind === 'confirm') {
      return;
    }

    props.setMessagesTop(() => 0);
    setOverlay({ kind: 'messages' });
  };

  const toggleHelp = (toggling: boolean) => {
    const { kind } = modal.current.overlay;

    if (kind === 'confirm') {
      return;
    }

    props.setHelpTop(() => 0);
    setOverlay(toggling && kind !== 'help' ? { kind: 'help' } : { kind: 'none' });
  };

  const runUiAction = (intent: UiIntent) => {
    const { action } = intent;

    if (intent.action === 'askOpen') {
      setOverlay({ kind: 'confirm', pages: intent.pages });
    } else if (action === 'confirmOpen') {
      confirmOpen();
    } else if (action === 'cancelOpen') {
      setOverlay({ kind: 'none' });
    } else if (action === 'openDetail') {
      setDetailOpen(!props.sideLayout);
    } else if (action === 'closeDetail') {
      setDetailOpen(false);
    } else if (action === 'openMessages') {
      openMessages();
    } else if (action === 'closeMessages') {
      setOverlay({ kind: 'none' });
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
    } else {
      toggleHelp(action === 'toggleHelp');
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

  const run = (command: Command, count?: number) => {
    const snapshot = session.getSnapshot();

    if (command.disabledReason(snapshot) !== undefined) {
      return;
    }

    const intent = command.intent(snapshot, count);

    if (isFilterRowIntent(intent) && isComposerBlind(snapshot, props.width, props.height)) {
      return;
    }

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
  const scopeActive = (scope: Command['scope']): boolean => {
    const { searchOpen, filtersOpen, commandLineOpen } = session.getSnapshot();
    const { overlay, detailOpen } = modal.current;

    return isActive(scope, {
      overlay: overlay.kind,
      detailOpen: detailOpen && !props.sideLayout,
      searchOpen,
      filtersOpen,
      commandLineOpen,
    });
  };

  // A key no command takes reaches here. Before the input takes focus, it is typed here.
  useKeyboard((event) => {
    const isOneVisibleCodePoint = /^[^\p{Cc}]$/u.test(event.sequence);
    const printable = isOneVisibleCodePoint && !event.ctrl && !event.meta;

    if (printable) {
      typeIntoPendingInput(event.sequence);
    }
  });

  const bindingDeps = [
    props.overlay,
    props.helpMaximumTop,
    props.messagesMaximumTop,
    setOverlay,
    props.detailOpen,
    props.sideLayout,
    props.width,
    props.height,
    props.catalog,
    session,
    onTerminalIntent,
    setDetailOpen,
  ];

  const bindingFor = (scoped: Command[], key: string, prefix: string | undefined) => ({
    key: `${prefix ?? ''}${key}`,
    preventDefault: false,
    cmd: (context: CommandContext<Renderable, KeyEvent>) => {
      const command = scoped.find((candidate) => candidate.keys.includes(key));

      if (command === undefined) {
        return;
      }

      run(command, prefix === undefined ? undefined : countOf(context.payload));

      if (command.preventDefault ?? true) {
        context.event.preventDefault();
        context.event.stopPropagation();
      }
    },
  });

  // A pending count swallows the next key unless a binding follows it.
  const commandsDuringCount = (scope: Command['scope']) => {
    if (scope !== 'list') {
      return [];
    }

    return props.catalog.flatMap((command) =>
      (command.keysDuringCount ?? []).flatMap((key) =>
        countPrefixes.map((prefix) => ({
          key: `${prefix}${key}`,
          cmd: () => {
            run(command);
          },
        })),
      ),
    );
  };

  const layerFor = (scope: Command['scope']) => {
    const scoped = props.catalog.filter((command) => command.scope === scope);
    const keyStrings = [...new Set(scoped.flatMap((command) => command.keys))];

    const countedKeys = scoped
      .filter((command) => scope === 'list' && command.counted === true)
      .flatMap((command) => command.keys);

    return {
      priority: scopePriority[scope],
      enabled: () => scopeActive(scope),
      bindings: [
        ...keyStrings.map((key) => bindingFor(scoped, key, undefined)),
        ...countedKeys.flatMap((key) =>
          countPrefixes.map((prefix) => bindingFor(scoped, key, prefix)),
        ),
        ...commandsDuringCount(scope),
      ],
    };
  };

  for (const scope of scopeOrder) {
    useBindings(() => layerFor(scope), bindingDeps);
  }

  return <CountPatterns />;
};

const Body = (props: {
  snapshot: Snapshot;
  palette: Palette;
  width: number;
  paneWidth: number;
  fullDetail: boolean;
  listHeight: number;
  catalog: readonly Command[];
}): ReactNode => {
  const { snapshot, palette, width, paneWidth, listHeight } = props;
  const selectedRow = visibleRows(snapshot).find((row) => row.key === snapshot.selectedRowKey);

  const facts =
    selectedRow?.kind === 'thread' ? snapshot.subjectFacts.get(selectedRow.thread.id) : undefined;

  const now = snapshot.savedAt ?? snapshot.refreshedAt ?? new Date(0);

  const noticeMessage = readNoticeMessage(snapshot, keyHintOf(props.catalog, 'refresh'));

  if (noticeMessage !== null) {
    return <Notice message={noticeMessage} palette={palette} />;
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
        height={listHeight}
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
  const [overlay, setOverlayState] = useState<Overlay>({ kind: 'none' });
  const [helpTop, setHelpTop] = useState(0);
  const [messagesTop, setMessagesTop] = useState(0);
  const [detailOpen, setDetailOpenState] = useState(false);

  // Keys in one burst arrive before React renders, so key handling reads this copy, which each
  // setter updates at once.
  const modal = useRef<ModalState>({
    overlay: { kind: 'none' },
    detailOpen: false,
  });

  const setOverlay = (next: Overlay) => {
    modal.current.overlay = next;
    setOverlayState(next);
  };

  const setDetailOpen = (open: boolean) => {
    modal.current.detailOpen = open;
    setDetailOpenState(open);
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

  const composerRows = composerRowsOf(snapshot);
  const composerLayout = composerLayoutFor(snapshot, composerRows, { width, height });
  const searchRoom = searchRoomOf(snapshot, height);

  const reservedRows =
    searchLineRows(snapshot, searchRoom) + commandLineRows(snapshot) + filterBarRows(snapshot);

  const listHeight = Math.max(1, height - statusRows - reservedRows);

  useEffect(() => {
    props.session.send({ kind: 'setListRows', rows: listHeight });
  }, [props.session, listHeight]);

  const widestPane = Math.floor(width * sidePaneShare);
  const paneWidth = sideLayout ? Math.min(sidePaneMaximumWidth, widestPane) : 0;

  return (
    <KeymapProvider keymap={props.keymap}>
      <Keys
        key={keymapKeyOf(props.keymap)}
        {...props}
        modal={modal}
        overlay={overlay}
        setOverlay={setOverlay}
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
        width={width}
        height={height}
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
          catalog={props.catalog}
        />
        <Body
          snapshot={snapshot}
          palette={palette}
          width={width}
          paneWidth={paneWidth}
          fullDetail={fullDetail}
          listHeight={listHeight}
          catalog={props.catalog}
        />
        <SearchLine
          session={props.session}
          snapshot={snapshot}
          palette={palette}
          room={searchRoom}
        />
        <CommandLine session={props.session} snapshot={snapshot} palette={palette} />
        <StatusLine snapshot={snapshot} palette={palette} catalog={props.catalog} />
      </box>
      <Toast snapshot={snapshot} palette={palette} />
      {overlay.kind === 'confirm' ? (
        <ConfirmDialog
          repositories={overlay.pages.length}
          palette={palette}
          catalog={props.catalog}
        />
      ) : null}
      {overlay.kind === 'messages' ? (
        <MessageOverlay
          messages={snapshot.messages}
          palette={palette}
          width={width}
          height={height}
          top={messagesTop}
        />
      ) : null}
      {overlay.kind === 'help' ? (
        <HelpOverlay catalog={props.catalog} palette={palette} height={height} top={helpTop} />
      ) : null}
    </KeymapProvider>
  );
};
