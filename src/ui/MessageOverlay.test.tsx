import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import type { SessionEffects } from '../session/session.ts';
import {
  makeThread,
  threadsEffects,
  track,
  typeText,
  mount as untrackedMount,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const timers: (() => void)[] = [];
const times = [new Date(2026, 0, 1, 9, 5, 7), new Date(2026, 0, 1, 9, 6, 8)];
let calls = 0;

const effects: SessionEffects = {
  ...threadsEffects([makeThread(1, 'Only thread')]),
  now: () => {
    const time = times[Math.min(calls, times.length - 1)] ?? new Date(0);

    calls += 1;

    return time;
  },
  setTimer: (_delay, callback) => {
    timers.push(callback);

    return () => undefined;
  },
};

const showTwoToasts = async (mounted: Awaited<ReturnType<typeof mount>>) => {
  const { setup, press, settle } = mounted;

  await press('r');
  await press('j');
  await press('j');
  await press('d');
  await press(':');
  await typeText(setup, settle, 'nope');
  await press('return');
};

const openMessages = async (mounted: Awaited<ReturnType<typeof mount>>) => {
  const { setup, press, settle } = mounted;

  await press(':');
  await typeText(setup, settle, 'messages');
  await press('return');
};

const pressMany = async (
  mounted: Awaited<ReturnType<typeof mount>>,
  key: string,
  repeats: number,
) => {
  await act(async () => {
    for (let index = 0; index < repeats; index += 1) {
      mounted.setup.mockInput.pressKey(key);
    }
  });

  await mounted.settle();
};

const rowOf = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

test(':messages lists the shown toasts newest first, each with its time and tone', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 30 });

  await showTwoToasts(mounted);
  await openMessages(mounted);

  const frame = mounted.setup.captureCharFrame();
  const newer = rowOf(frame, 'Unknown command: nope');
  const older = rowOf(frame, 'Marked Only thread done');

  expect(newer).toMatch(/\d\d:\d\d:\d\d\s+error/);
  expect(older).toMatch(/\d\d:\d\d:\d\d\s+info/);

  expect(frame.indexOf('Unknown command: nope')).toBeLessThan(
    frame.indexOf('Marked Only thread done'),
  );

  expect(frame).toContain('You can undo for 5 seconds');
});

test(':messages still lists toasts that already cleared', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 30 });

  await showTwoToasts(mounted);

  await act(async () => {
    for (const fire of timers.splice(0)) {
      fire();
    }
  });

  await mounted.settle();
  await openMessages(mounted);

  const frame = mounted.setup.captureCharFrame();

  expect(frame).toContain('Unknown command: nope');
  expect(frame).toContain('Marked Only thread done');
});

test('Esc closes the message overlay', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 30 });

  await openMessages(mounted);

  expect(mounted.setup.captureCharFrame()).toContain('No messages yet');

  await mounted.press('escape');

  expect(mounted.setup.captureCharFrame()).not.toContain('No messages yet');
});

test('the overlay shows only the newest messages that fit the terminal height', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 6 });

  for (const name of ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff']) {
    await mounted.press(':');
    await typeText(mounted.setup, mounted.settle, name);
    await mounted.press('return');
  }

  await openMessages(mounted);

  const frame = mounted.setup.captureCharFrame();

  expect(frame).toContain('Unknown command: fff');
  expect(frame).not.toContain('Unknown command: aaa');
});

const sendUnknownCommands = async (
  mounted: Awaited<ReturnType<typeof mount>>,
  names: readonly string[],
) => {
  for (const name of names) {
    await mounted.press(':');
    await typeText(mounted.setup, mounted.settle, name);
    await mounted.press('return');
  }
};

const names = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff'];

test('j scrolls the overlay to an older message that was out of view', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 6 });

  await sendUnknownCommands(mounted, names);
  await openMessages(mounted);

  expect(mounted.setup.captureCharFrame()).not.toContain('Unknown command: aaa');

  await pressMany(mounted, 'j', 5);

  const frame = mounted.setup.captureCharFrame();

  expect(frame).toContain('Unknown command: aaa');
  expect(frame).not.toContain('Unknown command: fff');
});

test('scrolling stops at the first and the last message', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 6 });

  await sendUnknownCommands(mounted, names);
  await openMessages(mounted);

  const top = mounted.setup.captureCharFrame();

  await mounted.press('k');
  await mounted.press('up');

  expect(mounted.setup.captureCharFrame()).toBe(top);

  for (let index = 0; index < 10; index += 1) {
    await mounted.press('down');
  }

  const bottom = mounted.setup.captureCharFrame();

  expect(bottom).toContain('Unknown command: aaa');

  await mounted.press('j');

  expect(mounted.setup.captureCharFrame()).toBe(bottom);

  await mounted.press('k');

  expect(mounted.setup.captureCharFrame()).not.toBe(bottom);
});

test('the overlay shows its position when the list overflows', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 6 });

  await sendUnknownCommands(mounted, names);
  await openMessages(mounted);

  expect(mounted.setup.captureCharFrame()).toContain('1-3 of 6');
});

test('two toasts with the same title shown at the same time stay separate rows when a new message arrives', async () => {
  const pending: { finish: (outcome: { ok: false; message: string }) => void } = {
    finish: () => undefined,
  };

  const sameTime: SessionEffects = {
    ...effects,
    now: () => new Date(2026, 0, 1, 9, 0, 0),
    openInBrowser: () =>
      new Promise((resolve) => {
        pending.finish = resolve;
      }),
  };

  const mounted = await mount({ themeMode: 'dark', effects: sameTime, width: 80 });

  await mounted.press('r');
  await mounted.press('o');

  await act(async () => {
    for (const character of ':foo\n:foo\n:messages\n') {
      if (character === '\n') {
        mounted.setup.mockInput.pressEnter();
      } else {
        mounted.setup.mockInput.pressKey(character);
      }
    }
  });

  await mounted.settle();

  await act(async () => {
    pending.finish({ ok: false, message: 'browser failed' });
  });

  await mounted.settle();

  const frame = mounted.setup.captureCharFrame();
  const unknownRows = frame.split('\n').filter((line) => line.includes('Unknown command: foo'));

  expect(unknownRows).toHaveLength(2);
  expect(frame.indexOf('browser failed')).toBeLessThan(frame.indexOf('Unknown command: foo'));
});

test('? over the messages overlay closes it and j then scrolls help', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 12 });

  await openMessages(mounted);
  await mounted.press('?');
  await mounted.press('j');

  const frame = mounted.setup.captureCharFrame();

  expect(frame).toContain('Help');
  expect(frame).toContain('2-');
  expect(frame).not.toContain('Messages');
});

test('a long message wraps in a narrow terminal and scrolling reaches its end', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 40, height: 8 });

  await sendUnknownCommands(mounted, [`${'long'.repeat(60)}ENDMARKER`]);
  await openMessages(mounted);

  const first = mounted.setup.captureCharFrame();

  expect(first).toMatch(/\d\d:\d\d:\d\d\s+error/);
  expect(first).not.toContain('ENDMARKER');

  await pressMany(mounted, 'j', 20);

  const last = mounted.setup.captureCharFrame();

  expect(last).toContain('ENDMARKER');

  await pressMany(mounted, 'k', 20);

  expect(mounted.setup.captureCharFrame()).toBe(first);
});

test('a message of wide characters wraps by cell width and scrolling reaches its end', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 40, height: 8 });

  await sendUnknownCommands(mounted, [`${'界'.repeat(55)}ENDMARKER`]);
  await openMessages(mounted);

  await pressMany(mounted, 'j', 30);

  expect(mounted.setup.captureCharFrame()).toContain('ENDMARKER');
});

test('a message with line breaks shows each line as its own row and scrolling reaches the last', async () => {
  const details = ['first detail', ...Array.from({ length: 10 }, (_, index) => `detail ${index}`)];

  const mounted = await mount({
    themeMode: 'dark',
    effects: {
      ...effects,
      openInBrowser: () =>
        Promise.resolve({ ok: false, message: [...details, 'ENDMARKER'].join('\r\n') }),
    },
    width: 80,
    height: 8,
  });

  await mounted.press('r');
  await mounted.press('o');
  await openMessages(mounted);

  await pressMany(mounted, 'j', 20);

  expect(mounted.setup.captureCharFrame()).toContain('ENDMARKER');
});

test('the empty messages overlay at 80x24 is a readable box with nothing from the list beside it', async () => {
  const threads = Array.from({ length: 30 }, (_, index) =>
    makeThread(index + 1, `Thread ${index + 1}`),
  );

  const mounted = await mount({ themeMode: 'dark', effects: threadsEffects(threads), width: 80 });

  await mounted.press('r');
  await openMessages(mounted);

  const lines = mounted.setup.captureCharFrame().split('\n');
  const bottom = lines.findIndex((line) => line.includes('╰'));
  const boxRows = lines.slice(0, bottom + 1);

  expect(bottom).toBe(23);

  for (const row of boxRows) {
    expect(row.startsWith('╭') || row.startsWith('│') || row.startsWith('╰')).toBe(true);
    expect(row.trimEnd().length).toBe(80);
  }

  for (const row of lines.slice(2, bottom)) {
    expect(row.slice(1, 79).trim()).toBe('');
  }
});

test('a list that exactly fills the box shows no position and one row more shows it', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 4 });

  await sendUnknownCommands(mounted, ['aaa', 'bbb']);
  await openMessages(mounted);

  const exact = mounted.setup.captureCharFrame();

  expect(exact).toContain('Unknown command: bbb');
  expect(exact).toContain('Unknown command: aaa');
  expect(exact).not.toMatch(/\d+-\d+ of \d+/);

  await mounted.press('escape');
  await sendUnknownCommands(mounted, ['ccc']);
  await openMessages(mounted);

  const over = mounted.setup.captureCharFrame();

  expect(over).toMatch(/│ 1-1 of 3\s+│/);
  expect(over).toContain('Unknown command: ccc');
  expect(over).not.toContain('Unknown command: aaa');
});

test('the overlay says No messages yet only while there are no messages', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 80, height: 12 });

  await openMessages(mounted);

  expect(mounted.setup.captureCharFrame()).toContain('No messages yet');

  await mounted.press('escape');
  await sendUnknownCommands(mounted, ['aaa']);
  await openMessages(mounted);

  const frame = mounted.setup.captureCharFrame();

  expect(frame).toContain('Unknown command: aaa');
  expect(frame).not.toContain('No messages yet');
});

test('a wrapped title shows its time and tone on the first row only', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 40, height: 12 });

  await sendUnknownCommands(mounted, [`${'long'.repeat(20)}ENDMARKER`]);
  await openMessages(mounted);

  const frame = mounted.setup.captureCharFrame();
  const rows = frame.split('\n').filter((line) => /long|ENDMARKER/.test(line));

  expect(rows.length).toBeGreaterThan(1);
  expect(frame.match(/\d\d:\d\d:\d\d/g)).toHaveLength(1);
  expect(frame.match(/error/g)).toHaveLength(1);
  expect(rows[0]).toMatch(/\d\d:\d\d:\d\d\s+error/);
  expect(rows[1]).not.toMatch(/\d\d:\d\d:\d\d|error/);
});

test('a character wider than the box column gets its own row with no empty row before it', async () => {
  calls = 0;

  const mounted = await mount({ themeMode: 'dark', effects, width: 20, height: 40 });

  await sendUnknownCommands(mounted, ['界']);
  await openMessages(mounted);

  const inner = mounted.setup
    .captureCharFrame()
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^│/, '').replace(/│$/, '').trim());

  expect(inner[0]).toMatch(/U$/);
  expect(inner[15]).toBe(':');
  expect(inner[17]).toBe('界');
  expect(inner[18]).toBe('');
});

test('a detail line that starts with a wide character gets no empty row before it', async () => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: {
      ...effects,
      openInBrowser: () => Promise.resolve({ ok: false, message: 'head\r\n界' }),
    },
    width: 20,
    height: 70,
  });

  await mounted.press('r');
  await mounted.press('o');
  await openMessages(mounted);

  const lines = mounted.setup.captureCharFrame().split('\n');
  const wideIndex = lines.findIndex((line) => line.includes('界'));

  expect(wideIndex).toBeGreaterThan(0);
  expect(lines[wideIndex - 1]).toMatch(/│\s+d\s+│/);
});
