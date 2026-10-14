import { expect, test } from 'bun:test';

import { filterFields } from '../query.ts';
import type { NotificationThread } from '../work/work.ts';
import { toThreadId } from '../work/work.ts';
import {
  describeFilterRow,
  filterCursorOf,
  filterRowsOf,
  formatFilter,
  matchCountOf,
  visibleRows,
} from './session.ts';
import type { FilterRow, SavedState } from './session.ts';
import {
  accountKeyOf,
  doneFor,
  factsOf,
  makeHarness,
  fireDoneTimerAt,
  makeThread,
  newThreadsFixture,
  octocat,
  readOf,
  releaseOf,
  savedSnapshotOf,
  seenFor,
  seenOf,
  rowKeysOf,
  sentOk,
  settle,
  stateWithSeen,
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

test('selectNext and selectPrevious move one row and stop at the ends', async () => {
  const { session, load, selected } = makeHarness();

  const [a, b, c] = [makeThread('1'), makeThread('2'), makeThread('3')] as const;

  await load(a, b, c);
  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe('node:review');

  session.send({ kind: 'selectNext' });

  expect(selected()).toBe('node:review/acme/app');

  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectNext' });

  expect(selected()).toBe(`thread:${c.id}`);

  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe(`thread:${b.id}`);
});

test('selection stays on the same thread across a refresh that reorders threads', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  const [a, b, c] = [makeThread('1'), makeThread('2'), makeThread('3')] as const;

  await load(a, b, c);
  selectThread(b);
  await load(c, b, a);

  expect(selected()).toBe(`thread:${b.id}`);

  session.send({ kind: 'selectNext' });
  await load(b, a, c);

  expect(selected()).toBe(`thread:${a.id}`);
});

test('when the selected thread and its group leave, the row now at its index is selected', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  const first = makeThread('1');
  const mention = makeThread('2', { reason: 'mention' });

  await load(first, mention);
  selectThread(mention);
  await load(first);

  expect(selected()).toBe(`thread:${first.id}`);

  await load();

  expect(selected()).toBeNull();
  expect(session.getSnapshot().hasLoaded).toBe(true);

  session.send({ kind: 'selectNext' });

  expect(selected()).toBeNull();
});

const reviewThread = makeThread('1');

const mentionThread = makeThread('2', {
  reason: 'mention',
  repository: 'acme/lib',
});

const threadKeys = (session: ReturnType<typeof makeHarness>['session']): string[] =>
  visibleRows(session.getSnapshot()).map((row) => row.key);

test('toggleFold folds the node that holds the selected thread and moves the cursor to it', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(reviewThread);

  expect(selected()).toBe('thread:1');

  session.send({ kind: 'toggleFold' });

  expect(session.getSnapshot().foldedNodes.reason.has('review/acme/app')).toBe(true);

  expect(selected()).toBe('node:review/acme/app');
  expect(threadKeys(session)).not.toContain('thread:1');
  expect(threadKeys(session)).toContain('thread:2');
});

test('toggleFold on a folded node unfolds it and keeps the cursor on the node', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(reviewThread);
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'toggleFold' });

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
  expect(selected()).toBe('node:review/acme/app');
  expect(threadKeys(session)).toContain('thread:1');
});

test('toggleFold does nothing without rows', () => {
  const { session } = makeHarness();
  const before = session.getSnapshot();

  session.send({ kind: 'toggleFold' });

  expect(session.getSnapshot()).toBe(before);
});

test('selectFirst and selectLast select the first and last visible rows', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectLast' });

  expect(selected()).toBe('thread:2');

  session.send({ kind: 'selectFirst' });

  expect(selected()).toBe('node:review');
});

test('selectNextGroup and selectPreviousGroup move between top-level groups and stop at the ends', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectPreviousGroup' });

  expect(selected()).toBe('node:review');

  session.send({ kind: 'selectNextGroup' });

  expect(selected()).toBe('node:mention');

  session.send({ kind: 'selectNextGroup' });

  expect(selected()).toBe('node:mention');

  session.send({ kind: 'selectPreviousGroup' });

  expect(selected()).toBe('node:review');
});

test('toggleAllFolds folds every top-level node, moves the cursor into the group, then unfolds them all', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(mentionThread);
  session.send({ kind: 'toggleAllFolds' });

  expect(threadKeys(session)).toEqual(['node:review', 'node:mention']);
  expect(selected()).toBe('node:mention');

  session.send({ kind: 'toggleAllFolds' });

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
  expect(selected()).toBe('node:mention');
  expect(threadKeys(session)).toHaveLength(6);
});

test('toggleAllFolds unfolds all top-level nodes when only one is folded', async () => {
  const { session, load } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'toggleAllFolds' });

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
});

test('cycleGrouping goes reason, type, none, reason and keeps the cursor on the same thread', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  const issue = makeThread('3', {
    subjectType: 'Issue',
    repository: 'acme/lib',
  });

  await load(reviewThread, mentionThread, issue);
  selectThread(mentionThread);

  const seen: string[] = [];

  for (let step = 0; step < 3; step += 1) {
    session.send({ kind: 'cycleGrouping' });
    seen.push(session.getSnapshot().grouping);

    expect(selected()).toBe('thread:2');
  }

  expect(seen).toEqual(['type', 'none', 'reason']);
});

test('cycleGrouping from a node selects the first thread under it, then keeps that thread', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectNextGroup' });

  expect(selected()).toBe('node:mention');

  session.send({ kind: 'cycleGrouping' });

  expect(selected()).toBe('thread:2');
});

test('cycleGrouping selects the nearest visible node when a fold hides the thread', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(mentionThread);
  session.send({ kind: 'cycleGrouping' });
  session.send({ kind: 'toggleFold' });

  expect(selected()).toBe('node:pull-requests/acme/lib');

  for (let step = 0; step < 2; step += 1) {
    session.send({ kind: 'cycleGrouping' });
  }

  expect(session.getSnapshot().grouping).toBe('reason');
  expect(selected()).toBe('thread:2');

  session.send({ kind: 'cycleGrouping' });

  expect(session.getSnapshot().grouping).toBe('type');
  expect(selected()).toBe('node:pull-requests/acme/lib');
});

test('a fold in one grouping does not fold a node in another', async () => {
  const { session, load, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'cycleGrouping' });
  selectThread(reviewThread);
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'cycleGrouping' });
  session.send({ kind: 'cycleGrouping' });

  expect(session.getSnapshot().grouping).toBe('reason');

  expect(session.getSnapshot().foldedNodes.type.has('pull-requests/acme/app')).toBe(true);

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
  expect(threadKeys(session)).toContain('thread:1');
});

test('a refresh keeps the grouping, the folds, and the selected row', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'cycleGrouping' });
  selectThread(mentionThread);
  session.send({ kind: 'selectPrevious' });
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'selectFirst' });
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'selectNext' });

  const key = selected();

  await load(reviewThread, mentionThread);

  expect(session.getSnapshot().grouping).toBe('type');

  expect([...session.getSnapshot().foldedNodes.type].toSorted()).toEqual([
    'pull-requests',
    'pull-requests/acme/lib',
  ]);

  expect(selected()).toBe(key);
});

test('selectPreviousGroup from a thread in the second group selects the first group row', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(mentionThread);
  session.send({ kind: 'selectPreviousGroup' });

  expect(selected()).toBe('node:review');
});

test('a refresh that removes the selected thread selects its repo row while the repo remains', async () => {
  const { load, selected, selectThread } = makeHarness();
  const second = makeThread('3');

  await load(reviewThread, second, mentionThread);
  selectThread(second);

  expect(selected()).toBe('thread:3');

  await load(reviewThread, mentionThread);

  expect(selected()).toBe('node:review/acme/app');
});

test('a refresh that removes the selected thread and its repo selects the group row', async () => {
  const { load, selected, selectThread } = makeHarness();
  const other = makeThread('4', { repository: 'acme/other' });

  await load(reviewThread, other, mentionThread);
  selectThread(other);

  expect(selected()).toBe('thread:4');

  await load(reviewThread, mentionThread);

  expect(selected()).toBe('node:review');
});

const otherThread = makeThread('3', { repository: 'acme/other' });

const flatHarness = async () => {
  const harness = makeHarness();

  await harness.load(reviewThread, mentionThread, otherThread);
  harness.session.send({ kind: 'cycleGrouping' });
  harness.session.send({ kind: 'cycleGrouping' });

  return harness;
};

test('none lists only thread rows in input order', async () => {
  const { session } = await flatHarness();

  expect(session.getSnapshot().grouping).toBe('none');
  expect(threadKeys(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
});

test('j, k, g, and G move over thread rows in none', async () => {
  const { session, selected } = await flatHarness();

  session.send({ kind: 'selectFirst' });

  expect(selected()).toBe('thread:1');

  session.send({ kind: 'selectNext' });

  expect(selected()).toBe('thread:2');

  session.send({ kind: 'selectLast' });

  expect(selected()).toBe('thread:3');

  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe('thread:2');
});

test('group jumps and folds change nothing in none and do not throw', async () => {
  const { session, selected, selectThread } = await flatHarness();

  selectThread(mentionThread);

  const before = session.getSnapshot();

  for (const kind of ['selectNextGroup', 'selectPreviousGroup', 'toggleAllFolds', 'toggleFold']) {
    session.send({ kind } as Parameters<typeof session.send>[0]);

    expect(selected()).toBe('thread:2');
    expect(session.getSnapshot().foldedNodes).toEqual(before.foldedNodes);
    expect(threadKeys(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
  }
});

test('a refresh in none keeps the selected thread, or falls back to the row index', async () => {
  const { load, selected, selectThread } = await flatHarness();

  selectThread(mentionThread);
  await load(mentionThread, reviewThread);

  expect(selected()).toBe('thread:2');

  await load(reviewThread, mentionThread, otherThread);
  selectThread(mentionThread);
  await load(reviewThread, otherThread);

  expect(selected()).toBe('thread:3');
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

const threadKeysOf = (session: ReturnType<typeof makeHarness>['session']) =>
  rowKeysOf(session).filter((key) => key.startsWith('thread:'));

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

test('openSearch opens the line and keepSearch closes it with the text applied', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'openSearch' });

  expect(session.getSnapshot().searchOpen).toBe(true);

  session.send({ kind: 'editSearch', text: 'docs' });
  session.send({ kind: 'keepSearch' });

  expect(session.getSnapshot().searchOpen).toBe(false);
  expect(session.getSnapshot().searchText).toBe('docs');
  expect(threadKeysOf(session)).toEqual(['thread:3']);
});

test('restoreSearch closes the line and brings back the earlier text', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'openSearch' });
  session.send({ kind: 'editSearch', text: 'docs' });
  session.send({ kind: 'restoreSearch' });

  const snapshot = session.getSnapshot();

  expect(snapshot.searchOpen).toBe(false);
  expect(snapshot.searchText).toBe('fix');
  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2']);
});

test('keepSearch on an empty line closes it with no text applied', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'openSearch' });
  session.send({ kind: 'editSearch', text: '' });
  session.send({ kind: 'keepSearch' });

  expect(session.getSnapshot().searchOpen).toBe(false);
  expect(session.getSnapshot().searchText).toBe('');
  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3', 'thread:4']);
});

test('a blank search shows every thread', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: '  ' });

  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3', 'thread:4']);
});

test('clearSearch clears the text and shows every thread', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'editSearch', text: 'fix lexer' });
  session.send({ kind: 'clearSearch' });

  expect(session.getSnapshot().searchText).toBe('');
  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3', 'thread:4']);
});

test('a search that hides the selected row moves the selection to a visible row', async () => {
  const { session, load, selectThread } = makeHarness();
  const threads = queryThreads();

  await load(...threads);
  selectThread(threads[3] as NotificationThread);
  session.send({ kind: 'editSearch', text: 'fix' });

  const keys = rowKeysOf(session);

  expect(keys).toContain(session.getSnapshot().selectedRowKey ?? '');
});

const filterThreads = () => [
  makeThread('1', { repository: 'hups-co/platform' }),
  makeThread('2', { repository: 'hups-co/web' }),
  makeThread('3', { repository: 'acme/app' }),
];

const sortedThreadKeysOf = (session: ReturnType<typeof makeHarness>['session']) =>
  threadKeysOf(session).toSorted();

const addFilters = (session: ReturnType<typeof makeHarness>['session'], text: string) => {
  session.send({ kind: 'editFilterDraft', text });
  session.send({ kind: 'applyFilterRow' });
};

test('applyFilterRow on a negated repo token hides that repo and keeps the others', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, '-repo:hups-co/platform');

  expect(session.getSnapshot().filters).toEqual([
    { field: 'repo', value: 'hups-co/platform', negated: true },
  ]);

  expect(sortedThreadKeysOf(session)).toEqual(['thread:2', 'thread:3']);
  expect(session.getSnapshot().filterDraft).toBe('');
  expect(session.getSnapshot().filtersOpen).toBe(true);
});

test('applyFilterRow on an active filter removes it', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');

  expect(sortedThreadKeysOf(session)).toEqual(['thread:3']);

  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
});

test('age:>3d keeps only older threads, and the list does not change while it is typed', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { updatedAt: '2026-01-02T10:00:00Z' }),
    makeThread('2', { updatedAt: '2026-01-31T12:00:00Z' }),
    makeThread('3', { updatedAt: '2026-01-20T12:00:00Z' }),
  );

  session.send({ kind: 'openFilters' });

  const before = sortedThreadKeysOf(session);
  const token = 'age:>3d';

  for (let length = 1; length <= token.length; length += 1) {
    session.send({ kind: 'editFilterDraft', text: token.slice(0, length) });

    expect(sortedThreadKeysOf(session)).toEqual(before);
  }

  session.send({ kind: 'applyFilterRow' });

  expect(before).toEqual(['thread:1', 'thread:2', 'thread:3']);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:3']);
});

test('editing age:>3d to age:>14d replaces the filter', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('age:>3d');

  addFilters(session, 'age:>14d');

  expect(session.getSnapshot().filters).toEqual([
    { field: 'age', value: '>14d', negated: false },
    { field: 'repo', value: 'acme/app', negated: false },
  ]);

  expect(session.getSnapshot().filterEditing).toBeNull();
});

test('closeFilters during an edit cancels the edit and keeps age:>3d', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'age:>14d' });
  session.send({ kind: 'closeFilters' });

  const snapshot = session.getSnapshot();

  expect(snapshot.filters).toEqual([{ field: 'age', value: '>3d', negated: false }]);
  expect(snapshot.filterEditing).toBeNull();
  expect(snapshot.filterDraft).toBe('');
  expect(snapshot.filtersOpen).toBe(true);

  session.send({ kind: 'closeFilters' });

  expect(session.getSnapshot().filtersOpen).toBe(false);
});

test('leaveFilters during an edit closes the composer and keeps the old chip', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: '' });
  session.send({ kind: 'leaveFilters' });

  const snapshot = session.getSnapshot();

  expect(snapshot.filters).toEqual([{ field: 'age', value: '>3d', negated: false }]);
  expect(snapshot.filtersOpen).toBe(false);
  expect(snapshot.filterEditing).toBeNull();
  expect(snapshot.filterDraft).toBe('');
});

test('typing an invalid token changes neither filters nor rows and applyFilterRow adds nothing', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');

  const before = sortedThreadKeysOf(session);

  session.send({ kind: 'editFilterDraft', text: 'age:>3' });

  expect(session.getSnapshot().filters).toHaveLength(1);
  expect(sortedThreadKeysOf(session)).toEqual(before);

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(1);
  expect(sortedThreadKeysOf(session)).toEqual(before);
});

test('two tokens in one draft add two filters', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'org:hups-co -repo:hups-co/web');

  expect(session.getSnapshot().filters).toHaveLength(2);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1']);
});

test('the same filter is not added twice', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'org:hups-co org:hups-co');

  expect(session.getSnapshot().filters).toHaveLength(1);
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

test('clearFilters empties the filters and shows every thread', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'clearFilters' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
});

test('a thread with unknown state stays visible under state:merged', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'state:merged');

  expect(sortedThreadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
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

const describeRow = (row: FilterRow): string => {
  if (row.kind === 'active') {
    return `active ${formatFilter(row.filter)}${row.count === null ? '' : ` ${row.count}`}`;
  }

  if (row.kind === 'field') {
    return `field ${row.field}`;
  }

  if (row.kind === 'candidate') {
    return `candidate ${formatFilter(row.filter)} ${row.count}`;
  }

  if (row.kind === 'typed') {
    return `typed ${row.filters.map(formatFilter).join(' ')} ${row.count}`;
  }

  return 'error';
};

test('composer rows list active filters, then values, then fields when the draft is empty', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');

  const rows = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(rows[0]).toBe('active repo:acme/app');
  expect(rows[1]).toMatch(/^candidate /);
  expect(rows).toContain('field repo');
  expect(rows).not.toContain('field kind');
  expect(rows.at(-1)).toMatch(/^field /);
  expect(filterCursorOf(session.getSnapshot())).toBe(-1);
});

test('composer rows start with the typed token and its count, then matching candidates', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:hups' });

  const rows = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(rows[0]).toBe('typed repo:hups 0');
  expect(rows).toContain('candidate repo:hups-co/platform 1');
  expect(rows).not.toContain('candidate repo:acme/app 1');

  session.send({ kind: 'editFilterDraft', text: 'age:>3' });

  expect(filterRowsOf(session.getSnapshot()).map(describeRow)).toEqual([]);

  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });

  const typed = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(typed[0]).toBe('active repo:acme/app 1');
  expect(typed.filter((row) => row.includes('repo:acme/app'))).toHaveLength(1);
  expect(filterCursorOf(session.getSnapshot())).toBe(0);
});

test('takeFilterRow on a field puts the field name in the draft and moveFilterCursor stays in range', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'moveFilterCursor', direction: 'up' });

  expect(filterCursorOf(session.getSnapshot())).toBe(
    filterRowsOf(session.getSnapshot()).length - 1,
  );

  session.send({ kind: 'editFilterDraft', text: 'rep' });

  const rows = filterRowsOf(session.getSnapshot());
  const fieldAt = rows.findIndex((row) => row.kind === 'field' && row.field === 'repo');

  for (let step = 0; step < fieldAt; step += 1) {
    session.send({ kind: 'moveFilterCursor', direction: 'down' });
  }

  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('repo:');
  expect(session.getSnapshot().filters).toEqual([]);
});

test('completing a field name with Tab keeps a leading minus, so the filter excludes', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-age' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('-age:');

  session.send({ kind: 'editFilterDraft', text: '-age:>3d' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([{ field: 'age', value: '>3d', negated: true }]);
});

test('completing a field name with Enter keeps a leading minus', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-ag' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('-age:');
  expect(session.getSnapshot().filters).toEqual([]);
});

const rowTexts = (session: ReturnType<typeof makeHarness>['session']) =>
  filterRowsOf(session.getSnapshot()).map(describeRow);

const moveCursorTo = (session: ReturnType<typeof makeHarness>['session'], text: string) => {
  for (
    let step = 0;
    step < 50 && rowTexts(session)[filterCursorOf(session.getSnapshot())] !== text;
    step += 1
  ) {
    session.send({ kind: 'moveFilterCursor', direction: 'down' });
  }

  expect(rowTexts(session)[filterCursorOf(session.getSnapshot())]).toBe(text);
};

test('typing a field name lists a matching active filter that is not an inbox value, and it can be edited', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'age:>3d');
  session.send({ kind: 'editFilterDraft', text: 'age:' });

  expect(rowTexts(session)).toContain('active age:>3d');

  moveCursorTo(session, 'active age:>3d');
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterDraft).toBe('age:>3d');

  addFilters(session, 'age:>14d');

  expect(session.getSnapshot().filters).toEqual([{ field: 'age', value: '>14d', negated: false }]);
});

test('an active inbox value reached by typing is taken as an edit and applied as a removal', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:acme' });
  moveCursorTo(session, 'active repo:acme/app 1');
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterEditing).toEqual({
    field: 'repo',
    value: 'acme/app',
    negated: false,
  });

  session.send({ kind: 'closeFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme' });
  moveCursorTo(session, 'active repo:acme/app 1');
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
});

test('picking a completion during an edit replaces the edited filter', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'repo:' });
  moveCursorTo(session, 'candidate repo:hups-co/web 1');
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'repo', value: 'hups-co/web', negated: false },
  ]);
});

test('a token that differs only by letter case from a chip is that chip, not a second one', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:ACME/APP' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows.filter((row) => row.kind === 'active')).toHaveLength(1);
  expect(rows.some((row) => row.kind === 'typed')).toBe(false);
});

test('the typed token counts open threads over the whole inbox, ignoring search and filters', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'editSearch', text: 'thread 1' });
  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:hups-co/web' });

  expect(rowTexts(session)[0]).toBe('typed repo:hups-co/web 1');
});

const rowSummaryOf = (row: FilterRow): string => {
  if (row.kind === 'candidate' || row.kind === 'active') {
    return `${row.kind} ${formatFilter(row.filter)}`;
  }

  return row.kind === 'field' ? `field ${row.field}` : row.kind;
};

test.each(['repplat', 'rep plat'])(
  '%s lists repo:hups-co/platform first and adds it',
  async (draft) => {
    const { session, load } = makeHarness();

    await load(...filterThreads());
    session.send({ kind: 'openFilters' });
    session.send({ kind: 'editFilterDraft', text: draft });

    const rows = filterRowsOf(session.getSnapshot());

    expect(rows.map(rowSummaryOf)[0]).toBe('candidate repo:hups-co/platform');

    session.send({ kind: 'applyFilterRow' });

    expect(session.getSnapshot().filters).toEqual([
      { field: 'repo', value: 'hups-co/platform', negated: false },
    ]);
  },
);

test('-rep plat lists the negated candidate first and adds a negated filter', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-rep plat' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows.map(rowSummaryOf)[0]).toBe('candidate -repo:hups-co/platform');

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'repo', value: 'hups-co/platform', negated: true },
  ]);
});

test('loose text shows no error row, a bad token does, and a miss starts on the best candidate', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'rep plat' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');

  session.send({ kind: 'editFilterDraft', text: 'repo:plat' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows[0]).toMatchObject({ kind: 'typed', count: 0 });
  expect(rowSummaryOf(rows[1] as FilterRow)).toBe('candidate repo:hups-co/platform');
  expect(filterCursorOf(session.getSnapshot())).toBe(1);
});

test('an empty draft lists active chips, then values by count, then field names', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { repository: 'hups-co/platform' }),
    makeThread('2', { repository: 'hups-co/web' }),
    makeThread('3', { repository: 'acme/app' }),
    makeThread('4', { repository: 'acme/app' }),
    makeThread('5', { repository: 'acme/app' }),
  );

  session.send({ kind: 'openFilters' });
  addFilters(session, 'repo:hups-co/web');

  const rows = filterRowsOf(session.getSnapshot());
  const kinds = rows.map((row) => row.kind);
  const firstField = kinds.indexOf('field');
  const counts = rows.flatMap((row) => (row.kind === 'candidate' ? [row.count] : []));

  expect(rowSummaryOf(rows[0] as FilterRow)).toBe('active repo:hups-co/web');
  expect(rows.slice(1).some((row) => row.kind === 'active')).toBe(false);
  expect(kinds.slice(1, firstField).every((kind) => kind === 'candidate')).toBe(true);
  expect(kinds.slice(firstField).every((kind) => kind === 'field')).toBe(true);
  expect(counts).toEqual(counts.toSorted((left, right) => right - left));
  expect(rowSummaryOf(rows[1] as FilterRow)).toMatch(/^candidate /);
  expect(counts[0]).toBeGreaterThanOrEqual(3);
});

test('a contiguous field match outranks separated initials in a long value', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { repository: 'acme/platform' }),
    makeThread('2', { repository: 'react-event-processing-operator/service' }),
  );

  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo' });

  const summaries = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(summaries[0]).toBe('field repo');

  expect(summaries).toContain('candidate repo:acme/platform');
  expect(summaries).not.toContain('candidate org:react-event-processing-operator');
});

test('a contiguous field match outranks initials spread over short words', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1', { repository: 'acme/platform' }),
    makeThread('2', { repository: 'red-env-prod-ops/service' }),
  );

  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo' });

  const summaries = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(summaries).toContain('candidate repo:acme/platform');
  expect(summaries).not.toContain('candidate org:red-env-prod-ops');
});

test('an emoji in the draft finds an active title chip that holds it', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  addFilters(session, 'title:"🚀 release"');
  session.send({ kind: 'editFilterDraft', text: '🚀' });

  const summaries = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(summaries).toContain('active title:"🚀 release"');
});

const medianRowsTime = async (segments: number): Promise<number> => {
  const { session, load } = makeHarness();
  const longName = 'segment-'.repeat(segments);

  const threads = Array.from({ length: 500 }, (_, index) =>
    makeThread(String(index), {
      repository: `org-${index % 50}/${longName}${index % 250}`,
    }),
  );

  await load(...threads);
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'rep seg tent' });
  filterRowsOf(session.getSnapshot());

  const times = [0, 1, 2].map(() => {
    const started = performance.now();

    filterRowsOf(session.getSnapshot());

    return performance.now() - started;
  });

  return times.toSorted((left, right) => left - right)[1] ?? Infinity;
};

test('filterRowsOf time grows linearly with the length of candidate values', async () => {
  const shortTime = await medianRowsTime(50);
  const longTime = await medianRowsTime(200);

  expect(longTime / shortTime).toBeLessThan(6);
});

const loadWithAuthors = async () => {
  const harness = makeHarness();
  const threads = filterThreads();

  await harness.load(...threads);
  harness.lookups[0]?.resolve(threads.map((thread) => factsOf(thread, 'octo')));
  await settle();
  harness.session.send({ kind: 'openFilters' });

  return harness;
};

test('Enter on the error row of foo: adds no chip', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');

  session.send({ kind: 'applyFilterRow' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filterDraft).toBe('foo:');
});

test('with an empty draft Enter and Tab do nothing, and Down then Enter applies the first row', async () => {
  const { session } = await loadWithAuthors();
  const first = filterRowsOf(session.getSnapshot())[0];

  session.send({ kind: 'applyFilterRow' });
  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(session.getSnapshot().filterDraft).toBe('');

  session.send({ kind: 'moveFilterCursor', direction: 'down' });

  expect(first?.kind).toBe('candidate');

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(1);
});

test('with an empty draft Up selects the last row, and clearing the draft drops the selection', async () => {
  const { session } = await loadWithAuthors();
  const rows = filterRowsOf(session.getSnapshot());

  session.send({ kind: 'moveFilterCursor', direction: 'up' });

  expect(filterCursorOf(session.getSnapshot())).toBe(rows.length - 1);

  session.send({ kind: 'editFilterDraft', text: 'kind' });
  session.send({ kind: 'editFilterDraft', text: '' });

  expect(filterCursorOf(session.getSnapshot())).toBe(-1);
});

test('typing age lists its field row first', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'age' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows[0]).toEqual({ kind: 'field', field: 'age' });
});

test('org:hups-co lists one row whose count is the number of matching threads', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'org:hups-co' });

  const rows = filterRowsOf(session.getSnapshot());
  const orgRows = rows.filter((row) => describeRow(row).includes(' org:hups-co '));

  expect(orgRows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'typed', count: 2 });
});

test('the typed row counts only threads the filter is known to match', async () => {
  const { session, load } = makeHarness();

  await load(...filterThreads());
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'author:octo' });

  expect(filterRowsOf(session.getSnapshot())[0]).toMatchObject({ kind: 'typed', count: 0 });
});

test.each(['author:', 'age:>3'])('%s shows no error row while it is typed', async (draft) => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: draft });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);
});

test('author: starts on its first candidate and Enter adds it', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'author:' });

  const rows = filterRowsOf(session.getSnapshot());

  expect(rows[filterCursorOf(session.getSnapshot())]).toMatchObject({ kind: 'candidate' });

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'author', value: 'octo', negated: false },
  ]);
});

test('Enter on age:>3 with no row selected shows an error row and adds no chip', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'age:>3' });
  session.send({ kind: 'applyFilterRow' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
  expect(session.getSnapshot().filters).toEqual([]);

  session.send({ kind: 'editFilterDraft', text: 'age:>3d' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);
});

test('foo: shows an error row at once', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
});

test('field rows exist only for fields that take a typed value', async () => {
  const { session } = await loadWithAuthors();

  const fieldsOf = (): string[] =>
    filterRowsOf(session.getSnapshot()).flatMap((row) => (row.kind === 'field' ? [row.field] : []));

  for (const field of ['repo', 'org', 'author', 'reason', 'age']) {
    expect(fieldsOf()).toContain(field);
  }

  for (const draft of ['new', 'unread', 'state', 'kind']) {
    session.send({ kind: 'editFilterDraft', text: draft });

    expect(fieldsOf()).not.toContain(draft);
  }

  session.send({ kind: 'editFilterDraft', text: 'age' });

  expect(fieldsOf()).toContain('age');
});

test('state lists state: values before reason:state_change', async () => {
  const harness = makeHarness();
  const threads = [makeThread('1', { reason: 'state_change' }), makeThread('2')];

  await harness.load(...threads);
  harness.lookups[0]?.resolve(threads.map((thread) => factsOf(thread, 'octo')));
  await settle();
  harness.session.send({ kind: 'openFilters' });
  harness.session.send({ kind: 'editFilterDraft', text: 'state' });

  const rows = filterRowsOf(harness.session.getSnapshot()).map(rowSummaryOf);

  expect(rows[0]).toBe('candidate state:open');

  expect(rows).not.toContain('candidate reason:state_change');
});

test('typing an active chip token shows one marked row; Tab edits it and Enter removes it', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'repo:acme/app');
  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });

  const rows = filterRowsOf(session.getSnapshot());
  const matching = rows.filter((row) => rowSummaryOf(row) === 'active repo:acme/app');

  expect(matching).toHaveLength(1);
  expect(rows.filter((row) => row.kind === 'typed')).toEqual([]);
  expect(rows[filterCursorOf(session.getSnapshot())]).toBe(matching[0]);

  session.send({ kind: 'takeFilterRow' });

  expect(session.getSnapshot().filterEditing).toEqual({
    field: 'repo',
    value: 'acme/app',
    negated: false,
  });

  session.send({ kind: 'closeFilters' });
  session.send({ kind: 'editFilterDraft', text: 'repo:acme/app' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
});

test('Enter on another active chip while editing replaces the edited chip with it', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'author:mona');
  addFilters(session, 'author:octo');
  session.send({ kind: 'editFilterDraft', text: 'author:mona' });
  session.send({ kind: 'takeFilterRow' });
  session.send({ kind: 'editFilterDraft', text: 'author:octo' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([
    { field: 'author', value: 'octo', negated: false },
  ]);
});

test('text inside an open quote is not a field name, but foo: still errors at once', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'title:"fix foo:' });

  expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);

  session.send({ kind: 'editFilterDraft', text: 'foo:' });

  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
});

test('a bare colon shows no error row while typed', async () => {
  const { session } = await loadWithAuthors();

  for (const draft of [':', '-:', ':x']) {
    session.send({ kind: 'editFilterDraft', text: draft });

    expect(filterRowsOf(session.getSnapshot()).some((row) => row.kind === 'error')).toBe(false);
  }
});

test('boolean fields list their true value first whatever the counts', async () => {
  const threads = ['1', '2', '3', '4'].map((id) => releaseOf(id));
  const [first, second, third] = threads;
  const seen = [first, second, third].map((thread) => [thread, thread?.updatedAt] as const);

  const savedState = stateWithSeen(
    seenFor(
      octocat,
      ...(seen as [[NotificationThread, string], ...[NotificationThread, string][]]),
    ),
  );

  const { session, load } = makeHarness({ savedState });

  await load(...threads);
  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: 'new' });

  const rows = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(rows.indexOf('candidate new:false')).toBeGreaterThan(-1);
  expect(rows[0]).toBe('candidate new:true');

  session.send({ kind: 'editFilterDraft', text: '' });

  const all = filterRowsOf(session.getSnapshot()).map(rowSummaryOf);

  expect(all.indexOf('candidate new:true')).toBeLessThan(all.indexOf('candidate new:false'));
});

const fieldOfRow = (row: FilterRow): string | undefined => {
  if (row.kind === 'field') {
    return row.field;
  }

  return row.kind === 'candidate' || row.kind === 'active' ? row.filter.field : undefined;
};

test('a single term that starts a field name lists only that field, and several terms match across fields', async () => {
  const harness = makeHarness();

  const threads = [
    makeThread('1', { reason: 'state_change', repository: 'rep-platform/app' }),
    makeThread('2', { repository: 'hups-co/platform' }),
  ];

  await harness.load(...threads);
  harness.lookups[0]?.resolve(threads.map((thread) => factsOf(thread, 'octo')));
  await settle();
  harness.session.send({ kind: 'openFilters' });

  const { session } = harness;

  for (const [draft, field] of [
    ['age', 'age'],
    ['state', 'state'],
    ['rep', 'repo'],
    ['unr', 'unread'],
  ] as const) {
    session.send({ kind: 'editFilterDraft', text: draft });

    const fields = new Set(filterRowsOf(session.getSnapshot()).map(fieldOfRow));

    expect([...fields]).toEqual([field]);
  }

  session.send({ kind: 'editFilterDraft', text: 'rep plat' });

  const fields = new Set(filterRowsOf(session.getSnapshot()).map(fieldOfRow));

  expect(fields.has('repo')).toBe(true);
  expect(fields.has('org')).toBe(true);
});

test('after Enter removes an active chip the next Enter removes the chip now under the cursor', async () => {
  const { session } = await loadWithAuthors();

  addFilters(session, 'repo:acme/app');
  addFilters(session, 'repo:hups-co/web');
  addFilters(session, 'kind:pr');
  session.send({ kind: 'moveFilterCursor', direction: 'down' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(2);

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toHaveLength(1);

  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
});

test('Enter on age:<0m adds no chip and shows an error row', async () => {
  const { session } = await loadWithAuthors();

  session.send({ kind: 'editFilterDraft', text: 'age:<0m' });
  session.send({ kind: 'applyFilterRow' });

  expect(session.getSnapshot().filters).toEqual([]);
  expect(filterRowsOf(session.getSnapshot())[0]?.kind).toBe('error');
});

const loadInbox = async (
  entries: { id: string; overrides?: Partial<NotificationThread>; author?: string }[],
) => {
  const harness = makeHarness();
  const threads = entries.map(({ id, overrides }) => makeThread(id, overrides));

  await harness.load(...threads);

  harness.lookups[0]?.resolve(
    threads.map((thread, index) => factsOf(thread, entries[index]?.author ?? 'octo')),
  );

  await settle();
  harness.session.send({ kind: 'openFilters' });

  return harness.session;
};

const descriptionOfDraft = (session: Awaited<ReturnType<typeof loadInbox>>, draft: string) => {
  session.send({ kind: 'editFilterDraft', text: draft });

  const snapshot = session.getSnapshot();
  const row = filterRowsOf(snapshot)[filterCursorOf(snapshot)];

  return row === undefined ? undefined : describeFilterRow(snapshot, row);
};

test('every known field and value has a description', async () => {
  const session = await loadInbox([{ id: '1' }]);

  for (const field of filterFields) {
    const snapshot = session.getSnapshot();

    expect(describeFilterRow(snapshot, { kind: 'field', field })).not.toBe('');
  }

  const drafts = [
    'kind:pr',
    'kind:issue',
    'kind:release',
    'kind:discussion',
    'kind:commit',
    'kind:ci',
    'state:open',
    'state:closed',
    'state:merged',
    'new:true',
    'new:false',
    'unread:true',
    'unread:false',
    'reason:mention',
    'reason:review_requested',
  ];

  for (const draft of drafts) {
    expect(descriptionOfDraft(session, draft)).toBeTruthy();
  }
});

test('a repo row describes its threads with counts by kind, singular for one', async () => {
  const session = await loadInbox([
    { id: '1', overrides: { repository: 'acme/app' } },
    { id: '2', overrides: { repository: 'acme/app', subjectType: 'Issue' } },
    { id: '3', overrides: { repository: 'acme/app', subjectType: 'Issue' } },
    { id: '4', overrides: { repository: 'acme/web' } },
  ]);

  const description = descriptionOfDraft(session, 'repo:acme/app') ?? '';

  expect(description).toContain('acme/app');
  expect(description).toMatch(/\b3 in your inbox/);
  expect(description).toMatch(/\b1 pull request\b(?!s)/);
  expect(description).toMatch(/\b2 issues\b/);
  expect(description).not.toContain('release');
});

test('an org row gives its thread and repository counts', async () => {
  const session = await loadInbox([
    { id: '1', overrides: { repository: 'acme/app' } },
    { id: '2', overrides: { repository: 'acme/web' } },
    { id: '3', overrides: { repository: 'other/web' } },
  ]);

  const description = descriptionOfDraft(session, 'org:acme') ?? '';

  expect(description).toContain('acme');
  expect(description).toContain('2 in your inbox');
  expect(description).toContain('2 repositories');
});

test('an author row adds the bot note for a bot login', async () => {
  const session = await loadInbox([
    { id: '1', author: 'renovate[bot]' },
    { id: '2', author: 'octo' },
  ]);

  const bot = descriptionOfDraft(session, 'author:renovate[bot]') ?? '';
  const human = descriptionOfDraft(session, 'author:octo') ?? '';

  expect(bot).toContain('renovate[bot]');
  expect(bot).toContain('1 in your inbox');
  expect(bot).toContain('bot account');
  expect(human).toContain('octo');
  expect(human).toContain('1 in your inbox');
  expect(human).not.toContain('bot');
});

test('a typed value with a star counts the threads it matches', async () => {
  const session = await loadInbox([
    { id: '1', overrides: { repository: 'acme/app' } },
    { id: '2', overrides: { repository: 'acme/web' } },
    { id: '3', overrides: { repository: 'other/web' } },
  ]);

  const repositories = descriptionOfDraft(session, 'repo:acme/*') ?? '';
  const authors = descriptionOfDraft(session, 'author:oc*') ?? '';

  expect(repositories).toContain('acme/*');
  expect(repositories).toContain('2 in your inbox');
  expect(authors).toContain('oc*');
  expect(authors).toContain('3 in your inbox');
});

test('a typed row of several tokens describes every filter it adds', async () => {
  const session = await loadInbox([{ id: '1', overrides: { repository: 'acme/app' } }]);

  const description = descriptionOfDraft(session, 'repo:acme/app author:octo') ?? '';

  expect(description).toMatch(/\b2 filters\b/);
  expect(description).toContain('repo:acme/app');
  expect(description).toContain('author:octo');
});

test('a typed row keeps the quotes and the minus of its filter labels', async () => {
  const session = await loadInbox([{ id: '1' }]);

  const description = descriptionOfDraft(session, '-kind:pr title:"hello, author:octo"') ?? '';

  expect(description).toMatch(/\b2 filters\b/);
  expect(description).toContain('-kind:pr');
  expect(description).toContain('title:"hello, author:octo"');
});

test('a typed row of one token keeps the description of its filter', async () => {
  const session = await loadInbox([{ id: '1', overrides: { repository: 'acme/app' } }]);

  const description = descriptionOfDraft(session, 'repo:acme/app') ?? '';

  expect(description).toContain('acme/app');
  expect(description).not.toContain('Adds');
});

test('a repo value with no threads leaves out the kind list', async () => {
  const session = await loadInbox([{ id: '1', overrides: { repository: 'acme/app' } }]);

  const description = descriptionOfDraft(session, 'repo:x/y') ?? '';

  expect(description).toContain('x/y');
  expect(description).toContain('0 in your inbox');

  for (const word of ['pull request', 'issue', 'release', 'discussion', 'commit', 'workflow run']) {
    expect(description).not.toContain(word);
  }
});

test('a negated row hides what its positive row describes, and an explicit value text wins over live text', async () => {
  const session = await loadInbox([{ id: '1', author: 'octo' }]);

  const positive = descriptionOfDraft(session, 'kind:pr') ?? '';
  const negated = descriptionOfDraft(session, '-kind:pr') ?? '';
  const me = descriptionOfDraft(session, 'author:@me') ?? '';

  const liveAuthor = descriptionOfDraft(session, 'author:octo') ?? '';

  expect(positive).toContain('Pull requests');
  expect(positive).not.toMatch(/^Hides/);
  expect(negated).toMatch(/^Hides/);
  expect(negated).toContain(positive);
  expect(me).not.toBe('');
  expect(me).not.toBe(liveAuthor);
  expect(me).not.toMatch(/\d+ in your inbox/);
  expect(me).not.toBe(describeFilterRow(session.getSnapshot(), { kind: 'field', field: 'author' }));
  expect(descriptionOfDraft(session, 'author:@me')).toBe(me);
});

test('a negated row counts the threads it keeps, before and after it is applied', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1'),
    makeThread('2'),
    makeThread('3'),
    makeThread('4', { subjectType: 'Issue' }),
  );

  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-kind:pr' });

  const before = filterRowsOf(session.getSnapshot()).map(describeRow);

  session.send({ kind: 'applyFilterRow' });
  session.send({ kind: 'editFilterDraft', text: '-kind:pr' });

  const after = filterRowsOf(session.getSnapshot()).map(describeRow);

  session.send({ kind: 'editFilterDraft', text: '-kind' });

  const candidates = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(before[0]).toBe('typed -kind:pr 1');
  expect(before).not.toContain('candidate -kind:pr 3');
  expect(after).toEqual(['active -kind:pr 1']);
  expect(candidates).toContain('active -kind:pr 1');
  expect(candidates).toContain('candidate -kind:issue 3');
});
