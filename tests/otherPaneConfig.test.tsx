import { afterEach, expect, test } from 'bun:test';

import { loadConfig } from '../src/config/config.ts';
import type { Session } from '../src/session/session.ts';
import { visibleRows } from '../src/session/session.ts';
import {
  fourRepoThreads,
  mount as untrackedMount,
  paneText,
  pressAll,
  threadsEffects,
  track,
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

const selectedTitleOf = (session: Session): string | undefined => {
  const snapshot = session.getSnapshot();
  const row = visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

  return row?.kind === 'thread' ? row.thread.title : undefined;
};

test('remapped Alt+n and Alt+p move the open reader, show in help, and Esc still returns to the inbox', async () => {
  const { catalog } = configured({
    version: 1,
    keys: { moveOtherPaneDown: ['<A-n>'], moveOtherPaneUp: ['<A-p>'] },
  });

  const { setup, press, session } = await mount({
    catalog,
    effects: threadsEffects(fourRepoThreads),
    width: 80,
    height: 100,
  });

  await press('r');
  await pressAll(press, ['j', 'j', 'return']);
  await press('meta+n');

  expect(selectedTitleOf(session)).toBe('Thread b');
  expect(setup.captureCharFrame()).toContain('Thread b');

  await press('meta+p');

  expect(selectedTitleOf(session)).toBe('Thread a');

  await press('?');

  const helpLines = setup.captureCharFrame().split('\n');

  expect(helpLines.find((line) => line.includes('Move the other pane down'))).toContain('Alt+n');
  expect(helpLines.find((line) => line.includes('Move the other pane up'))).toContain('Alt+p');

  await press('escape');
  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Alt+n next');
  expect(selectedTitleOf(session)).toBe('Thread a');
});

test('a remapped Alt+n scrolls the list preview, and Ctrl+n no longer does', async () => {
  const { catalog } = configured({
    version: 1,
    keys: { moveOtherPaneDown: ['<A-n>'] },
  });

  const { setup, press, session } = await mount({
    catalog,
    effects: threadsEffects(fourRepoThreads),
    width: 100,
    height: 6,
  });

  await pressAll(press, ['r', 'g', 'g', 'j', 'j']);

  const rowKey = session.getSnapshot().selectedRowKey;

  const previewTitleOf = () =>
    (paneText(setup, 100).split('\n')[0] ?? '').replace(/^│|[█░]$/g, '').trim();

  expect(previewTitleOf()).toBe('Thread a');

  await press('meta+n');

  expect(previewTitleOf()).toBe('');
  expect(session.getSnapshot().selectedRowKey).toBe(rowKey);

  const scrolled = setup.captureCharFrame();

  await press('ctrl+n');

  expect(setup.captureCharFrame()).toBe(scrolled);
});
