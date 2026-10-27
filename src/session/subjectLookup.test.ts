import { expect, test } from 'bun:test';

import type { SubjectLookupResult } from '../github/github.ts';
import type { NotificationThread } from '../work/work.ts';
import { createAdmission } from './admission.ts';
import { applyFailure, failureMessage } from './feedTransitions.ts';
import {
  factsOf,
  failure,
  makeHarness,
  makeThread,
  readOf,
  settle,
  stable,
  unchanged,
} from './sessionHarness.ts';
import type { Snapshot } from './sessionState.ts';
import { initialSnapshot } from './sessionState.ts';
import { createSubjectLookup } from './subjectLookup.ts';

test('the snapshot lists threads before the lookup resolves and holds the facts after', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');

  await load(thread);

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);
  expect(lookups).toHaveLength(1);
  expect(lookups[0]?.threads).toEqual([thread]);

  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  expect(session.getSnapshot().threads).toEqual([thread]);

  expect(session.getSnapshot().subjectFacts.get(thread.id)).toEqual({
    state: 'open',
    author: 'hubot',
    latestActor: null,
  });
});

test('a second refresh sends only threads with a new updated_at', async () => {
  const { load, lookups } = makeHarness();
  const first = makeThread('1');
  const second = makeThread('2');

  await load(first, second);
  lookups[0]?.resolve([factsOf(first), factsOf(second)]);
  await settle();

  await load(first, second);

  expect(lookups).toHaveLength(1);

  const changedSecond = makeThread('2', { updatedAt: '2026-01-03T10:00:00Z' });

  await load(first, changedSecond);

  expect(lookups).toHaveLength(2);
  expect(lookups[1]?.threads).toEqual([changedSecond]);
});

test('a result for a thread whose updated_at changed during the lookup is dropped', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');
  const changedThread = makeThread('1', { updatedAt: '2026-01-03T10:00:00Z' });

  await load(thread);
  await load(changedThread);

  expect(lookups).toHaveLength(2);

  lookups[0]?.resolve([factsOf(thread, 'stale')]);
  await settle();

  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  lookups[1]?.resolve([factsOf(changedThread, 'fresh')]);
  await settle();

  expect(session.getSnapshot().subjectFacts.get(thread.id)?.author).toBe('fresh');
});

test('a lookup that rejects keeps the threads and sends them again on the next refresh', async () => {
  const { session, load, lookups } = makeHarness();
  const first = makeThread('1');
  const second = makeThread('2');

  await load(first, second);
  lookups[0]?.reject(new Error('network down'));
  await settle();

  expect(session.getSnapshot().threads).toEqual([first, second]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  await load(first, second);

  expect(lookups).toHaveLength(2);
  expect(lookups[1]?.threads).toEqual([first, second]);
});

test('a thread that changed has unknown facts until its lookup answers, and after it fails', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');
  const changedThread = makeThread('1', { updatedAt: '2026-01-03T10:00:00Z' });

  await load(thread);
  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  await load(changedThread);

  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  lookups[1]?.resolve([]);
  await settle();

  expect(session.getSnapshot().threads).toEqual([changedThread]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);
});

test('a thread answered with null facts stays listed and is not sent again', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');

  await load(thread);

  lookups[0]?.resolve([{ threadId: thread.id, updatedAt: thread.updatedAt, facts: null }]);

  await settle();

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  await load(thread);

  expect(lookups).toHaveLength(1);
});

test('stop aborts a running lookup and drops its result', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  await session.stop(new AbortController().signal);

  expect(lookups[0]?.signal.aborted).toBe(true);

  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  expect(session.getSnapshot().subjectFacts.size).toBe(0);
});

test('a refresh that returns a thread with the same updated_at keeps its subject facts', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  lookups[0]?.resolve([factsOf(thread)]);
  await settle();
  await load(thread);

  expect(session.getSnapshot().subjectFacts.get(thread.id)).toEqual({
    state: 'open',
    author: 'hubot',
    latestActor: null,
  });
});

const directLookup = (pausedUntil: Date) => {
  const clock = { time: new Date('2026-02-01T12:00:00Z').getTime() };
  const now = () => new Date(clock.time);
  const sent: NotificationThread[][] = [];

  let snapshot = applyFailure(
    initialSnapshot,
    { kind: 'rateLimited', resetAt: pausedUntil },
    now(),
  );

  const getSnapshot = () => snapshot;

  const update = (next: Snapshot) => {
    snapshot = next;
  };

  const owner = createSubjectLookup({
    saved: null,
    lookUpSubjects: (threads) => {
      sent.push(threads);

      return Promise.resolve({ lookups: [], failures: [] });
    },
    getSnapshot,
    update,
    isStopped: () => false,
    admission: createAdmission({ now, getSnapshot, update }),
  });

  return { owner, sent, clock };
};

test('a feed rate limit holds subject lookups until the reset time', async () => {
  const resetAt = new Date('2026-02-01T12:05:00Z');
  const { owner, sent, clock } = directLookup(resetAt);
  const thread = makeThread('1');

  owner.start([thread]);
  await settle();

  expect(sent).toEqual([]);

  clock.time = resetAt.getTime();
  owner.start([thread]);
  await settle();

  expect(sent).toEqual([[thread]]);
});

const lookupResetAt = new Date('2026-02-01T12:05:00Z');

const rateLimitedLookup = (): SubjectLookupResult => ({
  lookups: [],
  failures: [{ kind: 'rateLimited', resetAt: lookupResetAt }],
});

const heldLookups = () => {
  const answers: ((result: SubjectLookupResult) => void)[] = [];

  const lookUpSubjects = () =>
    new Promise<SubjectLookupResult>((resolve) => {
      answers.push(resolve);
    });

  return { answers, lookUpSubjects };
};

test('a manual refresh during a pause set by a subject lookup starts no request', async () => {
  const { session, load, countOf, pending } = makeHarness({
    lookUpSubjects: () => Promise.resolve(rateLimitedLookup()),
  });

  await load(makeThread('1'));
  session.send({ kind: 'refresh' });
  await settle();

  expect(session.getSnapshot().pausedUntil).toEqual(lookupResetAt);

  expect(session.getSnapshot().errorMessage).toBe(
    failureMessage({ kind: 'rateLimited', resetAt: lookupResetAt }),
  );

  expect(countOf('viewer')).toBe(1);
  expect(countOf('read')).toBe(1);
  expect(pending).toHaveLength(0);
});

test('a lookup aborted after it started drops its facts but pauses on its rate limit', async () => {
  const { answers, lookUpSubjects } = heldLookups();
  const { session, load } = makeHarness({ lookUpSubjects });
  const first = makeThread('1');

  await load(first);
  await load(first, makeThread('2'));
  answers[0]?.({ ...rateLimitedLookup(), lookups: [factsOf(first)] });
  await settle();

  expect(session.getSnapshot().pausedUntil).toEqual(lookupResetAt);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);
});

test('a rate limit returned after stop sets no pause', async () => {
  const { answers, lookUpSubjects } = heldLookups();
  const { session, load } = makeHarness({ lookUpSubjects });

  await load(makeThread('1'));
  await session.stop(new AbortController().signal);
  answers[0]?.(rateLimitedLookup());
  await settle();

  expect(session.getSnapshot().pausedUntil).toBeNull();
});

test('a lookup pause set during a feed refresh outlasts that refresh and holds the next poll', async () => {
  const { answers, lookUpSubjects } = heldLookups();

  const { session, load, now, answerRead, answerVerify, activeTimers } = makeHarness({
    lookUpSubjects,
  });

  const thread = makeThread('1');

  await load(thread);
  session.send({ kind: 'refresh' });
  await settle();
  answers[0]?.(rateLimitedLookup());
  await settle();
  await answerRead(readOf('feed', [thread]));
  await answerVerify(stable);

  const remaining = lookupResetAt.getTime() - now().getTime();

  expect(session.getSnapshot().pausedUntil).toEqual(lookupResetAt);

  expect(session.getSnapshot().errorMessage).toBe(
    failureMessage({ kind: 'rateLimited', resetAt: lookupResetAt }),
  );

  expect(activeTimers().map((timer) => timer.delay)).toEqual([remaining]);
  expect(answers).toHaveLength(1);
});

test('a lookup rate limit with an earlier reset keeps the later feed pause', async () => {
  const { answers, lookUpSubjects } = heldLookups();
  const { session, load, fireTimer, answerPoll } = makeHarness({ lookUpSubjects });
  const feedResetAt = new Date('2026-02-01T12:10:00Z');

  await load(makeThread('1'));
  await fireTimer();
  await answerPoll({ ok: false, failure: { kind: 'rateLimited', resetAt: feedResetAt } });
  answers[0]?.(rateLimitedLookup());
  await settle();

  expect(session.getSnapshot().pausedUntil).toEqual(feedResetAt);

  expect(session.getSnapshot().errorMessage).toBe(
    failureMessage({ kind: 'rateLimited', resetAt: feedResetAt }),
  );
});

test('a lookup failure other than a rate limit sets no pause and keeps the found facts', async () => {
  const thread = makeThread('1');

  const { session, load, countOf } = makeHarness({
    lookUpSubjects: () =>
      Promise.resolve({
        lookups: [factsOf(thread)],
        failures: [{ kind: 'requestFailed', status: 500, message: 'Boom' }],
      }),
  });

  await load(thread);

  expect(session.getSnapshot().subjectFacts.has(thread.id)).toBe(true);

  session.send({ kind: 'refresh' });
  await settle();

  expect(session.getSnapshot().pausedUntil).toBeNull();
  expect(countOf('read')).toBe(2);
});

const pausedDuringPoll = async () => {
  const { answers, lookUpSubjects } = heldLookups();
  const harness = makeHarness({ lookUpSubjects });

  await harness.load(makeThread('1'));
  await harness.fireTimer();
  answers[0]?.(rateLimitedLookup());
  await settle();

  return harness;
};

const lookupPauseMessage = failureMessage({ kind: 'rateLimited', resetAt: lookupResetAt });

test('a feed failure during a lookup pause keeps the pause and blocks a manual refresh', async () => {
  const { session, answerPoll, countOf } = await pausedDuringPoll();

  await answerPoll(failure('Boom'));
  session.send({ kind: 'refresh' });
  await settle();

  expect(session.getSnapshot().pausedUntil).toEqual(lookupResetAt);
  expect(session.getSnapshot().errorMessage).toBe(lookupPauseMessage);
  expect(countOf('read')).toBe(1);
});

test('a feed rate limit with an earlier reset keeps the later lookup pause', async () => {
  const { session, answerPoll } = await pausedDuringPoll();

  await answerPoll({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date('2026-02-01T12:02:00Z') },
  });

  expect(session.getSnapshot().pausedUntil).toEqual(lookupResetAt);
  expect(session.getSnapshot().errorMessage).toBe(lookupPauseMessage);
});

test('an unchanged poll during a lookup pause keeps the pause message', async () => {
  const { session, answerPoll } = await pausedDuringPoll();

  await answerPoll(unchanged());

  expect(session.getSnapshot().pausedUntil).toEqual(lookupResetAt);
  expect(session.getSnapshot().errorMessage).toBe(lookupPauseMessage);
});

test('a lookup rate limit with a later reset extends the feed pause', async () => {
  const { answers, lookUpSubjects } = heldLookups();
  const { session, load, fireTimer, answerPoll } = makeHarness({ lookUpSubjects });

  await load(makeThread('1'));
  await fireTimer();

  await answerPoll({
    ok: false,
    failure: { kind: 'rateLimited', resetAt: new Date('2026-02-01T12:02:00Z') },
  });

  answers[0]?.(rateLimitedLookup());
  await settle();

  expect(session.getSnapshot().pausedUntil).toEqual(lookupResetAt);
});
