import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import { catalog } from '../commands.ts';
import type { Setup } from './uiHarness.tsx';
import {
  idleEffects,
  makeThread,
  threadsEffects,
  colorOf,
  statusLineColor,
  selectedRowText,
  threeThreads,
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
  const { setup, press, settle, changeTheme, subscriberCount } = await mount(
    'dark',
    idleEffects,
    60,
    false,
    catalog.length + 10,
  );

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
  const { press, sent } = await mount('dark', threadsEffects(threeThreads));

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
  const { setup, press, resize } = await mount('dark', threadsEffects(threeThreads), 100);

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

  const { setup, press } = await mount('dark', threadsEffects([long]), 90);

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
  const { setup, press } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j', 'j', 'return', '?', 'escape']);

  expect(setup.captureCharFrame()).toMatch(/Repo\s+example\/repo/);
  expect(setup.captureCharFrame()).not.toContain('Third');
});

test('resizing wide shows the side pane and resizing narrow again shows the list, not the detail', async () => {
  const { setup, press, resize } = await mount('dark', threadsEffects(threeThreads));

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
  const { setup, press, settle, terminalIntents } = await mount(
    'dark',
    threadsEffects(queryThreads),
  );

  await press('r');
  await press('/');
  await typeText(setup, settle, 'q');

  expect(terminalIntents).toEqual([]);
  expect(setup.captureCharFrame()).toContain('/q');
});

test('ctrl+c quits while the search line is open and q still types', async () => {
  const { setup, press, settle, terminalIntents } = await mount(
    'dark',
    threadsEffects(queryThreads),
  );

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
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 80, false, 30);
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
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 6);
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
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 4);
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
  const { setup, settle, press } = await mountFilters(60, true);

  await press('r');
  await burst(setup, ['f', 'kind:pr', 'return']);
  await settle();

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).toContain('kind:pr');
  expect(composerInputOf(frame)).toBe('');
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

test('text typed in the same burst after Enter starts a new draft', async () => {
  const { setup, settle, press, session } = await mountFilters();

  await press('f');
  await burst(setup, ['kind:pr', 'return', 'author:octo']);
  await settle();

  expect(session.getSnapshot().filters).toEqual([{ field: 'kind', value: 'pr', negated: false }]);
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
  const { setup, press, settle, session } = await mount(
    'dark',
    threadsEffects(threeThreads),
    80,
    false,
    24,
  );

  await pressAll(press, ['r', 'j']);

  const selected = session.getSnapshot().selectedRowKey;

  await burst(setup, ['?', 'j']);
  await settle();

  expect(setup.captureCharFrame()).toMatch(/2-\d+ of \d+/);
  expect(session.getSnapshot().selectedRowKey).toBe(selected);
});

test('? twice in one burst leaves help closed', async () => {
  const { setup, settle } = await mount('dark', threadsEffects(threeThreads), 80, false, 24);

  await burst(setup, ['?', '?']);
  await settle();

  expect(setup.captureCharFrame()).not.toMatch(/\d+-\d+ of \d+/);
});

test('Enter and j in one burst open the detail and leave the list selection alone', async () => {
  const { setup, press, settle, session } = await mount('dark', threadsEffects(threeThreads));

  await pressAll(press, ['r', 'j', 'j']);

  const selected = session.getSnapshot().selectedRowKey;

  await burst(setup, ['return', 'j']);
  await settle();

  expect(setup.captureCharFrame()).toMatch(/Repo\s+example\/repo/);
  expect(session.getSnapshot().selectedRowKey).toBe(selected);
});
