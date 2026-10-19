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

const startupWarning = {
  reason: 'The file is not valid JSON.',
  path: '~/.local/state/zeta/state.json',
};

const statusRowOf = (frame: string) => {
  const row = frame.split('\n').find((line) => line.includes('? help'));

  if (row === undefined) {
    throw new Error('no status row');
  }

  return row;
};

test('the status line keeps every item whole at 80 columns with a state warning', async () => {
  const { setup, press } = await mount(
    'dark',
    {
      ...savedEffects(new Date(), threeThreads),
      readFeed: () => new Promise(() => {}),
      stateWarning: startupWarning,
    },
    80,
    false,
    24,
  );

  await press('r');

  const row = statusRowOf(setup.captureCharFrame());

  expect(row).toContain('saved 0m ago');
  expect(row).toContain('refreshing...');
  expect(row).toContain('state not saved');
  expect(row).not.toContain('Zeta will not save');
});

test('the status line names the key r in full at 80 columns when gh is missing and rows are shown', async () => {
  const effects: SessionEffects = {
    ...savedEffects(new Date(), threeThreads),
    readViewer: idleEffects.readViewer,
    readFeed: feedEffects(() => ({ ok: false as const, failure: { kind: 'ghMissing' as const } }))
      .readFeed,
  };

  const { setup, press } = await mount('dark', effects, 80, false, 24);

  await press('r');

  const row = statusRowOf(setup.captureCharFrame());

  expect(row).toContain('press r');
  expect(row).toContain('saved');
});

test('the status line stays on the last row in the full-width detail', async () => {
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j', 'return']);

  const rows = setup.captureCharFrame().split('\n');

  expect(rows.join('\n')).not.toContain('Third');
  expect(rows.findIndex((row) => row.includes('? help'))).toBe(rows.length - 2);
});

test('the status line keeps the state warning whole when the feed is busy and a refresh runs at 80 columns', async () => {
  let hang = false;

  const effects: SessionEffects = {
    ...savedEffects(new Date(), threeThreads),
    ...threadsEffects(threeThreads),
    savedSnapshot: savedEffects(new Date(), threeThreads).savedSnapshot,
    stateWarning: startupWarning,
    verifyFeed: () =>
      Promise.resolve({
        ok: true as const,
        value: { kind: 'changed' as const, pollInterval: null },
      }),
    readFeed: () => {
      if (hang) {
        return new Promise(() => {});
      }

      return Promise.resolve({
        ok: true as const,
        value: { feed: { pages: [] }, threads: [...threeThreads], pollInterval: null },
      });
    },
  };

  const { setup, press } = await mount('dark', effects, 80, false, 24);

  await press('r');
  hang = true;
  await press('r');

  const row = statusRowOf(setup.captureCharFrame());

  expect(row).toContain('saved 0m ago');
  expect(row).toContain('refreshing...');
  expect(row).toContain('state not saved');
  expect(row).toContain('feed busy');
});

test('a gh missing toast shows the install text and the key r at 80x24 with rows on screen', async () => {
  const effects: SessionEffects = {
    ...savedEffects(new Date(), threeThreads),
    readViewer: idleEffects.readViewer,
    readFeed: feedEffects(() => ({ ok: false as const, failure: { kind: 'ghMissing' as const } }))
      .readFeed,
  };

  const { setup, press, settle } = await mount('dark', effects, 80, false, 24);

  await press('r');
  await settle();

  const toastRows = setup
    .captureCharFrame()
    .split('\n')
    .filter((line) => line.includes('▌'));

  const toastText = toastRows.join('').replace(/[▌\s]+/g, '');

  expect(toastText).toContain('InstallGitHubCLI');
  expect(toastText).toContain('thenpressr');
});

test('the status line shows refreshing... while a refresh runs and drops it when the refresh ends', async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
  const base = threadsEffects(threeThreads);

  const effects: SessionEffects = {
    ...base,
    readFeed: async (request, signal) => {
      await gate;

      return base.readFeed(request, signal);
    },
  };

  const { setup, press, settle } = await mount('dark', effects);

  expect(setup.captureCharFrame()).not.toContain('refreshing...');

  await press('r');

  expect(setup.captureCharFrame()).toContain('refreshing...');

  release(undefined);
  await settle();

  expect(setup.captureCharFrame()).not.toContain('refreshing...');
  expect(setup.captureCharFrame()).toContain('First');
});

test('the status line leaves the notice to the screen body when no rows are shown', async () => {
  const effects: SessionEffects = {
    ...idleEffects,
    readFeed: feedEffects(() => ({ ok: false as const, failure: { kind: 'ghMissing' as const } }))
      .readFeed,
  };

  const { setup, press } = await mount('dark', effects, 80, false, 24);

  await press('r');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Install GitHub CLI');
  expect(statusRowOf(frame)).not.toContain('press r');
});

const busyStatusRowAt = async (width: number): Promise<string> => {
  let hang = false;

  const effects: SessionEffects = {
    ...savedEffects(new Date(), threeThreads),
    ...threadsEffects(threeThreads),
    savedSnapshot: savedEffects(new Date(), threeThreads).savedSnapshot,
    verifyFeed: () =>
      Promise.resolve({
        ok: true as const,
        value: { kind: 'changed' as const, pollInterval: null },
      }),
    readFeed: () => {
      if (hang) {
        return new Promise(() => {});
      }

      return Promise.resolve({
        ok: true as const,
        value: { feed: { pages: [] }, threads: [...threeThreads], pollInterval: null },
      });
    },
  };

  const { setup, press } = await mount('dark', effects, width, false, 24);

  await press('r');
  hang = true;
  await press('r');

  return statusRowOf(setup.captureCharFrame()).trimEnd();
};

// At the exact width the row needs, any extra gap cuts off the last segment.
test('the status line adds no gap for a warning, a marker, or an error that is absent', async () => {
  const wideRow = await busyStatusRowAt(120);
  const exactRow = await busyStatusRowAt(wideRow.length + 1);
  const wideGaps = wideRow.match(/ {3,}/g);

  expect(exactRow).toBe(wideRow);
  expect(wideGaps).toBeNull();
});
