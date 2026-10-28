import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import { commandsOfLayer, keyHintOf } from '../src/commands.ts';
import { loadConfig } from '../src/config/config.ts';
import { footerOf, helpWindowOf } from '../src/ui/helpWindow.ts';
import {
  feedEffects,
  fourRepoThreads,
  idleEffects,
  makeThread,
  pressAll,
  track,
  typeText,
  mount as untrackedMount,
} from '../src/ui/uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const configured = (config: unknown) => {
  const loaded = loadConfig(
    { XDG_CONFIG_HOME: '/test-config' },
    { readFile: () => ({ kind: 'text', text: JSON.stringify(config) }) },
  );

  if (!loaded.ok) {
    throw new Error(loaded.message);
  }

  return loaded;
};

test('version 1 accepts help search remaps alongside existing public IDs', async () => {
  const { catalog } = configured({
    version: 1,
    keys: {
      openHelpSearch: ['s'],
      openSearch: ['/'],
      closeHelp: ['q', '<Esc>'],
      clearLine: ['<C-u>'],
      clearHelpSearch: ['<C-x>'],
    },
  });

  const { setup, press } = await mount({ catalog, width: 80, height: 100 });

  await press('?');

  expect(setup.captureCharFrame()).toContain('s search');

  await press('s');
  await press('fltr');

  expect(setup.captureCharFrame()).toContain('Open filters');
  expect(setup.captureCharFrame()).not.toContain('Quit');
  expect(keyHintOf(catalog, 'openSearch')).toBe('/');
  expect(keyHintOf(catalog, 'closeHelp')).toBe('q/Esc');
});

test('the help footer advertises Down for scrolling when closeHelp takes j', () => {
  const { catalog } = configured({ version: 1, keys: { closeHelp: ['j', '<Esc>'] } });
  const helpCommands = commandsOfLayer(catalog, 'help');
  const forward = helpCommands.find((command) => command.id === 'selectNext');

  expect(forward?.keys).toEqual(['down']);
  expect(footerOf(catalog, 'top', 60)).toBe('top  ↓/k scroll  j close');
});

test('constructor remains literal in configured refresh hints and help', () => {
  const { catalog } = configured({ version: 1, keys: { refresh: ['constructor'] } });
  const rows = helpWindowOf(catalog, 100, 100).lines;

  expect(keyHintOf(catalog, 'refresh')).toBe('constructor');
  expect(rows).toContainEqual({ kind: 'row', keys: 'constructor', label: 'Refresh' });
});

test('help shows each input scope when shared clear-line keys diverge', () => {
  const { catalog } = configured({ version: 1, keys: { cancelInput: ['<C-u>'] } });
  const rows = helpWindowOf(catalog, 100, 100).lines;

  expect(rows).toContainEqual({ kind: 'row', keys: '', label: 'Clear an input line (search)' });

  expect(rows).toContainEqual({
    kind: 'row',
    keys: 'Ctrl+U',
    label: 'Clear an input line (command)',
  });

  expect(rows).toContainEqual({
    kind: 'row',
    keys: 'Ctrl+U',
    label: 'Clear an input line (filter)',
  });
});

test('help keeps one shared clear-line row when input keys agree', () => {
  const { catalog } = configured({ version: 1, keys: { clearLine: ['<C-k>'] } });
  const rows = helpWindowOf(catalog, 100, 100).lines;

  const clearing = rows.filter(
    (row) => row.kind === 'row' && row.label.startsWith('Clear an input line'),
  );

  expect(clearing).toEqual([{ kind: 'row', keys: 'Ctrl+K', label: 'Clear an input line' }]);
});

for (const [scope, keys] of [
  ['list prefix', ['g']],
  ['counted prefix', ['5', 'g']],
  ['help prefix', ['?', 'g']],
  ['messages prefix', [':', 'm', 'e', 's', 's', 'a', 'g', 'e', 's', 'return', 'g']],
  ['search prefix', ['/', 'x']],
  ['command prefix', [':', 'x']],
  ['filter prefix', ['f', 'x']],
] as const) {
  test(`fixed Ctrl+C quits once during a ${scope} without another action`, async () => {
    const { catalog } = configured({ version: 1, keys: { quit: ['q'], clearLine: ['xx'] } });
    const { setup, session, sent, terminalIntents, press, settle } = await mount({ catalog });

    await pressAll(press, [...keys]);

    const before = session.getSnapshot();
    const actionsBefore = [...sent];

    act(() => {
      setup.mockInput.pressKey('c', { ctrl: true });
    });

    await settle();

    expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
    expect(session.getSnapshot()).toBe(before);
    expect(sent).toEqual(actionsBefore);
  });
}

for (const [scope, keys, visible] of [
  ['reader', ['r', 'j', 'j', 'return', 'x'], 'Mergit cannot show this content yet.'],
  ['confirmation', ['r', 'g', 'g', 'o', 'x'], 'Open 4 repos'],
] as const) {
  test(`fixed Ctrl+C quits once during a ${scope} prefix without another action`, async () => {
    const { catalog } = configured({
      version: 1,
      keys: { closeDetail: ['xx'], cancelOpen: ['xx'] },
    });

    const opens: unknown[] = [];

    const effects = {
      ...feedEffects(() => fourRepoThreads),
      openInBrowser: (page: unknown) => {
        opens.push(page);

        return Promise.resolve({ ok: true as const });
      },
    };

    const { setup, session, sent, terminalIntents, press, settle } = await mount({
      catalog,
      effects,
    });

    await pressAll(press, [...keys]);

    expect(setup.captureCharFrame()).toContain(visible);

    const before = session.getSnapshot();
    const actionsBefore = [...sent];

    act(() => {
      setup.mockInput.pressKey('c', { ctrl: true });
    });

    await settle();

    expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
    expect(session.getSnapshot()).toBe(before);
    expect(sent).toEqual(actionsBefore);
    expect(opens).toEqual([]);
  });
}

test('fixed quit handling respects a custom catalog without Ctrl+C', async () => {
  const configuredCatalog = configured({ version: 1 }).catalog;

  const catalog = configuredCatalog.map((command) =>
    Object.assign({}, command, { keys: command.keys.filter((key) => key !== 'ctrl+c') }),
  );

  const { setup, session, sent, terminalIntents, press, settle } = await mount({ catalog });

  await press('g');

  const before = session.getSnapshot();
  const actionsBefore = [...sent];

  act(() => {
    setup.mockInput.pressKey('c', { ctrl: true });
  });

  await settle();

  expect(terminalIntents).toEqual([]);
  expect(session.getSnapshot()).toBe(before);
  expect(sent).toEqual(actionsBefore);
});

test('Ctrl+Shift+C does not invoke the fixed Ctrl+C binding under Kitty', async () => {
  const { setup, terminalIntents, press, settle } = await mount({ kittyKeyboard: true });

  await press('g');

  act(() => {
    setup.mockInput.pressKey('c', { ctrl: true, shift: true });
  });

  await settle();

  expect(terminalIntents).toEqual([]);
});

for (const [scope, openKey, field] of [
  ['search', '/', 'searchText'],
  ['command', ':', 'commandLineText'],
  ['filter', 'f', 'filterDraft'],
] as const) {
  test(`unbound clearLine preserves native Ctrl+A editing in ${scope}`, async () => {
    const { catalog } = configured({ version: 1, keys: { clearLine: [] } });
    const { setup, session, press, settle } = await mount({ catalog });

    await press(openKey);
    await typeText(setup, settle, 'ab');

    act(() => {
      setup.mockInput.pressKey('u', { ctrl: true });
    });

    await settle();

    expect(session.getSnapshot()[field]).toBe('ab');

    act(() => {
      setup.mockInput.pressKey('a', { ctrl: true });
    });

    await settle();
    await press('x');

    expect(session.getSnapshot()[field]).toBe('xab');
  });

  for (const keys of [[], ['<C-k>']]) {
    test(`clearLine ${JSON.stringify(keys)} removes native Ctrl+U clearing in ${scope}`, async () => {
      const { catalog } = configured({ version: 1, keys: { clearLine: keys } });
      const { setup, session, press, settle } = await mount({ catalog });

      await press(openKey);
      await typeText(setup, settle, 'ab');

      act(() => {
        setup.mockInput.pressKey('u', { ctrl: true });
      });

      await settle();

      expect(session.getSnapshot()[field]).toBe('ab');

      await press('backspace');
      await press('c');

      expect(session.getSnapshot()[field]).toBe('ac');

      act(() => {
        setup.mockInput.pressKey('k', { ctrl: true });
      });

      await settle();

      expect(session.getSnapshot()[field]).toBe(keys.length === 0 ? 'ac' : '');
    });
  }
}

const refreshConfig = {
  version: 1,
  keys: { refresh: ['R'], markDone: [] },
  aliases: { refresh: ['reload'] },
};

test('configured Shift+R and :reload refresh, plain r does not, and d marks nothing done', async () => {
  const { catalog, notices } = configured(refreshConfig);
  let reads = 0;

  const effects = feedEffects(() => {
    reads += 1;

    return [makeThread(1, `Read ${reads}`)];
  });

  const { setup, session, press, settle, sent } = await mount({
    catalog,
    effects: { ...effects, configNotices: notices },
  });

  await press('r');

  expect(reads).toBe(0);

  act(() => {
    setup.mockInput.pressKey('r', { shift: true });
  });

  await settle();

  expect(reads).toBe(1);
  expect(setup.captureCharFrame()).toContain('Read 1');

  await press(':');
  await typeText(setup, settle, 'reload');
  await press('return');

  expect(reads).toBe(2);
  expect(setup.captureCharFrame()).toContain('Read 2');

  await pressAll(press, ['j', 'j']);

  expect(session.getSnapshot().selectedRowKey).toBe('thread:1');

  const before = session.getSnapshot();

  await press('d');

  expect(session.getSnapshot()).toBe(before);
  expect(sent).not.toContainEqual({ kind: 'markDone' });
  expect(setup.captureCharFrame()).toContain('Read 2');
});

test('help shows the configured refresh key and leaves mark done without a key', async () => {
  const { catalog, notices } = configured(refreshConfig);

  const { setup, press } = await mount({
    catalog,
    effects: { ...idleEffects, configNotices: notices },
    width: 100,
    height: 100,
  });

  await press('?');

  const rows = setup.captureCharFrame().split('\n');
  const refresh = rows.find((row) => row.includes('Refresh'));
  const markDone = rows.find((row) => row.includes('Mark done'));

  expect(refresh).toMatch(/│\s+R\/:reload\s+Refresh\s+│/u);
  expect(markDone).toMatch(/│\s+Mark done\s+│/u);
});

test('the refresh notice uses the configured R hint', async () => {
  const { catalog, notices } = configured(refreshConfig);
  const effects = feedEffects(() => ({ ok: false, failure: { kind: 'ghMissing' } }));

  const { setup, press } = await mount({
    catalog,
    effects: { ...effects, configNotices: notices },
    width: 100,
  });

  await press('R');

  expect(setup.captureCharFrame()).toContain('press R');
  expect(setup.captureCharFrame()).not.toContain('press r');
});

for (const [scope, openKey] of [
  ['list', null],
  ['search line', '/'],
  ['command line', ':'],
  ['filter composer', 'f'],
] as const) {
  test(`Ctrl+C still quits from the ${scope} when quit is configured as q`, async () => {
    const { catalog, notices } = configured({ version: 1, keys: { quit: ['q'] } });

    const { setup, press, settle, session, terminalIntents } = await mount({
      catalog,
      effects: { ...idleEffects, configNotices: notices },
    });

    if (openKey !== null) {
      await press(openKey);
    }

    if (scope === 'search line') {
      await press('q');

      expect(session.getSnapshot().searchText).toBe('q');
      expect(setup.captureCharFrame()).toContain('/q');
    }

    const snapshot = session.getSnapshot();

    expect(snapshot.searchOpen).toBe(scope === 'search line');
    expect(snapshot.commandLineOpen).toBe(scope === 'command line');
    expect(snapshot.filtersOpen).toBe(scope === 'filter composer');
    expect(terminalIntents).toEqual([]);

    act(() => {
      setup.mockInput.pressKey('c', { ctrl: true });
    });

    await settle();

    expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  });
}

test('a notice naming a key taken from the defaults shows after mount', async () => {
  const { catalog, notices } = configured({ version: 1, keys: { refresh: ['d'] } });

  const { setup, session, advance } = await mount({
    catalog,
    effects: { ...idleEffects, configNotices: notices },
    width: 120,
    manualTime: true,
  });

  await advance(0);
  await advance(200);

  const toastText = setup
    .captureCharFrame()
    .split('\n')
    .filter((row) => row.includes('▌'))
    .map((row) => row.split('▌')[1]?.trim())
    .join('')
    .replaceAll(/\s/gu, '');

  const noticeText = notices.join('').replaceAll(/\s/gu, '');

  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('d');
  expect(session.getSnapshot().toast?.lines).toEqual(notices);
  expect(toastText).toContain(noticeText);
});

test('a remapped closeDetail takes d from the reader, and d in the list still marks done', async () => {
  const { catalog } = configured({ version: 1, keys: { closeDetail: ['d'] } });

  const { setup, press, sent } = await mount({
    catalog,
    effects: feedEffects(() => fourRepoThreads),
  });

  await press('r');
  await pressAll(press, ['j', 'j', 'return']);
  await press('d');

  expect(setup.captureCharFrame()).not.toMatch(/Repo\s+example/);

  expect(sent.some((intent) => (intent as { kind?: string }).kind === 'markThreadsDone')).toBe(
    false,
  );

  await press('d');

  expect(sent.at(-1)).toEqual({ kind: 'markDone' });
});

test('markDone cannot take Escape because closeDetail must keep a key', () => {
  expect(() => configured({ version: 1, keys: { markDone: ['<Esc>'] } })).toThrow('closeDetail');
});

test('the reader hint shows a remapped markDone key and no default key', async () => {
  const { catalog } = configured({ version: 1, keys: { markDone: ['x'] } });

  const { setup, press, settle } = await mount({
    catalog,
    effects: feedEffects(() => fourRepoThreads),
  });

  await press('r');
  await pressAll(press, ['j', 'j', 'return']);
  await settle();

  const frame = setup.captureCharFrame();

  expect(frame).toContain('x done');
  expect(frame).not.toContain('d done');
});
