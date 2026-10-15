import { afterEach, expect, test } from 'bun:test';

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

test('marking the only thread done shows the empty inbox notice', async () => {
  const { setup, press } = await mount('dark', threadsEffects([makeThread(1, 'Only thread')]));

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
  const { setup, press } = await mount('dark', threadsEffects([]));

  await press('r');

  expect(setup.captureCharFrame()).toContain('No open notifications');
});
