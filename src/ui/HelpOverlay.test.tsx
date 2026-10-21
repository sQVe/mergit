import { afterEach, expect, test } from 'bun:test';

import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';

import { catalog } from '../commands.ts';
import type { Command } from '../commands.ts';
import { HelpOverlay } from './HelpOverlay.tsx';
import { keysTextOf } from './helpWindow.ts';
import { pickPalette } from './palette.ts';
import type { Setup } from './uiHarness.tsx';
import { idleEffects, track, mount as untrackedMount } from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const scrollToEnd = async (
  setup: Setup,
  press: (key: string) => Promise<void>,
  key: string,
): Promise<void> => {
  let before = '';

  while (setup.captureCharFrame() !== before) {
    before = setup.captureCharFrame();
    await press(key);
  }
};

const tallRows = catalog.length + 10;

test('? opens the overlay with every command label and ? closes it', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, tallRows);

  await press('?');

  const open = setup.captureCharFrame();
  const listed = catalog.filter((command) => command.scope !== 'confirm');

  for (const command of listed) {
    expect(open).toContain(command.label);
  }

  expect(open).not.toContain('Confirm opening');

  await press('?');

  const closed = setup.captureCharFrame();

  for (const command of catalog) {
    expect(closed).not.toContain(command.label);
  }
});

test('Escape closes the overlay', async () => {
  const { setup, press } = await mount();

  await press('?');
  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('escape does nothing while the overlay is closed', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, tallRows);

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Close help');
});

test('the overlay lists the close help command from the catalog', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, tallRows);

  await press('?');

  expect(setup.captureCharFrame()).toContain('Close help');
});

test('the help overlay lists the search line keys and still shows Close help', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, tallRows);

  await press('?');

  const frame = setup.captureCharFrame();

  for (const id of ['submitInput', 'cancelInput', 'clearInput', 'closeEmptyInput']) {
    const command = catalog.find((candidate) => candidate.id === id);

    expect(frame).toContain(command?.label ?? 'missing');
  }

  expect(frame).toContain('Close help');
});

test('help fits inside an 80x24 terminal and scrolls to Close help', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, 24);

  await press('?');

  const lines = setup.captureCharFrame().split('\n');
  const bottomBorder = lines.findIndex((line) => line.includes('╰'));

  expect(bottomBorder).toBeGreaterThan(0);
  expect(bottomBorder).toBeLessThan(24);
  expect(lines[0]).toContain('Help');

  await scrollToEnd(setup, press, 'j');

  const scrolled = setup.captureCharFrame();

  expect(scrolled).toContain('Close help');
  expect(scrolled).toContain('Esc');
});

test('scrolling 80x24 help reaches every listed command and shows the position', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, 24);

  await press('?');

  const listed = catalog.filter((command) => command.scope !== 'confirm');
  const seen = new Set<string>();
  const positions: string[] = [];

  let previous = '';

  while (setup.captureCharFrame() !== previous) {
    const frame = setup.captureCharFrame();

    positions.push(/\d+-\d+ of \d+/.exec(frame)?.[0] ?? 'none');

    for (const command of listed) {
      if (frame.includes(command.label)) {
        seen.add(command.id);
      }
    }

    previous = frame;
    await press('j');
  }

  expect(seen.size).toBe(listed.length);
  expect(positions[0]).toBe(`1-21 of ${listed.length}`);
  expect(positions.at(-1)).toBe(`${listed.length - 20}-${listed.length} of ${listed.length}`);
});

test('scrolling up stops at the first command and down stops at the last', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, 24);

  await press('?');
  await press('k');
  await press('up');

  expect(setup.captureCharFrame()).toContain('1-21 of');

  await scrollToEnd(setup, press, 'down');

  const bottom = setup.captureCharFrame();
  const total = catalog.filter((command) => command.scope !== 'confirm').length;

  expect(bottom).toContain(`-${total} of ${total}`);

  await press('j');

  expect(setup.captureCharFrame()).toBe(bottom);

  await press('k');

  expect(setup.captureCharFrame()).not.toBe(bottom);
});

test('the first scroll key after a resize moves one row from what is shown', async () => {
  const { setup, press, resize } = await mount(null, idleEffects, 80, false, 24);

  await press('?');

  await scrollToEnd(setup, press, 'j');

  const total = catalog.filter((command) => command.scope !== 'confirm').length;

  expect(setup.captureCharFrame()).toContain(`${total - 20}-${total} of ${total}`);

  await resize(80, 30);

  expect(setup.captureCharFrame()).toContain(`${total - 26}-${total} of ${total}`);

  await press('k');

  expect(setup.captureCharFrame()).toContain(`${total - 27}-${total - 1} of ${total}`);
});

const rightEdgeOf = (frame: string): number => frame.split('\n')[0]?.lastIndexOf('╮') ?? -1;

test('the help box keeps its width while scrolling', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, 24);

  await press('?');

  const atTop = rightEdgeOf(setup.captureCharFrame());

  await scrollToEnd(setup, press, 'j');

  const atEnd = rightEdgeOf(setup.captureCharFrame());

  expect(atTop).toBeGreaterThan(0);
  expect(atEnd).toBe(atTop);
});

test('the widest help rows show in full at 80x24', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, 24);

  await press('?');

  await scrollToEnd(setup, press, 'j');

  const frame = setup.captureCharFrame();
  const position = /(\d+)-(\d+) of \d+/u.exec(frame);
  const first = Number(position?.[1]);
  const last = Number(position?.[2]);
  const listed = catalog.filter((command) => command.scope !== 'confirm');
  const shown = listed.slice(first - 1, last);

  expect(shown.length).toBeGreaterThan(0);

  for (const command of shown) {
    const keys = keysTextOf(command);

    expect(frame).toContain(`${keys}  ${command.label}`);
  }
});

test('help that fits shows no position hint', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, tallRows);

  await press('?');

  expect(setup.captureCharFrame()).not.toMatch(/\d+-\d+ of \d+/);
});

test('a command without keys renders its label', async () => {
  const nameOnly: Command = {
    id: 'nameOnly',
    label: 'Run by name',
    scope: 'global',
    keys: [],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  };

  const setup = await act(() =>
    testRender(
      <HelpOverlay catalog={[nameOnly]} palette={pickPalette('dark')} height={24} top={0} />,
      { width: 80, height: 24 },
    ),
  );

  cleanups.push(() => {
    setup.renderer.destroy();
  });

  await act(() => setup.renderOnce());

  expect(setup.captureCharFrame()).toContain('Run by name');
});

test('a command with a name and no keys is listed as :<name>', async () => {
  const quit = catalog.find((command) => command.id === 'quit') as Command;

  const named: Command = {
    ...quit,
    id: 'quitByName',
    label: 'Leave Mergit',
    name: 'bye',
    keys: [],
  };

  const { setup, press } = await mount(null, idleEffects, 60, false, tallRows + 1, false, [
    ...catalog,
    named,
  ]);

  await press('?');

  const frame = setup.captureCharFrame();
  const row = frame.split('\n').find((line) => line.includes('Leave Mergit'));

  expect(row).toContain(':bye');
});

test('a command line command is listed with the command line suffix', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, tallRows);

  await press('?');

  const frame = setup.captureCharFrame();
  const row = frame.split('\n').find((line) => line.includes('Run the command'));

  expect(row).toContain('(command line)');
});

test('help lists the :messages command', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, tallRows);

  await press('?');

  const frame = setup.captureCharFrame();

  expect(frame).toContain(':messages');
  expect(frame).toContain('Show recent messages');
});

const listedCount = catalog.filter((command) => command.scope !== 'confirm').length;

test('help with height equal to the commands plus the border shows every row and no footer', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, listedCount + 2);

  await press('?');

  const frame = setup.captureCharFrame();

  expect(frame).not.toMatch(/\d+-\d+ of \d+/);
  expect(frame).not.toContain('scroll');

  for (const command of catalog.filter((candidate) => candidate.scope !== 'confirm')) {
    expect(frame).toContain(command.label);
  }
});

test('help one row shorter overflows and shows the footer with the scroll and close keys', async () => {
  const { setup, press } = await mount(null, idleEffects, 80, false, listedCount + 1);

  await press('?');

  const frame = setup.captureCharFrame();

  expect(frame).toContain(`1-${listedCount - 2} of ${listedCount}  j/k scroll  Esc close`);
});

const commandOf = (id: string, keys: string[]): Command => ({
  id,
  label: `Label of ${id}`,
  scope: 'global',
  keys,
  disabledReason: () => undefined,
  intent: () => ({ kind: 'terminal', action: 'quit' }),
});

test('the footer names the scroll and close keys that the catalog gives', async () => {
  const custom = [
    commandOf('scrollHelpDown', ['n', 'down']),
    commandOf('scrollHelpUp', ['p', 'up']),
    commandOf('closeHelp', ['x']),
    commandOf('other', ['o']),
    commandOf('another', ['a']),
  ];

  const setup = await act(() =>
    testRender(<HelpOverlay catalog={custom} palette={pickPalette('dark')} height={5} top={0} />, {
      width: 80,
      height: 5,
    }),
  );

  cleanups.push(() => {
    setup.renderer.destroy();
  });

  await act(() => setup.renderOnce());

  const frame = setup.captureCharFrame();

  expect(frame).toContain('1-2 of 5  n/p scroll  x close');
  expect(frame).toContain('╰');
});

test('help shows readable key names instead of raw ones', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, tallRows);

  await press('?');

  const open = setup.captureCharFrame();

  expect(open).toContain('Enter');
  expect(open).toContain('G');
  expect(open).not.toContain('return');
  expect(open).not.toContain('shift+g');
});
