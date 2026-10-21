import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import { catalog } from '../commands.ts';
import {
  colorOf,
  factsEffects,
  idleEffects,
  feedEffects,
  filterFacts,
  filterThreads,
  fourRepoThreads,
  mount as untrackedMount,
  savedEffects,
  threeThreads,
  track,
  typeText,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const without = (ids: readonly string[]) =>
  catalog.map((command) =>
    Object.assign({}, command, { keys: ids.includes(command.id) ? [] : command.keys }),
  );

const ghMissingEffects = {
  ...savedEffects(new Date(), threeThreads),
  readViewer: idleEffects.readViewer,
  readFeed: feedEffects(() => ({ ok: false as const, failure: { kind: 'ghMissing' as const } }))
    .readFeed,
};

const statusRowOf = (frame: string): string =>
  frame
    .split('\n')
    .toReversed()
    .find((line) => line.trim() !== '') ?? '';

test('a command without keys leaves its word alone in the status line', async () => {
  const { setup } = await mount({ themeMode: 'dark', width: 100, catalog: without(['help']) });

  expect(statusRowOf(setup.captureCharFrame()).trim()).toBe('help');
});

test('a missing refresh key gives the status marker and the toast a keyless fix', async () => {
  const { setup, session, settle } = await mount({
    themeMode: 'dark',
    effects: ghMissingEffects,
    width: 100,
    catalog: without(['refresh']),
  });

  act(() => {
    session.send({ kind: 'refresh' });
  });

  await settle();

  expect(statusRowOf(setup.captureCharFrame())).toContain('gh missing, refresh');
  expect(statusRowOf(setup.captureCharFrame())).not.toContain('undefined');
  expect(session.getSnapshot().toast?.lines.join(' ')).toContain('cli.github.com, then refresh');
});

const confirmHintOf = async (ids: readonly string[]): Promise<string> => {
  const { setup, session, press, settle } = await mount({
    themeMode: 'dark',
    effects: feedEffects(() => fourRepoThreads),
    width: 100,
    catalog: without(ids),
  });

  act(() => {
    session.send({ kind: 'refresh' });
  });

  await settle();
  await press('g');
  await press('o');

  const lines = setup.captureCharFrame().split('\n');
  const titleAt = lines.findIndex((line) => line.includes('Open 4 repos'));

  const column = (lines[titleAt] ?? '').indexOf('Open 4 repos');
  const inside = (lines[titleAt + 1] ?? '').slice(column).split('│')[0] ?? '';

  return inside.trim();
};

test('the confirm dialog shows y or Enter to open, n or Esc to cancel by default', async () => {
  expect(await confirmHintOf([])).toBe('y or Enter to open, n or Esc to cancel');
});

test('the confirm dialog drops the part of a command without keys', async () => {
  expect(await confirmHintOf(['confirmOpen'])).toBe('n or Esc to cancel');
  expect(await confirmHintOf(['cancelOpen'])).toBe('y or Enter to open');
  expect(await confirmHintOf(['confirmOpen', 'cancelOpen'])).toBe('');
});

const composerFrameOf = async (ids: readonly string[], draft: string): Promise<string> => {
  const { setup, session, press, settle } = await mount({
    themeMode: 'dark',
    effects: factsEffects(filterThreads, filterFacts),
    width: 100,
    catalog: without(ids),
  });

  act(() => {
    session.send({ kind: 'refresh' });
  });

  await settle();
  await press('f');

  if (draft !== '') {
    await typeText(setup, settle, draft);
  }

  return setup.captureCharFrame();
};

const keyless = ['applyFilterRow', 'takeFilterRow', 'closeFilters', 'openSearch'];

const boxedTextOf = (frame: string, needle: string): string => {
  const line = frame.split('\n').find((candidate) => candidate.includes(needle)) ?? '';

  return (line.split('│')[1] ?? '').trim();
};

test('the composer hint lists only commands that have keys', async () => {
  const hint = async (ids: readonly string[]) =>
    boxedTextOf(await composerFrameOf(ids, ''), '- exclude');

  expect(await hint([])).toBe('Enter apply · Tab edit · - exclude · Esc close');
  expect(await hint(keyless)).toBe('- exclude');
  expect(await hint(['takeFilterRow', 'closeFilters'])).toBe('Enter apply · - exclude');
  expect(await hint(['applyFilterRow', 'closeFilters'])).toBe('Tab edit · - exclude');
});

test('the no-match row points to search only when both the close and search keys exist', async () => {
  const label = async (ids: readonly string[]) =>
    boxedTextOf(await composerFrameOf(ids, 'zzzqq'), 'No matches');

  expect(await label([])).toBe('No matches. Press Esc, then / to search titles.');
  expect(await label(['closeFilters'])).toBe('No matches.');
  expect(await label(['openSearch'])).toBe('No matches.');
  expect(await label(keyless)).toBe('No matches.');
});

test('the no-match row is dim, unmarked, and not an error', async () => {
  const { setup, session, settle, press } = await mount({
    themeMode: 'dark',
    effects: factsEffects(filterThreads, filterFacts),
    width: 100,
    catalog: without([]),
  });

  act(() => {
    session.send({ kind: 'refresh' });
  });

  await settle();
  await press('f');
  await typeText(setup, settle, 'zzzqq');

  const frame = setup.captureCharFrame();
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const span = spans.find((candidate) => candidate.text.includes('No matches'));

  expect(span?.fg.toString()).toBe(colorOf('dark'));
  expect(boxedTextOf(frame, 'No matches')).not.toContain('✓');
});

test('the empty-list notice tells to refresh without a key when refresh has none', async () => {
  const effects = {
    ...idleEffects,
    readFeed: feedEffects(() => ({ ok: false as const, failure: { kind: 'ghMissing' as const } }))
      .readFeed,
  };

  const { setup, session, settle } = await mount({
    themeMode: 'dark',
    effects,
    width: 100,
    catalog: without(['refresh']),
  });

  act(() => {
    session.send({ kind: 'refresh' });
  });

  await settle();

  expect(setup.captureCharFrame()).toContain('cli.github.com, then refresh');
});
