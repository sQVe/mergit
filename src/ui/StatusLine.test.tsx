import { afterEach, expect, test } from 'bun:test';

import type { SessionEffects } from '../session/session.ts';
import {
  idleEffects,
  feedEffects,
  threadsEffects,
  colorOf,
  statusLineColor,
  threeThreads,
  savedEffects,
  pressAll,
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

test('the status line shows ? help', async () => {
  const { setup } = await mount();

  expect(setup.captureCharFrame()).toContain('? help');
});

test('the status line color follows the theme mode, and dark when it is unknown', async () => {
  const light = await mount('light');
  const dark = await mount('dark');
  const unknown = await mount(null);

  expect(statusLineColor(light.setup)).toBe(colorOf('light'));
  expect(statusLineColor(dark.setup)).toBe(colorOf('dark'));
  expect(statusLineColor(unknown.setup)).toBe(colorOf('dark'));
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

test('the status line shows the age of the saved list, and not without one', async () => {
  const savedAt = new Date(Date.now() - 3 * 3_600_000);
  const saved = await mount('dark', savedEffects(savedAt, threeThreads));
  const fresh = await mount('dark', threadsEffects(threeThreads));

  expect(saved.setup.captureCharFrame()).toContain('saved 3h ago');
  expect(fresh.setup.captureCharFrame()).not.toContain('saved');
});

test('the status line shows the state warning', async () => {
  const { setup } = await mount('dark', { ...idleEffects, stateWarning: 'state file is invalid' });

  expect(setup.captureCharFrame()).toContain('state file is invalid');
});

test('the status line stays on the last row in the full-width detail', async () => {
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j', 'return']);

  const rows = setup.captureCharFrame().split('\n');

  expect(rows.join('\n')).not.toContain('Third');
  expect(rows.findIndex((row) => row.includes('? help'))).toBe(rows.length - 2);
});
