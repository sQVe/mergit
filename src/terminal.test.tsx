import { expect, test } from 'bun:test';

import { createTestRenderer } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot } from '@opentui/react';
import type { ReactElement } from 'react';

import { catalog } from './commands.ts';
import { createSession } from './session/session.ts';
import type { SessionEffects } from './session/session.ts';
import { refuseStart, startTerminal } from './terminal.tsx';
import type { TerminalEffects, TerminalRenderer } from './terminal.tsx';
import type { AppProps } from './ui/ui.tsx';

type Viewer = Extract<Awaited<ReturnType<SessionEffects['readViewer']>>, { ok: true }>['value'];
type ThemeMode = 'light' | 'dark' | null;
type ThemeListener = (mode: ThemeMode) => void;

interface RenderedProps {
  themeSource: { getThemeMode: () => ThemeMode; subscribe: (listener: () => void) => () => void };
  onTerminalIntent: (intent: { kind: 'terminal'; action: 'quit' }) => void;
}

const idleEffects: SessionEffects = {
  savedSnapshot: null,
  host: 'github.com',
  refreshKey: 'r',
  savedState: null,
  saveState: () => undefined,
  markThreadDone: () => Promise.resolve({ ok: true, value: null }),
  openInBrowser: () => Promise.resolve({ ok: true as const }),
  configNotices: [],
  stateWarning: null,
  readViewer: () =>
    Promise.resolve({
      ok: true as const,
      value: { login: 'octocat' as Viewer['login'], etag: null },
    }),
  saveSnapshot: () => undefined,
  pollFeed: () =>
    Promise.resolve({
      ok: true as const,
      value: { kind: 'unchanged' as const, pollInterval: null },
    }),
  readFeed: () =>
    Promise.resolve({
      ok: true as const,
      value: { feed: { pages: [] }, threads: [], pollInterval: null },
    }),
  verifyFeed: () =>
    Promise.resolve({ ok: true as const, value: { kind: 'stable' as const, pollInterval: null } }),
  lookUpSubjects: () => Promise.resolve({ lookups: [], failures: [] }),
  now: () => new Date(0),
  setTimer: () => () => undefined,
};

const createHarness = (initialTheme: ThemeMode) => {
  const listeners = new Set<ThemeListener>();
  const handlers = new Map<string, (reason?: unknown) => void>();
  const rendered: ReactElement<RenderedProps>[] = [];
  const exitCodes: number[] = [];
  const printed: unknown[] = [];
  const calls = { destroy: 0, unmount: 0 };
  const failures: { unmount?: Error; printError?: Error } = {};

  const renderer: TerminalRenderer = {
    waitForThemeMode: () => Promise.resolve(initialTheme),
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    destroy: () => {
      calls.destroy += 1;
    },
  };

  const effects: TerminalEffects = {
    open: () =>
      Promise.resolve({
        renderer,
        keymap: {} as AppProps['keymap'],
        root: {
          render: (node) => rendered.push(node as ReactElement<RenderedProps>),
          unmount: () => {
            calls.unmount += 1;

            if (failures.unmount !== undefined) {
              throw failures.unmount;
            }
          },
        },
      }),
    listen: (event, handler) => {
      handlers.set(event, handler);

      return () => handlers.delete(event);
    },
    exit: (code) => exitCodes.push(code),
    printError: (error) => {
      if (failures.printError !== undefined) {
        throw failures.printError;
      }

      printed.push(error);
    },
  };

  const session = createSession(idleEffects);
  const latestTheme = () => rendered.at(-1)?.props.themeSource.getThemeMode() ?? null;

  return {
    effects,
    renderer,
    failures,
    session,
    handlers,
    listeners,
    rendered,
    exitCodes,
    printed,
    calls,
    latestTheme,
  };
};

const settle = () => Bun.sleep(10);

test('refuseStart prints the reason and exits 1 without opening the renderer', () => {
  const harness = createHarness('dark');
  let opened = 0;

  harness.effects.open = () => {
    opened += 1;

    return Promise.reject(new Error('must not open'));
  };

  refuseStart('state file is too new', harness.effects);

  expect(harness.printed).toEqual(['state file is too new']);
  expect(harness.exitCodes).toEqual([1]);
  expect(opened).toBe(0);
  expect(harness.handlers.size).toBe(0);
});

test('a second shutdown destroys the renderer once and changes nothing more', async () => {
  const harness = createHarness('dark');

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  const sigint = harness.handlers.get('SIGINT');
  const sigterm = harness.handlers.get('SIGTERM');

  sigint?.();
  sigterm?.();
  await settle();

  expect(harness.calls).toEqual({ destroy: 1, unmount: 1 });
  expect(harness.exitCodes).toEqual([0]);
  expect(harness.handlers.size).toBe(0);
  expect(harness.listeners.size).toBe(0);
});

test('a fatal error destroys the renderer before it prints and exits non-zero', async () => {
  const harness = createHarness('dark');
  const order: string[] = [];

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  const failure = new Error('boom');
  const original = harness.effects.printError;

  harness.effects.printError = (error) => {
    order.push(`print:${harness.calls.destroy}`);
    original(error);
  };

  harness.handlers.get('uncaughtException')?.(failure);
  await settle();

  expect(order).toEqual(['print:1']);
  expect(harness.printed).toEqual([failure]);
  expect(harness.exitCodes).toEqual([1]);
});

test('the renderer theme reaches the UI and later changes follow', async () => {
  const harness = createHarness('light');

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  expect(harness.latestTheme()).toBe('light');

  for (const listener of harness.listeners) {
    listener('dark');
  }

  expect(harness.latestTheme()).toBe('dark');
  expect(harness.rendered).toHaveLength(1);
});

test('the first refresh starts after the UI has mounted and subscribed', async () => {
  const harness = createHarness('dark');
  const { renderer } = await createTestRenderer({ width: 40, height: 10 });
  const subscribersAtFetch: number[] = [];
  let subscribers = 0;

  const session = createSession({
    ...idleEffects,
    readFeed: (request, signal) => {
      subscribersAtFetch.push(subscribers);

      return idleEffects.readFeed(request, signal);
    },
  });

  const subscribe = session.subscribe;

  session.subscribe = (listener) => {
    subscribers += 1;

    return subscribe(listener);
  };

  harness.effects.open = () =>
    Promise.resolve({
      renderer,
      root: createRoot(renderer),
      keymap: createDefaultOpenTuiKeymap(renderer),
    });

  try {
    await startTerminal({ session, catalog, flushState: () => Promise.resolve() }, harness.effects);
    await Bun.sleep(0);

    expect(subscribersAtFetch).toEqual([1]);
  } finally {
    renderer.destroy();
  }
});

test('an unknown theme gives the dark palette', async () => {
  const harness = createHarness(null);

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  expect(harness.latestTheme()).toBeNull();
});

test('SIGINT during a pending open destroys the renderer once and exits 0 without rendering', async () => {
  const harness = createHarness('dark');
  const realOpen = harness.effects.open;
  const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();

  harness.effects.open = async () => {
    await gate;

    return realOpen();
  };

  const started = startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(harness.exitCodes).toEqual([]);

  release(undefined);
  await started;
  await settle();

  expect(harness.calls.destroy).toBe(1);
  expect(harness.rendered).toHaveLength(0);
  expect(harness.exitCodes).toEqual([0]);
  expect(harness.handlers.size).toBe(0);
});

test('a rejected open prints the error, exits 1, and removes the process listeners', async () => {
  const harness = createHarness('dark');
  const failure = new Error('no terminal');

  harness.effects.open = () => Promise.reject(failure);

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  await settle();

  expect(harness.printed).toEqual([failure]);
  expect(harness.exitCodes).toEqual([1]);
  expect(harness.handlers.size).toBe(0);
  expect(harness.calls.destroy).toBe(0);
});

const startWithRejectingOpen = (harness: ReturnType<typeof createHarness>, failure: Error) => {
  const { promise: gate, reject } = Promise.withResolvers<never>();

  harness.effects.open = () => gate;

  const started = startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  return {
    started,
    rejectOpen: () => {
      reject(failure);
    },
  };
};

test('a quit before a failing open still prints the error and exits 1 once', async () => {
  const harness = createHarness('dark');
  const failure = new Error('no terminal');
  const { started, rejectOpen } = startWithRejectingOpen(harness, failure);

  harness.handlers.get('SIGINT')?.();
  rejectOpen();
  await started;
  await settle();

  expect(harness.printed).toEqual([failure]);
  expect(harness.exitCodes).toEqual([1]);
});

test('a fatal error before a quit still exits 1 once with the error printed', async () => {
  const harness = createHarness('dark');
  const failure = new Error('crashed');
  const { started, rejectOpen } = startWithRejectingOpen(harness, new Error('unused'));

  harness.handlers.get('uncaughtException')?.(failure);
  harness.handlers.get('SIGINT')?.();
  rejectOpen();
  await started;
  await settle();

  expect(harness.printed).toEqual([failure]);
  expect(harness.exitCodes).toEqual([1]);
});

test('shutdown waits for flushState before it unmounts', async () => {
  const harness = createHarness('dark');
  const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();

  await startTerminal(
    { session: harness.session, catalog, flushState: () => gate },
    harness.effects,
  );

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(harness.calls.unmount).toBe(0);
  expect(harness.exitCodes).toEqual([]);

  release(undefined);
  await settle();

  expect(harness.calls).toEqual({ destroy: 1, unmount: 1 });
  expect(harness.exitCodes).toEqual([0]);
});

test('a flushState that never settles still lets Mergit exit 0 after the bounded wait', async () => {
  const harness = createHarness('dark');

  await startTerminal(
    {
      session: harness.session,
      catalog,
      flushState: () => Promise.withResolvers<undefined>().promise,
    },
    harness.effects,
  );

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(harness.exitCodes).toEqual([]);

  await Bun.sleep(1100);

  expect(harness.calls).toEqual({ destroy: 1, unmount: 1 });
  expect(harness.exitCodes).toEqual([0]);
});

test('shutdown waits for the stop promise before it calls flushState', async () => {
  const harness = createHarness('dark');
  const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
  const order: string[] = [];

  harness.session.stop = async () => {
    order.push('stop');
    await gate;
    order.push('stopped');
  };

  await startTerminal(
    {
      session: harness.session,
      catalog,
      flushState: () => {
        order.push('flush');

        return Promise.resolve();
      },
    },
    harness.effects,
  );

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(order).toEqual(['stop']);
  expect(harness.exitCodes).toEqual([]);

  release(undefined);
  await settle();

  expect(order).toEqual(['stop', 'stopped', 'flush']);
  expect(harness.exitCodes).toEqual([0]);
});

test('a stop that never settles still lets Mergit exit 0 after the bounded wait', async () => {
  const harness = createHarness('dark');

  harness.session.stop = () => Promise.withResolvers<undefined>().promise;

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(harness.exitCodes).toEqual([]);

  await Bun.sleep(1100);

  expect(harness.calls).toEqual({ destroy: 1, unmount: 1 });
  expect(harness.exitCodes).toEqual([0]);
});

test('a rejected flushState does not change the exit code', async () => {
  const harness = createHarness('dark');

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.reject(new Error('disk')) },
    harness.effects,
  );

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(harness.exitCodes).toEqual([0]);
  expect(harness.printed).toEqual([]);
});

test('the stop deadline signal aborts before the 1000 ms bound and flushState still finishes', async () => {
  const harness = createHarness('dark');
  let deadline: AbortSignal | undefined;
  let flushed = false;

  harness.session.stop = (signal) => {
    deadline = signal;

    return new Promise<undefined>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve(undefined);
      });
    });
  };

  const flushState = async () => {
    await Bun.sleep(100);
    flushed = true;
  };

  await startTerminal({ session: harness.session, catalog, flushState }, harness.effects);

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(deadline?.aborted).toBe(false);

  await Bun.sleep(850);

  expect(deadline?.aborted).toBe(true);

  await Bun.sleep(100);

  expect(flushed).toBe(true);
  expect(harness.exitCodes).toEqual([0]);
});

test('shutdown never waits past 1000 ms in total when stop ignores the deadline and flushState hangs', async () => {
  const harness = createHarness('dark');

  harness.session.stop = () => Bun.sleep(800).then(() => undefined);

  await startTerminal(
    {
      session: harness.session,
      catalog,
      flushState: () => Promise.withResolvers<undefined>().promise,
    },
    harness.effects,
  );

  const startedAt = performance.now();

  harness.handlers.get('SIGINT')?.();

  while (harness.exitCodes.length === 0) {
    await Bun.sleep(10);
  }

  const elapsed = performance.now() - startedAt;

  expect(harness.exitCodes).toEqual([0]);
  expect(elapsed).toBeGreaterThanOrEqual(950);
  expect(elapsed).toBeLessThan(1100);
});

test('a root that throws on unmount prints that error, still destroys the renderer, and exits 1', async () => {
  const harness = createHarness('dark');
  const failure = new Error('unmount failed');

  harness.failures.unmount = failure;

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  harness.handlers.get('SIGINT')?.();
  await settle();

  expect(harness.printed).toEqual([failure]);
  expect(harness.exitCodes).toEqual([1]);
  expect(harness.calls.destroy).toBe(1);
});

test('a fatal error still exits 1 when printing the error throws', async () => {
  const harness = createHarness('dark');

  harness.failures.printError = new Error('stderr closed');

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  harness.handlers.get('uncaughtException')?.(new Error('boom'));
  await settle();

  expect(harness.exitCodes).toEqual([1]);
  expect(harness.printed).toEqual([]);
});

test('a terminal intent from the UI quits once and exits 0', async () => {
  const harness = createHarness('dark');

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  harness.rendered[0]?.props.onTerminalIntent({ kind: 'terminal', action: 'quit' });
  await settle();

  expect(harness.calls).toEqual({ destroy: 1, unmount: 1 });
  expect(harness.exitCodes).toEqual([0]);
});

test('a theme subscriber hears the renderer theme until it unsubscribes', async () => {
  const harness = createHarness('dark');

  await startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  let heard = 0;

  const off = harness.rendered[0]?.props.themeSource.subscribe(() => {
    heard += 1;
  });

  for (const listener of harness.listeners) {
    listener('light');
  }

  expect(heard).toBe(1);

  off?.();

  for (const listener of harness.listeners) {
    listener('dark');
  }

  expect(heard).toBe(1);
});

test('a SIGINT while the theme query is pending renders nothing and exits 0', async () => {
  const harness = createHarness('dark');
  const { promise: gate, resolve: release } = Promise.withResolvers<ThemeMode>();

  harness.renderer.waitForThemeMode = () => gate;

  const started = startTerminal(
    { session: harness.session, catalog, flushState: () => Promise.resolve() },
    harness.effects,
  );

  await settle();
  harness.handlers.get('SIGINT')?.();
  await settle();
  release('dark');
  await started;
  await settle();

  expect(harness.rendered).toHaveLength(0);
  expect(harness.listeners.size).toBe(0);
  expect(harness.exitCodes).toEqual([0]);
});
