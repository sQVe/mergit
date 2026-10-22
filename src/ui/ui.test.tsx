import { afterEach, expect, test } from 'bun:test';

import { KeyEvent } from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useMemo, useState } from 'react';

import { catalog } from '../commands.ts';
import type { SessionEffects } from '../session/session.ts';
import { createSession, visibleRows } from '../session/session.ts';
import { App } from './ui.tsx';
import type { Setup } from './uiHarness.tsx';
import {
  makeThread,
  threadsEffects,
  colorOf,
  statusLineColor,
  selectedRowText,
  threeThreads,
  treeThread,
  pressAll,
  paneWidthAt,
  paneText,
  factsEffects,
  queryThreads,
  typeText,
  composerInputOf,
  manyAuthors,
  manyFacts,
  track,
  mountWithGroup as untrackedMountWithGroup,
  mountFilters as untrackedMountFilters,
  mount as untrackedMount,
  feedEffects,
  filterThreads,
  filterFacts,
  fourRepoThreads,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mountWithGroup = track(cleanups, untrackedMountWithGroup);

const mountFilters = track(cleanups, untrackedMountFilters);

const mount = track(cleanups, untrackedMount);

test('q passes a quit terminal intent and sends nothing to the session', async () => {
  const { press, terminalIntents, sent } = await mount();

  await press('q');

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  expect(sent).toEqual([]);
});

test('q still quits while the overlay is open', async () => {
  const { press, terminalIntents } = await mount();

  await press('?');
  await press('q');

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
});

test('ctrl+c passes a quit terminal intent', async () => {
  const { setup, terminalIntents, settle } = await mount();

  await act(async () => {
    setup.mockInput.pressKey('c', { ctrl: true });
  });

  await settle();

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
});

test('a theme change keeps the overlay open, recolors it, and adds no subscriber', async () => {
  const { setup, press, settle, changeTheme, subscriberCount } = await mount({
    themeMode: 'dark',
    height: catalog.length + 10,
  });

  await press('?');

  const before = subscriberCount();

  await changeTheme('light');
  await settle();

  expect(setup.captureCharFrame()).toContain('Toggle help');
  expect(statusLineColor(setup)).toBe(colorOf('light'));
  expect(subscriberCount()).toBe(before);
  expect(before).toBe(1);

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('the tree keys reach the session as their intents', async () => {
  const { press, sent } = await mount({ themeMode: 'dark', effects: threadsEffects(threeThreads) });

  await press('r');

  const keys = ['g', 'G', 'J', 'K', 'z', 'space', 'return', 'Z', 's'];

  for (const key of keys) {
    await press(key === 'space' ? ' ' : key);
  }

  expect(sent.slice(1)).toEqual([
    { kind: 'selectFirst' },
    { kind: 'selectLast' },
    { kind: 'selectNextGroup' },
    { kind: 'selectPreviousGroup' },
    { kind: 'toggleFold' },
    { kind: 'toggleFold' },
    { kind: 'toggleFold' },
    { kind: 'toggleAllFolds' },
    { kind: 'cycleGrouping' },
  ]);
});

test('resizing across 90 columns removes and restores the side pane and keeps the selected row', async () => {
  const { setup, press, resize } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
    width: 100,
  });

  await press('r');
  await press('j');
  await press('j');
  expect(paneText(setup, 100)).toMatch(/Repo\s+example\/repo/);

  await resize(60, 20);

  const narrow = setup.captureCharFrame();

  expect(narrow).not.toContain('Unread');
  expect(narrow).not.toContain('Updated');
  expect(narrow).toMatch(/PR\s+#1\s+First\s+3h/);
  expect(selectedRowText(setup)).toContain('First');

  await resize(90, 20);

  expect(paneText(setup, 90)).toMatch(/Repo\s+example\/repo/);
  expect(selectedRowText(setup)).toContain('First');
});

test('a long title stays inside the list columns and clear of the pane at 90 columns', async () => {
  const long = makeThread(1, 'x'.repeat(120));

  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects([long]),
    width: 90,
  });

  await press('r');
  await press('j');
  await press('j');

  const listWidth = 90 - paneWidthAt(90);
  const lines = setup.captureCharFrame().split('\n');
  const row = lines.find((line) => /PR\s+#1/.test(line)) ?? '';
  const border = lines.map((line) => line[listWidth]);

  expect(row.slice(0, listWidth)).toContain('…');
  expect(row.slice(0, listWidth)).toMatch(/3h\s*$/);
  expect(border.slice(0, 5).every((char) => char === '│')).toBe(true);
});

test('Escape with help open inside the detail closes help only', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await pressAll(press, ['r', 'j', 'j', 'j', 'return', '?', 'escape']);

  expect(setup.captureCharFrame()).toMatch(/Repo\s+example\/repo/);
  expect(setup.captureCharFrame()).not.toContain('Third');
});

test('resizing wide shows the side pane and resizing narrow again shows the list, not the detail', async () => {
  const { setup, press, resize } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await pressAll(press, ['r', 'j', 'j', 'j', 'return']);

  expect(setup.captureCharFrame()).not.toContain('Third');

  await resize(100, 20);

  expect(setup.captureCharFrame()).toContain('Third');
  expect(paneText(setup, 100)).toMatch(/Repo\s+example\/repo/);

  await resize(60, 20);

  const narrow = setup.captureCharFrame();

  expect(narrow).toContain('First');
  expect(narrow).toContain('Third');
  expect(narrow).not.toContain('Unread');
  expect(selectedRowText(setup)).toContain('Second');
});

test('list keys do nothing while the dialog is open', async () => {
  const { setup, press, sent } = await mountWithGroup();

  await press('o');

  const before = sent.length;

  await pressAll(press, ['j', 'd', 'z', '?']);

  expect(sent).toHaveLength(before);
  expect(setup.captureCharFrame()).toContain('Open 4 repos');
  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('Escape with help open closes help and opens no dialog', async () => {
  const { setup, press } = await mountWithGroup();

  await pressAll(press, ['?', 'escape']);

  const frame = setup.captureCharFrame();

  expect(frame).not.toContain('Toggle help');
  expect(frame).not.toContain('Open 4 repos');
});

test('q typed in the open search line goes into the text and does not quit', async () => {
  const { setup, press, settle, terminalIntents } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'q');

  expect(terminalIntents).toEqual([]);
  expect(setup.captureCharFrame()).toContain('/q');
});

test('ctrl+c quits while the search line is open and q still types', async () => {
  const { setup, press, settle, terminalIntents } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'q');

  expect(terminalIntents).toEqual([]);

  await act(async () => {
    setup.mockInput.pressKey('c', { ctrl: true });
  });

  await settle();

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  expect(setup.captureCharFrame()).toContain('/q');
});

test('opening the composer leaves the thread rows below the box where they were', async () => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: factsEffects(manyAuthors, manyFacts),
    width: 80,
    height: 30,
  });

  const { setup, press, settle } = mounted;

  await press('r');
  await settle();

  const rowOf = (label: string): number =>
    setup
      .captureCharFrame()
      .split('\n')
      .findIndex((line) => line.includes(label));

  const before = rowOf('Change 12');

  await press('f');
  await typeText(setup, settle, 'author:user0');

  expect(before).toBeGreaterThan(0);
  expect(rowOf('Change 12')).toBe(before);

  await press('escape');

  expect(rowOf('Change 12')).toBe(before);
});

test('in a very short terminal Enter applies the row shown under the cursor or nothing', async () => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: factsEffects(manyAuthors, manyFacts),
    height: 6,
  });

  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await press('down');

  const lines = setup.captureCharFrame().split('\n');
  const shown = lines.filter((line) => /^│\s+(✓ )?\S.*\d\s*│$/.test(line));

  expect(shown.length).toBeGreaterThanOrEqual(1);

  const label = shown[0]?.replace(/^│\s*/, '').split(/\s+/)[0] ?? '';

  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain(label);
});

test('in a terminal too short for any candidate row Enter adds nothing', async () => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: factsEffects(manyAuthors, manyFacts),
    height: 4,
  });

  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await press('return');
  await press('escape');

  expect(setup.captureCharFrame().split('\n')[0]).not.toContain('kind:');
});

const burst = async (setup: Setup, keys: string[]) => {
  await act(async () => {
    for (const key of keys) {
      if (key === 'escape') {
        setup.mockInput.pressEscape();
      } else if (key === 'return') {
        setup.mockInput.pressEnter();
      } else {
        for (const character of key) {
          setup.mockInput.pressKey(character);
        }
      }
    }
  });
};

test('keys sent in the same burst as f go to the draft and run no list command', async () => {
  const { setup, settle, press, sent } = await mountFilters();

  await press('r');
  sent.length = 0;

  await burst(setup, ['f', 'kind:pr']);
  await settle();

  const kinds = new Set(sent.map((intent) => (intent as { kind: string }).kind));

  expect([...kinds].every((kind) => kind === 'openFilters' || kind === 'editFilterDraft')).toBe(
    true,
  );

  expect(composerInputOf(setup.captureCharFrame())).toBe('kind:pr');
});

test('a supplementary character typed in the same burst as f stays in the draft', async () => {
  const { setup, settle, press, session } = await mountFilters();

  await press('r');
  await burst(setup, ['f', 'title:🚀']);
  await settle();

  expect(session.getSnapshot().filterDraft).toBe('title:🚀');
});

test('keys sent in the same burst as / go to the search text and run no list command', async () => {
  const { setup, settle, press, sent } = await mountFilters();

  await press('r');
  sent.length = 0;

  await burst(setup, ['/', 'd']);
  await settle();

  const kinds = new Set(sent.map((intent) => (intent as { kind: string }).kind));

  expect([...kinds].every((kind) => kind === 'openSearch' || kind === 'editSearch')).toBe(true);
  expect(setup.captureCharFrame()).toContain('/d');
});

test.each([
  ['f', 'composer'],
  ['/', 'search'],
] as const)('keys after %s keep shifted letters and spaces as typed', async (opening, input) => {
  const { setup, settle, press } = await mountFilters(60, true);

  await press('r');
  await burst(setup, [opening, 'Fix a bug']);
  await settle();

  const frame = setup.captureCharFrame();

  if (input === 'composer') {
    expect(composerInputOf(frame)).toBe('Fix a bug');
  } else {
    expect(frame).toContain('/Fix a bug');
  }
});

test('f, kind:pr, and Enter in one burst add the kind:pr chip', async () => {
  const { setup, settle, press, session } = await mountFilters(60, true);

  await press('r');
  await burst(setup, ['f', 'kind:pr', 'return']);
  await settle();

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).toContain('kind:pr');
  expect(session.getSnapshot().filtersOpen).toBe(false);
});

test('f then Esc in one burst closes the composer', async () => {
  const { setup, settle, press } = await mountFilters(60, true);

  await press('r');
  await burst(setup, ['f', 'escape']);
  await settle();

  expect(setup.captureCharFrame()).not.toContain('─ Filter ');
});

test('keys sent in the same burst as Esc on the composer change no filter', async () => {
  const { setup, settle, press, session } = await mountFilters(60, true);

  await press('r');
  await press('f');
  await burst(setup, ['escape', 'da']);
  await settle();

  expect(session.getSnapshot().filterDraft).toBe('');
  expect(session.getSnapshot().filters).toEqual([]);
});

test('keys sent in the same burst as Enter on the search line leave the search text', async () => {
  const { setup, settle, press, session } = await mountFilters(60, true);

  await press('r');
  await press('/');
  await burst(setup, ['Alpha', 'return', 'da']);
  await settle();

  expect(session.getSnapshot().searchText).toBe('Alpha');
});

test('text typed in the same burst after Enter removes a chip starts a new draft', async () => {
  const { setup, settle, press, session } = await mountFilters();

  await press('f');
  await burst(setup, ['kind:pr', 'return']);
  await press('f');
  await burst(setup, ['kind:pr', 'return', 'author:octo']);
  await settle();

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filterDraft).toBe('author:octo');
});

test('text typed in the same burst after Ctrl-U on the search line replaces the old text', async () => {
  const { setup, settle, press, session } = await mountFilters();

  await press('/');
  await burst(setup, ['abc']);

  await act(async () => {
    setup.mockInput.pressKey('u', { ctrl: true });
    setup.mockInput.pressKey('x');
  });

  await settle();

  expect(session.getSnapshot().searchText).toBe('x');
});

test('? and j in one burst scroll help and leave the list selection alone', async () => {
  const { setup, press, settle, session } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
    width: 80,
  });

  await pressAll(press, ['r', 'j']);

  const selected = session.getSnapshot().selectedRowKey;

  await burst(setup, ['?', 'j']);
  await settle();

  expect(setup.captureCharFrame()).toMatch(/2-\d+ of \d+/);
  expect(session.getSnapshot().selectedRowKey).toBe(selected);
});

test('? twice in one burst leaves help closed', async () => {
  const { setup, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
    width: 80,
  });

  await burst(setup, ['?', '?']);
  await settle();

  expect(setup.captureCharFrame()).not.toMatch(/\d+-\d+ of \d+/);
});

test('Enter and j in one burst open the detail and leave the list selection alone', async () => {
  const { setup, press, settle, session } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await pressAll(press, ['r', 'j', 'j']);

  const selected = session.getSnapshot().selectedRowKey;

  await burst(setup, ['return', 'j']);
  await settle();

  expect(setup.captureCharFrame()).toMatch(/Repo\s+example\/repo/);
  expect(session.getSnapshot().selectedRowKey).toBe(selected);
});

test('search-line keys do nothing in the list when no search is open', async () => {
  const { press, sent, setup, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');
  sent.length = 0;

  await act(async () => {
    setup.mockInput.pressKey('u', { ctrl: true });
  });

  await settle();
  await press('backspace');

  expect(sent).toEqual([]);
});

const slideMilliseconds = 200;

const mountShort = async (height: number) => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: factsEffects(manyAuthors, manyFacts),
    height,
  });

  await mounted.press('r');
  await mounted.settle();

  return mounted;
};

test('in a composer too short for any candidate row Enter and Tab change nothing and Escape closes it', async () => {
  const { press, session } = await mountShort(4);

  await press('f');
  await press('return');
  await press('tab');
  await press('down');
  await press('return');
  await press('tab');

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filterDraft).toBe('');
  expect(session.getSnapshot().filtersOpen).toBe(true);

  await press('escape');

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filterDraft).toBe('');
  expect(session.getSnapshot().filtersOpen).toBe(false);
});

test('f, kind:pr, and Enter in one burst in a composer too short for any candidate row apply nothing', async () => {
  const { session, setup, settle } = await mountShort(4);

  await burst(setup, ['f', 'kind:pr', 'return']);
  await settle();

  expect(session.getSnapshot().filters).toEqual([]);
});

test('ctrl+c quits in a composer too short for any candidate row', async () => {
  const { press, setup, settle, terminalIntents } = await mountShort(4);

  await press('f');

  await act(async () => {
    setup.mockInput.pressKey('c', { ctrl: true });
  });

  await settle();

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
});

test('Enter on the command line closes it and runs a known name with padding', async () => {
  const { press, setup, settle, session } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');
  await press(':');
  await typeText(setup, settle, '  messages ');
  await press('return');

  expect(session.getSnapshot().commandLineOpen).toBe(false);
  expect(setup.captureCharFrame()).toContain('No messages yet');
});

test('Enter on the command line reports an unknown name in a toast', async () => {
  const { press, setup, settle, session, advance } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
    manualTime: true,
  });

  await press('r');
  await press(':');
  await typeText(setup, settle, 'nope');
  await press('return');
  await advance(0);
  await advance(slideMilliseconds);

  expect(session.getSnapshot().commandLineOpen).toBe(false);
  expect(setup.captureCharFrame()).toContain('nope');
});

test('Enter on an empty command line closes it and shows no toast', async () => {
  const { press, setup, session, advance } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
    manualTime: true,
  });

  await press('r');

  const before = setup.captureCharFrame();

  await press(':');
  await press('return');
  await advance(0);
  await advance(slideMilliseconds);

  expect(session.getSnapshot().commandLineOpen).toBe(false);
  expect(setup.captureCharFrame()).toBe(before);
});

test('a key with no command that is not one visible character does not reach the draft', async () => {
  const { setup, settle, press, session } = await mountFilters();

  await press('r');

  await act(async () => {
    setup.mockInput.pressKey('f');
    setup.mockInput.pressArrow('left');
  });

  await settle();

  expect(session.getSnapshot().filtersOpen).toBe(true);
  expect(session.getSnapshot().filterDraft).toBe('');
});

const lastNonEmptyLine = (setup: Setup): string | undefined =>
  setup
    .captureCharFrame()
    .split('\n')
    .findLast((line) => line.trim() !== '');

const addChip = async (mounted: Awaited<ReturnType<typeof mountShort>>, text: string) => {
  await mounted.press('f');
  await typeText(mounted.setup, mounted.settle, text);
  await mounted.press('return');
  await mounted.press('escape');
};

test('with a chip bar the last selected row stays visible', async () => {
  const mounted = await mountShort(9);

  await addChip(mounted, 'kind:pr');
  await mounted.press('G');

  expect(selectedRowText(mounted.setup)).toContain('Change');
  expect(lastNonEmptyLine(mounted.setup)).toContain('? help');
});

test('with kept search text and an open command line the last selected row stays visible', async () => {
  const mounted = await mountShort(9);

  await mounted.press('/');
  await typeText(mounted.setup, mounted.settle, 'Change');
  await mounted.press('return');
  await mounted.press('G');

  expect(selectedRowText(mounted.setup)).toContain('Change');

  await mounted.press(':');

  expect(selectedRowText(mounted.setup)).toContain('Change');
  const lines = mounted.setup.captureCharFrame().split('\n');
  const searchLine = lines.find((line) => line.startsWith('/Change'));
  const commandLine = lines.find((line) => line.startsWith(':'));

  expect(searchLine).not.toContain('PR');
  expect(commandLine).not.toContain('PR');
});

const topics = Array.from({ length: 9 }, (_, index) =>
  treeThread(index + 1, `Fix topic${index + 1}`, { repository: 'acme/app' }),
);

test('with chips and many search completions the status line stays on the last row', async () => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: factsEffects(topics, new Map()),
    height: 7,
  });

  await mounted.press('r');
  await addChip(mounted, 'kind:pr');
  await mounted.press('/');
  await typeText(mounted.setup, mounted.settle, 'topic');

  const lines = mounted.setup.captureCharFrame().split('\n');

  expect(lines[0]).toContain('kind:pr');
  expect(lines.some((line) => line.includes('#1 '))).toBe(true);
  expect(lines.some((line) => line.startsWith('/topic'))).toBe(true);
  expect(lastNonEmptyLine(mounted.setup)).toContain('? help');
});

test.each(['chip', 'search'] as const)(
  'with a %s the open composer keeps the status line on screen in a short terminal',
  async (kind) => {
    const mounted = await mountShort(10);

    if (kind === 'chip') {
      await addChip(mounted, 'author:user00');
    } else {
      await mounted.press('/');
      await typeText(mounted.setup, mounted.settle, 'Change');
      await mounted.press('return');
    }

    await mounted.press('f');
    await typeText(mounted.setup, mounted.settle, 'author:');

    expect(composerInputOf(mounted.setup.captureCharFrame())).toBe('author:');
    expect(lastNonEmptyLine(mounted.setup)).toContain('? help');
  },
);

test('an open command line takes a row from the search completions', async () => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: factsEffects(topics, new Map()),
    height: 9,
  });

  await mounted.press('r');
  await mounted.press('/');
  await typeText(mounted.setup, mounted.settle, 'topic');

  const completionsOf = () =>
    mounted.setup
      .captureCharFrame()
      .split('\n')
      .filter((line) => /^\s+topic\d+\s+1\s*$/.test(line));

  expect(completionsOf()).toHaveLength(4);

  act(() => {
    mounted.session.send({ kind: 'openCommandLine' });
  });

  await mounted.settle();

  const lines = mounted.setup.captureCharFrame().split('\n');

  expect(completionsOf()).toHaveLength(3);
  expect(lines.some((line) => line.startsWith(':'))).toBe(true);
  expect(lastNonEmptyLine(mounted.setup)).toContain('? help');
});

test('an open command line takes a row from the composer', async () => {
  const mounted = await mountShort(10);

  await mounted.press('f');
  await typeText(mounted.setup, mounted.settle, 'author:');

  const authorRowsOf = () =>
    mounted.setup
      .captureCharFrame()
      .split('\n')
      .filter((line) => /author:user\d+/.test(line));

  const before = authorRowsOf().length;

  act(() => {
    mounted.session.send({ kind: 'openCommandLine' });
  });

  await mounted.settle();

  const lines = mounted.setup.captureCharFrame().split('\n');

  expect(before).toBe(6);
  expect(authorRowsOf()).toHaveLength(5);
  expect(lines.some((line) => line.startsWith(':'))).toBe(true);
});

test('a key whose text is several characters is not typed into a filter draft that is still opening', async () => {
  const { setup, settle, press, session } = await mountFilters(undefined, true);

  await press('r');

  await act(async () => {
    setup.mockInput.pressKey('f');
    setup.mockInput.pressKey('\u001B[223;2u');
  });

  await settle();

  expect(session.getSnapshot().filtersOpen).toBe(true);
  expect(session.getSnapshot().filterDraft).toBe('');
  expect(composerInputOf(setup.captureCharFrame())).toBe('');
});

test('a key bound in help, the list, and global runs only the help command, also after a resize', async () => {
  const helpToggle = catalog.filter((command) => command.id === 'help');

  const sharedKey = [
    {
      id: 'globalX',
      label: 'Global x',
      scope: 'global',
      keys: ['x'],
      disabledReason: () => undefined,
      intent: () => ({ kind: 'terminal', action: 'quit' }),
    },
    {
      id: 'listX',
      label: 'List x',
      scope: 'list',
      keys: ['x'],
      disabledReason: () => undefined,
      intent: () => ({ kind: 'ui', action: 'openMessages' }),
    },
    {
      id: 'helpX',
      label: 'Help x',
      scope: 'help',
      keys: ['x'],
      disabledReason: () => undefined,
      intent: () => ({ kind: 'application', intent: { kind: 'closeCommandLine' } }),
    },
  ] satisfies typeof catalog;

  const { press, resize, sent, terminalIntents, setup } = await mount({
    themeMode: 'dark',
    height: 20,
    catalog: [...helpToggle, ...sharedKey],
  });

  await press('?');
  sent.length = 0;
  await press('x');

  expect(sent).toEqual([{ kind: 'closeCommandLine' }]);

  await resize(100, 24);
  await press('x');

  expect(sent).toEqual([{ kind: 'closeCommandLine' }, { kind: 'closeCommandLine' }]);
  expect(terminalIntents).toEqual([]);
  expect(setup.captureCharFrame()).not.toContain('No messages yet');
});

const quitFrom = async (
  open: (mounted: Awaited<ReturnType<typeof mountFilters>>) => Promise<void>,
  mountApp: typeof mountFilters = mountFilters,
) => {
  const mounted = await mountApp();

  await open(mounted);

  mounted.terminalIntents.length = 0;

  await act(async () => {
    mounted.setup.mockInput.pressKey('c', { ctrl: true });
  });

  await mounted.settle();

  return mounted.terminalIntents;
};

test('ctrl+c gives one quit terminal intent from every scope', async () => {
  const openers = {
    list: async () => {},
    help: async ({ press }: { press: (key: string) => Promise<void> }) => press('?'),
    messages: async ({ press, setup, settle }: Awaited<ReturnType<typeof mountFilters>>) => {
      await press(':');
      await typeText(setup, settle, 'messages');
      await press('return');
      expect(setup.captureCharFrame()).toContain('No messages yet');
    },
    confirm: async ({ press, setup }: Awaited<ReturnType<typeof mountFilters>>) => {
      await press('o');
      expect(setup.captureCharFrame()).toContain('Open 4 repos');
    },
    search: async ({ press }: { press: (key: string) => Promise<void> }) => press('/'),
    command: async ({ press }: { press: (key: string) => Promise<void> }) => press(':'),
    filter: async ({ press }: { press: (key: string) => Promise<void> }) => press('f'),
  };

  for (const [name, open] of Object.entries(openers)) {
    const intents = await quitFrom(
      open,
      name === 'confirm' ? () => mountWithGroup() : mountFilters,
    );

    expect({ name, intents }).toEqual({ name, intents: [{ kind: 'terminal', action: 'quit' }] });
  }
});

const movedKeys: Record<string, readonly string[]> = {
  refresh: ['shift+r'],
  help: ['h'],
  confirmOpen: ['a', 'space'],
  applyFilterRow: ['ctrl+j'],
};

const movedKeysCatalog = catalog.map((command) =>
  Object.assign({}, command, { keys: movedKeys[command.id] ?? command.keys }),
);

const signedOutEffects = (threads: typeof threeThreads) => {
  let signedIn = true;

  return {
    effects: feedEffects(() =>
      signedIn ? threads : { ok: false as const, failure: { kind: 'notSignedIn' as const } },
    ),
    signOut: () => {
      signedIn = false;
    },
  };
};

const movedMount = (effects: SessionEffects) =>
  mount({ themeMode: 'dark', effects, width: 100, catalog: movedKeysCatalog });

test('a custom catalog shows its keys in the status line and the refresh notices', async () => {
  const { effects, signOut } = signedOutEffects(threeThreads);
  const { setup, session, press } = await movedMount(effects);

  await press('R');
  signOut();
  await press('R');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('h help');
  expect(frame).toContain('not signed in, press R');
  expect(session.getSnapshot().toast?.lines.join(' ')).toContain('then press R');
});

test('a custom catalog shows its refresh key in the empty-list notice', async () => {
  const { effects, signOut } = signedOutEffects([]);

  signOut();

  const { setup, press } = await movedMount(effects);

  await press('R');

  expect(setup.captureCharFrame()).toContain('then press R');
});

test('a custom catalog shows its keys in the confirm dialog', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: feedEffects(() => fourRepoThreads),
    width: 100,
    catalog: movedKeysCatalog,
  });

  await press('R');
  await press('g');
  await press('o');

  expect(setup.captureCharFrame()).toContain('a or Space to open');
});

test('a custom catalog shows its keys in the filter composer hint', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: factsEffects(filterThreads, filterFacts),
    width: 100,
    catalog: movedKeysCatalog,
  });

  await press('R');
  await press('f');

  expect(setup.captureCharFrame()).toContain('Ctrl+J apply');
});

test('5 then ctrl+c passes one quit terminal intent', async () => {
  const { setup, press, settle, terminalIntents } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await pressAll(press, ['r', '5']);

  await act(async () => {
    setup.mockInput.pressKey('c', { ctrl: true });
  });

  await settle();

  expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
});

test('5 then q passes no quit terminal intent', async () => {
  const { press, terminalIntents } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await pressAll(press, ['r', '5', 'q']);

  expect(terminalIntents).toEqual([]);
});

test('digits typed in the open search line reach the text and the selection stays', async () => {
  const numbered = Array.from({ length: 20 }, (_, index) =>
    makeThread(index + 1, `Item ${index + 1}`),
  );

  const { setup, press, settle, session } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(numbered),
  });

  await press('r');

  const before = session.getSnapshot().selectedRowKey;

  await press('/');
  await typeText(setup, settle, '12');

  expect(setup.captureCharFrame()).toContain('/12');
  expect(session.getSnapshot().selectedRowKey).toBe(before);
});

test('a slash, 5, and j in one burst type 5j into the search line', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await press('r');
  await typeText(setup, settle, '/5j');

  expect(setup.captureCharFrame()).toContain('/5j');
});

test('swapping the keymap A to B to A keeps counts working, drops old layers, and logs no warning', async () => {
  const session = createSession(
    threadsEffects(
      Array.from({ length: 20 }, (_, index) => makeThread(index + 1, `Item ${index + 1}`)),
    ),
  );

  const diagnostics: string[] = [];
  const keymaps: ReturnType<typeof createDefaultOpenTuiKeymap>[] = [];
  const prepended: ((event: KeyEvent) => void)[] = [];
  const swapper: { swap: (index: number) => void } = { swap: () => undefined };

  const Swapper = () => {
    const renderer = useRenderer();

    const pair = useMemo(() => {
      const { keyInput } = renderer;
      const prepend = keyInput.prependListener.bind(keyInput);

      // Records each keymap's key listener so a test can call one keymap alone.
      keyInput.prependListener = ((name: string, listener: (event: KeyEvent) => void) => {
        if (name === 'keypress') {
          prepended.push(listener);
        }

        return prepend(name as 'keypress', listener);
      }) as typeof keyInput.prependListener;

      return [createDefaultOpenTuiKeymap(renderer), createDefaultOpenTuiKeymap(renderer)] as const;
    }, [renderer]);

    const [index, setIndex] = useState(0);

    swapper.swap = setIndex;
    keymaps.splice(0, keymaps.length, ...pair);

    return (
      <App
        session={session}
        catalog={catalog}
        keymap={pair[index] ?? pair[0]}
        themeSource={{ getThemeMode: () => 'dark', subscribe: () => () => undefined }}
        onTerminalIntent={() => undefined}
      />
    );
  };

  const setup = await act(() => testRender(<Swapper />, { width: 60, height: 24 }));

  cleanups.push(() => {
    act(() => {
      setup.renderer.destroy();
    });
  });

  for (const keymap of keymaps) {
    keymap.on('warning', (event) => diagnostics.push(JSON.stringify(event)));
    keymap.on('error', (event) => diagnostics.push(JSON.stringify(event)));
  }

  const settle = () =>
    act(async () => {
      await Bun.sleep(50);
      await setup.renderOnce();
    });

  const swapTo = async (index: number) => {
    await act(() => {
      swapper.swap(index);

      return Promise.resolve();
    });

    await settle();
  };

  const moves: unknown[] = [];
  const send = session.send;

  session.send = (intent) => {
    moves.push(intent);
    send(intent);
  };

  const selectedIndex = () => {
    const snapshot = session.getSnapshot();

    return visibleRows(snapshot).findIndex((row) => row.key === snapshot.selectedRowKey);
  };

  const dispatchTo = async (keymapIndex: number, name: string) => {
    const listener = prepended[keymapIndex];

    if (listener === undefined) {
      throw new Error(`No key listener was recorded for keymap ${keymapIndex}.`);
    }

    await act(() => {
      listener(
        new KeyEvent({
          name,
          sequence: name,
          ctrl: false,
          meta: false,
          shift: false,
          option: false,
          number: false,
          raw: name,
          eventType: 'press',
          source: 'raw',
        }),
      );

      return Promise.resolve();
    });

    await settle();
  };

  const expectStep = async (active: number) => {
    const inactive = 1 - active;
    const start = selectedIndex();

    moves.length = 0;
    await dispatchTo(inactive, 'j');

    expect(moves).toEqual([]);
    expect(selectedIndex()).toBe(start);

    await act(async () => {
      setup.mockInput.pressKey('5');
      setup.mockInput.pressKey('j');
    });

    await settle();

    expect(moves).toEqual([{ kind: 'selectNext', count: 5 }]);
    expect(selectedIndex()).toBe(start + 5);
    moves.length = 0;
  };

  await settle();

  await act(() => {
    session.send({ kind: 'refresh' });

    return Promise.resolve();
  });

  await settle();
  await settle();
  await expectStep(0);
  await swapTo(1);
  await expectStep(1);
  await swapTo(0);
  await expectStep(0);

  expect(diagnostics).toEqual([]);
});
