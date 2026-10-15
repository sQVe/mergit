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

const mount = track(cleanups, untrackedMount);

const threads = [
  treeThread(1, 'Fix cache', { repository: 'hups-co/platform' }),
  treeThread(2, 'Plan release', { repository: 'acme/app' }),
  treeThread(3, 'Plant docs', { repository: 'acme/app' }),
];

const highlightedBelowLine = (setup: Setup): string[] => {
  const selectedBackground = RGBA.fromHex(pickPalette('dark').selectedBackground).toString();
  const lines = setup.captureSpans().lines.map((line) => line.spans);
  const queryIndex = lines.findIndex((spans) => spans[0]?.text.startsWith('/') === true);

  return lines
    .slice(queryIndex + 1)
    .filter((spans) => spans.some((span) => span.bg.toString() === selectedBackground))
    .map((spans) => spans.map((span) => span.text).join(''));
};

const searchWith = async (typed: string) => {
  const app = await mount('dark', threadsEffects(threads));

  await app.press('r');
  await app.press('/');
  await typeText(app.setup, app.settle, typed);

  return app;
};

test('typing after / lists the repositories that match under the line', async () => {
  const { setup } = await searchWith('pla');

  const lines = frameLines(setup);
  const queryIndex = lines.findIndex((line) => line.startsWith('/pla'));
  const candidateIndex = lines.findLastIndex((line) => line.includes('hups-co/platform'));

  expect(queryIndex).toBeGreaterThanOrEqual(0);
  expect(candidateIndex).toBeGreaterThan(queryIndex);
});

test('tab puts the candidate on the line, narrows the matches, and keeps the typed list with the choice marked', async () => {
  const { setup, press, settle } = await searchWith('pla');

  expect(highlightedBelowLine(setup)).toEqual([]);

  await press('tab');
  await settle();

  const frame = setup.captureCharFrame();
  const lines = frameLines(setup);
  const queryLine = lines.find((line) => line.startsWith('/'));
  const marked = highlightedBelowLine(setup);

  expect(queryLine).toContain('/hups-co/platform');
  expect(frame).toContain('1 match');
  expect(frame).toContain('plant');
  expect(marked).toHaveLength(1);
  expect(marked[0]).toContain('hups-co/platform');
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
