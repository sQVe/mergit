import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import { catalog } from '../src/commands.ts';
import { loadConfig } from '../src/config/config.ts';
import { burst, track, mount as untrackedMount } from '../src/ui/uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

test('help search editing hides navigation hints until Enter', async () => {
  const { setup, press } = await mount({ width: 80, height: 24 });

  await press('?');
  await press('/');

  const editing = setup.captureCharFrame();

  expect(editing).toMatch(/1-\d+ of \d+/);
  expect(editing).not.toContain('j/k scroll');
  expect(editing).not.toContain('q close');

  await press('return');

  const retained = setup.captureCharFrame();

  expect(retained).toContain('j/k scroll');
  expect(retained).toContain('q close');
});

test('help retains a visible long query on one row at 30 columns', async () => {
  const query = 'verylongsearchtextwithnomatches012345678901234567890123456789';
  const { setup, press } = await mount({ width: 30, height: 24 });

  await press('?');
  await press('/');
  await press(query);
  await press('return');

  const lines = setup.captureCharFrame().split('\n');
  const first = lines.findIndex((line) => line.includes('╭'));
  const last = lines.findIndex((line) => line.includes('╰'));
  const rows = lines.slice(first + 1, last);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain('/ search verylong');
  expect(rows[0]).toContain('…');
  expect(rows[0]?.trimEnd().endsWith('│')).toBe(true);

  await press('/');

  expect(setup.captureCharFrame()).toContain(query.slice(-12));
});

test('help search narrows fuzzy labels', async () => {
  const { setup, press } = await mount({ width: 80, height: 24 });

  await press('?');
  await press('/');
  await press('fltr');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Open filters');
  expect(frame).not.toContain('Quit');
});

for (const inBurst of [false, true]) {
  test(`help search receives q j k and keeps Ctrl+C active, burst=${inBurst}`, async () => {
    const custom = catalog.map((command) =>
      Object.assign({}, command, { label: `qjk ${command.label}` }),
    );

    const { setup, press, settle, terminalIntents } = await mount({
      catalog: custom,
      width: 80,
      height: 24,
    });

    await press('?');

    if (inBurst) {
      await burst(setup, ['/', 'qjk']);
      await settle();
    } else {
      await press('/');

      for (const key of ['q', 'j', 'k']) {
        await press(key);

        expect(setup.captureCharFrame()).toMatch(/1-19 of \d+/);
        expect(setup.captureCharFrame()).toContain('qjk Quit');
      }
    }

    expect(setup.captureCharFrame()).toMatch(/1-19 of \d+/);
    expect(setup.captureCharFrame()).toContain('qjk Quit');
    expect(setup.captureCharFrame()).toContain('Search: qjk');
    expect(setup.captureCharFrame()).toContain('Help');
    expect(terminalIntents).toEqual([]);

    act(() => {
      setup.mockInput.pressKey('c', { ctrl: true });
    });

    await settle();

    expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  });
}

test('help search Enter retains matches, reopening edits them, and Escape clears before closing', async () => {
  const { setup, press } = await mount({ width: 80, height: 100 });

  await press('?');

  const original = setup.captureCharFrame();

  await press('/');
  await press('fltr');
  await press('return');

  expect(setup.captureCharFrame()).toContain('Open filters');
  expect(setup.captureCharFrame()).not.toContain('Quit');
  expect(setup.captureCharFrame()).not.toContain('Search:');

  await press('/');

  expect(setup.captureCharFrame()).toContain('Search: fltr');

  await press('backspace');

  expect(setup.captureCharFrame()).toContain('Search: flt');

  await press('escape');

  expect(setup.captureCharFrame()).toBe(original);
  expect(setup.captureCharFrame()).toContain('Quit');
  expect(setup.captureCharFrame()).not.toContain('Search:');

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('╭─ Help');

  await press('?');

  expect(setup.captureCharFrame()).toContain('Quit');
});

test('Enter returns q to help and reopening help clears retained search', async () => {
  const { setup, press } = await mount({ width: 80, height: 100 });

  await press('?');
  await press('/');
  await press('fltr');
  await press('return');
  await press('q');

  expect(setup.captureCharFrame()).not.toContain('╭─ Help');

  await press('?');

  expect(setup.captureCharFrame()).toContain('Quit');
});

test('help search clears a remapped input line before the next burst key', async () => {
  const config = loadConfig(
    { XDG_CONFIG_HOME: '/test-config' },
    {
      readFile: () => ({
        kind: 'text',
        text: JSON.stringify({ version: 1, keys: { clearHelpSearch: ['<C-x>'] } }),
      }),
    },
  );

  if (!config.ok) {
    throw new Error(config.message);
  }

  const { setup, press, settle } = await mount({ catalog: config.catalog, width: 80, height: 100 });

  await press('?');
  await press('/');
  await press('qjk');

  act(() => {
    setup.mockInput.pressKey('x', { ctrl: true });
    setup.mockInput.pressKey('f');
    setup.mockInput.pressKey('l');
    setup.mockInput.pressKey('t');
    setup.mockInput.pressKey('r');
  });

  await settle();

  expect(setup.captureCharFrame()).toContain('Search: fltr');
  expect(setup.captureCharFrame()).toContain('Open filters');
  expect(setup.captureCharFrame()).not.toContain('Quit');
});

test('help search opener and hint follow a custom catalog', async () => {
  const custom = catalog.map((command) =>
    command.id === 'openHelpSearch' ? Object.assign({}, command, { keys: ['s'] }) : command,
  );

  const { setup, press } = await mount({ catalog: custom, width: 80, height: 100 });

  await press('?');

  expect(setup.captureCharFrame()).toContain('s search');
  expect(setup.captureCharFrame()).toMatch(/s\s+Search help/);

  await press('s');
  await press('fltr');

  expect(setup.captureCharFrame()).toContain('Open filters');
  expect(setup.captureCharFrame()).not.toContain('Quit');
});
