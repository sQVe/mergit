import { expect, test } from 'bun:test';

import { toThreadId, toViewerLogin } from '../work/work.ts';
import type { SavedState } from './session.ts';
import {
  accountKeyOf,
  doneFor,
  doneWindow,
  doneOf,
  failure,
  fireDoneTimerAt,
  loadFive,
  makeHarness,
  makeSavedHarness,
  makeThread,
  markSelectedDone,
  octocat,
  readOf,
  savedThreads,
  sendAndRelease,
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

test('a sent done leaves the hidden set after the next refresh and shows again with a newer updated_at', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two);
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await sendAndRelease(harness, before);
  await harness.answerRead(readOf('fresh', [one, two]));
  await harness.answerVerify(stable);

  expect(harness.session.getSnapshot().hiddenThreadIds.has(one.id)).toBe(false);
  expect(rowKeysOf(harness.session)).not.toContain(`thread:${one.id}`);

  const newer = { ...one, updatedAt: '2026-01-09T10:00:00Z' };

  await harness.loadWith('newer', [newer, two]);

  expect(rowKeysOf(harness.session)).toContain(`thread:${one.id}`);
});

test('a loaded refresh that drops a done record saves state even when no seen value changes', async () => {
  const [two, three] = [makeThread('2'), makeThread('3')];
  const missing = makeThread('1');

  const savedState: SavedState = {
    grouping: 'reason',
    done: doneFor(octocat, missing),
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

  expect(harness.saves).toHaveLength(1);
  expect(harness.saves[0]?.done.get(accountKeyOf(octocat))?.has(missing.id)).toBe(false);
});

test('a thread marked done again after it returned newer stays hidden through a refresh in the undo window', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two);
  harness.selectThread(one);

  const first = markSelectedDone(harness);

  await sendAndRelease(harness, first);
  await harness.answerRead(readOf('released', [one, two]));
  await harness.answerVerify(stable);

  const newer = { ...one, updatedAt: '2026-01-09T10:00:00Z' };

  await harness.loadWith('newer', [newer, two]);
  harness.selectThread(newer);

  const second = markSelectedDone(harness);

  expect(rowKeysOf(harness.session)).not.toContain(`thread:${one.id}`);
  expect(harness.timers[second]?.active).toBe(true);

  await harness.loadWith('during', [newer, two]);

  expect(rowKeysOf(harness.session)).not.toContain(`thread:${one.id}`);
});

test('a refresh after one done was sent keeps another waiting done hidden', async () => {
  const harness = makeHarness();
  const [one, two, three] = [makeThread('1'), makeThread('2'), makeThread('3')];

  await harness.load(one, two, three);
  harness.selectThread(one);

  const first = markSelectedDone(harness);

  harness.selectThread(two);
  markSelectedDone(harness);
  await sendAndRelease(harness, first);
  await harness.answerRead(readOf('fresh', [one, two, three]));
  await harness.answerVerify(stable);

  const keys = rowKeysOf(harness.session);

  expect(keys).not.toContain(`thread:${two.id}`);
  expect(keys).toContain(`thread:${three.id}`);
});

test.each(['ghMissing', 'notSignedIn'] as const)(
  'a done that fails with %s shows an error toast with a line',
  async (kind) => {
    const harness = makeHarness();
    const one = makeThread('1');

    await harness.load(one, makeThread('2'));
    harness.selectThread(one);

    const before = markSelectedDone(harness);

    await fireDoneTimerAt(harness, before);
    harness.sends[0]?.resolve({ ok: false, failure: { kind } });
    await settle();

    const toast = harness.session.getSnapshot().toast;

    expect(toast?.tone).toBe('error');
    expect(toast?.lines).toHaveLength(1);
    expect(toast?.lines[0]?.length).toBeGreaterThan(0);
  },
);
