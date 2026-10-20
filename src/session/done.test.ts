import { expect, test } from 'bun:test';

import type { GitHubResult } from '../github/github.ts';
import type { ThreadId } from '../work/work.ts';
import {
  accountKeyOf,
  doneWindow,
  failure,
  fireDoneTimerAt,
  loadFive,
  makeHarness,
  makeThread,
  markSelectedDone,
  octocat,
  sendAndRelease,
  rowKeysOf,
  sentOk,
  settle,
} from './sessionHarness.ts';

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

test.each(['ghMissing', 'rateLimited'] as const)(
  'a %s failure stops the bulk done and sends nothing more',
  async (kind) => {
    const harness = makeHarness();
    const threads = await startBulkDone(harness);

    await resolveSend(
      harness,
      0,
      kind === 'rateLimited'
        ? { ok: false, failure: { kind, resetAt: new Date('2026-02-01T13:00:00Z') } }
        : { ok: false, failure: { kind } },
    );

    await settle();

    const keys = rowKeysOf(harness.session);

    expect(harness.sends).toHaveLength(1);

    for (const thread of threads) {
      expect(keys).toContain(`thread:${thread.id}`);
    }

    expect(harness.session.getSnapshot().toast?.tone).toBe('error');
  },
);

test('a markThreadDone that throws counts as a failed send', async () => {
  const harness = makeHarness({
    markThreadDone: () => {
      throw new Error('kaboom');
    },
  });

  const one = makeThread('1');

  await harness.load(one, makeThread('2'));

  const savesAfterLoad = harness.saves.length;

  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await fireDoneTimerAt(harness, before);
  await settle();

  const toast = harness.session.getSnapshot().toast;

  expect(rowKeysOf(harness.session)).toContain(`thread:${one.id}`);
  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toContain('kaboom');
  expect(harness.saves).toHaveLength(savesAfterLoad);
});

test('aborting the deadline during the first send of a bulk done at stop starts no second send', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];
  const deadline = new AbortController();

  await harness.load(one, two);
  harness.session.send({ kind: 'markThreadsDone', threadIds: [one.id, two.id] });

  const stopped = harness.session.stop(deadline.signal);

  expect(harness.sends).toHaveLength(1);

  deadline.abort();
  await stopped;

  expect(harness.sends).toHaveLength(1);
});

test('a done whose every send fails starts no full refresh', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);

  const before = markSelectedDone(harness);
  const readsBefore = harness.countOf('read');

  await fireDoneTimerAt(harness, before);
  harness.sends[0]?.resolve(failure('Boom'));
  await settle();
  await settle();

  expect(harness.countOf('read')).toBe(readsBefore);
});

test('undo after a single done failed does nothing', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await fireDoneTimerAt(harness, before);
  harness.sends[0]?.resolve(failure('Boom'));
  await settle();

  const snapshot = harness.session.getSnapshot();

  harness.session.send({ kind: 'undoDone' });

  expect(harness.session.getSnapshot()).toBe(snapshot);
});

test('when the sending done fails, undo still brings back the done that waits', async () => {
  const harness = makeHarness();
  const [one, two, three] = [makeThread('1'), makeThread('2'), makeThread('3')];

  await harness.load(one, two, three);
  harness.selectThread(one);

  const first = markSelectedDone(harness);

  harness.selectThread(two);
  markSelectedDone(harness);
  await fireDoneTimerAt(harness, first);
  harness.sends[0]?.resolve(failure('Boom'));
  await settle();

  expect(rowKeysOf(harness.session)).not.toContain(`thread:${two.id}`);

  harness.session.send({ kind: 'undoDone' });

  expect(rowKeysOf(harness.session)).toContain(`thread:${two.id}`);
});

test('a second done sends when its timer fires after the first send finished', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two, makeThread('3'));
  harness.selectThread(one);

  const first = markSelectedDone(harness);

  await sendAndRelease(harness, first);
  harness.selectThread(two);

  const second = markSelectedDone(harness);

  await fireDoneTimerAt(harness, second);

  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id, two.id]);
});

test('a second undo after the only waiting done was undone does nothing, and stop sends nothing', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);
  markSelectedDone(harness);
  harness.session.send({ kind: 'undoDone' });

  const snapshot = harness.session.getSnapshot();

  harness.session.send({ kind: 'undoDone' });

  expect(harness.session.getSnapshot()).toBe(snapshot);

  await harness.session.stop(new AbortController().signal);

  expect(harness.sends).toHaveLength(0);
});

test('undoing the latest of two waiting dones leaves the first one to send', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two, makeThread('3'));
  harness.selectThread(one);

  const first = markSelectedDone(harness);

  harness.selectThread(two);
  markSelectedDone(harness);
  harness.session.send({ kind: 'undoDone' });
  await fireDoneTimerAt(harness, first);

  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id]);
});

test('a send that fails during stop shows no error toast and adds no message', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);
  markSelectedDone(harness);

  const messagesBefore = harness.session.getSnapshot().messages.length;
  const stopped = harness.session.stop(new AbortController().signal);

  harness.sends[0]?.resolve(failure('Boom'));
  await stopped;

  const snapshot = harness.session.getSnapshot();

  expect(snapshot.toast?.tone).not.toBe('error');
  expect(snapshot.messages).toHaveLength(messagesBefore);
});

test('stop with an already aborted deadline sends no waiting done', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);
  markSelectedDone(harness);
  await harness.session.stop(AbortSignal.abort());

  expect(harness.sends).toHaveLength(0);
});

test('stop does not send a done again that was already sent', async () => {
  const harness = makeHarness();
  const one = makeThread('1');

  await harness.load(one, makeThread('2'));
  harness.selectThread(one);

  const before = markSelectedDone(harness);

  await sendAndRelease(harness, before);
  await harness.session.stop(new AbortController().signal);

  expect(harness.sends.map((call) => call.threadId)).toEqual([one.id]);
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
