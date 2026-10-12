import { afterEach, expect, test } from 'bun:test';

import { RGBA } from '@opentui/core';
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
import { pickPalette } from './palette.ts';
import { App } from './ui.tsx';
import type { AppProps } from './ui.tsx';

type Setup = Awaited<ReturnType<typeof testRender>>;

type ReadFailure = Extract<Awaited<ReturnType<SessionEffects['readFeed']>>, { ok: false }>;

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const idleEffects: SessionEffects = {
  savedSnapshot: null,
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

afterEach(() => {
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

  const setup = await act(() => testRender(node, { width, height: 20 }));

  setups.push(setup);

  const settle = () =>
    act(async () => {
      await Bun.sleep(50);
      await setup.renderOnce();
    });

  const press = async (key: string) => {
    await act(async () => {
      if (key === 'escape') {
        setup.mockInput.pressEscape();
      } else if (key === 'return') {
        setup.mockInput.pressEnter();
      } else {
        setup.mockInput.pressKey(key);
      }
    });

    await settle();
    await settle();
  };

  await settle();

  return {
    setup,
    press,
    settle,
    changeTheme,
    terminalIntents,
    sent,
    subscriberCount: () => sessionSubscribers,
  };
};

test('? opens the overlay with every command label and ? closes it', async () => {
  const { setup, press } = await mount();

  await press('?');

  const open = setup.captureCharFrame();

  for (const command of catalog) {
    expect(open).toContain(command.label);
  }

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
  const { setup, press } = await mount();

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Close help');
});

test('the overlay lists the close help command from the catalog', async () => {
  const { setup, press } = await mount();

  await press('?');

  expect(setup.captureCharFrame()).toContain('Close help');
});

test('a theme change keeps the overlay open, recolors it, and adds no subscriber', async () => {
  const { setup, press, settle, changeTheme, subscriberCount } = await mount('dark');

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
  expect(lines[2]).toMatch(/^│ │ ├─PR\s+#1\s+Fix parser\s+2h$/);
  expect(lines[3]).toMatch(/^│ │ └─PR\s+#2\s+Add cache\s+2h$/);
  expect(lines[4]).toMatch(/^▾ Mention 2$/);
  expect(lines[5]).toMatch(/^│ ▾ example\/beta 2$/);
  expect(lines[6]).toMatch(/^│ │ ├─ISS\s+#3\s+Crash on start\s+2h$/);
  expect(lines[7]).toMatch(/^│ │ └─ISS\s+#5\s+Stale crash\s+2h$/);
  expect(lines[8]).toMatch(/^▾ Release 1$/);
  expect(lines[9]).toMatch(/^│ ▾ example\/beta 1$/);
  expect(lines[10]).toMatch(/^│ │ └─REL\s+Release v1\s+2h$/);
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

  expect(ungrouped.filter((line) => /^(PR|ISS|REL)\s/.test(line))).toHaveLength(treeThreads.length);
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

  expect(lines[0]).toMatch(/^PR\s+#1\s+example\/alpha\s+Fix parser\s+2h$/);
  expect(lines[1]).toMatch(/^PR\s+#2\s+example\/alpha\s+Add cache\s+2h$/);
  expect(lines[2]).toMatch(/^ISS\s+#3\s+example\/beta\s+Crash on start\s+2h$/);
  expect(lines[3]).toMatch(/^REL\s+example\/beta\s+Release v1\s+2h$/);
  expect(lines[4]).toMatch(/^ISS\s+#5\s+example\/beta\s+Stale crash\s+2h$/);

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

  expect(frameLines(setup)[0]).toMatch(/^PR\s+#1\s+example\/a-valid.*…\s+Fix parser\s+\d+h$/);
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

test('Enter folds a group and does nothing on a thread', async () => {
  const { setup, press } = await mount('dark', threadsEffects(treeThreads));

  await pressAll(press, ['r', 'return']);

  expect(frameLines(setup)[0]).toBe('▸ Review requested 2');
  expect(setup.captureCharFrame()).not.toContain('Fix parser');

  await press('return');

  expect(frameLines(setup)[0]).toBe('▾ Review requested 2');

  await pressAll(press, ['j', 'j', 'return']);

  expect(selectedLine(setup)).toContain('Fix parser');
  expect(setup.captureCharFrame()).toContain('Add cache');
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
