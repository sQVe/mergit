import { afterEach, expect, test } from 'bun:test';

import { invariant } from '../invariant.ts';
import type { Session } from '../session/session.ts';
import { visibleRows } from '../session/session.ts';
import {
  fourRepoThreads,
  mount as untrackedMount,
  mountWithGroup as untrackedMountWithGroup,
  paneText,
  pressAll,
  threadsEffects,
  track,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mountWithGroup = track(cleanups, untrackedMountWithGroup);

const paneWidth = 100;

const mountWithShortPreview = track(cleanups, async () => {
  const mounted = await untrackedMount({
    effects: threadsEffects(fourRepoThreads),
    width: paneWidth,
    height: 6,
  });

  await pressAll(mounted.press, ['r', 'g', 'g', 'j', 'j']);

  return mounted;
});

const paneTopLineOf = (setup: Parameters<typeof paneText>[0]): string =>
  (paneText(setup, paneWidth).split('\n')[0] ?? '').replace(/^│|[█░]$/g, '').trim();

test('Ctrl+n, Alt+j, Ctrl+p, and Alt+k scroll the list preview and stop at both ends', async () => {
  const { setup, press, session } = await mountWithShortPreview();
  const rowKey = session.getSnapshot().selectedRowKey;

  expect(paneTopLineOf(setup)).toBe('Thread a');

  await press('ctrl+n');

  expect(paneTopLineOf(setup)).toBe('');
  expect(paneText(setup, paneWidth)).toContain('Repo');

  await pressAll(press, ['meta+j', 'ctrl+n']);

  expect(paneText(setup, paneWidth)).toContain('Unread');
  expect(paneText(setup, paneWidth)).not.toContain('Repo');

  const bottom = setup.captureCharFrame();

  await pressAll(press, ['ctrl+n', 'meta+j']);

  expect(setup.captureCharFrame()).toBe(bottom);

  await pressAll(press, ['meta+k', 'ctrl+p', 'meta+k']);

  expect(paneTopLineOf(setup)).toBe('Thread a');

  const top = setup.captureCharFrame();

  await pressAll(press, ['ctrl+p', 'meta+k']);

  expect(setup.captureCharFrame()).toBe(top);
  expect(session.getSnapshot().selectedRowKey).toBe(rowKey);
  expect(setup.captureCharFrame()).not.toContain('Alt+j/Ctrl+N next');
});

test('Ctrl+n scrolls a preview that overflows only after the terminal shrinks', async () => {
  const mounted = await untrackedMount({
    effects: threadsEffects(fourRepoThreads),
    width: paneWidth,
    height: 24,
  });

  cleanups.push(mounted.cleanup);

  const { setup, press, resize } = mounted;

  await pressAll(press, ['r', 'g', 'g', 'j', 'j']);
  await resize(paneWidth, 6);

  expect(paneTopLineOf(setup)).toBe('Thread a');

  await press('ctrl+n');

  expect(paneTopLineOf(setup)).toBe('');
});

test('Ctrl+n changes nothing after the terminal gets too narrow for the preview', async () => {
  const { setup, press, resize, session } = await mountWithShortPreview();
  const rowKey = session.getSnapshot().selectedRowKey;

  await resize(60, 6);

  const frame = setup.captureCharFrame();

  await pressAll(press, ['ctrl+n', 'ctrl+p']);

  expect(setup.captureCharFrame()).toBe(frame);
  expect(session.getSnapshot().selectedRowKey).toBe(rowKey);
});

test('opening the reader from a scrolled preview shows the thread from its top', async () => {
  const { setup, press } = await mountWithShortPreview();

  await pressAll(press, ['ctrl+n', 'ctrl+n']);

  expect(paneText(setup, paneWidth)).not.toContain('Thread a');

  await press('return');
  await press('?');
  await press('escape');

  const lines = setup.captureCharFrame().split('\n');

  expect(lines[0]).toContain('│ example/a / Pull request');
  expect(lines[1]).toContain('│ Thread a');
});

test('moving the selection with j shows the next preview from its top', async () => {
  const { setup, press } = await mountWithShortPreview();

  await pressAll(press, ['ctrl+n', 'ctrl+n']);

  expect(paneText(setup, paneWidth)).not.toContain('Thread a');

  await press('j');

  expect(paneTopLineOf(setup)).toBe('example/b');
});

const selectedThreadOf = (session: Session) => {
  const snapshot = session.getSnapshot();
  const row = visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

  invariant(row?.kind === 'thread', 'The selected row is not a thread.');

  return row.thread;
};

test('Ctrl+n and Alt+j switch the reader across a group, keep it focused, and stop at the last thread', async () => {
  const { setup, press, session } = await mountWithGroup();

  await pressAll(press, ['j', 'j', 'return']);

  const first = selectedThreadOf(session);

  await press('ctrl+n');

  const second = selectedThreadOf(session);

  expect(second.repository).not.toBe(first.repository);
  expect(setup.captureCharFrame()).toContain(second.title);
  expect(setup.captureCharFrame()).toContain('Alt+j/Ctrl+N next');

  await pressAll(press, ['ctrl+n', 'meta+j']);

  const last = selectedThreadOf(session);

  await press('ctrl+n');

  expect(selectedThreadOf(session).id).toBe(last.id);
  expect(setup.captureCharFrame()).toContain(last.title);

  await press('meta+k');

  const previous = selectedThreadOf(session);

  expect(previous.id).not.toBe(last.id);

  await press('escape');

  expect(selectedThreadOf(session).id).toBe(previous.id);
  expect(setup.captureCharFrame()).not.toContain('Alt+j/Ctrl+N next');
});
