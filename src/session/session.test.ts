import { expect, test } from 'bun:test';

import { toThreadId } from '../work/work.ts';
import { matchCountOf, visibleRows } from './session.ts';
import type { SavedState } from './session.ts';
import {
  accountKeyOf,
  addFilters,
  doneFor,
  failure,
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

test('a startup state warning shows as an error toast and stays in the message history', () => {
  const { session } = makeHarness({
    stateWarning: { reason: 'The file is not valid JSON.', path: '~/state.json' },
  });

  const { toast, messages, stateWarning } = session.getSnapshot();

  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toEqual(['The file is not valid JSON.', '~/state.json']);

  expect(messages.map((message) => message.lines)).toEqual([
    ['The file is not valid JSON.', '~/state.json'],
  ]);

  expect(stateWarning).not.toBeNull();
});

test('a session without a state warning has no toast and no messages', () => {
  const { session } = makeHarness();

  expect(session.getSnapshot().stateWarning).toBeNull();
  expect(session.getSnapshot().toast).toBeNull();
  expect(session.getSnapshot().messages).toEqual([]);
});

test('a gh notice with rows on screen toasts once, and again only when the notice changes', async () => {
  const { session, load, answerRead } = makeHarness();

  await load(makeThread('1'));

  const failWith = async (kind: 'ghMissing' | 'notSignedIn') => {
    session.send({ kind: 'refresh' });
    await settle();
    await answerRead({ ok: false, failure: { kind } });
  };

  await failWith('ghMissing');

  expect(session.getSnapshot().messages).toHaveLength(1);
  expect(session.getSnapshot().toast?.lines.join(' ')).toContain('press r');

  await failWith('ghMissing');
  await failWith('ghMissing');

  expect(session.getSnapshot().messages).toHaveLength(1);

  await failWith('notSignedIn');

  expect(session.getSnapshot().messages).toHaveLength(2);

  await load(makeThread('1'));
  await failWith('notSignedIn');

  expect(session.getSnapshot().messages).toHaveLength(3);
});

test('a gh notice with no rows on screen adds no toast', async () => {
  const { session, answerRead } = makeHarness();

  session.send({ kind: 'refresh' });
  await settle();
  await answerRead({ ok: false, failure: { kind: 'ghMissing' } });

  expect(session.getSnapshot().notice).toBe('ghMissing');
  expect(session.getSnapshot().messages).toEqual([]);
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

test.each(['read', 'viewer'] as const)(
  'a %s failure that arrives after stop leaves the snapshot unchanged',
  async (stage) => {
    const harness = makeHarness({}, { holdViewer: stage === 'viewer' });

    if (stage === 'read') {
      await harness.load(makeThread('1'));
    }

    harness.session.send({ kind: 'refresh' });
    await settle();

    const before = harness.session.getSnapshot();

    await harness.session.stop(new AbortController().signal);

    if (stage === 'read') {
      await harness.answerRead(failure('offline'));
    } else {
      await harness.answerViewer(failure('offline'));
    }

    expect(harness.session.getSnapshot()).toBe(before);
  },
);

test('an intent that changes nothing does not notify subscribers', async () => {
  const { session, load } = makeHarness();

  await load(makeThread('1'), makeThread('2'), makeThread('3'));
  session.send({ kind: 'selectLast' });

  const last = session.getSnapshot();
  let notifications = 0;

  session.subscribe(() => {
    notifications += 1;
  });

  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectLast' });

  expect(notifications).toBe(0);
  expect(session.getSnapshot()).toBe(last);

  session.send({ kind: 'selectPrevious' });

  expect(notifications).toBe(1);
  expect(session.getSnapshot().selectedRowKey).not.toBe(last.selectedRowKey);
});
