import type { KeyEvent, Renderable } from '@opentui/core';
import type { CommandContext, KeySequencePart } from '@opentui/keymap';
import { registerEscapeClearsPendingSequence } from '@opentui/keymap/addons';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings, useKeymap, usePendingSequence } from '@opentui/keymap/react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useSyncExternalStore } from 'react';

import type { Command, ReaderContext, TerminalIntent } from '../commands.ts';
import {
  commandsOfLayer,
  isReaderDetached,
  keyHintOf,
  readableStrokeOf,
  scopePriority,
} from '../commands.ts';
import type { FilterRow, Session, Snapshot } from '../session/session.ts';
import { filterRowsOf, visibleRows } from '../session/session.ts';
import { CommandLine, commandLineRows, commandLineNamesOf } from './CommandLine.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DetailPane } from './DetailPane.tsx';
import { detailScrollOf, readerInputOf, readerLayoutOf } from './DetailReader.tsx';
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
import { fitText } from './textLayout.ts';
import { ThreadList } from './ThreadList.tsx';
import { Toast } from './Toast.tsx';
import type { ModalState, Overlay, ScrollWindow, UiIntent } from './uiState.ts';
import { useUiState } from './uiState.ts';

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

interface KeysProps extends AppProps {
  modal: RefObject<ModalState>;
  overlay: Overlay;
  reader: ReaderContext;
  runUiAction: (intent: UiIntent) => void;
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
const readerStripMinimumWidth = 24;
const readerStripShare = 0.2;

const inputScopes = new Set<Command['scope']>(['input', 'filter', 'command']);
const inputSegmenter = new Intl.Segmenter();

const isActive = (
  scope: Command['scope'],
  state: {
    overlay: Overlay['kind'];
    readerOpen: boolean;
    searchOpen: boolean;
    filtersOpen: boolean;
    commandLineOpen: boolean;
  },
): boolean => {
  const { overlay, readerOpen } = state;
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

  return scope === 'reader' ? readerOpen : !readerOpen;
};

const composerRowsOf = (snapshot: Snapshot) => (snapshot.filtersOpen ? filterRowsOf(snapshot) : []);

const searchRoomOf = (snapshot: Snapshot, height: number): number =>
  Math.max(
    0,
    height -
      statusRows -
      boxChromeRows -
      commandLineRows(snapshot, [], 1) -
      filterBarRows(snapshot),
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
    commandLineRows(snapshot, [], 1) +
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

    const removeEscape = registerEscapeClearsPendingSequence(keymap);

    return () => {
      removeEscape();
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

const pendingKeysOf = (parts: readonly KeySequencePart[]): string =>
  parts.map((part) => readableStrokeOf(part.stroke)).join('');

const PendingStatusLine = (props: {
  snapshot: Snapshot;
  palette: Palette;
  catalog: readonly Command[];
}): ReactNode => {
  const pending = pendingKeysOf(usePendingSequence());

  return <StatusLine {...props} pending={pending} />;
};

const Keys = (props: KeysProps): ReactNode => {
  const { session, onTerminalIntent, runUiAction, modal } = props;
  const keymap = useKeymap();

  // A key that misses a pending sequence is dropped here, so it never runs or reaches the
  // fallback below.
  useEffect(
    () =>
      keymap.intercept('key:after', (context) => {
        if (context.reason === 'sequence-miss') {
          context.consume();
        }
      }),
    [keymap],
  );

  const editPendingHelpInput = (text: string, backspace: boolean): void => {
    const current = modal.current.overlay;
    const helpRendered = props.overlay.kind === 'help' && props.overlay.editing;

    if (current.kind === 'help' && current.editing && !helpRendered) {
      let nextText = current.text + text;

      if (backspace) {
        const last = [...inputSegmenter.segment(current.text)].at(-1);

        nextText = current.text.slice(0, last?.index ?? 0);
      }

      runUiAction({ kind: 'ui', action: 'editHelpSearch', text: nextText });
    }
  };

  const typeIntoPendingInput = (text: string): void => {
    editPendingHelpInput(text, false);

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

    const named = props.catalog.find((command) => command.names?.includes(name) === true);

    if (named === undefined) {
      session.send({ kind: 'reportUnknownCommand', name });
    } else {
      runNamed(named);
    }
  };

  const run = (command: Command, count?: number) => {
    const snapshot = session.getSnapshot();
    const reader = modal.current.reader;

    if (command.disabledReason(snapshot, reader) !== undefined) {
      return;
    }

    const intent = command.intent(snapshot, reader, count);

    if (isFilterRowIntent(intent) && isComposerBlind(snapshot, props.width, props.height)) {
      return;
    }

    if (intent.kind === 'application') {
      session.send(intent.intent);
    } else if (intent.kind === 'ui' && intent.action === 'runCommandLine') {
      runCommandLine(run);
    } else if (intent.kind === 'ui' && intent.action === 'nextCommandLineCompletion') {
      session.send({
        kind: 'moveCommandLineCompletion',
        names: commandLineNamesOf(props.catalog),
        direction: 1,
      });
    } else if (intent.kind === 'ui' && intent.action === 'previousCommandLineCompletion') {
      session.send({
        kind: 'moveCommandLineCompletion',
        names: commandLineNamesOf(props.catalog),
        direction: -1,
      });
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
    const { overlay, reader } = modal.current;

    if (overlay.kind === 'help' && overlay.editing) {
      return scope === 'helpSearch';
    }

    if (scope === 'helpSearch') {
      return false;
    }

    return isActive(scope, {
      overlay: overlay.kind,
      readerOpen: reader.kind === 'reader',
      searchOpen,
      filtersOpen,
      commandLineOpen,
    });
  };

  // A key no command takes reaches here. Before the input takes focus, it is typed here.
  useKeyboard((event) => {
    if (event.ctrl || event.meta) {
      return;
    }

    const printable = /^[^\p{Cc}]$/u.test(event.sequence);

    if (printable) {
      typeIntoPendingInput(event.sequence);
    } else if (event.name === 'backspace') {
      editPendingHelpInput('', true);
    }
  });

  const bindingDeps = [
    props.overlay,
    props.reader,
    props.width,
    props.height,
    props.catalog,
    session,
    onTerminalIntent,
    runUiAction,
  ];

  useEffect(() => {
    const isFixedQuit = keymap.createKeyMatcher('ctrl+c');

    return keymap.intercept('key', (context) => {
      if (!isFixedQuit(context.event)) {
        return;
      }

      const command = props.catalog.find(
        (candidate) => scopeActive(candidate.scope) && candidate.keys.includes('ctrl+c'),
      );

      const snapshot = session.getSnapshot();

      const { reader } = modal.current;

      if (command === undefined || command.disabledReason(snapshot, reader) !== undefined) {
        return;
      }

      const intent = command.intent(snapshot, reader);

      if (intent.kind !== 'terminal') {
        return;
      }

      keymap.clearPendingSequence();
      context.consume();
      onTerminalIntent(intent);
    });
  }, [keymap, ...bindingDeps]);

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
    const scoped = commandsOfLayer(props.catalog, scope);
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

const readerHints: [string, string][] = [
  ['readerMarkDone', 'done'],
  ['readerOpenInBrowser', 'open'],
  ['readerRefresh', 'refresh'],
  ['readerUndoDone', 'undo'],
  ['readerNextThread', 'next'],
  ['readerPreviousThread', 'previous'],
  ['closeDetail', 'close'],
  ['nextTab', 'tab'],
  ['scrollDown', 'scroll'],
  ['readerHalfPageDown', 'page'],
];

const readerHintOf = (catalog: readonly Command[]): string => {
  const parts = readerHints.map(([id, label]) => {
    const key = keyHintOf(catalog, id);

    return key === undefined ? undefined : `${key} ${label}`;
  });

  return parts.filter((part): part is string => part !== undefined).join('  ');
};

const paneWidthsOf = (
  width: number,
  reader: ReaderContext,
): { listWidth: number; detailWidth: number } => {
  const sideLayout = width >= sidePaneMinimumWidth;

  if (reader.kind === 'reader') {
    const stripWidth = sideLayout
      ? Math.max(readerStripMinimumWidth, Math.floor(width * readerStripShare))
      : 0;

    return { listWidth: stripWidth, detailWidth: width - stripWidth };
  }

  const widestPane = Math.floor(width * sidePaneShare);
  const paneWidth = sideLayout ? Math.min(sidePaneMaximumWidth, widestPane) : 0;

  return { listWidth: width - paneWidth, detailWidth: paneWidth };
};

const Body = (props: {
  snapshot: Snapshot;
  palette: Palette;
  listWidth: number;
  detailWidth: number;
  reader: ReaderContext;
  listHeight: number;
  catalog: readonly Command[];
  previewTop: number;
  onPreviewWindow: (measure: () => ScrollWindow) => void;
}): ReactNode => {
  const { snapshot, palette, listWidth, detailWidth, listHeight } = props;
  const selectedRow = visibleRows(snapshot).find((row) => row.key === snapshot.selectedRowKey);
  const detailRow = props.reader.kind === 'reader' ? props.reader.row : selectedRow;
  const detached = isReaderDetached(snapshot, props.reader);

  const readerPane = { width: detailWidth, height: listHeight };
  const readerInput = readerInputOf(snapshot, props.reader, readerPane, props.catalog);
  const readerLayout = readerInput === null ? null : readerLayoutOf(readerInput);

  const facts =
    detailRow?.kind === 'thread' ? snapshot.subjectFacts.get(detailRow.thread.id) : undefined;

  const now = snapshot.savedAt ?? snapshot.refreshedAt ?? new Date(0);

  const readerFocused = props.reader.kind === 'reader';

  const noticeMessage = readNoticeMessage(
    snapshot,
    keyHintOf(props.catalog, 'refresh'),
    readerFocused,
  );

  if (noticeMessage !== null) {
    return <Notice message={noticeMessage} palette={palette} />;
  }

  const detailPane =
    detailWidth === 0 ? null : (
      <DetailPane
        row={detailRow}
        facts={facts}
        newThreadIds={snapshot.newThreadIds}
        palette={palette}
        now={now}
        width={detailWidth}
        detached={detached}
        previewTop={props.previewTop}
        onPreviewWindow={props.onPreviewWindow}
        readerLayout={readerLayout}
      />
    );

  return (
    <box flexDirection="row" flexGrow={1}>
      {listWidth === 0 ? null : (
        <ThreadList snapshot={snapshot} palette={palette} width={listWidth} height={listHeight} />
      )}
      {readerFocused ? (
        <box flexDirection="column" flexGrow={1}>
          <box flexDirection="row" flexGrow={1}>
            {detailPane}
          </box>
          <text fg={palette.dim}>{fitText(readerHintOf(props.catalog), detailWidth)}</text>
        </box>
      ) : (
        detailPane
      )}
    </box>
  );
};

export const App = (props: AppProps): ReactNode => {
  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);

  const themeMode = useSyncExternalStore(
    props.themeSource.subscribe,
    props.themeSource.getThemeMode,
  );

  const palette = pickPalette(themeMode);
  const { width, height } = useTerminalDimensions();

  const helpWindowFor = (current: Overlay) => {
    const text = current.kind === 'help' ? current.text : '';

    return helpWindowOf(props.catalog, height, width, text);
  };

  const messageWindow = messageWindowOf(snapshot.messages, width, height);

  const composerRows = composerRowsOf(snapshot);
  const composerLayout = composerLayoutFor(snapshot, composerRows, { width, height });
  const searchRoom = searchRoomOf(snapshot, height);

  const commandNames = commandLineNamesOf(props.catalog);
  const commandRoom = Math.max(1, height - statusRows - boxChromeRows - filterBarRows(snapshot));

  const reservedRows =
    searchLineRows(snapshot, searchRoom) +
    commandLineRows(snapshot, commandNames, commandRoom) +
    filterBarRows(snapshot);

  const listHeight = Math.max(1, height - statusRows - reservedRows);

  const detailScrollFor = (current: ReaderContext) => {
    const pane = { width: paneWidthsOf(width, current).detailWidth, height: listHeight };
    const input = readerInputOf(props.session.getSnapshot(), current, pane, props.catalog);

    return input === null ? null : detailScrollOf(input);
  };

  const uiState = useUiState(props.session, helpWindowFor, messageWindow, detailScrollFor);

  const { overlay, helpTop, helpInput, messagesTop, previewTop, reader, modal, runUiAction } =
    uiState;

  const helpWindow = helpWindowFor(overlay);

  useEffect(() => {
    props.session.send({ kind: 'setListRows', rows: listHeight });
  }, [props.session, listHeight]);

  const { listWidth, detailWidth } = paneWidthsOf(width, reader);

  return (
    <KeymapProvider keymap={props.keymap}>
      <Keys
        key={keymapKeyOf(props.keymap)}
        {...props}
        modal={modal}
        overlay={overlay}
        reader={reader}
        runUiAction={runUiAction}
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
          listWidth={listWidth}
          detailWidth={detailWidth}
          reader={reader}
          listHeight={listHeight}
          catalog={props.catalog}
          previewTop={previewTop}
          onPreviewWindow={uiState.reportPreviewWindow}
        />
        <SearchLine
          session={props.session}
          snapshot={snapshot}
          palette={palette}
          room={searchRoom}
        />
        <CommandLine
          session={props.session}
          snapshot={snapshot}
          palette={palette}
          names={commandNames}
          room={commandRoom}
          width={width}
        />
        <PendingStatusLine snapshot={snapshot} palette={palette} catalog={props.catalog} />
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
          messageWindow={messageWindow}
          palette={palette}
          height={height}
          top={messagesTop}
        />
      ) : null}
      {overlay.kind === 'help' ? (
        <HelpOverlay
          catalog={props.catalog}
          palette={palette}
          height={height}
          helpWindow={helpWindow}
          top={helpTop}
          search={overlay}
          input={helpInput}
          runUiAction={runUiAction}
        />
      ) : null}
    </KeymapProvider>
  );
};
