import { afterEach, expect, test } from 'bun:test';

import type { Command } from '../commands.ts';
import { catalog } from '../commands.ts';
import {
  mount as untrackedMount,
  threadsEffects,
  track,
  typeText,
  makeThread,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const effects = threadsEffects([makeThread(1, 'Only thread')]);

const quitCommand = catalog.find((command) => command.id === 'quit');

const namedCatalog: readonly Command[] = [
  ...catalog,
  { ...(quitCommand as Command), id: 'quitByName', name: 'bye', keys: [] },
];

const mountNamed = (manualTime = false) =>
  mount({ themeMode: 'dark', effects, manualTime, catalog: namedCatalog });

const slideMilliseconds = 200;

test('Enter on an unknown name closes the line and shows an error toast naming it', async () => {
  const { setup, press, settle, advance } = await mountNamed(true);

  await press(':');
  await typeText(setup, settle, 'foo');
  await press('return');
  await advance(0);
  await advance(slideMilliseconds);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Unknown command: foo');
  expect(frame).not.toContain(':foo');
});

test(': shows the command line with the typed text', async () => {
  const { setup, press, settle } = await mountNamed();

  await press(':');
  await typeText(setup, settle, 'ab');

  expect(setup.captureCharFrame()).toContain(':ab');
});

test('Esc closes the line and runs nothing', async () => {
  const { setup, press, settle, terminalIntents } = await mountNamed();

  await press(':');
  await typeText(setup, settle, 'bye');
  await press('escape');

  const frame = setup.captureCharFrame();

  expect(frame).not.toContain(':bye');
  expect(frame).not.toContain('Unknown command');
  expect(terminalIntents).toEqual([]);
});

test('Enter on a known name closes the line and runs that command', async () => {
  const { setup, press, settle, terminalIntents } = await mountNamed();

  await press(':');
  await typeText(setup, settle, ' bye ');
  await press('return');

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  expect(setup.captureCharFrame()).not.toContain(':bye');
});

test('typing right after : in one burst lands in the line', async () => {
  const { setup, settle } = await mountNamed();

  await typeText(setup, settle, ':bye');

  expect(setup.captureCharFrame()).toContain(':bye');
});

test('Backspace on an empty line closes it, and an empty Enter just closes', async () => {
  const { setup, press, session } = await mountNamed();

  await press(':');
  await press('backspace');

  expect(session.getSnapshot().commandLineOpen).toBe(false);

  await press(':');
  await press('return');

  expect(session.getSnapshot().commandLineOpen).toBe(false);
  expect(setup.captureCharFrame()).not.toContain('Unknown command');
});
