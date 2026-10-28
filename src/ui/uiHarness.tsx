import { RGBA } from '@opentui/core';
import { ManualClock } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useMemo } from 'react';
import type { ReactNode } from 'react';

import { catalog, keyHintOf } from '../commands.ts';
import type { Command, TerminalIntent } from '../commands.ts';
import { createSession } from '../session/session.ts';
import type { Session, SessionEffects } from '../session/session.ts';
import { toThreadId, toViewerId, toViewerLogin } from '../work/work.ts';
import type { NotificationThread } from '../work/work.ts';
import { pickPalette } from './palette.ts';
import { App } from './ui.tsx';
import type { AppProps } from './ui.tsx';

export type Setup = Awaited<ReturnType<typeof testRender>>;

export type ReadFailure = Extract<Awaited<ReturnType<SessionEffects['readFeed']>>, { ok: false }>;

export interface MountedApp {
  setup: Setup;
  cleanup: () => void;
  session: Session;
  press: (key: string) => Promise<void>;
  resize: (nextWidth: number, nextHeight: number) => Promise<void>;
  settle: () => Promise<void>;
  advance: (milliseconds: number) => Promise<void>;
  changeTheme: (mode: 'light' | 'dark' | null) => Promise<void>;
  terminalIntents: TerminalIntent[];
  sent: unknown[];
  subscriberCount: () => number;
}

interface MountOptions {
  themeMode?: 'light' | 'dark' | null;
  effects?: SessionEffects;
  width?: number;
  manualTime?: boolean;
  height?: number;
  kittyKeyboard?: boolean;
  catalog?: readonly Command[];
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

export const idleEffects: SessionEffects = {
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
      value: { id: toViewerId('U_octocat'), login: toViewerLogin('octocat'), etag: null },
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

export const makeThread = (id: number, title: string): NotificationThread => ({
  id: toThreadId(String(id)),
  reason: 'subscribed',
  unread: true,
  updatedAt: '1970-01-01T00:00:00Z',
  lastReadAt: null,
  title,
  subjectType: 'PullRequest',
  subjectUrl: `https://api.github.com/repos/example/repo/pulls/${id}`,
  repository: 'example/repo',
});

const hourMilliseconds = 3_600_000;

const feedHours = 3;

export const feedEffects = (
  read: () => readonly NotificationThread[] | ReadFailure,
): SessionEffects => ({
  ...idleEffects,
  readFeed: () => {
    const result = read();

    return Promise.resolve(
      'ok' in result
        ? result
        : {
            ok: true as const,
            value: { feed: { pages: [] }, threads: [...result], pollInterval: null },
          },
    );
  },
  now: () => new Date(feedHours * hourMilliseconds),
});

export const threadsEffects = (threads: readonly NotificationThread[]): SessionEffects =>
  feedEffects(() => threads);

const WithKeymap = (props: Omit<AppProps, 'keymap'>): ReactNode => {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  return <App {...props} keymap={keymap} />;
};

const defaultWidth = 60;

const defaultHeight = 24;

const framesAfterTimeline = 2;

export const mount = async (options: MountOptions = {}): Promise<MountedApp> => {
  const {
    themeMode: initialMode = null,
    effects = idleEffects,
    width = defaultWidth,
    manualTime = false,
    height = defaultHeight,
    kittyKeyboard = false,
    catalog: appCatalog = catalog,
  } = options;

  let themeMode = initialMode;
  const themeListeners = new Set<() => void>();

  const themeSource = {
    getThemeMode: () => themeMode,
    subscribe: (listener: () => void) => {
      themeListeners.add(listener);

      return () => themeListeners.delete(listener);
    },
  };

  const changeTheme = async (mode: 'light' | 'dark' | null) => {
    themeMode = mode;

    // oxlint-disable-next-line typescript/require-await -- act flushes the callback's updates
    await act(async () => {
      for (const listener of themeListeners) {
        listener();
      }
    });
  };

  const session = createSession({ ...effects, refreshKey: keyHintOf(appCatalog, 'refresh') });
  let sessionSubscribers = 0;
  const subscribe = session.subscribe;

  session.subscribe = (listener) => {
    sessionSubscribers += 1;

    const unsubscribe = subscribe(listener);

    return () => {
      sessionSubscribers -= 1;
      unsubscribe();
    };
  };

  const terminalIntents: TerminalIntent[] = [];
  const sent: unknown[] = [];
  const send = session.send;

  session.send = (intent) => {
    if (intent.kind !== 'setListRows') {
      sent.push(intent);
    }

    send(intent);
  };

  const node: ReactNode = (
    <WithKeymap
      session={session}
      catalog={appCatalog}
      themeSource={themeSource}
      onTerminalIntent={(intent) => terminalIntents.push(intent)}
    />
  );

  const clock = manualTime ? new ManualClock() : undefined;

  const rendererOptions = clock === undefined ? { width, height } : { width, height, clock };

  const setup = await act(() => testRender(node, { ...rendererOptions, kittyKeyboard }));

  const cleanup = () => {
    act(() => {
      setup.renderer.destroy();
    });
  };

  const render = () =>
    act(async () => {
      // renderOnce returns early if a frame is already running.
      await setup.waitFor(() => !setup.renderer.getSchedulerState().isRendering);
      await setup.renderOnce();
    });

  const settle = async () => {
    await render();

    if (clock !== undefined) {
      return;
    }

    await setup.waitFor(async () => {
      await act(async () => {
        await setup.flush();
      });

      // Timeline callbacks update React state; draw its commit before checking visual completion.
      await render();

      return setup.getNativeStats().cellsUpdated === 0;
    });
  };

  const advance = async (milliseconds: number) => {
    await act(async () => {
      clock?.advance(milliseconds);
      await setup.renderOnce();
    });

    // The timeline sets React state during a frame; two more frames draw the result.
    for (let pass = 0; pass < framesAfterTimeline; pass += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- frames draw one after the other
      await act(async () => {
        await setup.renderOnce();
      });
    }
  };

  const press = async (key: string) => {
    await act(async () => {
      const dispatched = new Promise<void>((resolve) => {
        const onKeypress = () => {
          setup.renderer.keyInput.off('keypress', onKeypress);
          resolve();
        };

        setup.renderer.keyInput.prependListener('keypress', onKeypress);
      });

      if (key === 'escape' && manualTime && !kittyKeyboard) {
        // Unmodified modifyOtherKeys Escape avoids the parser timeout without advancing the clock.
        setup.mockInput.pressKey('\x1b[27;1;27~');
      } else if (key === 'escape') {
        setup.mockInput.pressEscape();
      } else if (key === 'return') {
        setup.mockInput.pressEnter();
      } else if (key === 'down' || key === 'up') {
        setup.mockInput.pressArrow(key);
      } else if (key === 'tab') {
        setup.mockInput.pressTab();
      } else if (key === 'backspace') {
        setup.mockInput.pressBackspace();
      } else if (key.startsWith('ctrl+')) {
        setup.mockInput.pressKey(key.slice('ctrl+'.length), { ctrl: true });
      } else if (key.startsWith('meta+')) {
        setup.mockInput.pressKey(key.slice('meta+'.length), { meta: true });
      } else {
        setup.mockInput.pressKey(key);
      }

      await dispatched;
    });

    await settle();
    await settle();
  };

  const resize = async (nextWidth: number, nextHeight: number) => {
    // oxlint-disable-next-line typescript/require-await -- act flushes the callback's updates
    await act(async () => {
      setup.resize(nextWidth, nextHeight);
    });

    await settle();
  };

  await settle();

  return {
    setup,
    cleanup,
    session,
    press,
    resize,
    settle,
    advance,
    changeTheme,
    terminalIntents,
    sent,
    subscriberCount: () => sessionSubscribers,
  };
};

export const track =
  <Args extends unknown[], Mounted extends { cleanup: () => void }>(
    cleanups: (() => void)[],
    mountWith: (...args: Args) => Promise<Mounted>,
  ) =>
  async (...args: Args): Promise<Mounted> => {
    const mounted = await mountWith(...args);

    cleanups.push(mounted.cleanup);

    return mounted;
  };

export const colorOf = (mode: 'light' | 'dark'): string =>
  RGBA.fromHex(pickPalette(mode).dim).toString();

export const statusLineColor = (setup: Setup): string | undefined => {
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const span = spans.find((candidate) => /^[?] help$/.test(candidate.text));

  return span?.fg.toString();
};

export const selectedRowText = (setup: Setup): string | undefined => {
  const selectedBackground = RGBA.fromHex(pickPalette('dark').selectedBackground).toString();

  const line = setup
    .captureSpans()
    .lines.find((candidate) =>
      candidate.spans.some((span) => span.bg.toString() === selectedBackground),
    );

  return line?.spans.map((span) => span.text).join('');
};

export const threeThreads: readonly NotificationThread[] = ['First', 'Second', 'Third'].map(
  (title, index) => makeThread(index + 1, title),
);

export const savedEffects = (
  savedAt: Date,
  threads: readonly NotificationThread[],
): SessionEffects => ({
  ...idleEffects,
  savedSnapshot: {
    viewer: { id: toViewerId('U_octocat'), login: toViewerLogin('octocat'), etag: null },
    savedAt,
    feed: { pages: [] },
    threads: [...threads],
  },
  readViewer: () => Promise.withResolvers<never>().promise,
  now: () => new Date(),
});

export const treeThread = (
  id: number,
  title: string,
  overrides: Partial<NotificationThread>,
): NotificationThread => ({ ...makeThread(id, title), ...overrides });

export const frameLines = (setup: Setup): string[] =>
  setup
    .captureCharFrame()
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');

export const pressAll = async (
  press: (key: string) => Promise<void>,
  keys: string[],
): Promise<void> => {
  for (const key of keys) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- keys go out in order
    await press(key);
  }
};

const paneMaximumWidth = 44;

const paneWidthShare = 0.36;

export const paneWidthAt = (width: number): number =>
  Math.min(paneMaximumWidth, Math.floor(width * paneWidthShare));

export const paneText = (setup: Setup, width: number): string => {
  const left = width - paneWidthAt(width);

  return setup
    .captureCharFrame()
    .split('\n')
    .map((line) => line.slice(left))
    .join('\n');
};

export const factsEffects = (
  threads: readonly NotificationThread[],
  facts: ReadonlyMap<string, { state: 'open' | 'closed' | 'merged'; author: string | null }>,
): SessionEffects => ({
  ...threadsEffects(threads),
  lookUpSubjects: () =>
    Promise.resolve({
      failures: [],
      lookups: threads.flatMap((thread) => {
        const known = facts.get(thread.id);

        return known === undefined
          ? []
          : [
              {
                threadId: thread.id,
                updatedAt: thread.updatedAt,
                facts: { ...known, latestActor: null },
              },
            ];
      }),
    }),
});

export const newMarkerThreads: readonly NotificationThread[] = [
  { ...makeThread(1, 'Seen thread'), repository: 'acme/alpha' },
  { ...makeThread(2, 'Fresh thread'), repository: 'acme/alpha' },
];

export const newMarkerEffects = (
  threads: readonly NotificationThread[],
  seenIds: string[],
): SessionEffects => ({
  ...threadsEffects(threads),
  savedState: {
    grouping: 'reason',
    done: new Map(),
    seen: new Map([
      [
        'github.com/octocat',
        new Map(
          threads
            .filter((thread) => seenIds.includes(thread.id))
            .map((thread) => [thread.id, thread.updatedAt]),
        ),
      ],
    ]),
  },
});

export const fourRepoThreads: readonly NotificationThread[] = ['a', 'b', 'c', 'd'].map(
  (name, index) =>
    treeThread(index + 1, `Thread ${name}`, {
      reason: 'review_requested',
      repository: `example/${name}`,
      subjectUrl: null,
    }),
);

export const mountWithGroup = async (
  feed: () => readonly NotificationThread[] = () => fourRepoThreads,
): Promise<MountedApp & { opens: unknown[] }> => {
  const opens: unknown[] = [];

  const effects: SessionEffects = {
    ...feedEffects(feed),
    openInBrowser: (page) => {
      opens.push(page);

      return Promise.resolve({ ok: true });
    },
  };

  const mounted = await mount({ themeMode: 'dark', effects });

  await pressAll(mounted.press, ['r', 'g', 'g']);

  return { ...mounted, opens };
};

const queryThreadOverrides: readonly (readonly [string, Partial<NotificationThread>])[] = [
  ['Mergit pull request', { repository: 'sqve/mergit' }],
  ['App pull request', { repository: 'acme/app' }],
  ['Web pull request', { repository: 'acme/web' }],
  [
    'App issue',
    {
      repository: 'acme/app',
      subjectType: 'Issue',
      subjectUrl: 'https://api.github.com/repos/acme/app/issues/4',
    },
  ],
];

export const queryThreads: readonly NotificationThread[] = queryThreadOverrides.map(
  ([title, overrides], index) => treeThread(index + 1, title, overrides),
);

export const burst = async (setup: Setup, keys: string[]): Promise<void> => {
  // oxlint-disable-next-line typescript/require-await -- a sync callback returns no thenable, which the await on act rejects
  await act(async () => {
    for (const key of keys) {
      if (key === 'escape') {
        setup.mockInput.pressEscape();
      } else if (key === 'return') {
        setup.mockInput.pressEnter();
      } else {
        for (const character of key) {
          setup.mockInput.pressKey(character);
        }
      }
    }
  });
};

export const typeText = async (
  setup: Setup,
  settle: () => Promise<void>,
  text: string,
): Promise<void> => {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });

  await settle();
};

export const pressCtrlU = async (setup: Setup, settle: () => Promise<void>): Promise<void> => {
  // oxlint-disable-next-line typescript/require-await -- act flushes the callback's updates
  await act(async () => {
    setup.mockInput.pressKey('u', { ctrl: true });
  });

  await settle();
};

const filterRepositories: readonly (readonly [string, string])[] = [
  ['Alpha change', 'acme/app'],
  ['Beta change', 'acme/app'],
  ['Gamma change', 'acme/web'],
];

export const filterThreads: readonly NotificationThread[] = filterRepositories.map(
  ([title, repository], index) => treeThread(index + 1, title, { repository }),
);

export const filterFacts: ReadonlyMap<string, { state: 'open'; author: string }> = new Map([
  ['1', { state: 'open', author: 'octo' }],
  ['2', { state: 'open', author: 'octo' }],
  ['3', { state: 'open', author: 'mona' }],
]);

export const mountFilters = async (
  width = defaultWidth,
  kittyKeyboard = false,
): Promise<MountedApp> => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: factsEffects(filterThreads, filterFacts),
    width,
    kittyKeyboard,
  });

  await mounted.press('r');
  await mounted.settle();

  return mounted;
};

export const composerInputOf = (frame: string): string | undefined => {
  const lines = frame.split('\n');
  const titleAt = lines.findIndex((line) => line.includes('─ Filter '));
  const line = lines[titleAt + 1];

  return titleAt === -1 ? undefined : line?.replace(/^│/, '').replace(/│$/, '').trim();
};

export const pressBackspace = async (setup: Setup, settle: () => Promise<void>): Promise<void> => {
  // oxlint-disable-next-line typescript/require-await -- act flushes the callback's updates
  await act(async () => {
    setup.mockInput.pressBackspace();
  });

  await settle();
};

const manyAuthorCount = 12;

export const manyAuthors: readonly NotificationThread[] = Array.from(
  { length: manyAuthorCount },
  (_, index) => treeThread(index + 1, `Change ${index + 1}`, { repository: 'acme/app' }),
);

export const manyFacts: ReadonlyMap<string, { state: 'open'; author: string }> = new Map(
  manyAuthors.map((thread, index) => [
    String(thread.id),
    { state: 'open' as const, author: `user${String(index).padStart(2, '0')}` },
  ]),
);
