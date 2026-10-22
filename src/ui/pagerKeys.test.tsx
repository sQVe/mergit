import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import { catalog } from '../commands.ts';
import { helpWindowOf } from './helpWindow.ts';
import { messageWindowOf } from './messageWindow.ts';
import type { MountedApp } from './uiHarness.tsx';
import { burst, pressAll, track, typeText, mount as untrackedMount } from './uiHarness.tsx';

interface Overlay {
  name: string;
  height: number;
  open: (mounted: MountedApp) => Promise<void>;
  windowOf: (
    mounted: MountedApp,
    height: number,
  ) => { total: number; viewportRows: number; maximumTop: number };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const width = 80;

const openHelp = async (mounted: MountedApp) => {
  await mounted.press('?');
};

const openMessages = async (mounted: MountedApp) => {
  await mounted.press(':');
  await typeText(mounted.setup, mounted.settle, 'messages');
  await mounted.press('return');
};

const fillMessages = async (mounted: MountedApp) => {
  for (let index = 0; index < 40; index += 1) {
    await burst(mounted.setup, [':', `unknown${index}`, 'return']);
  }

  await mounted.settle();
};

const overlays: Overlay[] = [
  {
    name: 'help',
    height: 24,
    open: openHelp,
    windowOf: (_mounted, height) => {
      const window = helpWindowOf(catalog, height, width);

      return { total: window.lines.length, ...window };
    },
  },
  {
    name: 'messages',
    height: 14,
    open: async (mounted) => {
      await fillMessages(mounted);
      await openMessages(mounted);
    },
    windowOf: (mounted, height) => {
      const { messages } = mounted.session.getSnapshot();
      const window = messageWindowOf(messages, width, height);

      return { total: window.rows.length, ...window };
    },
  },
];

const positionOf = (mounted: MountedApp): string =>
  /\d+-\d+ of \d+/.exec(mounted.setup.captureCharFrame())?.[0] ?? 'no position';

const pressCtrl = async (mounted: MountedApp, letter: string) => {
  await act(async () => {
    mounted.setup.mockInput.pressKey(letter, { ctrl: true });
  });

  await mounted.settle();
};

const mountOpen = async (overlay: Overlay) => {
  const mounted = await mount({ themeMode: 'dark', width, height: overlay.height });
  await overlay.open(mounted);

  const window = overlay.windowOf(mounted, overlay.height);

  expect(window.maximumTop).toBeGreaterThanOrEqual(window.viewportRows);

  const positionAt = (top: number): string =>
    `${top + 1}-${top + window.viewportRows} of ${window.total}`;

  return { mounted, window, positionAt };
};

const half = (viewportRows: number): number => Math.max(1, Math.floor(viewportRows / 2));

for (const overlay of overlays) {
  const pagerTest = (
    name: string,
    run: (opened: Awaited<ReturnType<typeof mountOpen>>) => Promise<void>,
  ) => {
    test(`${overlay.name}: ${name}`, async () => {
      await run(await mountOpen(overlay));
    });
  };

  pagerTest('G shows the last line', async ({ mounted, window, positionAt }) => {
    await mounted.press('G');

    expect(positionOf(mounted)).toBe(positionAt(window.maximumTop));
  });

  pagerTest('j moves one line down', async ({ mounted, positionAt }) => {
    await mounted.press('j');

    expect(positionOf(mounted)).toBe(positionAt(1));
  });

  pagerTest('k moves one line up', async ({ mounted, window, positionAt }) => {
    await mounted.press('G');
    await mounted.press('k');

    expect(positionOf(mounted)).toBe(positionAt(window.maximumTop - 1));
  });

  pagerTest('Ctrl+d moves half a page down', async ({ mounted, window, positionAt }) => {
    await pressCtrl(mounted, 'd');

    expect(positionOf(mounted)).toBe(positionAt(half(window.viewportRows)));
  });

  pagerTest('Ctrl+u moves half a page up', async ({ mounted, window, positionAt }) => {
    await mounted.press('G');
    await pressCtrl(mounted, 'u');

    expect(positionOf(mounted)).toBe(positionAt(window.maximumTop - half(window.viewportRows)));
  });

  pagerTest('Ctrl+f moves a full page down', async ({ mounted, window, positionAt }) => {
    await pressCtrl(mounted, 'f');

    expect(positionOf(mounted)).toBe(positionAt(window.viewportRows));
  });

  pagerTest('Ctrl+b moves a full page up', async ({ mounted, window, positionAt }) => {
    await mounted.press('G');
    await pressCtrl(mounted, 'b');

    expect(positionOf(mounted)).toBe(positionAt(window.maximumTop - window.viewportRows));
  });

  pagerTest('gg shows the first line', async ({ mounted, positionAt }) => {
    await mounted.press('G');
    await pressAll(mounted.press, ['g', 'g']);

    expect(positionOf(mounted)).toBe(positionAt(0));
  });

  test(`${overlay.name}: q closes it without quitting, also after a resize`, async () => {
    const { mounted } = await mountOpen(overlay);

    await mounted.press('q');

    expect(positionOf(mounted)).toBe('no position');
    expect(mounted.terminalIntents).toEqual([]);

    await mounted.resize(width, overlay.height + 2);
    await overlay.open(mounted);

    expect(positionOf(mounted)).not.toBe('no position');

    await mounted.press('q');

    expect(positionOf(mounted)).toBe('no position');
    expect(mounted.terminalIntents).toEqual([]);
  });

  test(`${overlay.name}: Ctrl+C quits`, async () => {
    const { mounted } = await mountOpen(overlay);

    await pressCtrl(mounted, 'c');

    expect(mounted.terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  });
}

test('a list count survives an unrelated render between the count and the key', async () => {
  const mounted = await mount({ themeMode: 'dark', width, height: 24 });

  await mounted.press('5');
  await mounted.changeTheme('light');
  await mounted.press('j');

  expect(mounted.sent).toEqual([{ kind: 'selectNext', count: 5 }]);
});

test('help gg survives an unrelated render between the two g strokes', async () => {
  const mounted = await mount({ themeMode: 'dark', width, height: 24 });

  await mounted.press('?');
  await mounted.press('G');
  await mounted.press('g');
  await mounted.changeTheme('light');
  await mounted.press('g');

  const window = helpWindowOf(catalog, 24, width);

  expect(positionOf(mounted)).toBe(`1-${window.viewportRows} of ${window.lines.length}`);
});
