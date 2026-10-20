import { afterEach, expect, test } from 'bun:test';

import { RGBA } from '@opentui/core';

import type { createSession } from '../session/session.ts';
import { describeFilterRow, filterCursorOf, filterRowsOf } from '../session/session.ts';
import { pickPalette } from './palette.ts';
import {
  threadsEffects,
  treeThread,
  factsEffects,
  typeText,
  pressCtrlU,
  filterThreads,
  filterFacts,
  composerInputOf,
  pressBackspace,
  manyAuthors,
  manyFacts,
  track,
  mountFilters as untrackedMountFilters,
  mount as untrackedMount,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mountFilters = track(cleanups, untrackedMountFilters);

const mount = track(cleanups, untrackedMount);

const addAuthorChip = async (mounted: Awaited<ReturnType<typeof mountFilters>>, text: string) => {
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, text);
  await press('return');
  await press('f');
};

test('f lists author candidates with their counts', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'author:');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/author:octo\s+2/);
  expect(frame).toMatch(/author:mona\s+1/);
});

test('Enter on a candidate adds a chip and narrows the list', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'author:mona');
  await press('return');

  expect(mounted.session.getSnapshot().filtersOpen).toBe(false);

  const frame = setup.captureCharFrame();
  const chipRow = frame.split('\n')[0] ?? '';

  expect(chipRow).toContain('author:mona');
  expect(frame).toContain('Gamma change');
  expect(frame).not.toContain('Alpha change');
  expect(frame).not.toContain('Beta change');
});

test('a field name that is an object key keeps the composer on screen and the list returns after Esc', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, '__proto__:');

  const protoLines = setup.captureCharFrame().split('\n');

  expect(composerInputOf(setup.captureCharFrame())).toBe('__proto__:');
  expect(protoLines.some((line) => line.includes('Alpha change'))).toBe(false);

  await press('escape');

  expect(setup.captureCharFrame()).toContain('Alpha change');

  const second = await mountFilters();

  await second.press('f');
  await typeText(second.setup, second.settle, 'constructor:');

  const constructorFrame = second.setup.captureCharFrame();

  expect(composerInputOf(constructorFrame)).toBe('constructor:');
  expect(constructorFrame).not.toContain('function');
});

test('an invalid age shows an error after Enter and adds no chip', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'age:>3');

  expect(setup.captureCharFrame()).not.toContain('age takes');

  await press('return');

  expect(setup.captureCharFrame()).toContain('age takes');

  await press('escape');

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).not.toContain('age:');
  expect(frame).toContain('Alpha change');
  expect(frame).toContain('Gamma change');
});

test('Tab on a chip edits it and Enter replaces it', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');

  expect(composerInputOf(setup.captureCharFrame())).toBe('author:mona');

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'author:octo');
  await press('return');
  await press('escape');

  const frame = setup.captureCharFrame();
  const chipRow = frame.split('\n')[0] ?? '';

  expect(chipRow).toContain('author:octo');
  expect(chipRow).not.toContain('author:mona');
  expect(frame).toContain('Alpha change');
  expect(frame).not.toContain('Gamma change');
});

test('Esc during an edit keeps the old chip', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');
  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'author:octo');
  await press('escape');

  expect(composerInputOf(setup.captureCharFrame())).toBe('');

  await press('escape');

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).toContain('author:mona');
  expect(frame).toContain('Gamma change');
  expect(frame).not.toContain('Alpha change');
});

test('Backspace on an empty draft closes the composer', async () => {
  const { setup, press } = await mountFilters();

  await press('f');

  expect(setup.captureCharFrame()).toContain('author');

  await press('backspace');

  const frame = setup.captureCharFrame();

  expect(frame).not.toContain('author');
  expect(frame).toContain('Alpha change');
});

test('F clears all chips', async () => {
  const mounted = await mountFilters();
  const { setup, press } = mounted;

  await addAuthorChip(mounted, 'author:mona');

  expect(setup.captureCharFrame()).not.toContain('Alpha change');

  await press('escape');
  await press('F');

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).not.toContain('author:');
  expect(frame).toContain('Alpha change');
  expect(frame).toContain('Gamma change');
});

test('Backspace on an empty draft during an edit closes the composer and keeps the chip', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('tab');
  await pressCtrlU(setup, settle);
  await pressBackspace(setup, settle);

  const frame = setup.captureCharFrame();

  expect(frame.split('\n')[0]).toContain('author:mona');
  expect(frame).not.toContain('fauthor');
  expect(frame).toContain('Gamma change');

  await press('j');

  expect(composerInputOf(setup.captureCharFrame())).toBeUndefined();
});

test('Esc during an edit cancels the edit and leaves the composer open', async () => {
  const mounted = await mountFilters();
  const { setup, press } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');
  await press('escape');
  await press('j');

  expect(composerInputOf(setup.captureCharFrame())).toBe('j');
});

test('-, f, j, and F typed in the composer go into the draft and run no list command', async () => {
  const mounted = await mountFilters();
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await typeText(setup, settle, '-fjF');

  const frame = setup.captureCharFrame();

  expect(composerInputOf(frame)).toBe('-fjF');
  expect(frame.split('\n')[0]).toContain('author:mona');
  expect(frame).not.toContain('Alpha change');
  await press('escape');
});

test('Backspace on a non-empty draft deletes a character and keeps the composer open', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'ab');
  await pressBackspace(setup, settle);

  const frame = setup.captureCharFrame();

  expect(composerInputOf(frame)).toBe('a');

  await typeText(setup, settle, 'u');

  expect(composerInputOf(setup.captureCharFrame())).toBe('au');
});

test('moving the cursor past the last shown candidate scrolls the list', async () => {
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 40);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'author:');

  await press('down');

  const selectedBackground = RGBA.fromHex(pickPalette('dark').selectedBackground).toString();

  const cursorText = (): string | undefined =>
    setup
      .captureSpans()
      .lines.map((line) => line.spans)
      .filter((spans) => spans.some((span) => span.bg.toString() === selectedBackground))
      .map((spans) => spans.map((span) => span.text).join(''))
      .find((text) => text.includes('author:user'));

  const firstCandidate = cursorText()?.match(/author:user\d+/)?.[0];

  for (let step = 0; step < 10; step += 1) {
    await press('down');
  }

  const movedTo = cursorText()?.match(/author:user\d+/)?.[0];
  const candidateLines = setup.captureCharFrame().split('\n');

  const firstStillShown = candidateLines.some(
    (line) => firstCandidate !== undefined && line.includes(firstCandidate),
  );

  expect(firstCandidate).toBeDefined();
  expect(movedTo).toBeDefined();
  expect(movedTo).not.toBe(firstCandidate);
  expect(firstStillShown).toBe(false);
});

test('in a short terminal the composer keeps the input, a candidate, and the status line visible', async () => {
  const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 60, false, 9);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'author:');

  const lines = setup.captureCharFrame().split('\n');

  expect(composerInputOf(lines.join('\n'))).toBe('author:');
  expect(lines.at(-2)).toContain('? help');
  expect(lines.some((line) => /author:user00\s+1/.test(line))).toBe(true);
});

test('the composer box sits on the top row with no chips and has no prompt', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'ab');

  const lines = setup.captureCharFrame().split('\n');

  expect(lines[0]).toContain('─ Filter ─');
  expect(lines[1]?.startsWith('│ ab')).toBe(true);
});

test('the composer box sits directly under the chip bar', async () => {
  const mounted = await mountFilters();

  await addAuthorChip(mounted, 'author:mona');

  const lines = mounted.setup.captureCharFrame().split('\n');

  expect(lines[0]).toContain('author:mona');
  expect(lines[1]).toContain('─ Filter ─');
});

test('a draft that matches no row shows a No matches row that Enter cannot apply', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'zzzqq');

  expect(setup.captureCharFrame()).toContain('No matches');

  await press('return');
  await press('escape');

  expect(setup.captureCharFrame().split('\n')[0]).not.toContain('zzzqq');
});

test('an empty draft shows the key hints, and a field with a colon shows its value form', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');

  expect(setup.captureCharFrame()).toContain('Enter apply · Tab edit · - exclude · Esc close');

  await typeText(setup, settle, 'kind:');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('pr, issue, release, discussion, commit, or ci');
  expect(frame).not.toContain('Enter apply');
});

test('the box title names the chip being edited', async () => {
  const mounted = await mountFilters();
  const { setup, press } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await press('down');
  await press('tab');

  expect(setup.captureCharFrame()).toContain('Filter · editing author:mona');

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('editing');
});

test('a label wider than the box ends with an ellipsis and keeps the field prefix', async () => {
  const login = 'a'.repeat(70);
  const threads = [treeThread(1, 'Change 1', { repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: login }]]);
  const { setup, press, settle } = await mount('dark', factsEffects(threads, facts), 50);

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'author:');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/author:aaaa+…/);
  expect(frame).not.toContain(login);
});

const innerOf = (line: string | undefined): string => (line ?? '').replace(/^│|│$/g, '').trim();

const descriptionLineOf = (frame: string): string => {
  const lines = frame.split('\n');
  const bottom = lines.findIndex((line) => line.startsWith('╰'));

  return (lines[bottom - 1] ?? '').replace(/^│/, '').replace(/│$/, '').trim();
};

const selectedDescriptionOf = (session: ReturnType<typeof createSession>): string => {
  const snapshot = session.getSnapshot();

  return describeFilterRow(snapshot, filterRowsOf(snapshot)[filterCursorOf(snapshot)]);
};

test('the last line of the box describes the selected row, or the field being typed', async () => {
  const threads = [treeThread(1, 'Change 1', { reason: 'ci_activity', repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: 'sQVe' }]]);

  const { setup, press, settle, session } = await mount(
    'dark',
    factsEffects(threads, facts),
    90,
    false,
    30,
  );

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'reason:ci');

  const reasonLine = descriptionLineOf(setup.captureCharFrame());

  const reasonField = describeFilterRow(session.getSnapshot(), { kind: 'field', field: 'reason' });

  expect(reasonLine).not.toBe('');
  expect(reasonLine).toBe(selectedDescriptionOf(session));
  expect(reasonLine).not.toBe(reasonField);

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'author:sQVe');

  const authorLine = descriptionLineOf(setup.captureCharFrame());

  expect(authorLine).toBe(selectedDescriptionOf(session));
  expect(authorLine).toContain('sQVe');
  expect(authorLine).toContain('1 in your inbox');
  expect(authorLine).not.toBe(reasonLine);
});

test('a description that does not fit ends with an ellipsis', async () => {
  const threads = [treeThread(1, 'Change 1', { reason: 'state_change', repository: 'acme/app' })];
  const { setup, press, settle } = await mount('dark', threadsEffects(threads), 40, false, 30);

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'reason:state_change');

  expect(descriptionLineOf(setup.captureCharFrame())).toMatch(/…$/);
});

test('a draft that is only a partial value shows no No matches row', async () => {
  const { setup, press, settle } = await mountFilters();

  await press('f');
  await typeText(setup, settle, 'age:>3');

  expect(setup.captureCharFrame()).not.toContain('No matches');
});

test('in a short terminal the description line stays and the key hint row goes', async () => {
  const { setup, press, settle } = await mount(
    'dark',
    factsEffects(filterThreads, filterFacts),
    90,
    false,
    7,
  );

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'repo:');

  const frame = setup.captureCharFrame();

  expect(descriptionLineOf(frame)).not.toBe('');
  expect(frame).not.toContain('owner/name, one * allowed');
});

test('the input line uses the full inner width of the box', async () => {
  const { setup, press, settle } = await mountFilters(100);

  await press('f');
  await typeText(setup, settle, 'x'.repeat(90));

  expect(composerInputOf(setup.captureCharFrame())).toBe('x'.repeat(90));
});

test('a plain-word draft that matches nothing points to the / search', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');
  await typeText(setup, settle, 'zzzqq');

  expect(setup.captureCharFrame()).toContain('Use / to search titles');
});

test('after Enter removes a chip found by typing, a second Enter removes the next chip', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle, session } = mounted;

  await press('f');
  await typeText(setup, settle, 'author:octo');
  await press('return');
  await press('f');
  await typeText(setup, settle, 'author:mona');
  await press('return');
  await press('f');
  await typeText(setup, settle, 'author:octo');
  await press('return');

  expect(session.getSnapshot().filters).toEqual([
    { field: 'author', value: 'mona', negated: false },
  ]);

  expect(session.getSnapshot().filtersOpen).toBe(true);

  await press('return');

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filtersOpen).toBe(true);
});

test('a long description wraps over several lines and never over more than three', async () => {
  const threads = [treeThread(1, 'Change 1', { reason: 'state_change', repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: 'sQVe' }]]);
  const { setup, press, settle } = await mount('dark', factsEffects(threads, facts), 50, false, 30);

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, '-reason:state_change');

  const lines = setup.captureCharFrame().split('\n');
  const bottom = lines.findIndex((line) => line.startsWith('╰'));
  expect(innerOf(lines[bottom - 3])).toMatch(/^Hides/);
  expect(innerOf(lines[bottom - 2])).not.toBe('');
  expect(innerOf(lines[bottom - 1])).toMatch(/…$/);
  expect(innerOf(lines[bottom - 4])).not.toMatch(/Hides/);
});

test('author:@me shows its own text, and -kind:pr says it hides pull requests', async () => {
  const { setup, press, settle, session } = await mountFilters(120);

  await press('f');
  await typeText(setup, settle, 'author:@me');

  const meLine = descriptionLineOf(setup.captureCharFrame());

  expect(meLine).not.toBe('');
  expect(meLine).toBe(selectedDescriptionOf(session));
  expect(meLine).not.toMatch(/\d+ in your inbox/);

  const authorField = describeFilterRow(session.getSnapshot(), { kind: 'field', field: 'author' });

  expect(meLine).not.toBe(authorField);

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'kind:pr');

  const positiveLine = descriptionLineOf(setup.captureCharFrame());

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, '-kind:pr');

  const negatedLine = descriptionLineOf(setup.captureCharFrame());

  expect(positiveLine).toContain('Pull requests');
  expect(positiveLine).not.toMatch(/^Hides/);
  expect(negatedLine).toMatch(/^Hides/);
  expect(negatedLine).toContain(positiveLine);
});

test('a label exactly as wide as its room shows in full with no ellipsis and no count', async () => {
  const { setup, press, settle } = await mountFilters(13);

  await press('f');
  await typeText(setup, settle, 'auth');

  const rows = setup.captureCharFrame().split('\n').map(innerOf);

  expect(rows).toContain('author:');
});

test('a field row shows no count after its label', async () => {
  const { setup, press, settle } = await mountFilters(60);

  await press('f');
  await typeText(setup, settle, 'auth');

  const row = setup
    .captureCharFrame()
    .split('\n')
    .find((line) => line.includes('author:'));

  expect(innerOf(row)).toBe('author:');
});

const boxRowsOf = (frame: string): string[] => {
  const lines = frame.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╭'));
  const bottom = lines.findIndex((line) => line.startsWith('╰'));

  return lines.slice(top + 1, bottom).map(innerOf);
};

const describedOf = async (
  width: number,
  height: number,
  draft: string,
  rowCount: number,
): Promise<{ rows: string[]; text: string }> => {
  const threads = [treeThread(1, 'Change 1', { reason: 'ci_activity', repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: 'sQVe' }]]);

  const { setup, press, settle, session } = await mount(
    'dark',
    factsEffects(threads, facts),
    width,
    false,
    height,
  );

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, draft);

  return {
    rows: boxRowsOf(setup.captureCharFrame()).slice(-rowCount),
    text: selectedDescriptionOf(session),
  };
};

const composerChrome = 4;

const mountFiltersFor = async (draft: string) => {
  const threads = [treeThread(1, 'Change 1', { reason: 'ci_activity', repository: 'acme/app' })];
  const facts = new Map([['1', { state: 'open' as const, author: 'sQVe' }]]);
  const mounted = await mount('dark', factsEffects(threads, facts), 60, false, 30);

  await mounted.press('r');
  await mounted.settle();
  await mounted.press('f');
  await typeText(mounted.setup, mounted.settle, draft);

  return mounted;
};

const wordsOf = (text: string): string[] => text.split(' ');

test('a description line exactly as wide as the box is neither broken nor cut', async () => {
  const { text } = await describedOf(60, 30, 'author:sQVe', 1);
  const firstFour = wordsOf(text).slice(0, 4).join(' ');
  const { rows } = await describedOf(firstFour.length + composerChrome, 30, 'author:sQVe', 3);

  expect(rows[0]).toBe(firstFour);
  expect(rows).toHaveLength(3);
  expect(rows.join(' ')).toBe(text);
});

test('a description of more than three lines ends the third line with an ellipsis', async () => {
  const { setup, resize, settle, session } = await mountFiltersFor('author:sQVe');
  const text = selectedDescriptionOf(session);
  const narrowest = wordsOf(text).slice(0, 2).join(' ').length;
  let cutAtFullWidth = false;

  for (let inner = narrowest; inner <= narrowest + 4; inner += 1) {
    await resize(inner + composerChrome, 30);
    await settle();

    const rows = boxRowsOf(setup.captureCharFrame()).slice(-3);

    expect(rows.every((row) => row !== '' && row.length <= inner)).toBe(true);

    if (rows.join(' ') === text) {
      continue;
    }

    const kept = rows.slice(0, 2).join(' ');

    expect(rows[2]?.endsWith('…')).toBe(true);
    expect(text.startsWith(`${kept} ${rows[2]?.slice(0, -1)}`)).toBe(true);
    cutAtFullWidth ||= rows[2]?.length === inner;
  }

  expect(cutAtFullWidth).toBe(true);
});

test('a short terminal limits the description to the lines it has room for', async () => {
  const one = await describedOf(30, 6, 'author:sQVe', 1);
  const two = await describedOf(30, 7, 'author:sQVe', 2);
  const inner = 30 - composerChrome;

  expect(one.rows).toHaveLength(1);
  expect(one.rows[0]?.length).toBeLessThanOrEqual(inner);
  expect(one.rows[0]?.endsWith('…')).toBe(true);
  expect(one.text.startsWith(one.rows[0]?.slice(0, -1) ?? '')).toBe(true);

  expect(two.rows).toHaveLength(2);
  expect(two.rows[1]?.length).toBeLessThanOrEqual(inner);
  expect(two.rows[1]?.endsWith('…')).toBe(true);
  expect(two.text.startsWith(`${two.rows[0]} ${two.rows[1]?.slice(0, -1)}`)).toBe(true);
});

test('a word wider than the box ends with an ellipsis on a line of its own', async () => {
  const token = 'abcdefghij'.repeat(4);
  const { rows } = await describedOf(40, 30, `author:${token}`, 3);
  const inner = 40 - composerChrome;

  expect(rows.find((row) => row.includes('abcdefghij'))).toBe(`${token.slice(0, inner - 1)}…`);
  expect(rows.every((row) => row !== '')).toBe(true);
});

test('a word exactly as wide as the box shows in full', async () => {
  const token = 'abcdefghij'.repeat(4);
  const probe = await describedOf(100, 30, `author:${token}`, 1);
  const word = wordsOf(probe.text).find((candidate) => candidate.includes(token)) ?? '';
  const { rows } = await describedOf(word.length + composerChrome, 30, `author:${token}`, 3);

  expect(rows).toContain(word);
  expect(rows.some((row) => row.endsWith('…'))).toBe(false);
});

test('a first word wider than the box leaves no empty line above it', async () => {
  const { rows, text } = await describedOf(7, 30, 'author:x', 3);
  const inner = 7 - composerChrome;
  const words = wordsOf(text);

  expect(rows.every((row) => row !== '')).toBe(true);
  expect(rows[0]).toBe(words[0]?.slice(0, inner));
  expect(rows[1]).toBe(words[1]?.slice(0, inner));
  expect(rows[2]).toHaveLength(inner);
  expect(rows[2]?.endsWith('…')).toBe(true);
});

test('a row without a description shows no description line and no blank line', async () => {
  const rows = (await describedOf(40, 30, 'zzzqq', 3)).rows;

  expect(rows[0]).toBe('zzzqq');
  expect(rows).toHaveLength(3);
  expect(rows[2]).toContain('No matches');
});

test('a typed row lists the text of its filters', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');
  await typeText(setup, settle, 'author:octo kind:pr');

  const lines = setup.captureCharFrame().split('\n');

  expect(lines.some((line) => /^│\s+author:octo kind:pr\s+2\s*│$/.test(line))).toBe(true);
});

const tickCount = (frame: string): number => frame.split('✓').length - 1;

test('the check mark shows only on rows for chips already applied', async () => {
  const mounted = await mountFilters(80);
  const { setup, press, settle } = mounted;

  await addAuthorChip(mounted, 'author:mona');
  await typeText(setup, settle, 'author:');

  const valueRows = setup.captureCharFrame().split('\n');

  expect(valueRows.filter((line) => line.includes('✓'))).toHaveLength(1);
  expect(valueRows.find((line) => line.includes('✓'))).toContain('author:mona');

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'auth');

  const fieldFrame = setup.captureCharFrame();

  expect(fieldFrame.split('\n').map(innerOf)).toContain('author:');
  expect(tickCount(fieldFrame)).toBe(1);

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'author:mona kind:pr');

  expect(tickCount(setup.captureCharFrame())).toBe(0);

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'age:>3');
  await press('return');

  const errorFrame = setup.captureCharFrame();

  expect(errorFrame).toContain('age takes');
  expect(tickCount(errorFrame)).toBe(0);

  await pressCtrlU(setup, settle);
  await typeText(setup, settle, 'octo');

  const plainFrame = setup.captureCharFrame();

  expect(plainFrame).toContain('author:octo');
  expect(tickCount(plainFrame)).toBe(0);
});

test('a draft with leading spaces still shows the value hint of its field', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');
  await typeText(setup, settle, '  age:');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('<N or >N with m h d w');
  expect(frame).not.toContain('Enter apply');
});

test('a draft that matches rows lists them and shows no No matches row', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');
  await typeText(setup, settle, 'mona');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/author:mona\s+1/);
  expect(frame).not.toContain('No matches');
});

test.each([5, 6, 7, 8, 9, 10, 11, 12])(
  'in a terminal %i rows tall the composer keeps the input, a candidate, and the status line',
  async (height) => {
    const mounted = await mount('dark', factsEffects(manyAuthors, manyFacts), 40, false, height);
    const { setup, press, settle } = mounted;

    await press('r');
    await settle();
    await press('f');
    await typeText(setup, settle, 'author:');

    const frame = setup.captureCharFrame();
    const lines = frame.split('\n');
    const shown = lines.filter((line) => /author:user\d+/.test(line));
    const lone = lines.filter((line) => innerOf(line) === '…');

    expect(composerInputOf(frame)).toBe('author:');
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(lone).toEqual([]);
    expect(lines.findLast((line) => line.trim() !== '')).toContain('? help');
  },
);

test('a field name with a dash inside shows the key hints, not the value form of the field without the dash', async () => {
  const { setup, press, settle } = await mountFilters(80);

  await press('f');
  await typeText(setup, settle, 'sta-te:');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Enter apply');
  expect(frame).not.toContain('open, closed, or merged');
});

test('a candidate with wide text ends in an ellipsis within the composer width', async () => {
  const wideFacts = new Map([['1', { state: 'open' as const, author: '界'.repeat(60) }]]);
  const mounted = await mount('dark', factsEffects(manyAuthors, wideFacts), 60, false, 40);
  const { setup, press, settle } = mounted;

  await press('r');
  await settle();
  await press('f');
  await typeText(setup, settle, 'author:');

  const row = setup
    .captureCharFrame()
    .split('\n')
    .find((line) => line.includes('author:界'));

  expect(row).toBeDefined();
  expect(row).toMatch(/…\s+\d+\s*│/);
  expect(row).not.toMatch(/\uFFFD|[\uD800-\uDFFF]/u);
  expect(Bun.stringWidth(row ?? '')).toBeLessThanOrEqual(60);
});
