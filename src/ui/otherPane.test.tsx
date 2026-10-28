import { afterEach, expect, test } from 'bun:test';

import { invariant } from '../invariant.ts';
import type { Session } from '../session/session.ts';
import { visibleRows } from '../session/session.ts';
import { mountWithGroup as untrackedMountWithGroup, pressAll, track } from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mountWithGroup = track(cleanups, untrackedMountWithGroup);

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
