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

test('unbinding help search removes its shortcut hint', async () => {
  const config = loadConfig(
    { XDG_CONFIG_HOME: '/test-config' },
    {
      readFile: () => ({
        kind: 'text',
        text: JSON.stringify({ version: 1, keys: { openHelpSearch: [] } }),
      }),
    },
  );

  if (!config.ok) {
    throw new Error(config.message);
  }

  const { setup, press } = await mount({ catalog: config.catalog, width: 80, height: 24 });

  await press('?');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('╭─ Help');
  expect(frame).not.toContain('undefined');
  expect(frame).not.toContain(' search');

  await press('/');

  expect(setup.captureCharFrame()).toBe(frame);
});

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

test('help search after scrolling shows the first matching rows', async () => {
  const custom = catalog.map((command) =>
    Object.assign({}, command, { label: `qjk ${command.label}` }),
  );

  const { setup, press } = await mount({ catalog: custom, width: 80, height: 24 });

  await press('?');
  await press('G');

  expect(setup.captureCharFrame()).not.toContain('qjk Quit');

  await press('/');
  await press('qjk');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('qjk Quit');
  expect(frame).toMatch(/1-19 of \d+/);
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
    expect(setup.captureCharFrame()).toContain('/qjk');
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
  expect(setup.captureCharFrame()).not.toContain('/fltr');

  await press('/');

  expect(setup.captureCharFrame()).toContain('/fltr');

  await press('backspace');

  expect(setup.captureCharFrame()).toContain('/flt');

  await press('escape');

  expect(setup.captureCharFrame()).toBe(original);
  expect(setup.captureCharFrame()).toContain('Quit');
  expect(setup.captureCharFrame()).not.toContain('/flt');

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

  expect(setup.captureCharFrame()).toContain('/fltr');
  expect(setup.captureCharFrame()).toContain('Open filters');
  expect(setup.captureCharFrame()).not.toContain('Quit');
});

for (const entry of [
  { name: 'retained query', query: 'fltr', opener: '/', keys: ['backspace'], expected: 'flt' },
  { name: 'emoji', query: 'fltr🚀', opener: '/', keys: ['backspace'], expected: 'fltr' },
  { name: 'precomposed text', query: 'fltré', opener: '/', keys: ['backspace'], expected: 'fltr' },
  { name: 'remapped opener', query: 'fltr', opener: 's', keys: ['backspace'], expected: 'flt' },
  {
    name: 'deletion to empty stays editing',
    query: 'ab',
    opener: '/',
    keys: ['backspace', 'backspace'],
    expected: '',
  },
  {
    name: 'mixed typing and deletion',
    query: 'fl',
    opener: '/',
    keys: ['x', 'backspace', 't', 'r', 'backspace'],
    expected: 'flt',
  },
]) {
  for (const inBurst of [false, true]) {
    test(`help search Backspace ${entry.name}, burst=${inBurst}`, async () => {
      const custom = catalog.map((command) =>
        command.id === 'openHelpSearch'
          ? Object.assign({}, command, { keys: [entry.opener] })
          : command,
      );

      const { setup, press, settle } = await mount({ catalog: custom, width: 80, height: 100 });

      await press('?');
      await press(entry.opener);
      await press(entry.query);
      await press('return');

      if (inBurst) {
        act(() => {
          setup.mockInput.pressKey(entry.opener);

          for (const key of entry.keys) {
            if (key === 'backspace') {
              setup.mockInput.pressBackspace();
            } else {
              setup.mockInput.pressKey(key);
            }
          }
        });

        await settle();
        await settle();
      } else {
        await press(entry.opener);

        for (const key of entry.keys) {
          await press(key);
        }
      }

      const frame = setup.captureCharFrame();
      const query = frame.match(/│ \/([^\n│]*)│ *\n *╰/)?.[1]?.trim();

      expect(query).toBe(entry.expected);
      expect(frame).toContain('╭─ Help');
    });
  }
}

test('help search pending Backspace deletes a decomposed grapheme', async () => {
  const { setup, press, settle } = await mount({ width: 80, height: 100 });

  await press('?');
  await press('/');
  await press('fltre\u0301');
  await press('return');

  act(() => {
    setup.mockInput.pressKey('/');
    setup.mockInput.pressBackspace();
  });

  await settle();
  await settle();

  const query = setup
    .captureCharFrame()
    .match(/│ \/([^\n│]*)│ *\n *╰/)?.[1]
    ?.trim();

  expect(query).toBe('fltr');
});

for (const inBurst of [false, true]) {
  test(`help search catalog Backspace clears before typing, burst=${inBurst}`, async () => {
    const config = loadConfig(
      { XDG_CONFIG_HOME: '/test-config' },
      {
        readFile: () => ({
          kind: 'text',
          text: JSON.stringify({ version: 1, keys: { clearHelpSearch: ['<BS>'] } }),
        }),
      },
    );

    if (!config.ok) {
      throw new Error(config.message);
    }

    const { setup, press, settle } = await mount({
      catalog: config.catalog,
      width: 80,
      height: 100,
    });

    await press('?');
    await press('/');
    await press('fltr');
    await press('return');

    if (!inBurst) {
      await press('/');
    }

    act(() => {
      if (inBurst) {
        setup.mockInput.pressKey('/');
      }

      setup.mockInput.pressBackspace();
      setup.mockInput.pressBackspace();
      setup.mockInput.pressKey('q');
    });

    await settle();
    await settle();

    const frame = setup.captureCharFrame();
    const query = frame.match(/│ \/([^\n│]*)│ *\n *╰/)?.[1]?.trim();

    expect(query).toBe('q');
    expect(frame).toContain('Quit');
  });
}

for (const mode of [
  'settled',
  'mounted burst',
  'pending opener',
  'pending retained',
  'clear burst',
]) {
  test(`help search Backspace on an empty query exits to help navigation: ${mode}`, async () => {
    const { setup, press, settle } = await mount({ width: 80, height: 100 });

    await press('?');

    const original = setup.captureCharFrame();

    if (mode !== 'pending opener') {
      await press('/');
      await press('a');
    }

    if (mode === 'pending retained') {
      await press('return');
    }

    if (mode === 'settled') {
      await press('backspace');

      expect(setup.captureCharFrame()).toMatch(/│ \/\s*│ *\n *╰/);

      await press('backspace');
    } else {
      act(() => {
        if (mode === 'pending opener' || mode === 'pending retained') {
          setup.mockInput.pressKey('/');
        }

        if (mode === 'clear burst') {
          setup.mockInput.pressKey('u', { ctrl: true });
        } else if (mode !== 'pending opener') {
          setup.mockInput.pressBackspace();
        }

        setup.mockInput.pressBackspace();
      });

      await settle();
      await settle();
    }

    expect(setup.captureCharFrame()).toBe(original);

    await press('q');

    expect(setup.captureCharFrame()).not.toContain('╭─ Help');
  });
}

for (const pending of [false, true]) {
  test(`help search Backspace on an empty query exits to help navigation in the same burst, pending=${pending}`, async () => {
    const { setup, press, settle } = await mount({ width: 80, height: 100 });

    await press('?');

    if (!pending) {
      await press('/');
    }

    act(() => {
      if (pending) {
        setup.mockInput.pressKey('/');
      }

      setup.mockInput.pressBackspace();
      setup.mockInput.pressKey('q');
    });

    await settle();
    await settle();

    expect(setup.captureCharFrame()).not.toContain('╭─ Help');
  });

  test(`help search deleting the final grapheme keeps editing, pending=${pending}`, async () => {
    const { setup, press, settle } = await mount({ width: 80, height: 100 });

    await press('?');
    await press('/');
    await press('e\u0301');

    if (pending) {
      await press('return');
    }

    act(() => {
      if (pending) {
        setup.mockInput.pressKey('/');
      }

      setup.mockInput.pressBackspace();
    });

    await settle();
    await settle();

    expect(setup.captureCharFrame()).toMatch(/│ \/\s*│ *\n *╰/);

    await press('q');

    expect(setup.captureCharFrame()).toContain('/q');
    expect(setup.captureCharFrame()).toContain('╭─ Help');
  });
}

for (const keys of [[], ['<C-x>']]) {
  for (const pending of [false, true]) {
    test(`help search empty close follows config ${keys.join(',')}, pending=${pending}`, async () => {
      const config = loadConfig(
        { XDG_CONFIG_HOME: '/test-config' },
        {
          readFile: () => ({
            kind: 'text',
            text: JSON.stringify({ version: 1, keys: { closeEmptyHelpSearch: keys } }),
          }),
        },
      );

      if (!config.ok) {
        throw new Error(config.message);
      }

      const { setup, press, settle } = await mount({
        catalog: config.catalog,
        width: 80,
        height: 100,
      });

      await press('?');

      const original = setup.captureCharFrame();

      if (!pending) {
        await press('/');
      }

      act(() => {
        if (pending) {
          setup.mockInput.pressKey('/');
        }

        setup.mockInput.pressBackspace();
        setup.mockInput.pressKey('q');
      });

      await settle();
      await settle();

      expect(setup.captureCharFrame()).toContain('/q');
      expect(setup.captureCharFrame()).toContain('╭─ Help');

      act(() => {
        setup.mockInput.pressKey('x', { ctrl: true });
      });

      await settle();

      expect(setup.captureCharFrame()).toContain('/q');

      await press('backspace');

      if (pending) {
        await press('return');
      }

      act(() => {
        if (pending) {
          setup.mockInput.pressKey('/');
        }

        setup.mockInput.pressKey('x', { ctrl: true });
      });

      await settle();

      if (keys.length > 0) {
        expect(setup.captureCharFrame()).toBe(original);
      } else {
        expect(setup.captureCharFrame()).toMatch(/│ \/\s*│ *\n *╰/);
      }
    });
  }
}

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
