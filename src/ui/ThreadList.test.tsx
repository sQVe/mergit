import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import type { Setup } from './uiHarness.tsx';
import {
  makeThread,
  feedEffects,
  threadsEffects,
  selectedRowText,
  threeThreads,
  savedEffects,
  treeThread,
  frameLines,
  pressAll,
  typeText,
  newMarkerThreads,
  newMarkerEffects,
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

test('r sends a refresh and the rows show type, number, title, and age', async () => {
  const { setup, press, sent } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');

  const frame = setup.captureCharFrame();

  expect(sent).toEqual([{ kind: 'refresh' }]);
  expect(frame).toMatch(/PR\s+#1\s+First\s+3h/);
  expect(frame).toContain('Second');
  expect(frame).toContain('Third');
});

test('j and k move the selected row', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');
  await press('j');
  await press('j');
  expect(selectedRowText(setup)).toContain('First');

  await press('j');
  expect(selectedRowText(setup)).toContain('Second');

  await press('j');
  await press('k');
  expect(selectedRowText(setup)).toContain('Second');
});

test('a refresh keeps the selection on the same thread when it still exists', async () => {
  let threads = threeThreads;

  const effects = feedEffects(() => threads);

  const { setup, press } = await mount({ themeMode: 'dark', effects });

  await press('r');
  await press('j');
  await press('j');
  await press('j');
  threads = [makeThread(0, 'Newest'), ...threeThreads];
  await press('r');

  expect(selectedRowText(setup)).toContain('Second');
});

test('the selected row stays in view when the list is taller than the screen', async () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    makeThread(index + 1, `Thread ${index + 1}`),
  );

  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(many),
  });

  await press('r');

  await act(async () => {
    for (let step = 0; step < 32; step += 1) {
      setup.mockInput.pressKey('j');
    }
  });

  await settle();

  expect(selectedRowText(setup)).toContain('Thread 31');
});

test('saved rows show their age relative to the saved time', async () => {
  const savedAt = new Date(Date.now() - 3 * 3_600_000);
  const updatedAt = new Date(savedAt.getTime() - 2 * 3_600_000).toISOString();
  const thread = { ...makeThread(1, 'First'), updatedAt };
  const { setup } = await mount({ themeMode: 'dark', effects: savedEffects(savedAt, [thread]) });

  expect(setup.captureCharFrame()).toMatch(/PR\s+#1\s+First\s+2h/);
});

const treeThreads = [
  treeThread(1, 'Fix parser', {
    reason: 'review_requested',
    repository: 'example/alpha',
    updatedAt: '1970-01-01T01:00:00Z',
  }),
  treeThread(2, 'Add cache', {
    reason: 'review_requested',
    repository: 'example/alpha',
    updatedAt: '1970-01-01T00:30:00Z',
  }),
  treeThread(3, 'Crash on start', {
    reason: 'mention',
    repository: 'example/beta',
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/example/beta/issues/3',
    updatedAt: '1970-01-01T00:20:00Z',
  }),
  treeThread(4, 'Release v1', {
    reason: 'subscribed',
    repository: 'example/beta',
    subjectType: 'Release',
    subjectUrl: 'https://api.github.com/repos/example/beta/releases/4',
    updatedAt: '1970-01-01T00:10:00Z',
  }),
  treeThread(5, 'Stale crash', {
    reason: 'mention',
    repository: 'example/beta',
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/example/beta/issues/5',
    updatedAt: '1970-01-01T00:05:00Z',
  }),
];

test('the list shows threads under their group and repo in reason order, releases in their own group', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await press('r');

  const lines = frameLines(setup).slice(0, 11);

  expect(lines[0]).toMatch(/^▾ Review requested 2$/);
  expect(lines[1]).toMatch(/^│ ▾ example\/alpha 2$/);
  expect(lines[2]).toMatch(/^│ │ ├─\s*PR\s+#1\s+Fix parser\s+2h$/);
  expect(lines[3]).toMatch(/^│ │ └─\s*PR\s+#2\s+Add cache\s+2h$/);
  expect(lines[4]).toMatch(/^▾ Mention 2$/);
  expect(lines[5]).toMatch(/^│ ▾ example\/beta 2$/);
  expect(lines[6]).toMatch(/^│ │ ├─\s*ISS\s+#3\s+Crash on start\s+2h$/);
  expect(lines[7]).toMatch(/^│ │ └─\s*ISS\s+#5\s+Stale crash\s+2h$/);
  expect(lines[8]).toMatch(/^▾ Release 1$/);
  expect(lines[9]).toMatch(/^│ ▾ example\/beta 1$/);
  expect(lines[10]).toMatch(/^│ │ └─\s*REL\s+Release v1\s+2h$/);
});

const selectedLine = (setup: Setup): string | undefined => selectedRowText(setup)?.trim();

test('folding a node hides its children and keeps its count', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'j', 'z']);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('│ ▸ example/alpha 2');
  expect(frame).not.toContain('Fix parser');
  expect(frame).not.toContain('Add cache');
  expect(frame).toContain('Crash on start');
  expect(selectedLine(setup)).toStartWith('│ ▸ example/alpha 2');

  await press('z');

  expect(setup.captureCharFrame()).toContain('Fix parser');
  expect(setup.captureCharFrame()).toContain('│ ▾ example/alpha 2');
});

test('s regroups by type, then none, then reason, and keeps the selection on the same thread', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'j', 'j']);
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('s');

  const byType = frameLines(setup);

  expect(byType[0]).toBe('▾ Pull requests 2');
  expect(byType).toContain('▾ Issues 2');
  expect(byType).toContain('▾ Releases 1');
  expect(byType).toContain('│ ▾ example/alpha 2');
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('s');

  const ungrouped = frameLines(setup);

  expect(ungrouped.filter((line) => /^\s*(PR|ISS|REL)\s/.test(line))).toHaveLength(
    treeThreads.length,
  );

  expect(ungrouped.some((line) => /[│├└▾▸]/.test(line))).toBe(false);
  expect(ungrouped.some((line) => line.includes('Pull requests'))).toBe(false);
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('s');

  expect(frameLines(setup)[0]).toBe('▾ Review requested 2');
  expect(selectedLine(setup)).toContain('Fix parser');
});

test('the flat list shows each thread with its repository and no guide or branch', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 's', 's']);

  const lines = frameLines(setup).slice(0, 5);

  expect(lines[0]).toMatch(/^\s*PR\s+#1\s+example\/alpha\s+Fix parser\s+2h$/);
  expect(lines[1]).toMatch(/^\s*PR\s+#2\s+example\/alpha\s+Add cache\s+2h$/);
  expect(lines[2]).toMatch(/^\s*ISS\s+#3\s+example\/beta\s+Crash on start\s+2h$/);
  expect(lines[3]).toMatch(/^\s*REL\s+example\/beta\s+Release v1\s+2h$/);
  expect(lines[4]).toMatch(/^\s*ISS\s+#5\s+example\/beta\s+Stale crash\s+2h$/);

  for (const line of lines) {
    expect(line).not.toMatch(/[│├└▾▸]/);
  }
});

test('the flat list keeps each title start and age on its row at narrow widths', async () => {
  for (const width of [40, 30]) {
    const { setup, press } = await mount({
      themeMode: 'dark',
      effects: threadsEffects(treeThreads),
      width,
    });

    await pressAll(press, ['r', 's', 's']);

    const lines = frameLines(setup).slice(0, 5);
    const titles = ['Fix', 'Add', 'Crash', 'Release', 'Stale'];

    expect(lines).toHaveLength(5);

    lines.forEach((line, index) => {
      expect(line).toMatch(new RegExp(`${titles[index]}.*\\d+h$`));
    });
  }
});

test('the flat list truncates a long repository name so the title keeps its space', async () => {
  const longRepository = 'example/a-valid-repository-name-longer-than-the-terminal-width';
  const threads = [treeThread(1, 'Fix parser', { repository: longRepository })];
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(threads) });

  await pressAll(press, ['r', 's', 's']);

  expect(frameLines(setup)[0]).toMatch(/^\s*PR\s+#1\s+example\/a-valid.*…\s+Fix parser\s+\d+h$/);
});

test('j and k move the selection one row, and g and G jump to the first and last row', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await press('r');
  expect(selectedLine(setup)).toBe('▾ Review requested 2');

  await press('j');
  expect(selectedLine(setup)).toBe('│ ▾ example/alpha 2');

  await press('j');
  expect(selectedLine(setup)).toContain('Fix parser');

  await press('k');
  expect(selectedLine(setup)).toBe('│ ▾ example/alpha 2');

  await press('G');
  expect(selectedLine(setup)).toContain('Release v1');

  await press('g');
  expect(selectedLine(setup)).toBe('▾ Review requested 2');
});

test('J and K move the selection to the next and previous group', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'j', 'j']);

  await press('J');
  expect(selectedLine(setup)).toBe('▾ Mention 2');

  await press('J');
  expect(selectedLine(setup)).toBe('▾ Release 1');

  await press('K');
  expect(selectedLine(setup)).toBe('▾ Mention 2');
});

test('z and Space fold the node that holds the selection, from a thread or a node', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'j', 'j', 'z']);

  expect(setup.captureCharFrame()).not.toContain('Fix parser');
  expect(selectedLine(setup)).toBe('│ ▸ example/alpha 2');

  await press(' ');

  expect(setup.captureCharFrame()).toContain('Fix parser');
  expect(selectedLine(setup)).toBe('│ ▾ example/alpha 2');

  await press(' ');

  expect(setup.captureCharFrame()).not.toContain('Fix parser');
});

test('Enter on a group folds and unfolds it, and j moves on to its threads', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'return']);

  expect(frameLines(setup)[0]).toBe('▸ Review requested 2');
  expect(setup.captureCharFrame()).not.toContain('Fix parser');

  await press('return');

  expect(frameLines(setup)[0]).toBe('▾ Review requested 2');

  await pressAll(press, ['j', 'j']);

  expect(selectedLine(setup)).toContain('Fix parser');
});

test('Enter on a group below 90 columns folds it and opens no detail', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'return']);

  expect(frameLines(setup)[0]).toBe('▸ Review requested 2');
  expect(setup.captureCharFrame()).not.toContain('Unread');
  expect(setup.captureCharFrame()).not.toContain('Repo ');
});

test('Z folds every group, and unfolds them when all are folded', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'j', 'j', 'Z']);

  expect(frameLines(setup).slice(0, 3)).toEqual([
    '▸ Review requested 2',
    '▸ Mention 2',
    '▸ Release 1',
  ]);

  expect(selectedLine(setup)).toBe('▸ Review requested 2');

  await press('Z');

  expect(setup.captureCharFrame()).toContain('Fix parser');
  expect(setup.captureCharFrame()).toContain('│ ▾ example/beta 1');
});

test('a node row with a long repository name keeps its marker and count, open and folded', async () => {
  const longRepository = 'example/a-valid-repository-name-longer-than-the-terminal-width';
  const threads = [treeThread(1, 'Fix parser', { repository: longRepository })];
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(threads) });

  await press('r');

  const nodeLine = (): string | undefined =>
    frameLines(setup).find((line) => line.startsWith('│ ') && line.includes('example/a-valid'));

  expect(nodeLine()).toMatch(/^│ ▾ example\/a-valid.*… 1$/);

  await pressAll(press, ['j', 'z']);

  expect(nodeLine()).toMatch(/^│ ▸ example\/a-valid.*… 1$/);
});

test('a new thread row shows the marker and its repo and group rows count it', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: newMarkerEffects(newMarkerThreads, ['1']),
    width: 100,
  });

  await press('r');

  const lines = frameLines(setup);
  const rowOf = (text: string) => lines.find((line) => line.includes(text)) ?? '';

  expect(rowOf('Fresh thread')).toContain('●');
  expect(rowOf('Seen thread')).not.toContain('●');
  expect(rowOf('acme/alpha')).toMatch(/acme\/alpha 1\/2 /);
  expect(rowOf('Subscribed or manual')).toMatch(/Subscribed or manual 1\/2 /);
});

test('a node with no new threads shows only its thread count', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: newMarkerEffects(newMarkerThreads, ['1', '2']),
    width: 100,
  });

  await press('r');

  const lines = frameLines(setup);
  const rowOf = (text: string) => lines.find((line) => line.includes(text)) ?? '';

  expect(setup.captureCharFrame()).not.toContain('●');
  expect(rowOf('acme/alpha')).toMatch(/acme\/alpha 2 /);
  expect(rowOf('Subscribed or manual')).toMatch(/Subscribed or manual 2 /);
});

const fiveThreads = Array.from({ length: 5 }, (_, index) =>
  makeThread(index + 1, `Batch thread ${index + 1}`),
);

test('d on a repo node with 5 threads hides all 5 at once', async () => {
  const { setup, press, sent } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(fiveThreads),
  });

  await pressAll(press, ['r', 'g', 'j']);

  expect(selectedLine(setup)).toContain('example/repo');

  await press('d');

  const frame = setup.captureCharFrame();

  for (const thread of fiveThreads) {
    expect(frame).not.toContain(thread.title);
  }

  expect(sent.filter((intent) => (intent as { kind: string }).kind === 'markThreadsDone')).toEqual([
    { kind: 'markThreadsDone', threadIds: fiveThreads.map((thread) => thread.id) },
  ]);
});

test('d on a folded group hides every thread under it, and one u brings them all back', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(treeThreads) });

  await pressAll(press, ['r', 'g', 'z']);

  const before = setup.captureCharFrame();

  expect(selectedLine(setup)).toContain('Review requested');

  await press('d');

  const hidden = setup.captureCharFrame();

  expect(hidden).not.toContain('Review requested');
  expect(hidden).toContain('Crash on start');

  await press('u');

  const restored = setup.captureCharFrame();

  expect(restored).toContain('Review requested');
  expect(restored.split('\n').slice(0, 8)).toEqual(before.split('\n').slice(0, 8));
});

const lastNewEffects = newMarkerEffects(
  [
    {
      ...treeThread(1, 'Seen thread', {
        repository: 'acme/a-repository-name-that-is-far-too-long',
      }),
    },
    {
      ...treeThread(2, 'Fresh thread', {
        repository: 'acme/a-repository-name-that-is-far-too-long',
      }),
    },
  ],
  ['1'],
);

test('a node row with new threads in a narrow terminal keeps its new and total counts inside the width', async () => {
  const { setup, press } = await mount({ themeMode: 'dark', effects: lastNewEffects, width: 30 });

  await press('r');

  const row = frameLines(setup).find((line) => line.includes('acme/a-repo'));

  expect(row).toMatch(/…  ?1\/2$/);
  expect(row?.length).toBeLessThanOrEqual(30);
});

const flatAt = async (width: number, title = 'Fix parser') => {
  const threads = [treeThread(1, title, { repository: 'example/alpha' })];
  const mounted = await mount({ themeMode: 'dark', effects: threadsEffects(threads), width });

  await pressAll(mounted.press, ['r', 's', 's']);

  return frameLines(mounted.setup)[0] ?? '';
};

test('the flat list shows the repository column only from its minimum width', async () => {
  const shown = await flatAt(37);
  const hidden = await flatAt(36);

  expect(shown).toMatch(/#1\s+exam…\s+Fix parser\s+\d+h$/);
  expect(hidden).toMatch(/#1\s+Fix parser\s+\d+h$/);
  expect(hidden).not.toContain('…');
});

test('the flat list shows a title that fits its column and cuts one that reaches the age', async () => {
  const fits = await flatAt(37, 'abcdefghijk');
  const reaches = await flatAt(37, 'abcdefghijkl');

  expect(fits).toMatch(/exam…\s+abcdefghijk\s+\d+h$/);
  expect(reaches).toMatch(/exam…\s+abcdefghij…\s+\d+h$/);
});

test('a thread of an unknown type shows the first three letters of the type in capitals', async () => {
  const threads = [
    treeThread(1, 'Odd thread', { subjectType: 'RepositoryAdvisory', subjectUrl: null }),
  ];

  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(threads) });

  await press('r');

  expect(frameLines(setup).find((line) => line.includes('Odd thread'))).toMatch(
    /└─\s+REP\s+Odd thread/,
  );
});

test('the list height subtracts the rows reserved for the search line', async () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    makeThread(index + 1, `Thread ${String(index + 1).padStart(2, '0')}`),
  );

  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(many),
    height: 10,
  });

  await press('r');
  await press('/');
  await typeText(setup, settle, 'Thread');
  await press('return');
  await press('G');

  const lines = setup.captureCharFrame().split('\n');

  expect(lines[7]).toContain('Thread 20');
  expect(lines[8]).toMatch(/^\/Thread/);
  expect(lines[9]).toContain('? help');
});

test('moving the selection inside the window leaves the window where it is', async () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    makeThread(index + 1, `Thread ${String(index + 1).padStart(2, '0')}`),
  );

  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(many),
    height: 12,
  });

  await press('r');

  await act(async () => {
    for (let step = 0; step < 30; step += 1) {
      setup.mockInput.pressKey('j');
    }
  });

  await settle();

  const first = frameLines(setup)[0];

  expect(selectedRowText(setup)).toContain('Thread 29');

  await press('k');

  expect(frameLines(setup)[0]).toBe(first);
  expect(selectedRowText(setup)).toContain('Thread 28');

  await press('g');

  expect(frameLines(setup)[0]).toBe('▾ Subscribed or manual 40');
  expect(selectedRowText(setup)).toContain('Subscribed or manual');
});

const pressRepeated = async (
  setup: Setup,
  settle: () => Promise<void>,
  key: string,
  count: number,
) => {
  await act(async () => {
    for (let step = 0; step < count; step += 1) {
      setup.mockInput.pressKey(key);
    }
  });

  await settle();
};

const numberedThreads = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    makeThread(index + 1, `Thread ${String(index + 1).padStart(2, '0')}`),
  );

const threadRowsOf = (setup: Setup): string[] =>
  frameLines(setup).filter((line) => line.includes('Thread '));

test('jumping to the last row shows the last rows at the bottom of the window, and g returns to the top', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(numberedThreads(11)),
    height: 8,
  });

  await press('r');
  await press('G');

  const lines = frameLines(setup);

  expect(lines[0]).toContain('Thread 05');
  expect(lines.at(-2)).toContain('Thread 11');
  expect(selectedRowText(setup)).toContain('Thread 11');

  await press('g');

  expect(frameLines(setup)[0]).toBe('▾ Subscribed or manual 11');
  expect(threadRowsOf(setup)).toHaveLength(5);
  expect(selectedRowText(setup)).toContain('Subscribed or manual');
});

test('the window scrolls one row when the selection leaves it below, and one row when it leaves it above', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(numberedThreads(11)),
    height: 8,
  });

  await press('r');
  await pressRepeated(setup, settle, 'j', 6);

  expect(frameLines(setup)[0]).toBe('▾ Subscribed or manual 11');
  expect(selectedRowText(setup)).toContain('Thread 05');

  await press('j');

  expect(frameLines(setup)[0]).toContain('example/repo');
  expect(selectedRowText(setup)).toContain('Thread 06');

  await press('G');
  await pressRepeated(setup, settle, 'k', 6);

  expect(frameLines(setup)[0]).toContain('Thread 05');
  expect(selectedRowText(setup)).toContain('Thread 05');

  await press('k');

  expect(frameLines(setup)[0]).toContain('Thread 04');
  expect(selectedRowText(setup)).toContain('Thread 04');
});

test('when the list shrinks below the window the window moves up to keep every row in use', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(numberedThreads(11)),
    height: 8,
  });

  await press('r');
  await press('G');
  await press('d');

  const lines = frameLines(setup);

  expect(lines[0]).toContain('Thread 04');
  expect(threadRowsOf(setup)).toHaveLength(7);
  expect(selectedRowText(setup)).toContain('Thread 10');
});

test('a list shorter than the window never scrolls', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');
  await press('G');

  expect(frameLines(setup)[0]).toBe('▾ Subscribed or manual 3');
  expect(selectedRowText(setup)).toContain('Third');

  await press('g');

  expect(frameLines(setup)[0]).toBe('▾ Subscribed or manual 3');
});

test('ages show minutes under an hour, hours under a day, and days from a day', async () => {
  const feedTime = 3 * 3_600_000;
  const minute = 60_000;

  const aged = (id: number, title: string, millisecondsAgo: number) => ({
    ...makeThread(id, title),
    updatedAt: new Date(feedTime - millisecondsAgo).toISOString(),
  });

  const threads = [
    aged(1, 'Just now', 0),
    aged(2, 'Under a minute', minute - 1),
    aged(3, 'One minute', minute),
    aged(4, 'Under an hour', 59 * minute),
    aged(5, 'One hour', 60 * minute),
    aged(6, 'Under a day', (23 * 60 + 59) * minute),
    aged(7, 'One day', 24 * 60 * minute),
    aged(8, 'Two days', 50 * 60 * minute),
    aged(9, 'In the future', -30 * minute),
  ];

  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(threads) });

  await press('r');

  const ageOf = (title: string): string | undefined =>
    new RegExp(`${title}\\s+(\\S+)$`).exec(
      frameLines(setup).find((line) => line.includes(title)) ?? '',
    )?.[1];

  expect(ageOf('Just now')).toBe('0m');
  expect(ageOf('Under a minute')).toBe('0m');
  expect(ageOf('One minute')).toBe('1m');
  expect(ageOf('Under an hour')).toBe('59m');
  expect(ageOf('One hour')).toBe('1h');
  expect(ageOf('Under a day')).toBe('23h');
  expect(ageOf('One day')).toBe('1d');
  expect(ageOf('Two days')).toBe('2d');
  expect(ageOf('In the future')).toBe('0m');
});

test('a wide or emoji title ends in an ellipsis within the row width', async () => {
  const wideTitle = `${'界'.repeat(60)}TAIL`;
  const emojiTitle = '🚀'.repeat(40);
  const threads = [treeThread(1, wideTitle, {}), treeThread(2, emojiTitle, {})];
  const { setup, press } = await mount({ themeMode: 'dark', effects: threadsEffects(threads) });

  await pressAll(press, ['r', 's', 's']);

  const lines = frameLines(setup).slice(0, 2);

  expect(lines).toHaveLength(2);

  for (const line of lines) {
    const title = line.replace(/\s+\d+h$/, '');

    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\uFFFD|[\uD800-\uDFFF]/u);
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
  }
});

test('the selected row stays in the frame after the terminal shrinks', async () => {
  const { setup, press, settle, resize } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(numberedThreads(11)),
    width: 60,
    height: 8,
  });

  await press('r');
  await pressRepeated(setup, settle, 'j', 6);
  expect(selectedRowText(setup)).toContain('Thread 05');

  await resize(60, 5);

  expect(selectedRowText(setup)).toContain('Thread 05');
});

test('the selected row stays in the frame above the search line when search opens', async () => {
  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(numberedThreads(11)),
    width: 60,
    height: 8,
  });

  await press('r');
  await pressRepeated(setup, settle, 'j', 6);
  expect(selectedRowText(setup)).toContain('Thread 05');

  await press('/');

  const lines = frameLines(setup);
  const selectedIndex = lines.findIndex((line) => line.includes('Thread 05'));
  const searchIndex = lines.findIndex((line) => line.startsWith('/'));

  expect(selectedRowText(setup)).toContain('Thread 05');
  expect(selectedIndex).toBeGreaterThanOrEqual(0);
  expect(selectedIndex).toBeLessThan(searchIndex);
});

test('the selected row stays in the frame when a refresh adds threads above it', async () => {
  let feed = numberedThreads(11);

  const { setup, press, settle } = await mount({
    themeMode: 'dark',
    effects: feedEffects(() => feed),
    width: 60,
    height: 8,
  });

  await press('r');
  await pressRepeated(setup, settle, 'j', 6);
  expect(selectedRowText(setup)).toContain('Thread 05');

  const added = Array.from({ length: 4 }, (_, index) => ({
    ...makeThread(100 + index, `Added ${index + 1}`),
    updatedAt: '1970-01-02T00:00:00Z',
  }));

  feed = [...added, ...feed];

  await press('r');

  expect(selectedRowText(setup)).toContain('Thread 05');
});

const twentyThreads = Array.from({ length: 20 }, (_, index) =>
  makeThread(index + 1, `Item ${String(index + 1).padStart(2, '0')}`),
);

// Rows: reason node, repo node, then Item 01 at row 3.
const countedList = async () => {
  const mounted = await mount({ themeMode: 'dark', effects: threadsEffects(twentyThreads) });

  await mounted.press('r');

  return mounted;
};

test('5 then j moves the selection five rows down', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['5', 'j']);

  expect(selectedLine(setup)).toContain('Item 04');
});

test('5 then Down moves the selection five rows down', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['5', 'down']);

  expect(selectedLine(setup)).toContain('Item 04');
});

test('3 then k moves the selection three rows up', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['G', '3', 'k']);

  expect(selectedLine(setup)).toContain('Item 17');
});

test('12 then G selects visible row 12', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['1', '2', 'G']);

  expect(selectedLine(setup)).toContain('Item 10');
});

test('0 then j moves one row down', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['0', 'j']);

  expect(selectedLine(setup)).toContain('example/repo');
});

test('9999 then j selects the last row', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['9', '9', '9', '9', 'j']);

  expect(selectedLine(setup)).toContain('Item 20');
});

test('5 then d hides no thread and the next j moves one row', async () => {
  const { setup, press, sent } = await countedList();

  await pressAll(press, ['j', 'j', '5', 'd']);

  expect(sent.filter((intent) => (intent as { kind: string }).kind === 'markDone')).toEqual([]);
  expect(selectedLine(setup)).toContain('Item 01');
  expect(setup.captureCharFrame()).toContain('Item 01');

  await press('j');

  expect(selectedLine(setup)).toContain('Item 02');
});

const markDoneCount = (sent: unknown[]) =>
  sent.filter((intent) => (intent as { kind: string }).kind === 'markDone').length;

test('0 then d marks the selected thread done', async () => {
  const { press, sent } = await countedList();

  await pressAll(press, ['j', 'j', '0', 'd']);

  expect(markDoneCount(sent)).toBe(1);
});

test('0 then slash opens the search line', async () => {
  const { setup, press, settle } = await countedList();

  await pressAll(press, ['0', '/']);
  await typeText(setup, settle, 'x');

  expect(setup.captureCharFrame()).toContain('/x');
});

// A leading zero is dropped, so the 5 after it starts a fresh count of five.
test('0 then 5 then j moves five rows down', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['0', '5', 'j']);

  expect(selectedLine(setup)).toContain('Item 04');
});

test('1 then 0 then j moves ten rows down', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['1', '0', 'j']);

  expect(selectedLine(setup)).toContain('Item 09');
});

test('1 then G selects the first visible row', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['G', '1', 'G']);

  expect(selectedLine(setup)).toContain('Subscribed or manual');
});

test('a counted G on an empty list selects nothing', async () => {
  const { session, press } = await mount({ themeMode: 'dark', effects: threadsEffects([]) });

  await pressAll(press, ['r', '3', 'G']);

  expect(session.getSnapshot().selectedRowKey).toBeNull();
});

test('F5 then d marks the selected thread done', async () => {
  const { setup, press, settle, sent } = await countedList();

  await pressAll(press, ['j', 'j']);

  await act(async () => {
    setup.mockInput.pressKey('F5');
  });

  await settle();
  await press('d');

  expect(markDoneCount(sent)).toBe(1);
});

test('ctrl+5 then d marks the selected thread done', async () => {
  const { setup, press, settle, sent } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(twentyThreads),
    width: 60,
    height: 24,
    kittyKeyboard: true,
  });

  await pressAll(press, ['r', 'j', 'j']);

  await act(async () => {
    setup.mockInput.pressKey('5', { ctrl: true });
  });

  await settle();
  await press('d');

  expect(markDoneCount(sent)).toBe(1);
});

test('10000 then k from the last row selects the first row', async () => {
  const { setup, press } = await countedList();

  await pressAll(press, ['G', '1', '0', '0', '0', '0', 'k']);

  expect(selectedLine(setup)).toContain('Subscribed or manual');
});

test('a five-digit count then d hides no thread and the next j moves one row', async () => {
  const { setup, press, sent } = await countedList();

  await pressAll(press, ['j', 'j', '1', '0', '0', '0', '0', 'd']);

  expect(markDoneCount(sent)).toBe(0);
  expect(selectedLine(setup)).toContain('Item 01');

  await press('j');

  expect(selectedLine(setup)).toContain('Item 02');
});
