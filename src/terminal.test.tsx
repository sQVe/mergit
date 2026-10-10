import { expect, test } from 'bun:test';

import { createTestRenderer } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot } from '@opentui/react';
import type { ReactElement } from 'react';

import { catalog } from './commands.ts';
import { createSession } from './session/session.ts';
import type { SessionEffects } from './session/session.ts';
import { startTerminal } from './terminal.tsx';
import type { TerminalEffects, TerminalRenderer } from './terminal.tsx';
import type { AppProps } from './ui/ui.tsx';

type ThemeMode = 'light' | 'dark' | null;
type ThemeListener = (mode: ThemeMode) => void;

const idleEffects: SessionEffects = {
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
  now: () => new Date(0),
  setTimer: () => () => undefined,
};

const createHarness = (initialTheme: ThemeMode) => {
  const listeners = new Set<ThemeListener>();
  const handlers = new Map<string, (reason?: unknown) => void>();
  const rendered: ReactElement<{ themeSource: { getThemeMode: () => ThemeMode } }>[] = [];
  const exitCodes: number[] = [];
  const printed: unknown[] = [];
  const calls = { destroy: 0, unmount: 0 };

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
          render: (node) =>
            rendered.push(node as ReactElement<{ themeSource: { getThemeMode: () => ThemeMode } }>),
          unmount: () => {
            calls.unmount += 1;
          },
        },
      }),
    listen: (event, handler) => {
      handlers.set(event, handler);

      return () => handlers.delete(event);
    },
    exit: (code) => exitCodes.push(code),
    printError: (error) => printed.push(error),
  };

  const session = createSession(idleEffects);
  const latestTheme = () => rendered.at(-1)?.props.themeSource.getThemeMode() ?? null;

  return {
    effects,
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

test('a second shutdown destroys the renderer once and changes nothing more', async () => {
  const harness = createHarness('dark');

  await startTerminal({ session: harness.session, catalog }, harness.effects);

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

  await startTerminal({ session: harness.session, catalog }, harness.effects);

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

  await startTerminal({ session: harness.session, catalog }, harness.effects);

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
    await startTerminal({ session, catalog }, harness.effects);

    expect(subscribersAtFetch).toEqual([1]);
  } finally {
    renderer.destroy();
  }
});

test('an unknown theme gives the dark palette', async () => {
  const harness = createHarness(null);

  await startTerminal({ session: harness.session, catalog }, harness.effects);

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

  const started = startTerminal({ session: harness.session, catalog }, harness.effects);

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

  await startTerminal({ session: harness.session, catalog }, harness.effects);
  await settle();

  expect(harness.printed).toEqual([failure]);
  expect(harness.exitCodes).toEqual([1]);
  expect(harness.handlers.size).toBe(0);
  expect(harness.calls.destroy).toBe(0);
});

const startWithRejectingOpen = (harness: ReturnType<typeof createHarness>, failure: Error) => {
  const { promise: gate, reject } = Promise.withResolvers<never>();

  harness.effects.open = () => gate;

  const started = startTerminal({ session: harness.session, catalog }, harness.effects);

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
