import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import type { SessionEffects } from '../session/session.ts';
import {
  idleEffects,
  makeThread,
  threadsEffects,
  track,
  mount as untrackedMount,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

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
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

  await press('s');
  await failWrite(session, advance);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('disk full');
  expect(frame).not.toContain('unsaved');
});

test('a toast shows its title, reason, and file, each on a row starting with the bar and with no line border', async () => {
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

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
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

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

  const { setup, session, press, advance } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threads),
    manualTime: true,
  });

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

  const { setup, session, press, settle, advance } = await mount({
    themeMode: 'dark',
    effects,
    width: 6,
    manualTime: true,
  });

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
  const { setup, session, press, advance } = await mount({
    themeMode: 'dark',
    width: 9,
    manualTime: true,
  });

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
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

  await press('s');
  await failWrite(session, advance);

  const rows = toastRows(setup.captureCharFrame());

  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]).toContain('✗');
});

test('a toast with a long reason is at most 40 columns wide', async () => {
  const { setup, session, press, advance } = await mount({
    themeMode: 'dark',
    width: 80,
    manualTime: true,
  });

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
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

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
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

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
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

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

  const { setup, session, press, advance } = await mount({
    themeMode: 'dark',
    effects,
    manualTime: true,
  });

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

  const { setup, session, press, advance } = await mount({
    themeMode: 'dark',
    effects,
    manualTime: true,
  });

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

test('a long reason is wrapped once and the path after it stays visible', async () => {
  const { setup, session, advance } = await mount({ themeMode: 'dark', manualTime: true });

  await act(async () => {
    session.reportStateWrite({ ok: false, reason: `${'A'.repeat(45)} ENDPATH`, path: '~/s.json' });
  });

  await advance(0);
  await advance(slideMilliseconds);

  const text = setup
    .captureCharFrame()
    .split('\n')
    .filter((line) => line.includes('▌'))
    .map((line) => line.slice(line.indexOf('▌') + 1))
    .join('')
    .replaceAll(/[\s▁]/g, '');

  expect(text).toContain('notsaved');
  expect(text).toContain('ENDPATH');
  expect(text.split('A'.repeat(45))).toHaveLength(2);
});

test('a toast with a wide reason wraps by cells and keeps its title and the end of the reason', async () => {
  const { setup, session, press, advance } = await mount({ themeMode: 'dark', manualTime: true });

  await press('s');
  await failWrite(session, advance, `${'界'.repeat(20)}END`);

  const rows = setup
    .captureCharFrame()
    .split('\n')
    .filter((row) => row.includes('▌'));

  const text = rows.join('\n');

  expect(text).toContain('✗ Grouping not saved');
  expect(text).toContain('END');
  expect(text).not.toMatch(/\uFFFD|[\uD800-\uDFFF]/u);

  for (const row of rows) {
    const barColumn = row.indexOf('▌');

    expect(Bun.stringWidth(row.slice(barColumn).trimEnd())).toBeLessThanOrEqual(40);
  }
});
