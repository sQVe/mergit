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

const placed = async (
  position: 'center' | 'top' | 'bottom',
  index: number,
  count?: number,
): Promise<{ listTop: number; selectedIndex: number }> => {
  const { session, load } = makeHarness();

  await load(...twentyThreads());
  session.send({ kind: 'setListRows', rows: 5 });
  selectRowIndex(session, index);
  session.send({ kind: 'placeSelectedRow', position, count });

  const snapshot = session.getSnapshot();

  const selectedIndex = visibleRows(snapshot).findIndex(
    (row) => row.key === snapshot.selectedRowKey,
  );

  return { listTop: snapshot.listTop, selectedIndex };
};

test('placeSelectedRow centers, tops, and bottoms the selected row without moving the selection', async () => {
  expect(await placed('center', 10)).toEqual({ listTop: 8, selectedIndex: 10 });
  expect(await placed('top', 10)).toEqual({ listTop: 10, selectedIndex: 10 });
  expect(await placed('bottom', 10)).toEqual({ listTop: 6, selectedIndex: 10 });
});

test('placeSelectedRow clamps listTop at both ends of the list', async () => {
  expect(await placed('center', 0)).toEqual({ listTop: 0, selectedIndex: 0 });
  expect(await placed('bottom', 0)).toEqual({ listTop: 0, selectedIndex: 0 });
  expect(await placed('top', 21)).toEqual({ listTop: 17, selectedIndex: 21 });
  expect(await placed('center', 21)).toEqual({ listTop: 17, selectedIndex: 21 });
});

test('placeSelectedRow with a count selects that visible row first', async () => {
  expect(await placed('center', 0, 15)).toEqual({ listTop: 12, selectedIndex: 14 });
  expect(await placed('top', 0, 15)).toEqual({ listTop: 14, selectedIndex: 14 });
  expect(await placed('bottom', 21, 15)).toEqual({ listTop: 10, selectedIndex: 14 });
});

test('placeSelectedRow with a count clamps to the first and last rows', async () => {
  expect(await placed('bottom', 10, 1)).toEqual({ listTop: 0, selectedIndex: 0 });
  expect(await placed('top', 10, 9999)).toEqual({ listTop: 17, selectedIndex: 21 });
});

const scrolled = async (
  direction: 'down' | 'up',
  size: 'half' | 'full',
  index: number,
  count?: number,
): Promise<{ listTop: number; selectedIndex: number }> => {
  const { session, load } = makeHarness();

  await load(...twentyThreads());
  session.send({ kind: 'setListRows', rows: 5 });
  selectRowIndex(session, index);
  session.send({ kind: 'placeSelectedRow', position: 'top' });
  session.send({ kind: 'scrollPage', direction, size, count });

  const snapshot = session.getSnapshot();

  const selectedIndex = visibleRows(snapshot).findIndex(
    (row) => row.key === snapshot.selectedRowKey,
  );

  return { listTop: snapshot.listTop, selectedIndex };
};

test('scrollPage half moves half the window, or count rows', async () => {
  expect(await scrolled('down', 'half', 8)).toEqual({ listTop: 10, selectedIndex: 10 });
  expect(await scrolled('up', 'half', 8)).toEqual({ listTop: 6, selectedIndex: 6 });
  expect(await scrolled('down', 'half', 8, 4)).toEqual({ listTop: 12, selectedIndex: 12 });
  expect(await scrolled('up', 'half', 8, 4)).toEqual({ listTop: 4, selectedIndex: 4 });
});

test('scrollPage full moves a window, or count windows', async () => {
  expect(await scrolled('down', 'full', 4)).toEqual({ listTop: 9, selectedIndex: 9 });
  expect(await scrolled('up', 'full', 8)).toEqual({ listTop: 3, selectedIndex: 3 });
  expect(await scrolled('down', 'full', 2, 2)).toEqual({ listTop: 12, selectedIndex: 12 });
  expect(await scrolled('up', 'full', 12, 2)).toEqual({ listTop: 2, selectedIndex: 2 });
});

test('scrollPage clamps at both ends of the list', async () => {
  expect(await scrolled('up', 'half', 0)).toEqual({ listTop: 0, selectedIndex: 0 });
  expect(await scrolled('up', 'full', 1, 9)).toEqual({ listTop: 0, selectedIndex: 0 });
  expect(await scrolled('down', 'half', 21)).toEqual({ listTop: 17, selectedIndex: 21 });
  expect(await scrolled('down', 'full', 15, 9)).toEqual({ listTop: 17, selectedIndex: 21 });
});

test('scrollPage on an empty list changes nothing and does not throw', () => {
  const { session } = makeHarness();
  const before = session.getSnapshot();

  session.send({ kind: 'scrollPage', direction: 'down', size: 'full', count: undefined });
  session.send({ kind: 'scrollPage', direction: 'up', size: 'half', count: 2 });

  const after = session.getSnapshot();

  expect(after.listTop).toBe(before.listTop);
  expect(after.selectedRowKey).toBe(before.selectedRowKey);
});

test('placing a middle row at the bottom puts it on the last window row', async () => {
  const { session, load } = makeHarness();

  await load(...twentyThreads());
  session.send({ kind: 'setListRows', rows: 5 });
  selectRowIndex(session, 10);
  session.send({ kind: 'placeSelectedRow', position: 'bottom', count: undefined });

  const snapshot = session.getSnapshot();
  const index = visibleRows(snapshot).findIndex((row) => row.key === snapshot.selectedRowKey);

  expect(index).toBeGreaterThan(5);
  expect(snapshot.listTop).toBe(index - 4);
});
