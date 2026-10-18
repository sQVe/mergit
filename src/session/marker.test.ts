import { expect, test } from 'bun:test';

import type { NotificationThread } from '../work/work.ts';
import { toViewerLogin } from '../work/work.ts';
import {
  accountKeyOf,
  doneFor,
  failure,
  makeFeed,
  makeHarness,
  makeThread,
  newThreadsFixture,
  octocat,
  readOf,
  releaseOf,
  savedAt,
  seenFor,
  seenOf,
  settle,
  stable,
  stateWithSeen,
  viewerOf,
} from './sessionHarness.ts';

test('a selected new thread stays new until the cursor leaves it', async () => {
  const { a, b, savedState } = newThreadsFixture();
  const harness = makeHarness({ savedState });

  await harness.load(a, b);
  harness.selectThread(a);
  harness.session.send({ kind: 'selectNext' });

  expect(harness.selected()).toBe(`thread:${b.id}`);
  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);
  expect(harness.saves.some((state) => seenOf(state, b) === b.updatedAt)).toBe(false);

  harness.session.send({ kind: 'selectPrevious' });

  expect(harness.selected()).toBe(`thread:${a.id}`);
  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);
  expect(seenOf(harness.saves.at(-1), b)).toBe(b.updatedAt);
});

test('stopping with a new thread selected saves it as seen and a restart shows no marker', async () => {
  const { a, b, savedState } = newThreadsFixture();
  const harness = makeHarness({ savedState });

  await harness.load(a, b);
  harness.selectThread(b);

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);

  await harness.session.stop(new AbortController().signal);

  const lastSave = harness.saves.at(-1);

  expect(seenOf(lastSave, b)).toBe(b.updatedAt);

  const restarted = makeHarness({ savedState: lastSave ?? null });

  await restarted.load(a, b);
  restarted.selectThread(b);

  expect(restarted.session.getSnapshot().newThreadIds.size).toBe(0);
});

test('the first loaded refresh without a seen entry marks nothing new, saves every thread as seen, and a later change is new', async () => {
  const [a, b] = [releaseOf('1'), releaseOf('2')];
  const harness = makeHarness();

  await harness.load(a, b);

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);

  expect(harness.saves.at(-1)?.seen.get(accountKeyOf(octocat))).toEqual(
    new Map([
      [a.id, a.updatedAt],
      [b.id, b.updatedAt],
    ]),
  );

  const changedB = releaseOf('2', '2026-01-05T10:00:00Z');

  await harness.loadWith('feed2', [a, changedB]);

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);
});

test('a thread whose latest actor is the viewer is not new and its updated_at is saved as seen', async () => {
  const [a, b] = [releaseOf('1'), makeThread('2')];

  const harness = makeHarness({
    savedState: stateWithSeen(seenFor(octocat, [a, a.updatedAt])),
  });

  await harness.load(a, b);
  await settle();

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([]);

  harness.lookups[0]?.resolve([
    {
      threadId: b.id,
      updatedAt: b.updatedAt,
      facts: { state: 'open', author: 'hubot', latestActor: 'OctoCat' },
    },
  ]);

  await settle();

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);

  expect(harness.saves.at(-1)?.seen.get(accountKeyOf(octocat))?.get(b.id)).toBe(b.updatedAt);
});

test('a changed pull request thread is not new while its lookup is pending and is new after the lookup rejects', async () => {
  const b = makeThread('2');

  const harness = makeHarness({
    savedState: stateWithSeen(seenFor(octocat, [b, '2026-01-01T10:00:00Z'])),
  });

  await harness.load(b);

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);

  harness.lookups[0]?.reject(new Error('network down'));
  await settle();

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);
});

test('a lookup that answers no facts leaves the changed thread new', async () => {
  const b = makeThread('2');

  const harness = makeHarness({
    savedState: stateWithSeen(seenFor(octocat, [b, '2026-01-01T10:00:00Z'])),
  });

  await harness.load(b);

  harness.lookups[0]?.resolve([{ threadId: b.id, updatedAt: b.updatedAt, facts: null }]);

  await settle();

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);
});

test('a loaded full refresh deletes the seen value of a thread missing from the feed and keeps one marked done', async () => {
  const [a, b, c] = [releaseOf('1'), releaseOf('2'), releaseOf('3')];

  const harness = makeHarness({
    savedState: {
      grouping: 'reason',
      done: doneFor(octocat, b),
      seen: seenFor(octocat, [a, a.updatedAt], [b, b.updatedAt], [c, c.updatedAt]),
    },
  });

  await harness.load(b, c);

  const seen = harness.saves.at(-1)?.seen.get(accountKeyOf(octocat));

  expect(seen?.has(a.id)).toBe(false);
  expect(seen?.get(b.id)).toBe(b.updatedAt);
  expect(seen?.get(c.id)).toBe(c.updatedAt);
});

test('a selected thread that leaves the feed keeps no seen value after the refresh', async () => {
  const { a, b, savedState } = newThreadsFixture();
  const harness = makeHarness({ savedState });

  await harness.load(a, b);
  harness.selectThread(b);
  await harness.loadWith('feed2', [a]);

  expect(harness.saves.at(-1)?.seen.get(accountKeyOf(octocat))?.has(b.id)).toBe(false);
});

test('an account change records the selected thread as seen for the account the cursor left', async () => {
  const hubot = toViewerLogin('hubot');
  const { a, b } = newThreadsFixture();
  let login = octocat;

  const harness = makeHarness({
    savedState: stateWithSeen(
      new Map([
        ...seenFor(octocat, [a, a.updatedAt], [b, '2026-01-01T10:00:00Z']),
        [accountKeyOf(hubot), new Map()],
      ]),
    ),
    readViewer: () => Promise.resolve(viewerOf(login)),
  });

  await harness.load(a, b);
  harness.selectThread(b);

  login = hubot;
  await harness.loadWith('hubot', []);

  const lastSave = harness.saves.at(-1);

  expect(seenOf(lastSave, b)).toBe(b.updatedAt);
  expect(lastSave?.seen.get(accountKeyOf(hubot))?.has(b.id)).toBe(false);
});

const savedMarkerHarness = (thread: NotificationThread) =>
  makeHarness(
    {
      savedSnapshot: {
        viewer: { login: octocat, etag: null },
        savedAt,
        feed: makeFeed('saved', [thread]),
        threads: [thread],
      },
      savedState: stateWithSeen(seenFor(octocat, [thread, '2026-01-01T10:00:00Z'])),
    },
    { holdViewer: true },
  );

test('a saved snapshot shows no marker on a changed pull request thread before its lookup answers', async () => {
  const thread = makeThread('2');
  const harness = savedMarkerHarness(thread);

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerViewer(viewerOf(octocat));
  harness.take('read').resolve(readOf('feed', [thread]));
  await settle();
  await harness.answerVerify(stable);

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);

  harness.lookups[0]?.resolve([
    {
      threadId: thread.id,
      updatedAt: thread.updatedAt,
      facts: { state: 'open', author: 'hubot', latestActor: 'OctoCat' },
    },
  ]);

  await settle();

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);
});

test('a saved pull request thread becomes new when the first full refresh fails', async () => {
  const thread = makeThread('2');
  const harness = savedMarkerHarness(thread);

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerViewer(viewerOf(octocat));
  harness.take('read').resolve(failure('network down'));
  await settle();

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([thread.id]);
});

test('a saved Release thread that changed since it was seen is new at start', () => {
  const thread = releaseOf('2');
  const harness = savedMarkerHarness(thread);

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([thread.id]);
});

test('moving the cursor before the first load with a saved login and no seen record does not throw', () => {
  const harness = makeHarness(
    {
      savedSnapshot: {
        viewer: { login: octocat, etag: null },
        savedAt,
        feed: makeFeed('saved', [makeThread('1'), makeThread('2')]),
        threads: [makeThread('1'), makeThread('2')],
      },
      savedState: stateWithSeen(new Map()),
    },
    { holdViewer: true },
  );

  const before = harness.selected();

  harness.session.send({ kind: 'selectNext' });
  harness.session.send({ kind: 'selectNext' });
  harness.session.send({ kind: 'selectPrevious' });

  expect(before).not.toBeNull();
  expect(harness.selected()).not.toBe(before);
  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);
});

test('a selected new thread stays new after cycleGrouping and after an unchanged poll', async () => {
  const { a, b, savedState } = newThreadsFixture();
  const harness = makeHarness({ savedState });

  await harness.load(a, b);
  harness.selectThread(b);
  harness.session.send({ kind: 'cycleGrouping' });

  expect(harness.selected()).toBe(`thread:${b.id}`);
  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);

  await harness.fireTimer();
  await harness.answerPoll({ ok: true, value: { kind: 'unchanged', pollInterval: null } });

  expect(harness.selected()).toBe(`thread:${b.id}`);
  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);
});

test('a refresh that drops the new thread and makes another one new replaces the new set', async () => {
  const [a, b] = [releaseOf('1'), releaseOf('2')];

  const harness = makeHarness({
    savedState: stateWithSeen(seenFor(octocat, [a, '2026-01-01T10:00:00Z'], [b, b.updatedAt])),
  });

  await harness.load(a, b);

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([a.id]);

  const changedB = releaseOf('2', '2026-01-05T10:00:00Z');

  await harness.loadWith('feed2', [changedB]);

  expect([...harness.session.getSnapshot().newThreadIds]).toEqual([b.id]);
});

test('an intent that changes nothing notifies no subscriber while a thread is new', async () => {
  const { a, b, savedState } = newThreadsFixture();
  const harness = makeHarness({ savedState });
  let calls = 0;

  await harness.load(a, b);
  harness.session.send({ kind: 'selectFirst' });

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(1);

  harness.session.subscribe(() => {
    calls += 1;
  });

  harness.session.send({ kind: 'selectPrevious' });

  expect(calls).toBe(0);
});

test('the first load with no new threads sets the snapshot viewer login', async () => {
  const harness = makeHarness();

  await harness.load(releaseOf('1'));

  expect(harness.session.getSnapshot().newThreadIds.size).toBe(0);
  expect(harness.session.getSnapshot().viewerLogin).toBe(octocat);
});
