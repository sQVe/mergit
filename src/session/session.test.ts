import { expect, test } from 'bun:test';

import { toThreadId } from '../work/work.ts';
import { matchCountOf, visibleRows } from './session.ts';
import type { SavedState } from './session.ts';
import {
  accountKeyOf,
  addFilters,
  doneFor,
  makeHarness,
  fireDoneTimerAt,
  makeThread,
  newThreadsFixture,
  octocat,
  readOf,
  savedSnapshotOf,
  seenOf,
  sentOk,
  settle,
  sortedThreadKeysOf,
  threadKeysOf,
} from './sessionHarness.ts';

test('getSnapshot returns the same object until a transition changes it', async () => {
  const { session, load } = makeHarness();
  const first = session.getSnapshot();

  expect(session.getSnapshot()).toBe(first);

  await load(makeThread('1'));

  expect(session.getSnapshot()).not.toBe(first);
});

test('subscribers hear transitions until they unsubscribe', async () => {
  const { session, load } = makeHarness();
  let calls = 0;

  const unsubscribe = session.subscribe(() => {
    calls += 1;
  });

  await load(makeThread('1'));

  const heard = calls;

  unsubscribe();
  session.send({ kind: 'selectNext' });
  await load(makeThread('1'));

  expect(heard).toBeGreaterThan(0);
  expect(calls).toBe(heard);
});

test('a result after stop is dropped, the running refresh is aborted, and no timer stays', async () => {
  const { session, pending, answerRead, activeTimers, load } = makeHarness();
  let calls = 0;

  await load(makeThread('1'));

  expect(activeTimers()).toHaveLength(1);

  session.subscribe(() => {
    calls += 1;
  });

  session.send({ kind: 'refresh' });
  await settle();

  const before = session.getSnapshot();
  const signal = pending[0]?.signal;
  const callsBeforeStop = calls;

  await session.stop(new AbortController().signal);

  expect(signal?.aborted).toBe(true);

  await answerRead(readOf('other', [makeThread('2')]));

  expect(session.getSnapshot()).toBe(before);
  expect(calls).toBe(callsBeforeStop);
  expect(pending).toHaveLength(0);
  expect(activeTimers()).toHaveLength(0);
});

test('stop cancels the scheduled poll', async () => {
  const { session, load, activeTimers } = makeHarness();

  await load(makeThread('1'));
  await session.stop(new AbortController().signal);

  expect(activeTimers()).toHaveLength(0);
});

test('send after stop starts no refresh and changes nothing', async () => {
  const { session, pending } = makeHarness();
  const before = session.getSnapshot();

  await session.stop(new AbortController().signal);
  session.send({ kind: 'refresh' });
  await settle();

  expect(pending).toHaveLength(0);
  expect(session.getSnapshot()).toBe(before);
});

test('savedState sets the starting grouping', () => {
  const { session } = makeHarness({
    savedState: { grouping: 'type', done: new Map(), seen: new Map() },
  });

  expect(session.getSnapshot().grouping).toBe('type');
});

test('savedState sets the starting grouping next to a saved snapshot', () => {
  const { session } = makeHarness({
    savedState: { grouping: 'type', done: new Map(), seen: new Map() },
    savedSnapshot: savedSnapshotOf(octocat),
  });

  expect(session.getSnapshot().grouping).toBe('type');
  expect(session.getSnapshot().threads.length).toBeGreaterThan(0);
});

test('each cycleGrouping intent saves the full state with the done records unchanged, and nothing else saves it', async () => {
  const saved: SavedState[] = [];
  const done = doneFor(octocat, makeThread('9'));

  const seen = new Map([
    [accountKeyOf(octocat), new Map([[toThreadId('4'), '2026-01-02T10:00:00Z']])],
  ]);

  const { session } = makeHarness({
    savedState: { grouping: 'reason', done, seen },
    saveState: (state) => {
      saved.push(state);
    },
  });

  await settle();
  session.send({ kind: 'selectNext' });
  session.send({ kind: 'toggleAllFolds' });

  expect(saved).toEqual([]);

  session.send({ kind: 'cycleGrouping' });

  expect(saved).toEqual([{ grouping: 'type', done, seen }]);

  session.send({ kind: 'cycleGrouping' });

  expect(saved.map((state) => state.grouping)).toEqual(['type', 'none']);

  expect(saved.every((state) => state.done.get(accountKeyOf(octocat))?.size === 1)).toBe(true);

  expect(
    saved.every(
      (state) =>
        state.seen.get(accountKeyOf(octocat))?.get(toThreadId('4')) === '2026-01-02T10:00:00Z',
    ),
  ).toBe(true);
});

test('a saveState that throws leaves the session running with the new grouping', () => {
  const { session } = makeHarness({
    saveState: () => {
      throw new Error('disk full');
    },
  });

  session.send({ kind: 'cycleGrouping' });

  expect(session.getSnapshot().grouping).toBe('type');

  session.send({ kind: 'cycleGrouping' });

  expect(session.getSnapshot().grouping).toBe('none');
});

test('stateWarning is in the starting snapshot', () => {
  const { session } = makeHarness({ stateWarning: 'bad state file' });

  expect(session.getSnapshot().stateWarning).toBe('bad state file');
});

test('a failed state write after a grouping change shows an error toast naming the grouping, the reason, and the file', () => {
  const { session } = makeHarness();

  session.send({ kind: 'cycleGrouping' });

  session.reportStateWrite({
    ok: false,
    reason: 'disk full',
    path: '~/state.json',
  });

  const { toast } = session.getSnapshot();

  expect(toast?.tone).toBe('error');
  expect(toast?.title.toLowerCase()).toContain('grouping');
  expect(toast?.lines).toEqual(['disk full', '~/state.json']);
});

test('a successful write after a failure shows no new toast', () => {
  const { session, timers } = makeHarness();

  session.send({ kind: 'cycleGrouping' });

  session.reportStateWrite({
    ok: false,
    reason: 'disk full',
    path: '~/state.json',
  });

  timers.at(-1)?.callback();
  session.reportStateWrite({ ok: true });

  expect(session.getSnapshot().toast).toBeNull();
});

test('marking the selected new thread done records it as seen', async () => {
  const { a, b, savedState } = newThreadsFixture();
  const harness = makeHarness({ savedState });

  await harness.load(a, b);
  harness.selectThread(b);

  expect(seenOf(harness.saves.at(-1), b)).toBeUndefined();

  harness.session.send({ kind: 'markDone' });

  expect(seenOf(harness.saves.at(-1), b)).toBe(b.updatedAt);
});

const queryThreads = () => [
  makeThread('1', { title: 'Fix parser', reason: 'review_requested', repository: 'acme/app' }),
  makeThread('2', { title: 'Fix lexer', reason: 'review_requested', repository: 'acme/lib' }),
  makeThread('3', { title: 'Docs', reason: 'review_requested', repository: 'acme/tools' }),
  makeThread('4', { title: 'Tidy', reason: 'mention', repository: 'acme/app' }),
];

const nodeRowsOf = (session: ReturnType<typeof makeHarness>['session']) =>
  visibleRows(session.getSnapshot()).filter((row) => row.kind === 'node');

test('a search leaves no rows for groups and repos without matching threads and counts matches', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());

  const allNodes = nodeRowsOf(session).length;

  session.send({ kind: 'editSearch', text: 'fix' });

  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2']);

  const nodes = nodeRowsOf(session);

  expect(nodes.length).toBeLessThan(allNodes);

  for (const node of nodes) {
    expect(node.threads.every((thread) => thread.title.startsWith('Fix'))).toBe(true);
  }

  expect(nodes.some((node) => node.title.includes('mention'))).toBe(false);
  expect(nodes.some((node) => node.title.includes('acme/tools'))).toBe(false);
  expect(matchCountOf(session.getSnapshot())).toBe(2);
});

test('the match count skips threads hidden by done', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'markThreadsDone', threadIds: [toThreadId('1')] });

  expect(matchCountOf(session.getSnapshot())).toBe(1);
});

test('editSearch treats field syntax as plain text and keeps no error state', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'repo:' });

  expect(session.getSnapshot().searchText).toBe('repo:');
  expect(threadKeysOf(session)).toEqual([]);

  session.send({ kind: 'editSearch', text: 'acme/app' });

  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:4']);

  session.send({ kind: 'editSearch', text: 'FIX  acme/app' });

  expect(threadKeysOf(session)).toEqual(['thread:1']);
});

test('markThreadsDone with a node row marks only its matching threads under a search', async () => {
  const harness = makeHarness();
  const { session, load } = harness;

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });

  const node = nodeRowsOf(session).find((row) => row.threads.length === 2);

  expect(node?.threads.map((thread) => thread.id)).toEqual([toThreadId('1'), toThreadId('2')]);

  const timersBefore = harness.timers.length;

  session.send({
    kind: 'markThreadsDone',
    threadIds: node?.threads.map((thread) => thread.id) ?? [],
  });

  session.send({ kind: 'clearSearch' });

  expect(threadKeysOf(session)).toEqual(['thread:3', 'thread:4']);

  await fireDoneTimerAt(harness, timersBefore);
  harness.sends[0]?.resolve(sentOk);
  await settle();

  expect(harness.sends.map((send) => send.threadId)).toEqual([toThreadId('1'), toThreadId('2')]);

  harness.sends[1]?.resolve(sentOk);
  await settle();

  expect(harness.sends).toHaveLength(2);
});

test('search text and filters combine with AND', async () => {
  const { session, load } = makeHarness();

  const threads = [
    makeThread('1', { title: 'Fix parser', repository: 'acme/app' }),
    makeThread('2', { title: 'Fix lexer', repository: 'acme/lib' }),
    makeThread('3', { title: 'Docs', repository: 'acme/app' }),
  ];

  await load(...threads);
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');

  expect(sortedThreadKeysOf(session)).toEqual(['thread:1']);
  expect(matchCountOf(session.getSnapshot())).toBe(1);
});

test('markThreadsDone from a node row under filters marks only that node visible threads', async () => {
  const harness = makeHarness();
  const { session, load } = harness;

  await load(...queryThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, '-repo:acme/lib');

  const node = nodeRowsOf(session).find((row) => row.threads.length === 2);

  expect(node?.threads.map((thread) => thread.id)).toEqual([toThreadId('1'), toThreadId('3')]);

  const timersBefore = harness.timers.length;

  session.send({
    kind: 'markThreadsDone',
    threadIds: node?.threads.map((thread) => thread.id) ?? [],
  });

  session.send({ kind: 'clearFilters' });

  expect(sortedThreadKeysOf(session)).toEqual(['thread:2', 'thread:4']);

  await fireDoneTimerAt(harness, timersBefore);
  harness.sends[0]?.resolve(sentOk);
  await settle();

  expect(harness.sends.map((send) => send.threadId)).toEqual([toThreadId('1'), toThreadId('3')]);
});
