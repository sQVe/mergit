import { afterEach, expect, test } from 'bun:test';

import { toThreadId } from '../work/work.ts';
import {
  makeThread,
  threadsEffects,
  treeThread,
  queryThreads,
  typeText,
  pressCtrlU,
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

const searchThreads = [
  ...queryThreads,
  treeThread(5, 'Fix yjs sync', { repository: 'acme/editor' }),
  treeThread(6, 'Update docs', { repository: 'acme/yjs' }),
  treeThread(7, 'Document repo: syntax', { repository: 'acme/docs' }),
];

test('Backspace deletes characters in the search line, and on an empty line closes it', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'ab');
  await press('backspace');

  expect(setup.captureCharFrame()).toContain('/a');
  expect(setup.captureCharFrame()).not.toContain('/ab');

  await press('backspace');

  const emptied = setup.captureCharFrame();

  expect(emptied).toContain('/');
  expect(emptied).toContain('4 matches');

  await press('backspace');

  const closed = setup.captureCharFrame();

  expect(closed).not.toContain('matches');

  for (const title of [
    'Mergit pull request',
    'App pull request',
    'Web pull request',
    'App issue',
  ]) {
    expect(closed).toContain(title);
  }
});

test('typing yjs after / shows only threads with yjs in the title or repository', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(searchThreads),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'yjs');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Fix yjs sync');
  expect(frame).toContain('Update docs');
  expect(frame).toContain('acme/yjs');
  expect(frame).not.toContain('Mergit pull request');
  expect(frame).not.toContain('App issue');
  expect(frame).not.toContain('acme/web');
  expect(frame).toContain('/yjs');
  expect(frame).toContain('2 matches');
});

test('repo: after / matches the text repo: and shows no error row', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(searchThreads),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'repo:');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Document repo: syntax');
  expect(frame).not.toContain('Mergit pull request');
  expect(frame).toContain('/repo:');
  expect(frame).toContain('1 match');
  expect(frame).not.toContain('^');
  expect(frame).not.toContain('Missing value');
});

test('Enter keeps the text, Esc while editing restores the old one, Ctrl-U clears the line, and Esc in the list clears', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'issue');
  await press('return');

  const kept = setup.captureCharFrame();

  expect(kept).toContain('App issue');
  expect(kept).not.toContain('Mergit pull request');
  expect(kept).toContain('1 match');

  await press('/');
  await typeText(setup, settle, ' acme');
  await press('escape');

  const restored = setup.captureCharFrame();

  expect(restored).toContain('/issue');
  expect(restored).not.toContain('/issue acme');
  expect(restored).toContain('App issue');

  await press('/');
  await pressCtrlU(setup, settle);

  const cleared = setup.captureCharFrame();

  expect(cleared).toContain('Mergit pull request');
  expect(cleared).not.toContain('/issue');

  await press('return');
  await press('/');
  await typeText(setup, settle, 'issue');
  await press('return');
  await press('escape');

  const listCleared = setup.captureCharFrame();

  expect(listCleared).toContain('Mergit pull request');
  expect(listCleared).not.toContain('/issue');
});

test('d on a group node under a search marks only its matching threads done', async () => {
  const { setup, press, settle, sent } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(queryThreads),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'acme/app');
  await press('return');
  await press('g');

  await press('d');

  const marks = sent.filter((intent) => (intent as { kind: string }).kind === 'markThreadsDone');

  expect(marks).toEqual([
    { kind: 'markThreadsDone', threadIds: [toThreadId('2'), toThreadId('4')] },
  ]);
});

test('under a search with more matches than rows, the last selected row stays fully visible', async () => {
  const many = Array.from({ length: 35 }, (_, index) =>
    makeThread(index + 1, `Match thread ${String(index + 1).padStart(2, '0')}`),
  );

  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(many),
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'Match');
  await press('return');
  await press('G');

  const lines = setup.captureCharFrame().split('\n');
  const rowIndex = lines.findIndex((line) => line.includes('Match thread 35'));
  const queryIndex = lines.findIndex((line) => line.startsWith('/Match'));

  expect(rowIndex).toBeGreaterThanOrEqual(0);
  expect(rowIndex).toBeLessThan(queryIndex);
  expect(lines[rowIndex]).toContain('3h');
});

const topicThreads = Array.from({ length: 9 }, (_, index) =>
  treeThread(index + 1, `Fix topic${index + 1}`, { repository: 'acme/app' }),
);

test('with the search closed and empty the list uses every row above the status line', async () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    makeThread(index + 1, `Thread ${String(index + 1).padStart(2, '0')}`),
  );

  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(many),
    height: 10,
  });

  await press('r');
  await press('G');

  const lines = setup.captureCharFrame().split('\n');

  expect(lines[8]).toContain('Thread 20');
  expect(lines[9]).toContain('? help');
});

test('in a short terminal the completions, the / line, and the status line all fit', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(topicThreads),
    height: 9,
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'topic');

  const lines = setup.captureCharFrame().split('\n');
  const queryIndex = lines.findIndex((line) => line.startsWith('/topic'));
  const completions = lines.filter((line) => /^\s+topic\d+\s+1\s*$/.test(line));

  expect(queryIndex).toBe(7);
  expect(lines[8]).toContain('? help');
  expect(completions).toHaveLength(4);
  expect(lines.slice(3, 7)).toEqual(completions);
});

test('in a terminal with no room for completions the / line keeps its own row above the status line', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(topicThreads),
    height: 4,
  });

  await press('r');
  await press('G');
  await press('/');
  await typeText(setup, settle, 'topic');

  const lines = setup.captureCharFrame().split('\n');

  expect(lines[1]).toContain('Fix topic9');
  expect(lines[2]).toMatch(/^\/topic/);
  expect(lines[3]).toContain('? help');
  expect(lines[0]).not.toMatch(/^\/topic/);
  expect(lines[1]).not.toMatch(/^\/topic/);
});
