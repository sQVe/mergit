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

const rowOf = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

test(':messages lists the shown toasts newest first, each with its time and tone', async () => {
  calls = 0;

  const mounted = await mount('dark', effects, 80, false, 30);

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

  const mounted = await mount('dark', effects, 80, false, 30);

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

  const mounted = await mount('dark', effects, 80, false, 30);

  await openMessages(mounted);

  expect(mounted.setup.captureCharFrame()).toContain('No messages yet');

  await mounted.press('escape');

  expect(mounted.setup.captureCharFrame()).not.toContain('No messages yet');
});

test('the overlay shows only the newest messages that fit the terminal height', async () => {
  calls = 0;

  const mounted = await mount('dark', effects, 80, false, 6);

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

  const mounted = await mount('dark', effects, 80, false, 6);

  await sendUnknownCommands(mounted, names);
  await openMessages(mounted);

  expect(mounted.setup.captureCharFrame()).not.toContain('Unknown command: aaa');

  for (let index = 0; index < 5; index += 1) {
    await mounted.press('j');
  }

  const frame = mounted.setup.captureCharFrame();

  expect(frame).toContain('Unknown command: aaa');
  expect(frame).not.toContain('Unknown command: fff');
});

test('scrolling stops at the first and the last message', async () => {
  calls = 0;

  const mounted = await mount('dark', effects, 80, false, 6);

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

  const mounted = await mount('dark', effects, 80, false, 6);

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

  const mounted = await mount('dark', sameTime, 80, false, 24);

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

  const mounted = await mount('dark', effects, 80, false, 12);

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

  const mounted = await mount('dark', effects, 40, false, 8);

  await sendUnknownCommands(mounted, [`${'long'.repeat(60)}ENDMARKER`]);
  await openMessages(mounted);

  const first = mounted.setup.captureCharFrame();

  expect(first).toMatch(/\d\d:\d\d:\d\d\s+error/);
  expect(first).not.toContain('ENDMARKER');

  for (let index = 0; index < 20; index += 1) {
    await mounted.press('j');
  }

  const last = mounted.setup.captureCharFrame();

  expect(last).toContain('ENDMARKER');

  for (let index = 0; index < 20; index += 1) {
    await mounted.press('k');
  }

  expect(mounted.setup.captureCharFrame()).toBe(first);
});

test('a message of wide characters wraps by cell width and scrolling reaches its end', async () => {
  calls = 0;

  const mounted = await mount('dark', effects, 40, false, 8);

  await sendUnknownCommands(mounted, [`${'界'.repeat(60)}ENDMARKER`]);
  await openMessages(mounted);

  for (let index = 0; index < 30; index += 1) {
    await mounted.press('j');
  }

  expect(mounted.setup.captureCharFrame()).toContain('ENDMARKER');
});

test('a message with line breaks shows each line as its own row and scrolling reaches the last', async () => {
  const details = ['first detail', ...Array.from({ length: 10 }, (_, index) => `detail ${index}`)];

  const mounted = await mount(
    'dark',
    {
      ...effects,
      openInBrowser: () =>
        Promise.resolve({ ok: false, message: [...details, 'ENDMARKER'].join('\r\n') }),
    },
    80,
    false,
    8,
  );

  await mounted.press('r');
  await mounted.press('o');
  await openMessages(mounted);

  for (let index = 0; index < 20; index += 1) {
    await mounted.press('j');
  }

  expect(mounted.setup.captureCharFrame()).toContain('ENDMARKER');
});
