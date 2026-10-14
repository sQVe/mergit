import { expect, test } from 'bun:test';

import type { GitHubResult } from '../github/github.ts';
import type { ThreadId } from '../work/work.ts';
import { toThreadId, toViewerLogin } from '../work/work.ts';
import { visibleRows } from './session.ts';
import type { SavedState, createSession } from './session.ts';
import {
  accountKeyOf,
  doneFor,
  doneOf,
  failure,
  fireDoneTimerAt,
  makeHarness,
  makeSavedHarness,
  makeThread,
  octocat,
  readOf,
  savedThreads,
  rowKeysOf,
  sentOk,
  settle,
  stable,
  viewerOf,
} from './sessionHarness.ts';

test('a saved done record hides its thread in the saved list and after a refresh with the same updated_at', async () => {
  const [first, second] = savedThreads;

  const { session, send, answerViewer, answerRead, answerVerify } = makeSavedHarness(octocat, {
    savedState: {
      grouping: 'reason',
      done: doneFor(octocat, first!),
      seen: new Map(),
    },
  });

  expect(session.getSnapshot().threads).toEqual([second!]);

  await send();
  await answerViewer(viewerOf(octocat));
  await answerRead(readOf('fresh', [first!, second!]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([second!]);
});

test('a thread with a done record shows again after a refresh with a newer updated_at', async () => {
  const [first, second] = savedThreads;
  const newer = { ...first!, updatedAt: '2026-01-09T10:00:00Z' };

  const { session, send, answerViewer, answerRead, answerVerify } = makeSavedHarness(octocat, {
    savedState: {
      grouping: 'reason',
      done: doneFor(octocat, first!),
      seen: new Map(),
    },
  });

  await send();
  await answerViewer(viewerOf(octocat));
  await answerRead(readOf('fresh', [newer, second!]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([newer, second!]);
});

const doneWindow = 5000;

const markSelectedDone = (harness: ReturnType<typeof makeHarness>) => {
  const before = harness.timers.length;

  harness.session.send({ kind: 'markDone' });

  return before;
};

test('done hides the selected thread and the next thread takes its row', async () => {
  const harness = makeHarness();
  const [one, two, three] = [makeThread('1'), makeThread('2'), makeThread('3')];

  await harness.load(one, two, three);
  harness.selectThread(two);
  harness.session.send({ kind: 'markDone' });

  expect(rowKeysOf(harness.session)).not.toContain(`thread:${two.id}`);
  expect(harness.selected()).toBe(`thread:${three.id}`);
});

test('done on the last thread of a group selects the row now at its index', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2', { reason: 'mention' })];

  await harness.load(one, two);
  harness.selectThread(two);

  const index = rowKeysOf(harness.session).indexOf(`thread:${two.id}`);

  harness.session.send({ kind: 'markDone' });

  const rows = rowKeysOf(harness.session);

  expect(rows).not.toContain(`thread:${two.id}`);

  expect(harness.selected()).toBe(rows[Math.min(index, rows.length - 1)] ?? null);

  expect(harness.selected()).toBe(`thread:${one.id}`);
});

test('done on a thread that ends its group selects the next group row', async () => {
  const harness = makeHarness();

  const [one, two, three] = [
    makeThread('1'),
    makeThread('2'),
    makeThread('3', { reason: 'mention' }),
  ];

  await harness.load(one, two, three);
  harness.selectThread(two);

  const rowsBefore = rowKeysOf(harness.session);
  const index = rowsBefore.indexOf(`thread:${two.id}`);

  harness.session.send({ kind: 'markDone' });

  expect(harness.selected()).toBe(rowKeysOf(harness.session)[index] ?? null);
  expect(harness.selected()).not.toBe(`thread:${two.id}`);
  expect(harness.selected()).not.toBeNull();
});

test('done shows an info toast with the thread title for the undo window', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one);
  harness.selectThread(one);
  harness.session.send({ kind: 'markDone' });

  const toast = harness.session.getSnapshot().toast;

  expect(toast?.tone).toBe('info');
  expect(toast?.title).toContain('Thread 1');
  expect(toast?.durationMilliseconds).toBe(doneWindow);
});

test('done on a group row changes nothing', async () => {
  const harness = makeHarness();

  await harness.load(makeThread('1'));
  harness.session.send({ kind: 'selectFirst' });

  const before = harness.session.getSnapshot();

  harness.session.send({ kind: 'markDone' });

  expect(harness.session.getSnapshot()).toBe(before);
});

test('undo within the window brings the thread back and sends nothing', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two);
  const savesAfterLoad = harness.saves.length;
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  harness.session.send({ kind: 'undoDone' });

  expect(rowKeysOf(harness.session)).toContain(`thread:${one.id}`);
  expect(harness.session.getSnapshot().toast?.tone).toBe('info');

  await fireDoneTimerAt(harness, before);

  expect(harness.sends).toHaveLength(0);
  expect(harness.saves).toHaveLength(savesAfterLoad);
});

test('the request goes out only when the timer fires, and dones send one at a time', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two);
  harness.selectThread(one);

  const firstBefore = markSelectedDone(harness);

  harness.selectThread(two);

  const secondBefore = markSelectedDone(harness);

  expect(harness.timers[firstBefore]?.delay).toBe(doneWindow);
  expect(harness.timers[secondBefore]?.delay).toBe(doneWindow);
  expect(harness.sends).toHaveLength(0);

  await fireDoneTimerAt(harness, firstBefore);

  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id]);

  await fireDoneTimerAt(harness, secondBefore);

  expect(harness.sends).toHaveLength(1);

  harness.sends[0]?.resolve(sentOk);
  await settle();

  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id, two.id]);
});

test('undo after the send leaves the thread hidden and says it cannot be undone', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await fireDoneTimerAt(harness, before);
  harness.sends[0]?.resolve(sentOk);
  await settle();
  harness.session.send({ kind: 'undoDone' });

  const toast = harness.session.getSnapshot().toast;

  expect(rowKeysOf(harness.session)).not.toContain(`thread:${one.id}`);
  expect(toast?.tone).toBe('info');
  expect(toast?.title).toContain('cannot be undone');
});

test('undo with no done does nothing', async () => {
  const harness = makeHarness();

  await harness.load(makeThread('1'));

  const before = harness.session.getSnapshot();

  harness.session.send({ kind: 'undoDone' });

  expect(harness.session.getSnapshot()).toBe(before);
});

test('a successful send saves the done record and starts a full refresh', async () => {
  const harness = makeHarness();
  const one = makeThread('1', { updatedAt: '2026-01-05T08:00:00Z' });

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);

  const before = markSelectedDone(harness);
  const readsBefore = harness.countOf('read');

  await fireDoneTimerAt(harness, before);
  harness.sends[0]?.resolve(sentOk);
  await settle();
  await settle();

  expect(harness.saves.at(-1)?.done.get(accountKeyOf(octocat))?.get(one.id)).toBe(
    '2026-01-05T08:00:00Z',
  );

  expect(harness.countOf('read')).toBe(readsBefore + 1);
  expect(rowKeysOf(harness.session)).not.toContain(`thread:${one.id}`);
});

const startBulkDone = async (harness: ReturnType<typeof makeHarness>) => {
  const threads = ['1', '2', '3', '4', '5'].map((id) =>
    makeThread(id, { updatedAt: `2026-01-05T08:00:0${id}Z` }),
  );

  await harness.load(...threads);

  const before = harness.timers.length;

  harness.session.send({ kind: 'markThreadsDone', threadIds: threads.map((thread) => thread.id) });
  await fireDoneTimerAt(harness, before);

  return threads;
};

const resolveSend = async (
  harness: ReturnType<typeof makeHarness>,
  index: number,
  result: GitHubResult<null>,
) => {
  harness.sends[index]?.resolve(result);
  await settle();
};

test('a bulk done starts one full refresh after its last send resolves', async () => {
  const harness = makeHarness();

  await startBulkDone(harness);

  const readsBefore = harness.countOf('read');

  for (let index = 0; index < 4; index += 1) {
    await resolveSend(harness, index, sentOk);
  }

  await settle();
  expect(harness.countOf('read')).toBe(readsBefore);

  await resolveSend(harness, 4, sentOk);
  await settle();

  expect(harness.countOf('read')).toBe(readsBefore + 1);
});

test('a bulk done saves each record as soon as its own send succeeds', async () => {
  const harness = makeHarness();
  const threads = await startBulkDone(harness);
  const recordsOf = () => harness.saves.at(-1)?.done.get(accountKeyOf(octocat));
  const savesBefore = harness.saves.length;

  await resolveSend(harness, 0, sentOk);

  expect(harness.saves).toHaveLength(savesBefore + 1);
  expect(recordsOf()?.get(threads[0]?.id as ThreadId)).toBe('2026-01-05T08:00:01Z');

  await resolveSend(harness, 1, sentOk);

  expect(harness.saves).toHaveLength(savesBefore + 2);
  expect(recordsOf()?.get(threads[1]?.id as ThreadId)).toBe('2026-01-05T08:00:02Z');
});

test('a notSignedIn failure stops the bulk done and restores the unsent threads', async () => {
  const harness = makeHarness();
  const threads = await startBulkDone(harness);

  await resolveSend(harness, 0, sentOk);
  await resolveSend(harness, 1, { ok: false, failure: { kind: 'notSignedIn' } });
  await settle();

  const toast = harness.session.getSnapshot().toast;
  const keys = rowKeysOf(harness.session);

  expect(harness.sends).toHaveLength(2);
  expect(keys).not.toContain(`thread:${threads[0]?.id}`);

  for (const thread of threads.slice(1)) {
    expect(keys).toContain(`thread:${thread.id}`);
  }

  expect(
    harness.saves
      .at(-1)
      ?.done.get(accountKeyOf(octocat))
      ?.has(threads[0]?.id as ThreadId),
  ).toBe(true);

  expect(toast?.tone).toBe('error');
  expect(toast?.title).toContain('4 of 5');
});

test('a requestFailed failure in a bulk done still sends the remaining threads', async () => {
  const harness = makeHarness();

  await startBulkDone(harness);
  await resolveSend(harness, 0, sentOk);
  await resolveSend(harness, 1, failure('boom'));
  await resolveSend(harness, 2, sentOk);
  await resolveSend(harness, 3, sentOk);
  await resolveSend(harness, 4, sentOk);

  expect(harness.sends).toHaveLength(5);
});

test('stop sends a waiting done at once and saves its record', async () => {
  const harness = makeHarness();
  const one = makeThread('1', { updatedAt: '2026-01-05T08:00:00Z' });

  await harness.load(one, makeThread('2'));
  const savesAfterLoad = harness.saves.length;
  harness.selectThread(one);

  const before = markSelectedDone(harness);
  const readsBefore = harness.countOf('read');
  const stopped = harness.session.stop(new AbortController().signal);

  expect(harness.timers[before]?.active).toBe(false);
  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id]);
  expect(harness.saves).toHaveLength(savesAfterLoad);

  harness.sends[0]?.resolve(sentOk);
  await stopped;

  expect(harness.saves.at(-1)?.done.get(accountKeyOf(octocat))?.get(one.id)).toBe(
    '2026-01-05T08:00:00Z',
  );

  expect(harness.countOf('read')).toBe(readsBefore);
});

test('stop sends waiting dones one at a time and saves each record', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two, makeThread('3'));
  harness.selectThread(one);
  markSelectedDone(harness);
  harness.selectThread(two);
  markSelectedDone(harness);

  const stopped = harness.session.stop(new AbortController().signal);

  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id]);

  harness.sends[0]?.resolve(sentOk);
  await settle();

  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id, two.id]);

  harness.sends[1]?.resolve(sentOk);
  await stopped;

  expect([...(harness.saves.at(-1)?.done.get(accountKeyOf(octocat))?.keys() ?? [])]).toEqual([
    one.id,
    two.id,
  ]);
});

test('stop waits for a send already in flight and saves its record', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await fireDoneTimerAt(harness, before);

  const stopped = harness.session.stop(new AbortController().signal);

  expect(harness.sends).toHaveLength(1);

  harness.sends[0]?.resolve(sentOk);
  await stopped;

  expect(harness.saves.at(-1)?.done.get(accountKeyOf(octocat))?.has(one.id)).toBe(true);
});

test('a failed send at stop saves nothing', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  const savesAfterLoad = harness.saves.length;
  harness.selectThread(one);
  markSelectedDone(harness);

  const stopped = harness.session.stop(new AbortController().signal);

  harness.sends[0]?.resolve(failure('boom'));
  await stopped;

  expect(harness.saves).toHaveLength(savesAfterLoad);
});

test('a failed send brings the thread back, shows an error toast, and saves nothing', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  const savesAfterLoad = harness.saves.length;
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await fireDoneTimerAt(harness, before);
  harness.sends[0]?.resolve(failure('Boom'));
  await settle();

  const toast = harness.session.getSnapshot().toast;

  expect(rowKeysOf(harness.session)).toContain(`thread:${one.id}`);
  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toContain('Boom');
  expect(harness.saves).toHaveLength(savesAfterLoad);
});

test('a complete refresh deletes done records of threads no longer in the feed', async () => {
  const savedState: SavedState = {
    grouping: 'reason',
    done: new Map([
      [
        accountKeyOf(octocat),
        new Map([
          [toThreadId('1'), '2026-01-02T10:00:00Z'],
          [toThreadId('2'), '2026-01-02T10:00:00Z'],
        ]),
      ],
    ]),
    seen: new Map(),
  };

  const harness = makeHarness({ savedState });

  await harness.load(makeThread('2'), makeThread('3'));

  const lastSave = harness.saves.at(-1);

  expect([...(lastSave?.done.get(accountKeyOf(octocat))?.keys() ?? [])]).toEqual([toThreadId('2')]);
});

test('a complete refresh that drops no done record saves nothing', async () => {
  const [two, three] = [makeThread('2'), makeThread('3')];

  const savedState: SavedState = {
    grouping: 'reason',
    done: doneFor(octocat, {
      ...two,
      updatedAt: '2026-01-02T10:00:00Z',
    }),
    seen: new Map([
      [
        accountKeyOf(octocat),
        new Map([
          [two.id, two.updatedAt],
          [three.id, three.updatedAt],
        ]),
      ],
    ]),
  };

  const harness = makeHarness({ savedState });

  await harness.load(two, three);

  expect(harness.saves).toHaveLength(0);
});

test('aborting the stop deadline aborts the send in flight and saves nothing', async () => {
  const harness = makeHarness();
  const one = makeThread('1');
  const deadline = new AbortController();

  await harness.load(one, makeThread('2'));
  const savesAfterLoad = harness.saves.length;
  harness.selectThread(one);
  markSelectedDone(harness);

  const stopped = harness.session.stop(deadline.signal);

  expect(harness.sends[0]?.signal.aborted).toBe(false);

  deadline.abort();
  await stopped;

  expect(harness.sends[0]?.signal.aborted).toBe(true);
  expect(harness.saves).toHaveLength(savesAfterLoad);
});

const foldedGroupHarness = async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two);
  harness.selectThread(one);

  return { harness };
};

const expectFoldedHolder = (harness: ReturnType<typeof makeHarness>) => {
  const snapshot = harness.session.getSnapshot();
  const keys = visibleRows(snapshot).map((row) => row.key);

  expect(snapshot.foldedNodes.reason.has('review/acme/app')).toBe(true);
  expect(keys).toContain(snapshot.selectedRowKey ?? '');
  expect(snapshot.selectedRowKey).toBe('node:review/acme/app');
};

test('undo of a done thread whose group was folded selects the group row and keeps the fold', async () => {
  const { harness } = await foldedGroupHarness();

  markSelectedDone(harness);
  harness.selectThread(makeThread('2'));
  harness.session.send({ kind: 'toggleFold' });
  harness.session.send({ kind: 'undoDone' });

  expectFoldedHolder(harness);
});

test('a failed send of a thread whose group was folded selects the group row', async () => {
  const { harness } = await foldedGroupHarness();
  const before = markSelectedDone(harness);

  harness.selectThread(makeThread('2'));
  harness.session.send({ kind: 'toggleFold' });
  await fireDoneTimerAt(harness, before);
  harness.sends[0]?.resolve(failure('Boom'));
  await settle();

  expectFoldedHolder(harness);
});

test('after an account switch a complete refresh keeps the other account done records and saves them', async () => {
  const hubot = toViewerLogin('hubot');
  const [first, second] = savedThreads;
  const hubotThread = makeThread('7');

  const { send, answerViewer, answerRead, answerVerify, saves } = makeSavedHarness(octocat, {
    savedState: {
      grouping: 'reason',
      done: new Map([...doneFor(octocat, first!), ...doneFor(hubot, hubotThread)]),
      seen: new Map(),
    },
  });

  await send();
  await answerViewer(viewerOf(hubot));
  await answerRead(readOf('fresh', [second!]));
  await answerVerify(stable);

  const lastSave = saves.at(-1);

  expect(lastSave?.done.get(accountKeyOf(octocat))).toEqual(doneOf(first!));
  expect(lastSave?.done.get(accountKeyOf(hubot))?.size ?? 0).toBe(0);
});

test('a done record of one account does not hide the same thread of another account', async () => {
  const hubot = toViewerLogin('hubot');
  const [first, second] = savedThreads;

  const { session, send, answerViewer, answerRead, answerVerify } = makeSavedHarness(octocat, {
    savedState: {
      grouping: 'reason',
      done: doneFor(octocat, first!),
      seen: new Map(),
    },
  });

  expect(session.getSnapshot().threads).toEqual([second!]);

  await send();
  await answerViewer(viewerOf(hubot));
  await answerRead(readOf('fresh', [first!, second!]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([first!, second!]);
});

test('a done sent as one account that succeeds after a switch is saved under that account', async () => {
  const hubot = toViewerLogin('hubot');
  const other = makeThread('7');
  let login = octocat;

  const harness = makeHarness({
    savedState: {
      grouping: 'reason',
      done: doneFor(hubot, other),
      seen: new Map(),
    },
    readViewer: () => Promise.resolve(viewerOf(login)),
  });

  const one = makeThread('1', { updatedAt: '2026-01-05T08:00:00Z' });

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await fireDoneTimerAt(harness, before);

  login = hubot;
  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerRead(readOf('fresh', [one, makeThread('2'), other]));
  await harness.answerVerify(stable);

  harness.sends[0]?.resolve(sentOk);
  await settle();

  const lastSave = harness.saves.at(-1);

  expect(lastSave?.done.get(accountKeyOf(octocat))).toEqual(doneOf({ ...one }));
  expect(lastSave?.done.get(accountKeyOf(hubot))).toEqual(doneOf(other));
});

const loadFive = async (harness: ReturnType<typeof makeHarness>) => {
  const threads = ['1', '2', '3', '4', '5'].map((id) => makeThread(id));

  await harness.load(...threads);

  return threads;
};

test('markThreadsDone hides all listed threads at once and one undo brings them all back', async () => {
  const harness = makeHarness();
  const threads = await loadFive(harness);
  const threadIds = threads.map((thread) => thread.id);
  const timersBefore = harness.timers.length;

  harness.session.send({ kind: 'markThreadsDone', threadIds });

  const hiddenKeys = rowKeysOf(harness.session);

  for (const thread of threads) {
    expect(hiddenKeys).not.toContain(`thread:${thread.id}`);
  }

  expect(harness.timers[timersBefore]?.delay).toBe(doneWindow);

  harness.session.send({ kind: 'undoDone' });

  const shownKeys = rowKeysOf(harness.session);

  for (const thread of threads) {
    expect(shownKeys).toContain(`thread:${thread.id}`);
  }

  await fireDoneTimerAt(harness, timersBefore);

  expect(harness.sends).toHaveLength(0);
});

test('a five-thread action sends its requests one at a time after the timer fires', async () => {
  const harness = makeHarness();
  const threads = await loadFive(harness);
  const timersBefore = harness.timers.length;

  harness.session.send({ kind: 'markThreadsDone', threadIds: threads.map((thread) => thread.id) });

  expect(harness.sends).toHaveLength(0);

  await fireDoneTimerAt(harness, timersBefore);

  for (const [index, thread] of threads.entries()) {
    expect(harness.sends.map((call) => call.threadId)).toEqual(
      threads.slice(0, index + 1).map((sent) => sent.id),
    );

    expect(harness.sends.at(-1)?.threadId).toBe(thread.id);

    harness.sends[index]?.resolve(sentOk);
    await settle();
  }

  expect(harness.sends).toHaveLength(5);
});

test('when 2 of 5 requests fail only those threads return, with one error toast', async () => {
  const harness = makeHarness();
  const threads = await loadFive(harness);
  const timersBefore = harness.timers.length;

  harness.session.send({ kind: 'markThreadsDone', threadIds: threads.map((thread) => thread.id) });
  await fireDoneTimerAt(harness, timersBefore);

  const failing = new Set([threads[1]?.id, threads[3]?.id]);

  for (const index of threads.keys()) {
    const sent = harness.sends[index];

    sent?.resolve(failing.has(sent.threadId) ? failure('Boom') : sentOk);
    await settle();
  }

  await settle();

  const keys = rowKeysOf(harness.session);
  const toast = harness.session.getSnapshot().toast;
  const records = harness.saves.at(-1)?.done.get(accountKeyOf(octocat));

  for (const thread of threads) {
    expect(keys.includes(`thread:${thread.id}`)).toBe(failing.has(thread.id));
    expect(records?.has(thread.id)).toBe(!failing.has(thread.id));
  }

  expect(toast?.tone).toBe('error');
  expect(toast?.title).toContain('2 of 5');
  expect(toast?.lines).toEqual(['Boom']);
});

test('markThreadsDone with hidden or unknown ids changes nothing and sends nothing', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two);
  harness.selectThread(one);
  harness.session.send({ kind: 'markDone' });

  const before = harness.session.getSnapshot();
  const timersBefore = harness.timers.length;

  harness.session.send({ kind: 'markThreadsDone', threadIds: [one.id, toThreadId('missing')] });
  harness.session.send({ kind: 'markThreadsDone', threadIds: [] });

  expect(harness.session.getSnapshot()).toBe(before);
  expect(harness.timers.length).toBe(timersBefore);
  expect(harness.sends).toHaveLength(0);
});

const selectedNodeThreadIds = (harness: ReturnType<typeof makeHarness>) => {
  const snapshot = harness.session.getSnapshot();
  const row = visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

  return row?.kind === 'node' ? row.threads.map((thread) => thread.id) : [];
};

const markNodeAt = async (steps: number, fold: boolean) => {
  const harness = makeHarness();

  await harness.load(
    makeThread('1', { repository: 'acme/app' }),
    makeThread('2', { repository: 'acme/app' }),
    makeThread('3', { repository: 'acme/lib' }),
    makeThread('4', { reason: 'mention', repository: 'acme/other' }),
  );

  harness.session.send({ kind: 'selectFirst' });

  for (let step = 0; step < steps; step += 1) {
    harness.session.send({ kind: 'selectNext' });
  }

  if (fold) {
    harness.session.send({ kind: 'toggleFold' });
  }

  harness.session.send({ kind: 'markThreadsDone', threadIds: selectedNodeThreadIds(harness) });

  return harness.session.getSnapshot();
};

const selectionIsShown = (
  snapshot: ReturnType<typeof createSession>['getSnapshot'] extends () => infer S ? S : never,
) => visibleRows(snapshot).some((row) => row.key === snapshot.selectedRowKey);

test('marking done on a folded repo node selects a remaining row', async () => {
  const snapshot = await markNodeAt(1, true);

  expect(snapshot.selectedRowKey).not.toBeNull();
  expect(selectionIsShown(snapshot)).toBe(true);
});

test('marking done on a folded group node selects a remaining row', async () => {
  const snapshot = await markNodeAt(0, true);

  expect(snapshot.selectedRowKey).not.toBeNull();
  expect(selectionIsShown(snapshot)).toBe(true);
});

test('marking done on an unfolded node selects a remaining row', async () => {
  const snapshot = await markNodeAt(1, false);

  expect(snapshot.selectedRowKey).not.toBeNull();
  expect(selectionIsShown(snapshot)).toBe(true);
});

test('marking done on an unfolded node that a refresh grew keeps the node selected', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one);
  harness.session.send({ kind: 'selectFirst' });

  const selected = harness.session.getSnapshot().selectedRowKey;
  const threadIds = selectedNodeThreadIds(harness);

  await harness.load(one, two);
  harness.session.send({ kind: 'markThreadsDone', threadIds });

  expect(selected).not.toBeNull();
  expect(harness.session.getSnapshot().selectedRowKey).toBe(selected);
});

test('marking done on a folded node that a refresh grew keeps the node selected', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one);
  harness.session.send({ kind: 'selectFirst' });
  harness.session.send({ kind: 'toggleFold' });

  const selected = harness.session.getSnapshot().selectedRowKey;
  const threadIds = selectedNodeThreadIds(harness);

  await harness.load(one, two);
  harness.session.send({ kind: 'markThreadsDone', threadIds });

  expect(selected).not.toBeNull();
  expect(harness.session.getSnapshot().selectedRowKey).toBe(selected);
});
