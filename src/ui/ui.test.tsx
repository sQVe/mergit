import { afterEach, expect, test } from 'bun:test';

import { RGBA } from '@opentui/core';
import { ManualClock } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useMemo } from 'react';
import type { ReactNode } from 'react';

import { catalog } from '../commands.ts';
import type { TerminalIntent } from '../commands.ts';
import { createSession } from '../session/session.ts';
import type { SessionEffects } from '../session/session.ts';
import { toThreadId, toViewerLogin } from '../work/work.ts';
import type { NotificationThread } from '../work/work.ts';
import { DetailPane } from './DetailPane.tsx';
import { pickPalette } from './palette.ts';
import { App } from './ui.tsx';
import type { AppProps } from './ui.tsx';

type Setup = Awaited<ReturnType<typeof testRender>>;

type ReadFailure = Extract<Awaited<ReturnType<SessionEffects['readFeed']>>, { ok: false }>;

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const idleEffects: SessionEffects = {
  savedSnapshot: null,
  host: 'github.com',
  savedState: null,
  saveState: () => undefined,
  markThreadDone: () => Promise.resolve({ ok: true, value: null }),
  openInBrowser: () => Promise.resolve({ ok: true as const }),
  stateWarning: null,
  readViewer: () =>
    Promise.resolve({ ok: true as const, value: { login: toViewerLogin('octocat'), etag: null } }),
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
  lookUpSubjects: () => Promise.resolve([]),
  now: () => new Date(0),
  setTimer: () => () => undefined,
};

const makeThread = (id: number, title: string): NotificationThread => ({
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

const feedEffects = (read: () => NotificationThread[] | ReadFailure): SessionEffects => ({
  ...idleEffects,
  readFeed: () => {
    const result = read();

    return Promise.resolve(
      Array.isArray(result)
        ? {
            ok: true as const,
            value: { feed: { pages: [] }, threads: result, pollInterval: null },
          }
        : result,
    );
  },
  now: () => new Date(3 * 3_600_000),
});

const threadsEffects = (threads: NotificationThread[]): SessionEffects =>
  feedEffects(() => threads);

const setups: Setup[] = [];

// Kitty encoding keeps Esc separate from the key after it.
let kittyKeyboard = false;

afterEach(() => {
  kittyKeyboard = false;

  for (const setup of setups.splice(0)) {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

const WithKeymap = (props: Omit<AppProps, 'keymap'>): ReactNode => {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  return <App {...props} keymap={keymap} />;
};

const mount = async (
  initialMode: 'light' | 'dark' | null = null,
  effects: SessionEffects = idleEffects,
  width = 60,
  manualTime = false,
  height = 24,
) => {
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

    await act(async () => {
      for (const listener of themeListeners) {
        listener();
      }
    });
  };

  const session = createSession(effects);
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
    sent.push(intent);
    send(intent);
  };

  const node: ReactNode = (
    <WithKeymap
      session={session}
      catalog={catalog}
      themeSource={themeSource}
      onTerminalIntent={(intent) => terminalIntents.push(intent)}
    />
  );

  const clock = manualTime ? new ManualClock() : undefined;

  const rendererOptions = clock === undefined ? { width, height } : { width, height, clock };

  const setup = await act(() => testRender(node, { ...rendererOptions, kittyKeyboard }));

  setups.push(setup);

  const settle = () =>
    act(async () => {
      await Bun.sleep(50);
      await setup.renderOnce();
    });

  const advance = async (milliseconds: number) => {
    await act(async () => {
      clock?.advance(milliseconds);
      await setup.renderOnce();
    });

    // The timeline sets React state during a frame; two more frames draw the result.
    for (let pass = 0; pass < 2; pass += 1) {
      await act(async () => {
        await setup.renderOnce();
      });
    }
  };

  const press = async (key: string) => {
    await act(async () => {
      if (key === 'escape') {
        setup.mockInput.pressEscape();
      } else if (key === 'return') {
        setup.mockInput.pressEnter();
      } else if (key === 'down' || key === 'up') {
        setup.mockInput.pressArrow(key);
      } else if (key === 'tab') {
        setup.mockInput.pressTab();
      } else if (key === 'backspace') {
        setup.mockInput.pressBackspace();
      } else {
        setup.mockInput.pressKey(key);
      }
    });

    await settle();
    await settle();
  };

  const resize = async (nextWidth: number, nextHeight: number) => {
    await act(async () => {
      setup.resize(nextWidth, nextHeight);
    });

    await settle();
  };

  await settle();

  return {
    setup,
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

test('? opens the overlay with every command label and ? closes it', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 50);

  await press('?');

  const open = setup.captureCharFrame();
  const listed = catalog.filter((command) => command.scope !== 'confirm');

  for (const command of listed) {
    expect(open).toContain(command.label);
  }

  expect(open).not.toContain('Confirm opening');

  await press('?');

  const closed = setup.captureCharFrame();

  for (const command of catalog) {
    expect(closed).not.toContain(command.label);
  }
});

test('Escape closes the overlay', async () => {
  const { setup, press } = await mount();

  await press('?');
  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('the status line shows ? help', async () => {
  const { setup } = await mount();

  expect(setup.captureCharFrame()).toContain('? help');
});

test('q passes a quit terminal intent and sends nothing to the session', async () => {
  const { press, terminalIntents, sent } = await mount();

  await press('q');

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  expect(sent).toEqual([]);
});

test('q still quits while the overlay is open', async () => {
  const { press, terminalIntents } = await mount();

  await press('?');
  await press('q');

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
});

const colorOf = (mode: 'light' | 'dark'): string => RGBA.fromHex(pickPalette(mode).dim).toString();

const statusLineColor = (setup: Setup): string | undefined => {
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const span = spans.find((candidate) => candidate.text.includes('? help'));

  return span?.fg.toString();
};

test('the status line color follows the theme mode, and dark when it is unknown', async () => {
  const light = await mount('light');
  const dark = await mount('dark');
  const unknown = await mount(null);

  expect(statusLineColor(light.setup)).toBe(colorOf('light'));
  expect(statusLineColor(dark.setup)).toBe(colorOf('dark'));
  expect(statusLineColor(unknown.setup)).toBe(colorOf('dark'));
});

test('ctrl+c passes a quit terminal intent', async () => {
  const { setup, terminalIntents, settle } = await mount();

  await act(async () => {
    setup.mockInput.pressKey('c', { ctrl: true });
  });

  await settle();

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
});

test('escape does nothing while the overlay is closed', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 30);

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Close help');
});

test('the overlay lists the close help command from the catalog', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 30);

  await press('?');

  expect(setup.captureCharFrame()).toContain('Close help');
});

test('a theme change keeps the overlay open, recolors it, and adds no subscriber', async () => {
  const { setup, press, settle, changeTheme, subscriberCount } = await mount(
    'dark',
    idleEffects,
    60,
    false,
    50,
  );

  await press('?');

  const before = subscriberCount();

  await changeTheme('light');
  await settle();

  expect(setup.captureCharFrame()).toContain('Toggle help');
  expect(statusLineColor(setup)).toBe(colorOf('light'));
  expect(subscriberCount()).toBe(before);
  expect(before).toBe(1);

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

const selectedRowText = (setup: Setup): string | undefined => {
  const selectedBackground = RGBA.fromHex(pickPalette('dark').selectedBackground).toString();

  const line = setup
    .captureSpans()
    .lines.find((candidate) =>
      candidate.spans.some((span) => span.bg.toString() === selectedBackground),
    );

  return line?.spans.map((span) => span.text).join('');
};

const threeThreads = [makeThread(1, 'First'), makeThread(2, 'Second'), makeThread(3, 'Third')];

test('r sends a refresh and the rows show type, number, title, and age', async () => {
  const { setup, press, sent } = await mount('dark', threadsEffects(threeThreads));

  await press('r');

  const frame = setup.captureCharFrame();

  expect(sent).toEqual([{ kind: 'refresh' }]);
  expect(frame).toMatch(/PR\s+#1\s+First\s+3h/);
  expect(frame).toContain('Second');
  expect(frame).toContain('Third');
});

test('j and k move the selected row', async () => {
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await press('r');
  await press('j');
  await press('j');
  expect(selectedRowText(setup)).toContain('First');

  await press('j');
  expect(selectedRowText(setup)).toContain('Second');

  await press('j');
  await press('k');
  expect(selectedRowText(setup)).toContain('Second');
});

test('a refresh keeps the selection on the same thread when it still exists', async () => {
  let threads = threeThreads;

  const effects = feedEffects(() => threads);

  const { setup, press } = await mount('dark', effects);

  await press('r');
  await press('j');
  await press('j');
  await press('j');
  threads = [makeThread(0, 'Newest'), ...threeThreads];
  await press('r');

  expect(selectedRowText(setup)).toContain('Second');
});

test('a failed refresh keeps the rows and shows the error in the status line', async () => {
  let fail = false;

  const effects = feedEffects(() =>
    fail
      ? {
          ok: false as const,
          failure: { kind: 'requestFailed' as const, status: 500, message: 'Boom' },
        }
      : threeThreads,
  );

  const { setup, press } = await mount('dark', effects);

  await press('r');
  fail = true;
  await press('r');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('First');
  expect(frame).toContain('Boom');
});

test('a sign-in failure after a load keeps the rows and shows the fix in the status line', async () => {
  let signedIn = true;

  const effects = feedEffects(() =>
    signedIn ? threeThreads : { ok: false as const, failure: { kind: 'notSignedIn' as const } },
  );

  const { setup, press } = await mount('dark', effects);

  await press('r');
  signedIn = false;
  await press('r');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('First');
  expect(frame).toContain('Run gh auth login');
});

test('an empty inbox shows its notice, and loading shows before the first refresh', async () => {
  const { setup, press } = await mount();

  expect(setup.captureCharFrame()).toContain('Loading notifications');
  expect(setup.captureCharFrame()).not.toContain('No open notifications');

  await press('r');

  expect(setup.captureCharFrame()).toContain('No open notifications');
});

test('marking the only thread done shows the empty inbox notice', async () => {
  const { setup, press } = await mount('dark', threadsEffects([makeThread(1, 'Only thread')]));

  await press('r');
  await press('j');
  await press('j');
  await press('d');

  expect(setup.captureCharFrame()).toContain('No open notifications');
});

test('the selected row stays in view when the list is taller than the screen', async () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    makeThread(index + 1, `Thread ${index + 1}`),
  );

  const { setup, press } = await mount('dark', threadsEffects(many));

  await press('r');

  for (let step = 0; step < 32; step += 1) {
    await press('j');
  }

  expect(selectedRowText(setup)).toContain('Thread 31');
});

test('the status line says the feed is busy when the list could not be checked', async () => {
  const effects: SessionEffects = {
    ...threadsEffects(threeThreads),
    verifyFeed: () =>
      Promise.resolve({
        ok: true as const,
        value: { kind: 'changed' as const, pollInterval: null },
      }),
  };

  const { setup, press } = await mount('dark', effects);

  expect(setup.captureCharFrame()).not.toContain('feed busy');

  await press('r');

  expect(setup.captureCharFrame()).toContain('feed busy');
});

test('the status line names the rate limit pause and its end', async () => {
  const resetAt = new Date(4 * 3_600_000);

  const effects = feedEffects(() => ({
    ok: false as const,
    failure: { kind: 'rateLimited' as const, resetAt },
  }));

  const { setup, press } = await mount('dark', effects);

  expect(setup.captureCharFrame()).not.toContain('paused until');

  await press('r');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('paused until');
  expect(frame).toContain('04:00:00 UTC');
});

const savedEffects = (savedAt: Date, threads: NotificationThread[]): SessionEffects => ({
  ...idleEffects,
  savedSnapshot: {
    viewer: { login: toViewerLogin('octocat'), etag: null },
    savedAt,
    feed: { pages: [] },
    threads,
  },
  readViewer: () => Promise.withResolvers<never>().promise,
  now: () => new Date(),
});

test('the status line shows the age of the saved list, and not without one', async () => {
  const savedAt = new Date(Date.now() - 3 * 3_600_000);
  const saved = await mount('dark', savedEffects(savedAt, threeThreads));
  const fresh = await mount('dark', threadsEffects(threeThreads));

  expect(saved.setup.captureCharFrame()).toContain('saved 3h ago');
  expect(fresh.setup.captureCharFrame()).not.toContain('saved');
});

test('saved rows show their age relative to the saved time', async () => {
  const savedAt = new Date(Date.now() - 3 * 3_600_000);
  const updatedAt = new Date(savedAt.getTime() - 2 * 3_600_000).toISOString();
  const thread = { ...makeThread(1, 'First'), updatedAt };
  const { setup } = await mount('dark', savedEffects(savedAt, [thread]));

  expect(setup.captureCharFrame()).toMatch(/PR\s+#1\s+First\s+2h/);
});

test('the tree keys reach the session as their intents', async () => {
  const { press, sent } = await mount('dark', threadsEffects(threeThreads));

  await press('r');

  const keys = ['g', 'G', 'J', 'K', 'z', 'space', 'return', 'Z', 's'];

  for (const key of keys) {
    await press(key === 'space' ? ' ' : key);
  }

  expect(sent.slice(1)).toEqual([
    { kind: 'selectFirst' },
    { kind: 'selectLast' },
    { kind: 'selectNextGroup' },
    { kind: 'selectPreviousGroup' },
    { kind: 'toggleFold' },
    { kind: 'toggleFold' },
    { kind: 'toggleFold' },
    { kind: 'toggleAllFolds' },
    { kind: 'cycleGrouping' },
  ]);
});

const treeThread = (
  id: number,
  title: string,
  overrides: Partial<NotificationThread>,
): NotificationThread => ({ ...makeThread(id, title), ...overrides });

const treeThreads = [
  treeThread(1, 'Fix parser', {
    reason: 'review_requested',
    repository: 'example/alpha',
    updatedAt: '1970-01-01T01:00:00Z',
  }),
  treeThread(2, 'Add cache', {
    reason: 'review_requested',
    repository: 'example/alpha',
    updatedAt: '1970-01-01T00:30:00Z',
  }),
  treeThread(3, 'Crash on start', {
    reason: 'mention',
    repository: 'example/beta',
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/example/beta/issues/3',
    updatedAt: '1970-01-01T00:20:00Z',
  }),
  treeThread(4, 'Release v1', {
    reason: 'subscribed',
    repository: 'example/beta',
    subjectType: 'Release',
    subjectUrl: 'https://api.github.com/repos/example/beta/releases/4',
    updatedAt: '1970-01-01T00:10:00Z',
  }),
  treeThread(5, 'Stale crash', {
    reason: 'mention',
    repository: 'example/beta',
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/example/beta/issues/5',
    updatedAt: '1970-01-01T00:05:00Z',
  }),
];

const frameLines = (setup: Setup): string[] =>
  setup
    .captureCharFrame()
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');

test('the list shows threads under their group and repo in reason order, releases in their own group', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await press('r');

  const lines = frameLines(setup).slice(0, 11);

  expect(lines[0]).toMatch(/^▾ Review requested 2$/);
  expect(lines[1]).toMatch(/^│ ▾ example\/alpha 2$/);
  expect(lines[2]).toMatch(/^│ │ ├─\s*PR\s+#1\s+Fix parser\s+2h$/);
  expect(lines[3]).toMatch(/^│ │ └─\s*PR\s+#2\s+Add cache\s+2h$/);
  expect(lines[4]).toMatch(/^▾ Mention 2$/);
  expect(lines[5]).toMatch(/^│ ▾ example\/beta 2$/);
  expect(lines[6]).toMatch(/^│ │ ├─\s*ISS\s+#3\s+Crash on start\s+2h$/);
  expect(lines[7]).toMatch(/^│ │ └─\s*ISS\s+#5\s+Stale crash\s+2h$/);
  expect(lines[8]).toMatch(/^▾ Release 1$/);
  expect(lines[9]).toMatch(/^│ ▾ example\/beta 1$/);
  expect(lines[10]).toMatch(/^│ │ └─\s*REL\s+Release v1\s+2h$/);
});

const selectedLine = (setup: Setup): string | undefined => selectedRowText(setup)?.trim();

const pressAll = async (press: (key: string) => Promise<void>, keys: string[]): Promise<void> => {
  for (const key of keys) {
    await press(key);
  }
};

test('folding a node hides its children and keeps its count', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'j', 'z']);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('│ ▸ example/alpha 2');
  expect(frame).not.toContain('Fix parser');
  expect(frame).not.toContain('Add cache');
  expect(frame).toContain('Crash on start');
  expect(selectedLine(setup)).toStartWith('│ ▸ example/alpha 2');

  await press('z');

  expect(setup.captureCharFrame()).toContain('Fix parser');
  expect(setup.captureCharFrame()).toContain('│ ▾ example/alpha 2');
});

test('s regroups by type, then none, then reason, and keeps the selection on the same thread', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'j', 'j']);
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('s');

  const byType = frameLines(setup);

  expect(byType[0]).toBe('▾ Pull requests 2');
  expect(byType).toContain('▾ Issues 2');
  expect(byType).toContain('▾ Releases 1');
  expect(byType).toContain('│ ▾ example/alpha 2');
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('s');

  const ungrouped = frameLines(setup);

  expect(ungrouped.filter((line) => /^\s*(PR|ISS|REL)\s/.test(line))).toHaveLength(
    treeThreads.length,
  );

  expect(ungrouped.some((line) => /[│├└▾▸]/.test(line))).toBe(false);
  expect(ungrouped.some((line) => line.includes('Pull requests'))).toBe(false);
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('s');

  expect(frameLines(setup)[0]).toBe('▾ Review requested 2');
  expect(selectedLine(setup)).toContain('Fix parser');
});

test('the flat list shows each thread with its repository and no guide or branch', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 's', 's']);

  const lines = frameLines(setup).slice(0, 5);

  expect(lines[0]).toMatch(/^\s*PR\s+#1\s+example\/alpha\s+Fix parser\s+2h$/);
  expect(lines[1]).toMatch(/^\s*PR\s+#2\s+example\/alpha\s+Add cache\s+2h$/);
  expect(lines[2]).toMatch(/^\s*ISS\s+#3\s+example\/beta\s+Crash on start\s+2h$/);
  expect(lines[3]).toMatch(/^\s*REL\s+example\/beta\s+Release v1\s+2h$/);
  expect(lines[4]).toMatch(/^\s*ISS\s+#5\s+example\/beta\s+Stale crash\s+2h$/);

  for (const line of lines) {
    expect(line).not.toMatch(/[│├└▾▸]/);
  }
});

test('the flat list keeps each title start and age on its row at narrow widths', async () => {
  for (const width of [40, 30]) {
    const { setup, press } = await mount('dark', threadsEffects(treeThreads), width);

    await pressAll(press, ['r', 's', 's']);

    const lines = frameLines(setup).slice(0, 5);
    const titles = ['Fix', 'Add', 'Crash', 'Release', 'Stale'];

    expect(lines).toHaveLength(5);

    lines.forEach((line, index) => {
      expect(line).toMatch(new RegExp(`${titles[index]}.*\\d+h$`));
    });
  }
});

test('the flat list truncates a long repository name so the title keeps its space', async () => {
  const longRepository = 'example/a-valid-repository-name-longer-than-the-terminal-width';
  const threads = [treeThread(1, 'Fix parser', { repository: longRepository })];
  const { setup, press } = await mount('dark', threadsEffects(threads));

  await pressAll(press, ['r', 's', 's']);

  expect(frameLines(setup)[0]).toMatch(/^\s*PR\s+#1\s+example\/a-valid.*…\s+Fix parser\s+\d+h$/);
});

test('j and k move the selection one row, and g and G jump to the first and last row', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await press('r');
  expect(selectedLine(setup)).toBe('▾ Review requested 2');

  await press('j');
  expect(selectedLine(setup)).toBe('│ ▾ example/alpha 2');

  await press('j');
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('k');
  expect(selectedLine(setup)).toBe('│ ▾ example/alpha 2');

  await press('G');
  expect(selectedLine(setup)).toContain('Release v1');

  await press('g');
  expect(selectedLine(setup)).toBe('▾ Review requested 2');
});

test('J and K move the selection to the next and previous group', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'j', 'j']);

  await press('J');
  expect(selectedLine(setup)).toBe('▾ Mention 2');

  await press('J');
  expect(selectedLine(setup)).toBe('▾ Release 1');

  await press('K');
  expect(selectedLine(setup)).toBe('▾ Mention 2');
});

test('z and Space fold the node that holds the selection, from a thread or a node', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'j', 'j', 'z']);

  expect(setup.captureCharFrame()).not.toContain('Fix parser');
  expect(selectedLine(setup)).toBe('│ ▸ example/alpha 2');

  await press(' ');

  expect(setup.captureCharFrame()).toContain('Fix parser');
  expect(selectedLine(setup)).toBe('│ ▾ example/alpha 2');

  await press(' ');

  expect(setup.captureCharFrame()).not.toContain('Fix parser');
});

test('Enter on a group folds and unfolds it, and j moves on to its threads', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'return']);

  expect(frameLines(setup)[0]).toBe('▸ Review requested 2');
  expect(setup.captureCharFrame()).not.toContain('Fix parser');

  await press('return');

  expect(frameLines(setup)[0]).toBe('▾ Review requested 2');

  await pressAll(press, ['j', 'j']);

  expect(selectedLine(setup)).toContain('Fix parser');
});

test('Enter on a group below 90 columns folds it and opens no detail', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'return']);

  expect(frameLines(setup)[0]).toBe('▸ Review requested 2');
  expect(setup.captureCharFrame()).not.toContain('Unread');
  expect(setup.captureCharFrame()).not.toContain('Repo ');
});

test('Z folds every group, and unfolds them when all are folded', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'j', 'j', 'Z']);

  expect(frameLines(setup).slice(0, 3)).toEqual([
    '▸ Review requested 2',
    '▸ Mention 2',
    '▸ Release 1',
  ]);

  expect(selectedLine(setup)).toBe('▸ Review requested 2');

  await press('Z');

  expect(setup.captureCharFrame()).toContain('Fix parser');
  expect(setup.captureCharFrame()).toContain('│ ▾ example/beta 1');
});

test('a node row with a long repository name keeps its marker and count, open and folded', async () => {
  const longRepository = 'example/a-valid-repository-name-longer-than-the-terminal-width';
  const threads = [treeThread(1, 'Fix parser', { repository: longRepository })];
  const { setup, press } = await mount('dark', threadsEffects(threads));

  await press('r');

  const nodeLine = (): string | undefined =>
    frameLines(setup).find((line) => line.startsWith('│ ') && line.includes('example/a-valid'));

  expect(nodeLine()).toMatch(/^│ ▾ example\/a-valid.*… 1$/);

  await pressAll(press, ['j', 'z']);

  expect(nodeLine()).toMatch(/^│ ▸ example\/a-valid.*… 1$/);
});

test('the status line shows the state warning', async () => {
  const { setup } = await mount('dark', { ...idleEffects, stateWarning: 'state file is invalid' });

  expect(setup.captureCharFrame()).toContain('state file is invalid');
});

const paneWidthAt = (width: number): number => Math.min(44, Math.floor(width * 0.36));

const paneText = (setup: Setup, width: number): string => {
  const left = width - paneWidthAt(width);

  return setup
    .captureCharFrame()
    .split('\n')
    .map((line) => line.slice(left))
    .join('\n');
};

test('at 90 columns and up, the side pane shows the selected thread and follows the cursor', async () => {
  const threads = [
    { ...makeThread(1, 'First title'), repository: 'acme/alpha' },
    { ...makeThread(2, 'Second title'), repository: 'acme/beta' },
  ];

  const { setup, press } = await mount('dark', threadsEffects(threads), 100);

  await press('r');
  await press('j');
  await press('j');

  const first = paneText(setup, 100);

  expect(first).toMatch(/Repo\s+acme\/alpha/);
  expect(first).toMatch(/Type\s+PR/);
  expect(first).toMatch(/Number\s+#1/);
  expect(first).toContain('First title');
  expect(first).toMatch(/Reason\s+subscribed/);
  expect(first).toMatch(/Updated\s+3h/);
  expect(first).toMatch(/Unread\s+yes/);

  await press('j');
  await press('j');

  const second = paneText(setup, 100);

  expect(second).toMatch(/Repo\s+acme\/beta/);
  expect(second).toMatch(/Number\s+#2/);
  expect(second).toContain('Second title');
  expect(second).not.toContain('First title');
  expect(second).not.toContain('acme/alpha');
});

const mixedThreads = [
  { ...makeThread(1, 'Alpha pull'), repository: 'acme/alpha' },
  {
    ...makeThread(2, 'Beta issue'),
    repository: 'acme/alpha',
    subjectType: 'Issue',
    reason: 'manual',
  },
  { ...makeThread(3, 'Gamma issue'), repository: 'acme/beta', subjectType: 'Issue' },
];

test('at 90 columns and up, the side pane summarizes a selected group and repo by type and reason', async () => {
  const { setup, press } = await mount('dark', threadsEffects(mixedThreads), 100);

  await press('r');

  const group = paneText(setup, 100);

  expect(group).toMatch(/Threads\s+3/);
  expect(group).toMatch(/2\s+ISS/);
  expect(group).toMatch(/1\s+PR/);
  expect(group).toMatch(/1\s+manual/);
  expect(group).toMatch(/2\s+subscribed/);

  await press('j');

  const repo = paneText(setup, 100);

  expect(repo).toContain('acme/alpha');
  expect(repo).toMatch(/Threads\s+2/);
  expect(repo).toMatch(/1\s+ISS/);
  expect(repo).toMatch(/1\s+PR/);
  expect(repo).toMatch(/1\s+manual/);
  expect(repo).toMatch(/1\s+subscribed/);
});

test('the side pane counts distinct unknown types separately by full name', async () => {
  const threads = [
    { ...makeThread(1, 'Invite'), repository: 'acme/alpha', subjectType: 'RepositoryInvitation' },
    {
      ...makeThread(2, 'Alert'),
      repository: 'acme/alpha',
      subjectType: 'RepositoryVulnerabilityAlert',
    },
  ];

  const { setup, press } = await mount('dark', threadsEffects(threads), 100);

  await press('r');
  await press('j');

  const repo = paneText(setup, 100).replace(/[\s│]+/g, '');

  expect(repo).toContain('1RepositoryInvitation');
  expect(repo).toContain('1RepositoryVulnerabilityAlert');
  expect(repo).not.toContain('2REP');
});

test('resizing across 90 columns removes and restores the side pane and keeps the selected row', async () => {
  const { setup, press, resize } = await mount('dark', threadsEffects(threeThreads), 100);

  await press('r');
  await press('j');
  await press('j');
  expect(paneText(setup, 100)).toMatch(/Repo\s+example\/repo/);

  await resize(60, 20);

  const narrow = setup.captureCharFrame();

  expect(narrow).not.toContain('Unread');
  expect(narrow).not.toContain('Updated');
  expect(narrow).toMatch(/PR\s+#1\s+First\s+3h/);
  expect(selectedRowText(setup)).toContain('First');

  await resize(90, 20);

  expect(paneText(setup, 90)).toMatch(/Repo\s+example\/repo/);
  expect(selectedRowText(setup)).toContain('First');
});

test('a long title stays inside the list columns and clear of the pane at 90 columns', async () => {
  const long = makeThread(1, 'x'.repeat(120));

  const { setup, press } = await mount('dark', threadsEffects([long]), 90);

  await press('r');
  await press('j');
  await press('j');

  const listWidth = 90 - paneWidthAt(90);
  const lines = setup.captureCharFrame().split('\n');
  const row = lines.find((line) => /PR\s+#1/.test(line)) ?? '';
  const border = lines.map((line) => line[listWidth]);

  expect(row.slice(0, listWidth)).toContain('…');
  expect(row.slice(0, listWidth)).toMatch(/3h\s*$/);
  expect(border.slice(0, 5).every((char) => char === '│')).toBe(true);
});

test('below 90 columns, Enter on a thread opens the full-width detail and Escape returns to the same row', async () => {
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j']);

  const before = selectedRowText(setup);

  await press('return');

  const detail = setup.captureCharFrame();

  expect(detail).toContain('Second');
  expect(detail).toMatch(/Repo\s+example\/repo/);
  expect(detail).not.toContain('First');
  expect(detail).not.toContain('Third');

  await press('escape');

  const list = setup.captureCharFrame();

  expect(list).toContain('First');
  expect(list).toContain('Second');
  expect(list).toContain('Third');
  expect(selectedRowText(setup)).toBe(before);
  expect(selectedRowText(setup)).toContain('Second');
});

test('j and k do not move the selection while the full-width detail is open', async () => {
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j', 'return', 'j', 'k', 'k']);

  expect(setup.captureCharFrame()).toContain('Second');
  expect(setup.captureCharFrame()).not.toContain('First');

  await press('escape');

  expect(selectedRowText(setup)).toContain('Second');
});

test('Escape with help open inside the detail closes help only', async () => {
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j', 'return', '?', 'escape']);

  expect(setup.captureCharFrame()).toMatch(/Repo\s+example\/repo/);
  expect(setup.captureCharFrame()).not.toContain('Third');
});

test('resizing wide shows the side pane and resizing narrow again shows the list, not the detail', async () => {
  const { setup, press, resize } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j', 'return']);

  expect(setup.captureCharFrame()).not.toContain('Third');

  await resize(100, 20);

  expect(setup.captureCharFrame()).toContain('Third');
  expect(paneText(setup, 100)).toMatch(/Repo\s+example\/repo/);

  await resize(60, 20);

  const narrow = setup.captureCharFrame();

  expect(narrow).toContain('First');
  expect(narrow).toContain('Third');
  expect(narrow).not.toContain('Unread');
  expect(selectedRowText(setup)).toContain('Second');
});

test('the status line stays on the last row in the full-width detail', async () => {
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j', 'return']);

  const rows = setup.captureCharFrame().split('\n');

  expect(rows.join('\n')).not.toContain('Third');
  expect(rows.findIndex((row) => row.includes('? help'))).toBe(rows.length - 2);
});

const factsEffects = (
  threads: NotificationThread[],
  facts: Map<string, { state: 'open' | 'closed' | 'merged'; author: string | null }>,
): SessionEffects => ({
  ...threadsEffects(threads),
  lookUpSubjects: () =>
    Promise.resolve(
      threads.flatMap((thread) => {
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
    ),
});

test('the side pane shows the state and author of a thread with known facts', async () => {
  const threads = [makeThread(1, 'First title')];
  const effects = factsEffects(threads, new Map([['1', { state: 'merged', author: 'octo' }]]));

  const { setup, press } = await mount('dark', effects, 100);

  await press('r');
  await press('j');
  await press('j');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/State\s+merged/);
  expect(frame).toMatch(/Author\s+octo/);
});

test('the side pane leaves out State and Author for a thread with no facts', async () => {
  const { setup, press } = await mount('dark', threadsEffects([makeThread(1, 'First title')]), 100);

  await press('r');
  await press('j');
  await press('j');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/Repo\s+example\/repo/);
  expect(frame).toMatch(/Unread\s+yes/);
  expect(frame).not.toContain('State');
  expect(frame).not.toContain('Author');
});

test('the side pane leaves out Author when the author is unknown', async () => {
  const threads = [makeThread(1, 'First title')];
  const effects = factsEffects(threads, new Map([['1', { state: 'closed', author: null }]]));

  const { setup, press } = await mount('dark', effects, 100);

  await press('r');
  await press('j');
  await press('j');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/State\s+closed/);
  expect(frame).not.toContain('Author');
});

const slideMilliseconds = 200;

const reportFailure = async (
  session: { reportStateWrite: (outcome: { ok: false; reason: string; path: string }) => void },
  advance: (milliseconds: number) => Promise<void>,
  reason = 'disk full',
) => {
  await act(async () => {
    session.reportStateWrite({ ok: false, reason, path: '~/state.json' });
  });

  await advance(0);
};

const failWrite = async (
  session: { reportStateWrite: (outcome: { ok: false; reason: string; path: string }) => void },
  advance: (milliseconds: number) => Promise<void>,
  reason = 'disk full',
) => {
  await reportFailure(session, advance, reason);
  await advance(slideMilliseconds);
};

test('a failed write shows a toast and no unsaved marker in the status line', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 60, true);

  await press('s');
  await failWrite(session, advance);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('disk full');
  expect(frame).not.toContain('unsaved');
});

test('a toast shows its title, reason, and file, each on a row starting with the bar and with no line border', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 60, true);

  await press('s');
  await failWrite(session, advance);

  const rows = setup
    .captureCharFrame()
    .split('\n')
    .filter((row) => row.includes('▌'));

  const texts = ['✗ Grouping not saved', 'disk full', '~/state.json'];

  for (const text of texts) {
    const row = rows.find((candidate) => candidate.includes(text));

    expect(row).toBeDefined();
    expect(row?.slice(row.indexOf('▌'), row.indexOf('▌') + 2)).toBe('▌ ');
  }

  expect(rows.join('')).not.toMatch(/[│╭╮╰╯─]/);
});

test('a toast with short lines draws a block narrower than the width limit', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 60, true);

  await press('s');
  await failWrite(session, advance);

  const rows = setup
    .captureCharFrame()
    .split('\n')
    .filter((row) => row.includes('▌'));

  const barColumn = rows[0]?.indexOf('▌') ?? -1;
  const blockWidth = (rows[0]?.length ?? 0) - barColumn - 1;
  const widthLimit = 40;

  expect(rows.length).toBeGreaterThan(0);
  expect(blockWidth).toBeLessThan(widthLimit);
});

const longReason = `disk full ${'/very/long/path'.repeat(8)}`;

test('a toast on a full list keeps the list height and wraps a long reason', async () => {
  const threads = Array.from({ length: 40 }, (_, index) =>
    makeThread(index + 1, `Thread ${index + 1}`),
  );

  const { setup, session, press, advance } = await mount('dark', threadsEffects(threads), 60, true);

  await press('r');
  await press('s');

  const before = setup.captureCharFrame().split('\n');

  await failWrite(session, advance, longReason);

  const after = setup.captureCharFrame().split('\n');
  const statusIndex = after.findIndex((line) => line.includes('? help'));

  const listColumns = 8;

  expect(after).toHaveLength(before.length);
  expect(statusIndex).toBe(before.findIndex((line) => line.includes('? help')));

  expect(after[statusIndex - 1]?.slice(0, listColumns)).toBe(
    before[statusIndex - 1]?.slice(0, listColumns),
  );

  const flattened = after
    .filter((line) => line.includes('▌'))
    .map((line) => line.slice(line.indexOf('▌') + 1))
    .join('')
    .replaceAll(/[\s│╭╮╰╯─]/g, '');

  expect(flattened).toContain(longReason.replaceAll(/\s/g, ''));

  const toastParts = after
    .filter((line) => line.includes('▌'))
    .map((line) => line.slice(line.indexOf('▌')));

  expect(toastParts.length).toBeGreaterThan(0);
  expect(toastParts.join('')).not.toMatch(/[│├└]|Thread/);
});

test('a toast on a terminal too narrow for text renders nothing and still expires', async () => {
  const callbacks: (() => void)[] = [];

  const effects: SessionEffects = {
    ...idleEffects,
    setTimer: (_delay, callback) => {
      callbacks.push(callback);

      return () => undefined;
    },
  };

  const { setup, session, press, settle, advance } = await mount('dark', effects, 6, true);

  await press('s');
  await failWrite(session, advance);

  expect(setup.captureCharFrame()).not.toContain('▌');

  await act(async () => {
    callbacks.at(-1)?.();
  });

  await settle();

  expect(session.getSnapshot().toast).toBeNull();
}, 5000);

const toastRows = (frame: string) => frame.split('\n').filter((row) => row.includes('▌'));

const barLength = (frame: string) => {
  const bottomRow = toastRows(frame).at(-1) ?? '';

  return bottomRow.split('▁').length - 1;
};

const titleColumn = (frame: string) => {
  const row = toastRows(frame).find((candidate) => candidate.includes('not saved'));

  return row?.indexOf('✗') ?? -1;
};

test('a toast on a terminal with two text columns stays within five text rows', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 9, true);

  await press('s');
  await failWrite(session, advance);

  const barRows = toastRows(setup.captureCharFrame());
  const paddingRow = 1;

  expect(barRows.length).toBeGreaterThan(paddingRow);
  expect(barRows.length - paddingRow).toBeLessThanOrEqual(5);
}, 5000);

const toastDuration = (session: {
  getSnapshot: () => { toast: { durationMilliseconds: number } | null };
}) => session.getSnapshot().toast?.durationMilliseconds ?? 0;

test('a toast block starts at its title row with no empty row above it', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 60, true);

  await press('s');
  await failWrite(session, advance);

  const rows = toastRows(setup.captureCharFrame());

  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]).toContain('✗');
});

test('a toast with a long reason is at most 40 columns wide', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 80, true);

  await press('s');
  await failWrite(session, advance, longReason);

  const rows = toastRows(setup.captureCharFrame());
  const barColumn = rows[0]?.indexOf('▌') ?? -1;
  const blockWidth = (rows[0]?.length ?? 0) - barColumn - 1;

  expect(rows.length).toBeGreaterThan(0);
  expect(blockWidth).toBeLessThanOrEqual(40);
  expect(blockWidth).toBeGreaterThan(30);
});

test('the time-left bar is shorter after half the toast duration than after the slide, and not empty', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 60, true);

  await press('s');

  await failWrite(session, advance);

  const full = barLength(setup.captureCharFrame());

  await advance(toastDuration(session) / 2);

  const half = barLength(setup.captureCharFrame());

  expect(full).toBeGreaterThan(0);
  expect(half).toBeGreaterThan(0);
  expect(half).toBeLessThan(full);
});

test('a toast starts away from its resting column and sits at it, with the title on screen, after the slide', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 60, true);

  await press('s');

  await reportFailure(session, advance);

  const start = titleColumn(setup.captureCharFrame());

  await advance(slideMilliseconds);

  const afterSlide = titleColumn(setup.captureCharFrame());

  await advance(1000);

  const later = titleColumn(setup.captureCharFrame());

  expect(afterSlide).toBeGreaterThan(-1);
  expect(start).not.toBe(afterSlide);
  expect(later).toBe(afterSlide);
});

test('a newer toast starts with a full bar again', async () => {
  const { setup, session, press, advance } = await mount('dark', idleEffects, 60, true);

  await press('s');

  await failWrite(session, advance);

  const full = barLength(setup.captureCharFrame());

  await advance(toastDuration(session) / 2);

  const shrunk = barLength(setup.captureCharFrame());

  await press('s');
  await failWrite(session, advance, 'second failure');

  const restarted = barLength(setup.captureCharFrame());

  expect(shrunk).toBeLessThan(full);
  expect(restarted).toBe(full);
});

const expiringEffects = () => {
  const callbacks: (() => void)[] = [];

  const effects: SessionEffects = {
    ...idleEffects,
    setTimer: (_delay, callback) => {
      callbacks.push(callback);

      return () => undefined;
    },
  };

  return { effects, callbacks };
};

const exitMilliseconds = 150;

const markColumn = (frame: string) =>
  toastRows(frame)
    .find((row) => row.includes('✗'))
    ?.indexOf('✗') ?? -1;

test('an expired toast stays on screen away from its resting column and is gone after the exit', async () => {
  const { effects, callbacks } = expiringEffects();
  const { setup, session, press, advance } = await mount('dark', effects, 60, true);

  await press('s');
  await failWrite(session, advance);

  const resting = markColumn(setup.captureCharFrame());

  await act(async () => {
    callbacks.at(-1)?.();
  });

  await advance(100);

  const exiting = setup.captureCharFrame();

  await advance(exitMilliseconds);

  expect(session.getSnapshot().toast).toBeNull();
  expect(resting).toBeGreaterThan(-1);
  expect(markColumn(exiting)).toBeGreaterThan(resting);
  expect(setup.captureCharFrame()).not.toContain('not saved');
});

test('a new toast during an exit appears at once and slides in', async () => {
  const { effects, callbacks } = expiringEffects();
  const { setup, session, press, advance } = await mount('dark', effects, 60, true);

  await press('s');
  await failWrite(session, advance);

  const resting = markColumn(setup.captureCharFrame());

  await act(async () => {
    callbacks.at(-1)?.();
  });

  await advance(20);

  const exiting = setup.captureCharFrame();

  await press('s');
  await reportFailure(session, advance, 'second failure');
  await advance(40);

  const start = setup.captureCharFrame();

  await advance(slideMilliseconds);

  const settled = setup.captureCharFrame();

  expect(exiting).toContain('disk full');
  expect(start).not.toContain('disk full');
  expect(markColumn(start)).toBeGreaterThan(resting);
  expect(markColumn(settled)).toBe(resting);
  expect(settled).toContain('second failure');
});

const newMarkerThreads = [
  { ...makeThread(1, 'Seen thread'), repository: 'acme/alpha' },
  { ...makeThread(2, 'Fresh thread'), repository: 'acme/alpha' },
];

const newMarkerEffects = (threads: NotificationThread[], seenIds: string[]): SessionEffects => ({
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

test('a new thread row shows the marker and its repo and group rows count it', async () => {
  const { setup, press } = await mount('dark', newMarkerEffects(newMarkerThreads, ['1']), 100);

  await press('r');

  const lines = frameLines(setup);
  const rowOf = (text: string) => lines.find((line) => line.includes(text)) ?? '';

  expect(rowOf('Fresh thread')).toContain('●');
  expect(rowOf('Seen thread')).not.toContain('●');
  expect(rowOf('acme/alpha')).toMatch(/acme\/alpha 1\/2 /);
  expect(rowOf('Subscribed or manual')).toMatch(/Subscribed or manual 1\/2 /);
});

test('a node with no new threads shows only its thread count', async () => {
  const { setup, press } = await mount('dark', newMarkerEffects(newMarkerThreads, ['1', '2']), 100);

  await press('r');

  const lines = frameLines(setup);
  const rowOf = (text: string) => lines.find((line) => line.includes(text)) ?? '';

  expect(setup.captureCharFrame()).not.toContain('●');
  expect(rowOf('acme/alpha')).toMatch(/acme\/alpha 2 /);
  expect(rowOf('Subscribed or manual')).toMatch(/Subscribed or manual 2 /);
});

const renderThreadPane = async (isNew: boolean): Promise<string> => {
  const thread = makeThread(1, 'Fresh thread');
  const row = { kind: 'thread' as const, key: 't', thread, depth: 0, nodeRowKey: null, last: true };
  const newThreadIds = new Set(isNew ? [thread.id] : []);

  const setup = await act(() =>
    testRender(
      <DetailPane
        row={row}
        facts={undefined}
        newThreadIds={newThreadIds}
        palette={pickPalette('dark')}
        now={new Date(3 * 3_600_000)}
        width={40}
      />,
      { width: 40, height: 12 },
    ),
  );

  setups.push(setup);
  await act(() => setup.renderOnce());

  return setup.captureCharFrame();
};

test('the side pane of a new thread has a New line, and not for a thread that is not new', async () => {
  expect(await renderThreadPane(true)).toMatch(/New\s+yes/);
  expect(await renderThreadPane(false)).not.toMatch(/New\s/);
});

test('the side pane of a node with new threads shows their count on a New line', async () => {
  const withNew = await mount('dark', newMarkerEffects(newMarkerThreads, ['1']), 100);

  await withNew.press('r');

  const without = await mount('dark', newMarkerEffects(newMarkerThreads, ['1', '2']), 100);

  await without.press('r');

  expect(paneText(withNew.setup, 100)).toMatch(/New\s+1/);
  expect(paneText(without.setup, 100)).not.toMatch(/New\s/);
});

const fiveThreads = Array.from({ length: 5 }, (_, index) =>
  makeThread(index + 1, `Batch thread ${index + 1}`),
);

test('d on a repo node with 5 threads hides all 5 at once', async () => {
  const { setup, press, sent } = await mount('dark', threadsEffects(fiveThreads));

  await pressAll(press, ['r', 'g', 'j']);

  expect(selectedLine(setup)).toContain('example/repo');

  await press('d');

  const frame = setup.captureCharFrame();

  for (const thread of fiveThreads) {
    expect(frame).not.toContain(thread.title);
  }

  expect(sent.filter((intent) => (intent as { kind: string }).kind === 'markThreadsDone')).toEqual([
    { kind: 'markThreadsDone', threadIds: fiveThreads.map((thread) => thread.id) },
  ]);
});

test('d on a folded group hides every thread under it, and one u brings them all back', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'g', 'z']);

  const before = setup.captureCharFrame();

  expect(selectedLine(setup)).toContain('Review requested');

  await press('d');

  const hidden = setup.captureCharFrame();

  expect(hidden).not.toContain('Review requested');
  expect(hidden).toContain('Crash on start');

  await press('u');

  const restored = setup.captureCharFrame();

  expect(restored).toContain('Review requested');
  expect(restored.split('\n').slice(0, 8)).toEqual(before.split('\n').slice(0, 8));
});

const fourRepoThreads = ['a', 'b', 'c', 'd'].map((name, index) =>
  treeThread(index + 1, `Thread ${name}`, {
    reason: 'review_requested',
    repository: `example/${name}`,
    subjectUrl: null,
  }),
);

const mountWithGroup = async (feed: () => NotificationThread[] = () => fourRepoThreads) => {
  const opens: unknown[] = [];

  const effects: SessionEffects = {
    ...feedEffects(feed),
    openInBrowser: (page) => {
      opens.push(page);

      return Promise.resolve({ ok: true });
    },
  };

  const mounted = await mount('dark', effects);

  await pressAll(mounted.press, ['r', 'g']);

  return { ...mounted, opens };
};

const openedPages = ['a', 'b', 'c', 'd'].map((name) => ({
  kind: 'repo',
  repository: `example/${name}`,
}));

const hasOpenIntent = (sent: unknown[]) =>
  sent.some((intent) => (intent as { kind: string }).kind === 'openInBrowser');

test('o on a group node over 4 repos shows the dialog and opens nothing', async () => {
  const { setup, press, sent, opens } = await mountWithGroup();

  await press('o');

  expect(setup.captureCharFrame()).toContain('Open 4 repos');
  expect(hasOpenIntent(sent)).toBe(false);
  expect(opens).toEqual([]);
});

for (const key of ['y', 'return']) {
  test(`${key} in the dialog opens each repo once and closes the dialog`, async () => {
    const { setup, press, settle, opens } = await mountWithGroup();

    await press('o');
    await press(key);
    await settle();

    expect(opens).toEqual(openedPages);
    expect(setup.captureCharFrame()).not.toContain('Open 4 repos');
  });
}

for (const key of ['n', 'escape']) {
  test(`${key} in the dialog opens nothing and closes the dialog`, async () => {
    const { setup, press, settle, sent, opens } = await mountWithGroup();

    await press('o');
    await press(key);
    await settle();

    expect(opens).toEqual([]);
    expect(hasOpenIntent(sent)).toBe(false);
    expect(setup.captureCharFrame()).not.toContain('Open 4 repos');
  });
}

test('list keys do nothing while the dialog is open', async () => {
  const { setup, press, sent } = await mountWithGroup();

  await press('o');

  const before = sent.length;

  await pressAll(press, ['j', 'd', 'z', '?']);

  expect(sent).toHaveLength(before);
  expect(setup.captureCharFrame()).toContain('Open 4 repos');
  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('Escape with help open closes help and opens no dialog', async () => {
  const { setup, press } = await mountWithGroup();

  await pressAll(press, ['?', 'escape']);

  const frame = setup.captureCharFrame();

  expect(frame).not.toContain('Toggle help');
  expect(frame).not.toContain('Open 4 repos');
});

test('confirm opens the repos captured when the dialog opened, not the refreshed group', async () => {
  let current = fourRepoThreads;
  const { setup, session, press, settle, opens } = await mountWithGroup(() => current);

  await press('o');

  current = [
    ...fourRepoThreads.slice(0, 2),
    treeThread(9, 'Thread z', {
      reason: 'review_requested',
      repository: 'example/z',
      subjectUrl: null,
    }),
  ];

  session.send({ kind: 'refresh' });
  await settle();

  expect(setup.captureCharFrame()).toContain('Open 4 repos');

  await press('y');
  await settle();

  expect(opens).toEqual(openedPages);
});

const queryThreads = [
  treeThread(1, 'Zeta pull request', { repository: 'sqve/zeta' }),
  treeThread(2, 'App pull request', { repository: 'acme/app' }),
  treeThread(3, 'Web pull request', { repository: 'acme/web' }),
  treeThread(4, 'App issue', {
    repository: 'acme/app',
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/acme/app/issues/4',
  }),
];

const searchThreads = [
  ...queryThreads,
  treeThread(5, 'Fix yjs sync', { repository: 'acme/editor' }),
  treeThread(6, 'Update docs', { repository: 'acme/yjs' }),
  treeThread(7, 'Document repo: syntax', { repository: 'acme/docs' }),
];

const typeText = async (setup: Setup, settle: () => Promise<void>, text: string) => {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });

  await settle();
};

const pressCtrlU = async (setup: Setup, settle: () => Promise<void>) => {
  await act(async () => {
    setup.mockInput.pressKey('u', { ctrl: true });
  });

  await settle();
};

test('Backspace deletes characters in the search line, and on an empty line closes it', async () => {
  const { setup, press, settle } = await mount('dark', threadsEffects(queryThreads));

  await press('r');
  await press('/');
  await typeText(setup, settle, 'ab');
  await press('backspace');

  expect(setup.captureCharFrame()).toContain('/a');
  expect(setup.captureCharFrame()).not.toContain('/ab');

  await press('backspace');

  const emptied = setup.captureCharFrame();

  expect(emptied).toContain('/');
  expect(emptied).toContain('4 matches');

  await press('backspace');

  const closed = setup.captureCharFrame();

  expect(closed).not.toContain('matches');

  for (const title of ['Zeta pull request', 'App pull request', 'Web pull request', 'App issue']) {
    expect(closed).toContain(title);
  }
});

test('typing yjs after / shows only threads with yjs in the title or repository', async () => {
  const { setup, press, settle } = await mount('dark', threadsEffects(searchThreads));

  await press('r');
  await press('/');
  await typeText(setup, settle, 'yjs');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Fix yjs sync');
  expect(frame).toContain('Update docs');
  expect(frame).toContain('acme/yjs');
  expect(frame).not.toContain('Zeta pull request');
  expect(frame).not.toContain('App issue');
  expect(frame).not.toContain('acme/web');
  expect(frame).toContain('/yjs');
  expect(frame).toContain('2 matches');
});

test('repo: after / matches the text repo: and shows no error row', async () => {
  const { setup, press, settle } = await mount('dark', threadsEffects(searchThreads));

  await press('r');
  await press('/');
  await typeText(setup, settle, 'repo:');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Document repo: syntax');
  expect(frame).not.toContain('Zeta pull request');
  expect(frame).toContain('/repo:');
  expect(frame).toContain('1 match');
  expect(frame).not.toContain('^');
  expect(frame).not.toContain('Missing value');
});

test('Enter keeps the text, Esc while editing restores the old one, Ctrl-U clears the line, and Esc in the list clears', async () => {
  const { setup, press, settle } = await mount('dark', threadsEffects(queryThreads));

  await press('r');
  await press('/');
  await typeText(setup, settle, 'issue');
  await press('return');

  const kept = setup.captureCharFrame();

  expect(kept).toContain('App issue');
  expect(kept).not.toContain('Zeta pull request');
  expect(kept).toContain('1 match');

  await press('/');
  await typeText(setup, settle, ' acme');
  await press('escape');

  const restored = setup.captureCharFrame();

  expect(restored).toContain('/issue');
  expect(restored).not.toContain('/issue acme');
  expect(restored).toContain('App issue');

  await press('/');
  await pressCtrlU(setup, settle);

  const cleared = setup.captureCharFrame();

  expect(cleared).toContain('Zeta pull request');
  expect(cleared).not.toContain('/issue');

  await press('return');
  await press('/');
  await typeText(setup, settle, 'issue');
  await press('return');
  await press('escape');

  const listCleared = setup.captureCharFrame();

  expect(listCleared).toContain('Zeta pull request');
  expect(listCleared).not.toContain('/issue');
});

test('q typed in the open search line goes into the text and does not quit', async () => {
  const { setup, press, settle, terminalIntents } = await mount(
    'dark',
    threadsEffects(queryThreads),
  );

  await press('r');
  await press('/');
  await typeText(setup, settle, 'q');

  expect(terminalIntents).toEqual([]);
  expect(setup.captureCharFrame()).toContain('/q');
});

test('d on a group node under a search marks only its matching threads done', async () => {
  const { setup, press, settle, sent } = await mount('dark', threadsEffects(queryThreads));

  await press('r');
  await press('/');
  await typeText(setup, settle, 'acme/app');
  await press('return');
  await press('g');

  await press('d');

  const marks = sent.filter((intent) => (intent as { kind: string }).kind === 'markThreadsDone');

  expect(marks).toEqual([
    { kind: 'markThreadsDone', threadIds: [toThreadId('2'), toThreadId('4')] },
  ]);
});

test('under a search with more matches than rows, the last selected row stays fully visible', async () => {
  const many = Array.from({ length: 35 }, (_, index) =>
    makeThread(index + 1, `Match thread ${String(index + 1).padStart(2, '0')}`),
  );

  const { setup, press, settle } = await mount('dark', threadsEffects(many));

  await press('r');
  await press('/');
  await typeText(setup, settle, 'Match');
  await press('return');
  await press('G');

  const lines = setup.captureCharFrame().split('\n');
  const rowIndex = lines.findIndex((line) => line.includes('Match thread 35'));
  const queryIndex = lines.findIndex((line) => line.startsWith('/Match'));

  expect(rowIndex).toBeGreaterThanOrEqual(0);
  expect(rowIndex).toBeLessThan(queryIndex);
  expect(lines[rowIndex]).toContain('3h');
});

test('ctrl+c quits while the search line is open and q still types', async () => {
  const { setup, press, settle, terminalIntents } = await mount(
    'dark',
    threadsEffects(queryThreads),
  );

  await press('r');
  await press('/');
  await typeText(setup, settle, 'q');

  expect(terminalIntents).toEqual([]);

  await act(async () => {
    setup.mockInput.pressKey('c', { ctrl: true });
  });

  await settle();

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  expect(setup.captureCharFrame()).toContain('/q');
});

test('the help overlay lists the search line keys and still shows Close help', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 30);

  await press('?');

  const frame = setup.captureCharFrame();

  for (const id of ['submitInput', 'cancelInput', 'clearInput', 'closeEmptyInput']) {
    const command = catalog.find((candidate) => candidate.id === id);

    expect(frame).toContain(command?.label ?? 'missing');
  }

  expect(frame).toContain('Close help');
});

const filterThreads = [
  treeThread(1, 'Alpha change', { repository: 'acme/app' }),
  treeThread(2, 'Beta change', { repository: 'acme/app' }),
  treeThread(3, 'Gamma change', { repository: 'acme/web' }),
];

const filterFacts = new Map<string, { state: 'open'; author: string }>([
  ['1', { state: 'open', author: 'octo' }],
  ['2', { state: 'open', author: 'octo' }],
  ['3', { state: 'open', author: 'mona' }],
]);

const mountFilters = async (width = 60) => {
  const mounted = await mount('dark', factsEffects(filterThreads, filterFacts), width, false, 24);

  await mounted.press('r');
  await mounted.settle();

  return mounted;
};

const composerInputOf = (frame: string): string | undefined => {
  const lines = frame.split('\n');
  const titleAt = lines.findIndex((line) => line.includes('─ Filter '));
  const line = lines[titleAt + 1];

  return titleAt === -1 ? undefined : line?.replace(/^│/, '').replace(/│$/, '').trim();
};

const addAuthorChip = async (mounted: Awaited<ReturnType<typeof mountFilters>>, text: string) => {
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, text);
  await press('return');
};

test('f lists author candidates with their counts', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'author:');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/author:octo\s+2/);
  expect(frame).toMatch(/author:mona\s+1/);
});

test('Enter on a candidate adds a chip and narrows the list', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'author:mona');
  await press('return');
  await press('escape');

  const frame = setup.captureCharFrame();
  const chipRow = frame.split('\n')[0] ?? '';

  expect(chipRow).toContain('author:mona');
  expect(frame).toContain('Gamma change');
  expect(frame).not.toContain('Alpha change');
  expect(frame).not.toContain('Beta change');
});

test('a field name that is an object key keeps the composer on screen and the list returns after Esc', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, '__proto__:');

  const protoLines = setup.captureCharFrame().split('\n');

  expect(composerInputOf(setup.captureCharFrame())).toBe('__proto__:');
  expect(protoLines.some((line) => line.includes('Alpha change'))).toBe(false);

  await press('escape');

  expect(setup.captureCharFrame()).toContain('Alpha change');

  const second = await mountFilters();

  await second.press('f');
  await typeText(second.setup, second.settle, 'constructor:');

  const constructorFrame = second.setup.captureCharFrame();

  expect(composerInputOf(constructorFrame)).toBe('constructor:');
  expect(constructorFrame).not.toContain('function');
});

test('an invalid age shows an error after Enter and adds no chip', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'age:>3');

  expect(setup.captureCharFrame()).not.toContain('age takes');

  await press('return');

  expect(setup.captureCharFrame()).toContain('age takes');

  await press('escape');

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).not.toContain('age:');
  expect(frame).toContain('Alpha change');
  expect(frame).toContain('Gamma change');
});

test('Tab on a chip edits it and Enter replaces it', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');

  expect(composerInputOf(setup.captureCharFrame())).toBe('author:mona');

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'author:octo');
  await press('return');
  await press('escape');

  const frame = setup.captureCharFrame();
  const chipRow = frame.split('\n')[0] ?? '';

  expect(chipRow).toContain('author:octo');
  expect(chipRow).not.toContain('author:mona');
  expect(frame).toContain('Alpha change');
  expect(frame).not.toContain('Gamma change');
});

test('Esc during an edit keeps the old chip', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');
  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'author:octo');
  await press('escape');

  expect(composerInputOf(setup.captureCharFrame())).toBe('');

  await press('escape');

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).toContain('author:mona');
  expect(frame).toContain('Gamma change');
  expect(frame).not.toContain('Alpha change');
});

test('Backspace on an empty draft closes the composer', async () => {
  const { setup, press } = await mountFilters();

  await press('f');

  expect(setup.captureCharFrame()).toContain('author');

  await press('backspace');

  const frame = setup.captureCharFrame();

  expect(frame).not.toContain('author');
  expect(frame).toContain('Alpha change');
});

test('F clears all chips', async () => {
  const mounted = await mountFilters();
  const { setup, press } = mounted;

  await addAuthorChip(mounted, 'author:mona');

  expect(setup.captureCharFrame()).not.toContain('Alpha change');

  await press('escape');
  await press('F');

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).not.toContain('author:');
  expect(frame).toContain('Alpha change');
  expect(frame).toContain('Gamma change');
});

test('chips that do not fit collapse into +N more', async () => {
  const mounted = await mountFilters(40);
  const { setup, press, settle } = mounted;

  for (const text of ['author:octo', 'author:mona', 'repo:acme/app']) {
    await press('f');
    await typeText(setup, settle, text);
    await press('return');
    await press('escape');
  }

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toMatch(/\+\d+ more/);
  expect(chipRow).toContain('author:octo');
  expect(chipRow).not.toContain('repo:acme/app');
});

const pressBackspace = async (setup: Setup, settle: () => Promise<void>) => {
  await act(async () => {
    setup.mockInput.pressBackspace();
  });

  await settle();
};

test('Backspace on an empty draft during an edit closes the composer and keeps the chip', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('tab');
  await pressCtrlU(setup, settle);
  await pressBackspace(setup, settle);

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).toContain('author:mona');
  expect(frame).not.toContain('fauthor');
  expect(frame).toContain('Gamma change');

  await press('j');

  expect(composerInputOf(setup.captureCharFrame())).toBeUndefined();
});

test('Esc during an edit cancels the edit and leaves the composer open', async () => {
  const mounted = await mountFilters();
  const { setup, press } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');
  await press('escape');
  await press('j');

  expect(composerInputOf(setup.captureCharFrame())).toBe('j');
});

test('-, f, j, and F typed in the composer go into the draft and run no list command', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await typeText(setup, settle, '-fjF');

  const frame = setup.captureCharFrame();

  expect(composerInputOf(frame)).toBe('-fjF');
  expect(frame.split('\n')[0]).toContain('author:mona');
  expect(frame).not.toContain('Alpha change');
  await press('escape');
});

test('Backspace on a non-empty draft deletes a character and keeps the composer open', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'ab');
  await pressBackspace(setup, settle);

  const frame = setup.captureCharFrame();

  expect(composerInputOf(frame)).toBe('a');

  await typeText(setup, settle, 'u');

  expect(composerInputOf(setup.captureCharFrame())).toBe('au');
});

const manyAuthors = Array.from({ length: 12 }, (_, index) =>
  treeThread(index + 1, `Change ${index + 1}`, { repository: 'acme/app' }),
);

const manyFacts = new Map(
  manyAuthors.map((thread, index) => [
    thread.id as string,
    { state: 'open' as const, author: `user${String(index).padStart(2, '0')}` },
  ]),
);

test('moving the cursor past the last shown candidate scrolls the list', async () => {
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 40);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'author:');

  await press('down');

  const selectedBackground = RGBA.fromHex(pickPalette('dark').selectedBackground).toString();

  const cursorText = (): string | undefined =>
    setup
      .captureSpans()
      .lines.map((line) => line.spans)
      .filter((spans) => spans.some((span) => span.bg.toString() === selectedBackground))
      .map((spans) => spans.map((span) => span.text).join(''))
      .find((text) => text.includes('author:user'));

  const firstCandidate = cursorText()?.match(/author:user\d+/)?.[0];

  for (let step = 0; step < 10; step += 1) {
    await press('down');
  }

  const movedTo = cursorText()?.match(/author:user\d+/)?.[0];
  const candidateLines = setup.captureCharFrame().split('\n');

  const firstStillShown = candidateLines.some(
    (line) => firstCandidate !== undefined && line.includes(firstCandidate),
  );

  expect(firstCandidate).toBeDefined();
  expect(movedTo).toBeDefined();
  expect(movedTo).not.toBe(firstCandidate);
  expect(firstStillShown).toBe(false);
});

test('in a short terminal the composer keeps the input, a candidate, and the status line visible', async () => {
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 9);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'author:');

  const lines = setup.captureCharFrame().split('\n');

  expect(composerInputOf(lines.join('\n'))).toBe('author:');
  expect(lines.at(-2)).toContain('? help');
  expect(lines.some((line) => /author:user00\s+1/.test(line))).toBe(true);
});

test('chips of a field are joined by or only when positive; negated chips stand apart', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'repo:a repo:b -repo:c -repo:d');
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain('repo:a or repo:b');
  expect(chipRow).not.toContain('or -repo');
  expect(chipRow).not.toContain('-repo:c or');
  expect(chipRow).toContain('-repo:c');
  expect(chipRow).toContain('-repo:d');
});

test('positive chips of a field stay joined by or when a negated chip was added between them', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'repo:a -repo:c repo:b');
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain('repo:a or repo:b');
  expect(chipRow).toContain('-repo:c');
  expect(chipRow).not.toContain('or -repo');
});

test('filters that hide every open thread show a no-match notice, not the empty inbox one', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'author:nobody');
  await press('return');
  await press('escape');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('No notifications match');
  expect(frame).not.toContain('No open notifications');
});

test('a search that hides every open thread shows a no-match notice', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('/');
  await typeText(setup, settle, 'zzzzqq');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('No notifications match');
  expect(frame).not.toContain('No open notifications');
});

test('an inbox with no open threads keeps the empty inbox notice', async () => {
  const { setup, press } = await mount('dark', threadsEffects([]));

  await press('r');

  expect(setup.captureCharFrame()).toContain('No open notifications');
});

test('the composer box sits on the top row with no chips and has no prompt', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'ab');

  const lines = setup.captureCharFrame().split('\n');

  expect(lines[0]).toContain('─ Filter ─');
  expect(lines[1]?.startsWith('│ ab')).toBe(true);
});

test('the composer box sits directly under the chip bar', async () => {
  const mounted = await mountFilters();

  await addAuthorChip(mounted, 'author:mona');

  const lines = mounted.setup.captureCharFrame().split('\n');

  expect(lines[0]).toContain('author:mona');
  expect(lines[1]).toContain('─ Filter ─');
});

test('opening the composer leaves the thread rows below the box where they were', async () => {
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 80, false, 30);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();

  const rowOf = (label: string): number =>
    setup
      .captureCharFrame()
      .split('\n')
      .findIndex((line) => line.includes(label));

  const before = rowOf('Change 12');

  await press('f');
  await typeText(setup, settle, 'author:user0');

  expect(before).toBeGreaterThan(0);
  expect(rowOf('Change 12')).toBe(before);

  await press('escape');

  expect(rowOf('Change 12')).toBe(before);
});

test('in a very short terminal Enter applies the row shown under the cursor or nothing', async () => {
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 6);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await press('down');

  const lines = setup.captureCharFrame().split('\n');
  const shown = lines.filter((line) => /^│\s+(✓ )?\S.*\d\s*│$/.test(line));

  expect(shown.length).toBeGreaterThanOrEqual(1);

  const label = shown[0]?.replace(/^│\s*/, '').split(/\s+/)[0] ?? '';

  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain(label);
});

test('in a terminal too short for any candidate row Enter adds nothing', async () => {
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 4);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await press('return');
  await press('escape');

  expect(setup.captureCharFrame().split('\n')[0]).not.toContain('kind:');
});

const burst = async (setup: Setup, keys: string[]) => {
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

test('keys sent in the same burst as f go to the draft and run no list command', async () => {
  const { setup, settle, press, sent } = await mountFilters();

  await press('r');
  sent.length = 0;

  await burst(setup, ['f', 'kind:pr']);
  await settle();

  const kinds = new Set(sent.map((intent) => (intent as { kind: string }).kind));

  expect([...kinds].every((kind) => kind === 'openFilters' || kind === 'editFilterDraft')).toBe(
    true,
  );

  expect(composerInputOf(setup.captureCharFrame())).toBe('kind:pr');
});

test('keys sent in the same burst as / go to the search text and run no list command', async () => {
  const { setup, settle, press, sent } = await mountFilters();

  await press('r');
  sent.length = 0;

  await burst(setup, ['/', 'd']);
  await settle();

  const kinds = new Set(sent.map((intent) => (intent as { kind: string }).kind));

  expect([...kinds].every((kind) => kind === 'openSearch' || kind === 'editSearch')).toBe(true);
  expect(setup.captureCharFrame()).toContain('/d');
});

test('chips of age are joined by and, chips of repo by or', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'age:>7d age:<30d repo:acme/app repo:acme/web');
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain('age:>7d and age:<30d');
  expect(chipRow).toContain('repo:acme/app or repo:acme/web');
});

test('a draft that matches no row shows a No matches row that Enter cannot apply', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'zzzqq');

  expect(setup.captureCharFrame()).toContain('No matches');

  await press('return');
  await press('escape');

  expect(setup.captureCharFrame().split('\n')[0]).not.toContain('zzzqq');
});

test('an empty draft shows the key hints, and a field with a colon shows its value form', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');

  expect(setup.captureCharFrame()).toContain('Enter apply · Tab edit · - exclude · Esc close');

  await typeText(setup, settle, 'kind:');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('pr, issue, release, discussion, commit, or ci');
  expect(frame).not.toContain('Enter apply');
});

test('the box title names the chip being edited', async () => {
  const mounted = await mountFilters();
  const { setup, press } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');

  expect(setup.captureCharFrame()).toContain('Filter · editing author:mona');

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('editing');
});

test('a label wider than the box ends with an ellipsis and keeps the field prefix', async () => {
  const login = 'a'.repeat(70);
  const threads = [treeThread(1, 'Change 1', { repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: login }]]);
  const { setup, press, settle } = await mount('dark', factsEffects(threads, facts), 50);

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'author:');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/author:aaaa+…/);
  expect(frame).not.toContain(login);
});

test.each([
  ['f', 'composer'],
  ['/', 'search'],
] as const)('keys after %s keep shifted letters and spaces as typed', async (opening, input) => {
  kittyKeyboard = true;
  const { setup, settle, press } = await mountFilters();

  await press('r');
  await burst(setup, [opening, 'Fix a bug']);
  await settle();

  const frame = setup.captureCharFrame();

  if (input === 'composer') {
    expect(composerInputOf(frame)).toBe('Fix a bug');
  } else {
    expect(frame).toContain('/Fix a bug');
  }
});

test('f, kind:pr, and Enter in one burst add the kind:pr chip', async () => {
  kittyKeyboard = true;
  const { setup, settle, press } = await mountFilters();

  await press('r');
  await burst(setup, ['f', 'kind:pr', 'return']);
  await settle();

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).toContain('kind:pr');
  expect(composerInputOf(frame)).toBe('');
});

test('f then Esc in one burst closes the composer', async () => {
  kittyKeyboard = true;
  const { setup, settle, press } = await mountFilters();

  await press('r');
  await burst(setup, ['f', 'escape']);
  await settle();

  expect(setup.captureCharFrame()).not.toContain('─ Filter ');
});

test('keys sent in the same burst as Esc on the composer change no filter', async () => {
  kittyKeyboard = true;
  const { setup, settle, press, session } = await mountFilters();

  await press('r');
  await press('f');
  await burst(setup, ['escape', 'da']);
  await settle();

  expect(session.getSnapshot().filterDraft).toBe('');
  expect(session.getSnapshot().filters).toEqual([]);
});

test('keys sent in the same burst as Enter on the search line leave the search text', async () => {
  kittyKeyboard = true;
  const { setup, settle, press, session } = await mountFilters();

  await press('r');
  await press('/');
  await burst(setup, ['Alpha', 'return', 'da']);
  await settle();

  expect(session.getSnapshot().searchText).toBe('Alpha');
});

const innerOf = (line: string | undefined): string => (line ?? '').replace(/^│|│$/g, '').trim();

const descriptionLineOf = (frame: string): string => {
  const lines = frame.split('\n');
  const bottom = lines.findIndex((line) => line.startsWith('╰'));

  return (lines[bottom - 1] ?? '').replace(/^│/, '').replace(/│$/, '').trim();
};

test('the last line of the box describes the selected row, or the field being typed', async () => {
  const threads = [treeThread(1, 'Change 1', { reason: 'ci_activity', repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: 'sQVe' }]]);
  const { setup, press, settle } = await mount('dark', factsEffects(threads, facts), 90, false, 30);

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'reason:ci');

  expect(descriptionLineOf(setup.captureCharFrame())).toBe(
    'A GitHub Actions workflow run that you triggered finished.',
  );

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'author:sQVe');

  expect(descriptionLineOf(setup.captureCharFrame())).toBe(
    'Pull requests and issues opened by sQVe: 1 in your inbox.',
  );
});

test('a description that does not fit ends with an ellipsis', async () => {
  const threads = [treeThread(1, 'Change 1', { reason: 'state_change', repository: 'acme/app' })];
  const { setup, press, settle } = await mount('dark', threadsEffects(threads), 40, false, 30);

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'reason:state_change');

  expect(descriptionLineOf(setup.captureCharFrame())).toMatch(/…$/);
});

test('a draft that is only a partial value shows no No matches row', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'age:>3');

  expect(setup.captureCharFrame()).not.toContain('No matches');
});

test('text typed in the same burst after Enter starts a new draft', async () => {
  const { setup, settle, press, session } = await mountFilters();

  await press('f');
  await burst(setup, ['kind:pr', 'return', 'author:octo']);
  await settle();

  expect(session.getSnapshot().filters).toEqual([{ field: 'kind', value: 'pr', negated: false }]);
  expect(session.getSnapshot().filterDraft).toBe('author:octo');
});

test('text typed in the same burst after Ctrl-U on the search line replaces the old text', async () => {
  const { setup, settle, press, session } = await mountFilters();

  await press('/');
  await burst(setup, ['abc']);

  await act(async () => {
    setup.mockInput.pressKey('u', { ctrl: true });
    setup.mockInput.pressKey('x');
  });

  await settle();

  expect(session.getSnapshot().searchText).toBe('x');
});

test('in a short terminal the description line stays and the key hint row goes', async () => {
  const { setup, press, settle } = await mount(
    'dark',
    factsEffects(filterThreads, filterFacts),
    90,
    false,
    7,
  );

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'repo:');

  const frame = setup.captureCharFrame();

  expect(descriptionLineOf(frame)).not.toBe('');
  expect(frame).not.toContain('owner/name, one * allowed');
});

test('the input line uses the full inner width of the box', async () => {
  const { setup, press, settle } = await mountFilters(100);

  await press('f');
  await typeText(setup, settle, 'x'.repeat(90));

  expect(composerInputOf(setup.captureCharFrame())).toBe('x'.repeat(90));
});

test('with narrow width the chip bar shows the first chip before +N more', async () => {
  const { setup, press, settle } = await mountFilters(30);

  await press('f');
  await typeText(setup, settle, `repo:acme/${'a'.repeat(40)} author:octo author:mona kind:pr`);
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow.startsWith('repo:acme/a')).toBe(true);
  expect(chipRow).toContain('…');
  expect(chipRow).toContain('more');
});

test('a plain-word draft that matches nothing points to the / search', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');
  await typeText(setup, settle, 'zzzqq');

  expect(setup.captureCharFrame()).toContain('Use / to search titles');
});

test('after Enter removes a chip found by typing, a second Enter removes the next chip', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle, session } = mounted;

  await press('f');
  await typeText(setup, settle, 'author:octo');
  await press('return');
  await typeText(setup, settle, 'author:mona');
  await press('return');
  await typeText(setup, settle, 'author:octo');
  await press('return');

  expect(session.getSnapshot().filters).toEqual([
    { field: 'author', value: 'mona', negated: false },
  ]);

  await press('return');

  expect(session.getSnapshot().filters).toEqual([]);
});

test('a long description wraps over several lines and never over more than three', async () => {
  const threads = [treeThread(1, 'Change 1', { reason: 'state_change', repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: 'sQVe' }]]);
  const { setup, press, settle } = await mount('dark', factsEffects(threads, facts), 50, false, 30);

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, '-reason:state_change');

  const lines = setup.captureCharFrame().split('\n');
  const bottom = lines.findIndex((line) => line.startsWith('╰'));
  expect(innerOf(lines[bottom - 3])).toMatch(/^Hides these threads/);
  expect(innerOf(lines[bottom - 2])).not.toBe('');
  expect(innerOf(lines[bottom - 1])).toMatch(/…$/);
  expect(innerOf(lines[bottom - 4])).not.toMatch(/Hides these threads/);
});

test('author:@me shows its own text, and -kind:pr says it hides pull requests', async () => {
  const { setup, press, settle } = await mountFilters(120);

  await press('f');
  await typeText(setup, settle, 'author:@me');

  expect(descriptionLineOf(setup.captureCharFrame())).toContain(
    'Pull requests and issues you opened',
  );

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, '-kind:pr');

  expect(descriptionLineOf(setup.captureCharFrame())).toBe(
    'Hides these threads: Pull requests, drafts included.',
  );
});
