import { createCliRenderer } from '@opentui/core';
import type { CliRenderer } from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot, flushSync } from '@opentui/react';
import type { ReactNode } from 'react';

import type { Command, TerminalIntent } from './commands.ts';
import type { Session } from './session/session.ts';
import { App } from './ui/ui.tsx';
import type { AppProps, ThemeSource } from './ui/ui.tsx';

type ThemeMode = 'light' | 'dark' | null;

type ProcessEvent = 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection';

export interface TerminalRenderer {
  waitForThemeMode: (timeoutMilliseconds: number) => Promise<ThemeMode>;
  on: (event: 'theme_mode', listener: (mode: ThemeMode) => void) => unknown;
  off: (event: 'theme_mode', listener: (mode: ThemeMode) => void) => unknown;
  destroy: () => void;
}

interface TerminalRoot {
  render: (node: ReactNode) => void;
  unmount: () => void;
}

export interface TerminalEffects {
  open: () => Promise<{
    renderer: TerminalRenderer;
    root: TerminalRoot;
    keymap: AppProps['keymap'];
  }>;
  listen: (event: ProcessEvent, handler: (reason?: unknown) => void) => () => void;
  exit: (code: number) => void;
  printError: (error: unknown) => void;
}

export interface TerminalDependencies {
  session: Session;
  catalog: readonly Command[];
  flushState: () => Promise<void>;
}

const themeWaitMilliseconds = 500;
const flushWaitMilliseconds = 1000;
const stopWaitMilliseconds = 750;

const openOpenTui = async (): Promise<{
  renderer: CliRenderer;
  root: TerminalRoot;
  keymap: AppProps['keymap'];
}> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });

  let created = false;

  try {
    const opened = {
      renderer,
      root: createRoot(renderer),
      keymap: createDefaultOpenTuiKeymap(renderer),
    };

    created = true;

    return opened;
  } finally {
    if (!created) {
      renderer.destroy();
    }
  }
};

const listenToProcess = (
  event: ProcessEvent,
  handler: (reason?: unknown) => void,
): (() => void) => {
  process.on(event, handler);

  return () => {
    process.off(event, handler);
  };
};

const waitForStop = async (
  stop: (deadline: AbortSignal) => Promise<void>,
  flushState: () => Promise<void>,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new AbortController();

  const stopTimer = setTimeout(() => {
    deadline.abort();
  }, stopWaitMilliseconds);

  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, flushWaitMilliseconds);
  });

  try {
    const saved = async () => {
      await stop(deadline.signal);
      await flushState();
    };

    await Promise.race([saved(), timeout]);
  } catch {
    // A failed stop or save must not block shutdown or change the exit code.
  } finally {
    clearTimeout(stopTimer);
    clearTimeout(timer);
  }
};

const processEffects: TerminalEffects = {
  open: openOpenTui,
  listen: listenToProcess,
  exit: (code) => process.exit(code),
  printError: (error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  },
};

export const refuseStart = (reason: string, effects: TerminalEffects = processEffects): void => {
  effects.printError(reason);
  effects.exit(1);
};

export const startTerminal = async (
  dependencies: TerminalDependencies,
  effects: TerminalEffects = processEffects,
): Promise<void> => {
  const { session, catalog, flushState } = dependencies;
  let themeMode: ThemeMode = null;
  const themeListeners = new Set<() => void>();
  let shutdownPromise: Promise<void> | undefined;

  const removers: (() => void)[] = [];

  // Shutdown waits for this promise, so a signal while it is pending still destroys the renderer.
  const openPromise = effects.open();

  const settledOpen = async () => {
    try {
      return await openPromise;
    } catch {
      return undefined;
    }
  };

  const runShutdown = async (): Promise<void> => {
    const opened = await settledOpen();

    try {
      await waitForStop((deadline) => session.stop(deadline), flushState);

      for (const remove of removers.splice(0)) {
        remove();
      }

      opened?.root.unmount();
      themeListeners.clear();
    } finally {
      opened?.renderer.destroy();
    }
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= runShutdown();

    return shutdownPromise;
  };

  const isShuttingDown = (): boolean => shutdownPromise !== undefined;

  let fatal: { error: unknown } | undefined;
  let finishing = false;

  const finish = (): void => {
    if (finishing) {
      return;
    }

    finishing = true;

    shutdown()
      .then(
        () => undefined,
        (error: unknown) => {
          fatal ??= { error };
        },
      )
      .then(() => {
        if (fatal === undefined) {
          effects.exit(0);

          return;
        }

        effects.printError(fatal.error);
        effects.exit(1);
      })
      .catch(() => {
        effects.exit(1);
      });
  };

  const quit = (): void => {
    finish();
  };

  const fail = (reason: unknown): void => {
    fatal ??= { error: reason };
    finish();
  };

  const handleIntent = (_intent: TerminalIntent) => {
    quit();
  };

  removers.push(
    effects.listen('SIGINT', quit),
    effects.listen('SIGTERM', quit),
    effects.listen('uncaughtException', fail),
    effects.listen('unhandledRejection', fail),
  );

  const themeSource: ThemeSource = {
    getThemeMode: () => themeMode,
    subscribe: (listener) => {
      themeListeners.add(listener);

      return () => {
        themeListeners.delete(listener);
      };
    },
  };

  const onThemeMode = (mode: ThemeMode) => {
    themeMode = mode;

    for (const listener of themeListeners) {
      listener();
    }
  };

  try {
    const { renderer, root, keymap } = await openPromise;

    if (isShuttingDown()) {
      return;
    }

    themeMode = await renderer.waitForThemeMode(themeWaitMilliseconds);

    if (isShuttingDown()) {
      return;
    }

    renderer.on('theme_mode', onThemeMode);
    removers.push(() => renderer.off('theme_mode', onThemeMode));

    // The root renders concurrently, so without flushSync the first fetch would start before the
    // UI has mounted and subscribed to the session.
    flushSync(() => {
      root.render(
        <App
          session={session}
          catalog={catalog}
          keymap={keymap}
          themeSource={themeSource}
          onTerminalIntent={handleIntent}
        />,
      );
    });

    session.send({ kind: 'refresh' });
  } catch (error) {
    fail(error);
  }
};
