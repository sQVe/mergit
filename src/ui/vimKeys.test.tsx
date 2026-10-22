import { afterEach, expect, test } from 'bun:test';

import { act } from 'react';

import { visibleRows } from '../session/session.ts';
import {
  burst,
  makeThread,
  pressAll,
  threadsEffects,
  threeThreads,
  track,
  typeText,
  mount as untrackedMount,
} from './uiHarness.tsx';
import type { Setup } from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const twentyThreads = Array.from({ length: 20 }, (_, index) =>
  makeThread(index + 1, `Thread ${index + 1}`),
);

const mountTwenty = async () => {
  const mounted = await mount({
    themeMode: 'dark',
    effects: threadsEffects(twentyThreads),
    height: 14,
  });

  await mounted.press('r');

  return mounted;
};

const selectedIndexOf = (session: Awaited<ReturnType<typeof mountTwenty>>['session']): number => {
  const snapshot = session.getSnapshot();

  return visibleRows(snapshot).findIndex((row) => row.key === snapshot.selectedRowKey);
};

const rowCountOf = (session: Awaited<ReturnType<typeof mountTwenty>>['session']): number =>
  visibleRows(session.getSnapshot()).length;

const pressCtrl = async (mounted: Awaited<ReturnType<typeof mountTwenty>>, letter: string) => {
  await act(async () => {
    mounted.setup.mockInput.pressKey(letter, { ctrl: true });
  });

  await mounted.settle();
};

const selectRow = async (mounted: Awaited<ReturnType<typeof mountTwenty>>, index: number) => {
  await pressAll(mounted.press, ['g', 'g', ...Array.from({ length: index }, () => 'j')]);
};

test('gg selects the first row', async () => {
  const { press, session } = await mountTwenty();

  await pressAll(press, ['j', 'j', 'j']);

  expect(selectedIndexOf(session)).toBe(3);

  await pressAll(press, ['g', 'g']);

  expect(selectedIndexOf(session)).toBe(0);
});

test('3gg selects the third row', async () => {
  const { press, session } = await mountTwenty();

  await pressAll(press, ['3', 'g', 'g']);

  expect(selectedIndexOf(session)).toBe(2);
});

test.each([
  ['za', ['z', 'a']],
  ['Space', [' ']],
])('%s folds an open node and unfolds it again', async (_name, keys) => {
  const { press, session } = await mountTwenty();
  const open = rowCountOf(session);

  await pressAll(press, keys);

  expect(rowCountOf(session)).toBeLessThan(open);

  await pressAll(press, keys);

  expect(rowCountOf(session)).toBe(open);
});

test('zc closes a fold and zo opens it', async () => {
  const { press, session } = await mountTwenty();
  const open = rowCountOf(session);

  await pressAll(press, ['z', 'c']);

  const closed = rowCountOf(session);

  expect(closed).toBeLessThan(open);

  await pressAll(press, ['z', 'c']);

  expect(rowCountOf(session)).toBe(closed);

  await pressAll(press, ['z', 'o']);

  expect(rowCountOf(session)).toBe(open);
});

test('zM closes every fold and zR opens every fold', async () => {
  const { press, session } = await mountTwenty();
  const open = rowCountOf(session);

  await pressAll(press, ['z', 'M']);

  expect(rowCountOf(session)).toBeLessThan(open);

  await pressAll(press, ['z', 'R']);

  expect(rowCountOf(session)).toBe(open);
});

const placedTopOf = (
  session: Awaited<ReturnType<typeof mountTwenty>>['session'],
  index: number,
  position: 'top' | 'center' | 'bottom',
): number => {
  const { listRows } = session.getSnapshot();

  const wanted = {
    top: index,
    center: index - Math.floor((listRows - 1) / 2),
    bottom: index - listRows + 1,
  };

  return Math.min(Math.max(wanted[position], 0), rowCountOf(session) - listRows);
};

test('zt, zz, and zb put the selected row at the top, center, and bottom', async () => {
  const mounted = await mountTwenty();
  const { press, session } = mounted;

  await selectRow(mounted, 10);

  const selected = selectedIndexOf(session);

  await pressAll(press, ['z', 't']);

  expect(session.getSnapshot().listTop).toBe(placedTopOf(session, selected, 'top'));

  await pressAll(press, ['z', 'z']);

  expect(session.getSnapshot().listTop).toBe(placedTopOf(session, selected, 'center'));

  await pressAll(press, ['z', 'b']);

  expect(session.getSnapshot().listTop).toBe(placedTopOf(session, selected, 'bottom'));
  expect(selectedIndexOf(session)).toBe(selected);
});

test('5zz selects the fifth row and centers it', async () => {
  const mounted = await mountTwenty();
  const { press, session } = mounted;

  await selectRow(mounted, 12);
  await pressAll(press, ['5', 'z', 'z']);

  expect(selectedIndexOf(session)).toBe(4);
  expect(session.getSnapshot().listTop).toBe(placedTopOf(session, 4, 'center'));
});

test('Ctrl+d moves half a page down, 2 Ctrl+d moves two rows, and Ctrl+u moves back', async () => {
  const mounted = await mountTwenty();
  const { press, session } = mounted;

  await pressAll(press, ['g', 'g']);

  const half = Math.floor(session.getSnapshot().listRows / 2);

  await pressCtrl(mounted, 'd');

  expect(selectedIndexOf(session)).toBe(half);
  expect(session.getSnapshot().listTop).toBe(half);

  await pressAll(press, ['2']);
  await pressCtrl(mounted, 'd');

  expect(selectedIndexOf(session)).toBe(half + 2);

  await pressCtrl(mounted, 'u');

  expect(selectedIndexOf(session)).toBe(half + 2 - half);
});

test('Ctrl+f moves a page down, 2 Ctrl+f moves two pages, and Ctrl+b moves a page up', async () => {
  const mounted = await mountTwenty();
  const { press, session } = mounted;

  await pressAll(press, ['g', 'g']);

  const { listRows } = session.getSnapshot();

  await pressCtrl(mounted, 'f');

  expect(selectedIndexOf(session)).toBe(listRows);

  await pressCtrl(mounted, 'b');

  expect(selectedIndexOf(session)).toBe(0);

  await press('2');
  await pressCtrl(mounted, 'f');

  expect(selectedIndexOf(session)).toBe(Math.min(2 * listRows, rowCountOf(session) - 1));
});

test('zc on a repo node, then zR, shows its threads again', async () => {
  const { press, session } = await mountTwenty();
  const open = rowCountOf(session);

  await press('j');

  expect(session.getSnapshot().selectedRowKey).toContain('node:');

  await pressAll(press, ['z', 'c']);

  expect(rowCountOf(session)).toBeLessThan(open);

  await pressAll(press, ['z', 'R']);

  expect(rowCountOf(session)).toBe(open);
});

test('5zt and 5zb select the fifth row and put it at the top and bottom', async () => {
  const mounted = await mountTwenty();
  const { press, session } = mounted;

  await selectRow(mounted, 12);
  await pressAll(press, ['5', 'z', 't']);

  expect(selectedIndexOf(session)).toBe(4);
  expect(session.getSnapshot().listTop).toBe(placedTopOf(session, 4, 'top'));

  await selectRow(mounted, 12);
  await pressAll(press, ['5', 'z', 'b']);

  expect(selectedIndexOf(session)).toBe(4);
  expect(session.getSnapshot().listTop).toBe(placedTopOf(session, 4, 'bottom'));
});

test('2 Ctrl+u moves up two rows', async () => {
  const mounted = await mountTwenty();
  const { press, session } = mounted;

  await selectRow(mounted, 12);
  await press('2');
  await pressCtrl(mounted, 'u');

  expect(selectedIndexOf(session)).toBe(10);
});

test('2 Ctrl+b moves up two pages', async () => {
  const mounted = await mountTwenty();
  const { press, session } = mounted;

  await press('G');

  const last = rowCountOf(session) - 1;
  const { listRows } = session.getSnapshot();

  expect(selectedIndexOf(session)).toBe(last);

  await press('2');
  await pressCtrl(mounted, 'b');

  expect(selectedIndexOf(session)).toBe(Math.max(last - 2 * listRows, 0));
});

test('gx opens the selected thread in the browser', async () => {
  const { press, sent } = await mountTwenty();

  await pressAll(press, ['j', 'j']);
  sent.length = 0;
  await pressAll(press, ['g', 'x']);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ kind: 'openInBrowser' });
});

test.each([['g'], ['z'], ['Z']])('a single %s selects, folds, and moves nothing', async (key) => {
  const { press, session, sent } = await mountTwenty();

  await pressAll(press, ['j', 'j', 'j']);

  const selected = selectedIndexOf(session);
  const rows = rowCountOf(session);

  sent.length = 0;
  await press(key);

  expect(sent).toEqual([]);
  expect(selectedIndexOf(session)).toBe(selected);
  expect(rowCountOf(session)).toBe(rows);
});

test.each([['quit'], ['q'], ['quitall'], ['qa']])(
  ':%s then Enter sends a quit intent',
  async (name) => {
    const { press, setup, settle, terminalIntents } = await mountTwenty();

    await press(':');
    await typeText(setup, settle, name);
    await press('return');

    expect(terminalIntents).toEqual([{ kind: 'terminal', action: 'quit' }]);
  },
);

const inputOf = {
  '/': (session: Awaited<ReturnType<typeof mountTwenty>>['session']) =>
    session.getSnapshot().searchText,
  ':': (session: Awaited<ReturnType<typeof mountTwenty>>['session']) =>
    session.getSnapshot().commandLineText,
  f: (session: Awaited<ReturnType<typeof mountTwenty>>['session']) =>
    session.getSnapshot().filterDraft,
};

test.each(['/', ':', 'f'] as const)('g and z typed after %s reach the input', async (opening) => {
  const { press, session } = await mountTwenty();

  await pressAll(press, [opening, 'g', 'z']);

  expect(inputOf[opening](session)).toBe('gz');
});

test.each(['/', ':', 'f'] as const)(
  'g and z in the same burst as %s reach the input',
  async (opening) => {
    const { setup, settle, session } = await mountTwenty();

    await burst(setup, [opening, 'gz']);
    await settle();

    expect(inputOf[opening](session)).toBe('gz');
  },
);

const statusLineOf = (setup: Setup): string => {
  const lines = setup.captureCharFrame().split('\n');

  return lines.find((line) => line.includes('? help'))?.trimEnd() ?? '';
};

test('a pending count and key show at the right of the status line, and Esc cancels them', async () => {
  const { press, setup, session } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');
  await press('/');
  await pressAll(press, ['F', 'i', 'return']);

  const before = session.getSnapshot();

  await pressAll(press, ['5', 'z']);

  expect(statusLineOf(setup).endsWith('5z')).toBe(true);

  await press('escape');

  const after = session.getSnapshot();

  expect(statusLineOf(setup).endsWith('5z')).toBe(false);
  expect(after.selectedRowKey).toBe(before.selectedRowKey);
  expect(after.searchText).toBe('Fi');
});

test('a key that misses a pending sequence is dropped without a toast and does not run', async () => {
  const { press, setup, session } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');

  const before = session.getSnapshot().selectedRowKey;

  await pressAll(press, ['z', '/']);

  const snapshot = session.getSnapshot();

  expect(snapshot.searchOpen).toBe(false);
  expect(snapshot.toast).toBeNull();
  expect(snapshot.selectedRowKey).toBe(before);
  expect(statusLineOf(setup).endsWith('z')).toBe(false);

  await press('j');

  expect(session.getSnapshot().selectedRowKey).not.toBe(before);
});

test('a finished zz shows no toast and clears the pending display', async () => {
  const { press, setup, session } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await press('r');
  await pressAll(press, ['z', 'z']);

  expect(session.getSnapshot().toast).toBeNull();
  expect(statusLineOf(setup).endsWith('z')).toBe(false);
});
