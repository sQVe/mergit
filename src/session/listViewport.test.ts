import { expect, test } from 'bun:test';

import { visibleRows } from './session.ts';
import { makeHarness, makeThread } from './sessionHarness.ts';

const twentyThreads = () => Array.from({ length: 20 }, (_, index) => makeThread(String(index + 1)));

const selectRowIndex = (session: ReturnType<typeof makeHarness>['session'], index: number) => {
  session.send({ kind: 'selectFirst' });

  for (let step = 0; step < index; step += 1) {
    session.send({ kind: 'selectNext' });
  }
};

const selectionInWindow = (session: ReturnType<typeof makeHarness>['session']) => {
  const snapshot = session.getSnapshot();
  const rows = visibleRows(snapshot);
  const index = rows.findIndex((row) => row.key === snapshot.selectedRowKey);

  return index >= snapshot.listTop && index < snapshot.listTop + Math.max(1, snapshot.listRows);
};

test('setListRows and selection moves keep the selected row inside the list window', async () => {
  const { session, load } = makeHarness();

  await load(...twentyThreads());
  session.send({ kind: 'setListRows', rows: 5 });
  selectRowIndex(session, 10);

  expect(selectionInWindow(session)).toBe(true);
  expect(session.getSnapshot().listTop).toBeGreaterThan(0);

  session.send({ kind: 'setListRows', rows: 3 });

  expect(selectionInWindow(session)).toBe(true);

  session.send({ kind: 'selectFirst' });

  expect(session.getSnapshot().listTop).toBe(0);
});

test('a list shorter than the window keeps listTop at 0', async () => {
  const { session, load } = makeHarness();

  await load(makeThread('1'), makeThread('2'));
  session.send({ kind: 'setListRows', rows: 20 });
  session.send({ kind: 'selectLast' });

  expect(session.getSnapshot().listTop).toBe(0);
});

test('setListRows with the current value does not notify subscribers', async () => {
  const { session, load } = makeHarness();

  await load(...twentyThreads());
  session.send({ kind: 'setListRows', rows: 5 });

  let calls = 0;

  session.subscribe(() => {
    calls += 1;
  });

  const before = session.getSnapshot();

  session.send({ kind: 'setListRows', rows: 5 });

  expect(calls).toBe(0);
  expect(session.getSnapshot()).toBe(before);
});

test('listRows 0 never hides the selected row', async () => {
  const { session, load } = makeHarness();

  await load(...twentyThreads());
  selectRowIndex(session, 10);

  expect(selectionInWindow(session)).toBe(true);
});
