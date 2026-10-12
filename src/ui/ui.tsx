import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';

import type { Command, TerminalIntent } from '../commands.ts';
import type { Session } from '../session/session.ts';
import { visibleRows } from '../session/session.ts';
import { DetailPane } from './DetailPane.tsx';
import { HelpOverlay } from './HelpOverlay.tsx';
import { hasNotice, Notice } from './Notice.tsx';
import { pickPalette } from './palette.ts';
import { StatusLine } from './StatusLine.tsx';
import { ThreadList } from './ThreadList.tsx';

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
}

const sidePaneMinimumWidth = 90;
const sidePaneMaximumWidth = 44;
const sidePaneShare = 0.36;

const isActive = (command: Command, helpOpen: boolean): boolean => {
  if (command.scope === 'modal') {
    return helpOpen;
  }

  return !helpOpen || command.scope === 'global';
};

const Keys = (props: KeysProps): null => {
  const { session, onTerminalIntent, setHelpOpen } = props;
  const commands = props.catalog.filter((command) => isActive(command, props.helpOpen));

  const run = (command: Command) => {
    const snapshot = session.getSnapshot();

    if (command.disabledReason(snapshot) !== undefined) {
      return;
    }

    const intent = command.intent(snapshot);

    if (intent.kind === 'application') {
      session.send(intent.intent);
    } else if (intent.kind === 'ui') {
      setHelpOpen(intent.action === 'toggleHelp' ? !props.helpOpen : false);
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
    [props.helpOpen, props.catalog, session, onTerminalIntent, setHelpOpen],
  );

  return null;
};

export const App = (props: AppProps): ReactNode => {
  const [helpOpen, setHelpOpen] = useState(false);

  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);

  const themeMode = useSyncExternalStore(
    props.themeSource.subscribe,
    props.themeSource.getThemeMode,
  );

  const palette = pickPalette(themeMode);
  const { width } = useTerminalDimensions();

  const sideLayout = width >= sidePaneMinimumWidth;
  const widestPane = Math.floor(width * sidePaneShare);
  const paneWidth = sideLayout ? Math.min(sidePaneMaximumWidth, widestPane) : 0;

  const selectedRow = visibleRows(snapshot).find((row) => row.key === snapshot.selectedRowKey);
  const now = snapshot.savedAt ?? snapshot.refreshedAt ?? new Date(0);

  return (
    <KeymapProvider keymap={props.keymap}>
      <Keys {...props} helpOpen={helpOpen} setHelpOpen={setHelpOpen} />
      <box flexDirection="column" flexGrow={1}>
        {hasNotice(snapshot) ? (
          <Notice snapshot={snapshot} palette={palette} />
        ) : (
          <box flexDirection="row" flexGrow={1}>
            <ThreadList snapshot={snapshot} palette={palette} width={width - paneWidth} />
            {sideLayout ? (
              <DetailPane row={selectedRow} palette={palette} now={now} width={paneWidth} />
            ) : null}
          </box>
        )}
        <StatusLine snapshot={snapshot} palette={palette} />
      </box>
      {helpOpen ? <HelpOverlay catalog={props.catalog} palette={palette} /> : null}
    </KeymapProvider>
  );
};
