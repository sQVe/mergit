import { afterEach, expect, test } from 'bun:test';

import { RGBA } from '@opentui/core';

import { pickPalette } from './palette.ts';
import type { Setup } from './uiHarness.tsx';
import {
  makeThread,
  threadsEffects,
  typeText,
  track,
  mountFilters as untrackedMountFilters,
  mount as untrackedMount,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mountFilters = track(cleanups, untrackedMountFilters);

const mount = track(cleanups, untrackedMount);

test('an empty inbox shows its notice, and loading shows before the first refresh', async () => {
  const { setup, press } = await mount();

  expect(setup.captureCharFrame()).toContain('Loading notifications');
  expect(setup.captureCharFrame()).not.toContain('No open notifications');

  await press('r');

  expect(setup.captureCharFrame()).toContain('No open notifications');
});

const noticeColorOf = (setup: Setup, text: string): string | undefined => {
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);

  return spans.find((span) => span.text.includes(text))?.fg.toString();
};

test('the loading notice is dim, and the empty inbox notice uses the text color', async () => {
  const palette = pickPalette('dark');
  const { setup, press } = await mount({ themeMode: 'dark' });

  expect(noticeColorOf(setup, 'Loading notifications')).toBe(RGBA.fromHex(palette.dim).toString());

  await press('r');

  expect(noticeColorOf(setup, 'No open notifications')).toBe(RGBA.fromHex(palette.text).toString());
});

test('marking the only thread done shows the empty inbox notice', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects([makeThread(1, 'Only thread')]),
  });

  await press('r');
  await press('j');
  await press('j');
  await press('d');

  expect(setup.captureCharFrame()).toContain('No open notifications');
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
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects([]) });

  await press('r');

  expect(setup.captureCharFrame()).toContain('No open notifications');
});
