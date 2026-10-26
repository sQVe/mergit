import { afterEach, expect, test } from 'bun:test';

import { RGBA } from '@opentui/core';

import type { Command } from '../commands.ts';
import { catalog } from '../commands.ts';
import { pickPalette } from './palette.ts';
import type { Setup } from './uiHarness.tsx';
import {
  frameLines,
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
  { ...(quitCommand as Command), id: 'quitByName', names: ['bye'], keys: [] },
];

const mountNamed = (manualTime = false) =>
  mount({ themeMode: 'dark', effects, manualTime, catalog: namedCatalog });

const slideMilliseconds = 200;

const highlightedCommands = (setup: Setup): string[] => {
  const background = RGBA.fromHex(pickPalette('dark').selectedBackground).toString();
  const lines = setup.captureSpans().lines.map((line) => line.spans);
  const inputIndex = lines.findIndex((spans) => spans[0]?.text.startsWith(':') === true);

  return lines
    .slice(0, inputIndex)
    .filter((spans) => spans.some((span) => span.bg.toString() === background))
    .map((spans) =>
      spans
        .map((span) => span.text)
        .join('')
        .trim(),
    );
};

test('command candidates highlight only the chosen name and keep it visible while cycling', async () => {
  const { setup, press, settle } = await mount({ themeMode: 'dark', effects, height: 7 });

  await press(':');
  await typeText(setup, settle, 'q');

  expect(highlightedCommands(setup)).toEqual([]);

  for (const name of ['quit', 'q', 'quitall', 'qa', 'quit']) {
    await press('tab');

    expect(highlightedCommands(setup)).toEqual([name]);

    const lines = frameLines(setup);
    const inputIndex = lines.findIndex((line) => line.startsWith(':'));
    const shown = lines.slice(0, inputIndex).filter((line) => /^\s+q/.test(line));

    expect(shown).toHaveLength(2);
    expect(shown.some((line) => line.trim() === name)).toBe(true);
    expect(lines.at(-1)).toContain('? help');
  }
});

test('a tiny terminal keeps the command input and status visible without candidate rows', async () => {
  const { setup, press, settle, session } = await mount({ themeMode: 'dark', effects, height: 4 });

  await press(':');
  await typeText(setup, settle, 'q');
  await press('tab');

  const lines = frameLines(setup);

  expect(session.getSnapshot().commandLineText).toBe('quit');
  expect(lines.some((line) => line.startsWith(':quit'))).toBe(true);
  expect(lines.at(-1)).toContain('? help');
  expect(highlightedCommands(setup)).toEqual([]);
});

test('Tab completes a command name and Enter opens messages', async () => {
  const { setup, press, settle, session } = await mountNamed();

  await press(':');
  await typeText(setup, settle, 'me');
  await press('tab');

  expect(session.getSnapshot().commandLineText).toBe('messages');

  await press('return');

  expect(session.getSnapshot().commandLineOpen).toBe(false);
  expect(setup.captureCharFrame()).toContain('Messages');
});

test('command completion cycles active names above the line and resets after editing and reopening', async () => {
  const { setup, press, settle, session, terminalIntents } = await mountNamed();

  await press(':');
  await typeText(setup, settle, 'q');

  const frame = setup.captureCharFrame();

  expect(frame.indexOf('quitall')).toBeLessThan(frame.indexOf(':q'));
  expect(frame).toContain('quitall');

  for (const name of ['quit', 'q', 'quitall', 'qa', 'quit']) {
    await press('tab');
    expect(session.getSnapshot().commandLineText).toBe(name);
  }

  await press('\u001b[Z');
  expect(session.getSnapshot().commandLineText).toBe('qa');

  await typeText(setup, settle, 'x');
  await press('tab');
  expect(session.getSnapshot().commandLineText).toBe('qax');

  await press('escape');
  await press(':');
  await typeText(setup, settle, 'b');
  await press('tab');
  expect(session.getSnapshot().commandLineText).toBe('bye');
  expect(terminalIntents).toEqual([]);
});

test.each(['', 'zz', 'msg', 'me argument', ' me'])(
  'Tab leaves non-prefix command input %s unchanged',
  async (text) => {
    const { setup, press, settle, session } = await mountNamed();

    await press(':');
    await typeText(setup, settle, text);
    await press('tab');

    expect(session.getSnapshot().commandLineText).toBe(text);
  },
);

test('completion includes every active catalog name and submits its added alias', async () => {
  const { setup, press, settle, session, terminalIntents } = await mountNamed();
  const names = namedCatalog.flatMap((command) => command.names ?? []);

  for (const name of names) {
    await press(':');
    await typeText(setup, settle, name);

    for (const candidate of names.filter((value) => value.startsWith(name))) {
      await press('tab');
      expect(session.getSnapshot().commandLineText).toBe(candidate);
    }

    if (name !== 'bye') {
      await press('escape');
    }
  }

  expect(setup.captureCharFrame()).toContain(':bye');

  await press('return');

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  expect(session.getSnapshot().commandLineCompletion).toBeNull();

  await press(':');
  await press('tab');

  expect(session.getSnapshot().commandLineText).toBe('');
});

test('command completion input stays isolated from list and global shortcuts', async () => {
  const { setup, press, settle, session, terminalIntents } = await mountNamed();

  await press(':');

  const before = session.getSnapshot();

  await typeText(setup, settle, 'jkrq/?');
  await press('tab');

  expect(session.getSnapshot().commandLineText).toBe('jkrq/?');
  expect(session.getSnapshot().searchOpen).toBe(false);
  expect(session.getSnapshot().selectedRowKey).toEqual(before.selectedRowKey);
  expect(terminalIntents).toEqual([]);
});

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
