import { afterEach, expect, test } from 'bun:test';

import { RGBA } from '@opentui/core';

import { pickPalette } from './palette.ts';
import type { Setup } from './uiHarness.tsx';
import {
  frameLines,
  threadsEffects,
  treeThread,
  typeText,
  track,
  mount as untrackedMount,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const shortHeight = 8;

const mount = track(cleanups, untrackedMount);

const threads = [
  treeThread(1, 'Fix cache', { repository: 'hups-co/platform' }),
  treeThread(2, 'Plan release', { repository: 'acme/app' }),
  treeThread(3, 'Plant docs', { repository: 'acme/app' }),
];

const highlightedAboveLine = (setup: Setup): string[] => {
  const selectedBackground = RGBA.fromHex(pickPalette('dark').selectedBackground).toString();
  const lines = setup.captureSpans().lines.map((line) => line.spans);
  const queryIndex = lines.findIndex((spans) => spans[0]?.text.startsWith('/') === true);

  return lines
    .slice(0, queryIndex)
    .filter((spans) => spans.some((span) => span.bg.toString() === selectedBackground))
    .map((spans) => spans.map((span) => span.text).join(''))
    .filter((text) => text.startsWith('  '));
};

const searchWith = async (typed: string) => {
  const app = await mount('dark', threadsEffects(threads));

  await app.press('r');
  await app.press('/');
  await typeText(app.setup, app.settle, typed);

  return app;
};

test('typing after / lists the repositories that match above the line', async () => {
  const { setup } = await searchWith('pla');

  const lines = frameLines(setup);
  const queryIndex = lines.findIndex((line) => line.startsWith('/pla'));
  const candidateIndex = lines.findLastIndex((line) => line.includes('hups-co/platform'));

  expect(queryIndex).toBeGreaterThanOrEqual(0);
  expect(candidateIndex).toBeLessThan(queryIndex);
  expect(candidateIndex).toBeGreaterThanOrEqual(0);
});

test('tab puts the candidate on the line, narrows the matches, and keeps the typed list with the choice marked', async () => {
  const { setup, press, settle } = await searchWith('pla');

  expect(highlightedAboveLine(setup)).toEqual([]);

  await press('tab');
  await settle();

  const frame = setup.captureCharFrame();
  const lines = frameLines(setup);
  const queryLine = lines.find((line) => line.startsWith('/'));
  const marked = highlightedAboveLine(setup);

  expect(queryLine).toContain('/hups-co/platform');
  expect(frame).toContain('1 match');
  expect(frame).toContain('plant');
  expect(marked).toHaveLength(1);
  expect(marked[0]).toContain('hups-co/platform');
});

test('the best candidate sits directly above the / line, and tab picks it there', async () => {
  const { setup, press, settle } = await searchWith('pla');

  await press('tab');
  await settle();

  const lines = frameLines(setup);
  const queryIndex = lines.findIndex((line) => line.startsWith('/'));
  const queryLine = lines[queryIndex] ?? '';
  const chosen = queryLine.slice(1).split(/\s/)[0] ?? '';

  expect(chosen).not.toBe('');
  expect(lines[queryIndex - 1]).toContain(chosen);
  expect(highlightedAboveLine(setup)[0]).toContain(chosen);
});

test('in a short terminal the rows kept are the best candidates, next to the / line', async () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    treeThread(index + 1, `Fix topic${index + 1}`, { repository: 'acme/app' }),
  );

  const tall = await mount('dark', threadsEffects(many));

  await tall.press('r');
  await tall.press('/');
  await typeText(tall.setup, tall.settle, 'topic');
  await tall.press('tab');
  await tall.settle();

  const tallQuery = frameLines(tall.setup).find((line) => line.startsWith('/')) ?? '';
  const best = tallQuery.slice(1).split(/\s/)[0] ?? '';

  const short = await mount('dark', threadsEffects(many), 60, false, shortHeight);

  await short.press('r');
  await short.press('/');
  await typeText(short.setup, short.settle, 'topic');

  const shortLines = frameLines(short.setup);
  const shortQuery = shortLines.findIndex((line) => line.startsWith('/'));

  const shownAbove = shortLines.slice(0, shortQuery).filter((line) => /topic\d/.test(line));

  expect(best).not.toBe('');
  expect(shownAbove.length).toBeLessThan(6);
  expect(shortLines[shortQuery - 1]).toContain(best);
});

test('the list holds at most 6 candidates', async () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    treeThread(index + 1, `Fix topic${index + 1}`, { repository: 'acme/app' }),
  );

  const { setup, press, settle } = await mount('dark', threadsEffects(many));

  await press('r');
  await press('/');
  await typeText(setup, settle, 'topic');

  const shown = frameLines(setup).filter((line) => /topic\d/.test(line) && !line.startsWith('/'));
  const listed = shown.filter((line) => /\s\d+\s*$/.test(line));

  expect(listed.length).toBe(6);
});

test('without tab, the list narrows by the typed text alone', async () => {
  const { setup, settle } = await searchWith('pla');

  expect(setup.captureCharFrame()).toContain('hups-co/platform');

  await typeText(setup, settle, 'n');

  const frame = setup.captureCharFrame();

  expect(frame).not.toContain('hups-co/platform');
  expect(frame).toContain('plan');
});

test('in a short terminal the completion list leaves the / line and the status line on screen', async () => {
  const app = await mount('dark', threadsEffects(threads), 60, false, 4);

  await app.press('r');
  await app.press('/');
  await typeText(app.setup, app.settle, 'pla');

  const lines = frameLines(app.setup);

  const lastLine = app.setup
    .captureCharFrame()
    .split('\n')
    .filter((line) => line.trim() !== '');

  expect(lines.some((line) => line.startsWith('/pla'))).toBe(true);
  expect(lastLine.at(-1)).toContain('? help');
});
