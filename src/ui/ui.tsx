import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Command, Intent, TerminalIntent } from '../commands.ts';
import type { Session, Snapshot } from '../session/session.ts';
import { visibleRows } from '../session/session.ts';
import { DetailPane } from './DetailPane.tsx';
import { HelpOverlay } from './HelpOverlay.tsx';
import { hasNotice, Notice } from './Notice.tsx';
import type { Palette } from './palette.ts';
import { pickPalette } from './palette.ts';
import { StatusLine } from './StatusLine.tsx';
import { ThreadList } from './ThreadList.tsx';

type UiAction = Extract<Intent, { kind: 'ui' }>['action'];

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
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  sideLayout: boolean;
}

const sidePaneMinimumWidth = 90;
const sidePaneMaximumWidth = 44;
const sidePaneShare = 0.36;

const isActive = (command: Command, helpOpen: boolean, detailOpen: boolean): boolean => {
  if (command.scope === 'modal') {
    return helpOpen;
  }

  if (command.scope === 'global') {
    return true;
  }

  if (helpOpen) {
    return false;
  }

  return command.scope === 'preview' ? detailOpen : !detailOpen;
};

const Keys = (props: KeysProps): null => {
  const { session, onTerminalIntent, setHelpOpen, setDetailOpen } = props;

  const commands = props.catalog.filter((command) =>
    isActive(command, props.helpOpen, props.detailOpen),
  );

  const runUiAction = (action: UiAction) => {
    if (action === 'openDetail') {
      setDetailOpen(!props.sideLayout);
    } else if (action === 'closeDetail') {
      setDetailOpen(false);
    } else {
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
      runUiAction(intent.action);
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
      props.detailOpen,
      props.sideLayout,
      props.catalog,
      session,
      onTerminalIntent,
      setHelpOpen,
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
        <DetailPane row={selectedRow} facts={facts} palette={palette} now={now} width={width} />
      </box>
    );
  }

  return (
    <box flexDirection="row" flexGrow={1}>
      <ThreadList snapshot={snapshot} palette={palette} width={width - paneWidth} />
      {paneWidth > 0 ? (
        <DetailPane row={selectedRow} facts={facts} palette={palette} now={now} width={paneWidth} />
      ) : null}
    </box>
  );
};

export const App = (props: AppProps): ReactNode => {
  const [helpOpen, setHelpOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

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
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
        detailOpen={fullDetail}
        setDetailOpen={setDetailOpen}
        sideLayout={sideLayout}
      />
      <box flexDirection="column" flexGrow={1}>
        <Body
          snapshot={snapshot}
          palette={palette}
          width={width}
          paneWidth={paneWidth}
          fullDetail={fullDetail}
        />
        <StatusLine snapshot={snapshot} palette={palette} />
      </box>
      {helpOpen ? <HelpOverlay catalog={props.catalog} palette={palette} /> : null}
    </KeymapProvider>
  );
};
