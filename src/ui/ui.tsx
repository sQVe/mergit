import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Command, Intent, TerminalIntent } from '../commands.ts';
import type { Session, Snapshot } from '../session/session.ts';
import { matchCountOf, visibleRows } from '../session/session.ts';
import type { BrowserPage } from '../work/work.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DetailPane } from './DetailPane.tsx';
import { HelpOverlay } from './HelpOverlay.tsx';
import { InputLine } from './InputLine.tsx';
import { hasNotice, Notice } from './Notice.tsx';
import type { Palette } from './palette.ts';
import { pickPalette } from './palette.ts';
import { StatusLine } from './StatusLine.tsx';
import { ThreadList } from './ThreadList.tsx';
import { truncate } from './threadRow.ts';
import { Toast } from './Toast.tsx';

type UiIntent = Extract<Intent, { kind: 'ui' }>;

type ThemeMode = 'light' | 'dark' | null;

type QueryError = NonNullable<Snapshot['queryError']>;

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
  queryOpen: boolean;
}

const sidePaneMinimumWidth = 90;
const sidePaneMaximumWidth = 44;
const sidePaneShare = 0.36;

const isActive = (
  command: Command,
  state: { helpOpen: boolean; confirmOpen: boolean; detailOpen: boolean; queryOpen: boolean },
): boolean => {
  const { helpOpen, confirmOpen, detailOpen, queryOpen } = state;

  if (queryOpen) {
    return command.scope === 'input';
  }

  if (command.scope === 'input') {
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
      props.queryOpen,
      props.catalog,
      session,
      onTerminalIntent,
      setHelpOpen,
      setDetailOpen,
    ],
  );

  return null;
};

const queryLineRows = (snapshot: Snapshot): number => {
  if (!snapshot.queryOpen && snapshot.appliedQuery === null) {
    return 0;
  }

  return snapshot.queryError === null ? 1 : 2;
};

// The caret lines up with the text only while the input does not scroll.
const errorRowText = (error: QueryError, textFits: boolean): string =>
  textFits
    ? `${' '.repeat(error.position + 1)}^ ${error.message}`
    : `column ${error.position + 1}: ${error.message}`;

const QueryLine = (props: {
  session: Session;
  snapshot: Snapshot;
  palette: Palette;
  width: number;
}): ReactNode => {
  const { session, snapshot, palette } = props;
  const { queryError } = snapshot;

  if (!snapshot.queryOpen && snapshot.appliedQuery === null) {
    return null;
  }

  const count = matchCountOf(snapshot);
  const suffix = `${count} ${count === 1 ? 'match' : 'matches'}`;
  const inputWidth = props.width - 1 - suffix.length;
  const textFits = snapshot.queryText.length < inputWidth;

  return (
    <box flexDirection="column" flexShrink={0}>
      <InputLine
        prompt="/"
        value={snapshot.queryText}
        palette={palette}
        focused={snapshot.queryOpen}
        suffix={suffix}
        onInput={(text) => {
          session.send({ kind: 'editQuery', text });
        }}
      />
      {queryError === null ? null : (
        // queryLineRows reserves one row for the error, so it must never wrap.
        <text fg={palette.error}>{truncate(errorRowText(queryError, textFits), props.width)}</text>
      )}
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
        reservedRows={queryLineRows(snapshot)}
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
  const { width } = useTerminalDimensions();

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
        queryOpen={snapshot.queryOpen}
      />
      <box flexDirection="column" flexGrow={1}>
        <Body
          snapshot={snapshot}
          palette={palette}
          width={width}
          paneWidth={paneWidth}
          fullDetail={fullDetail}
        />
        <QueryLine session={props.session} snapshot={snapshot} palette={palette} width={width} />
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
