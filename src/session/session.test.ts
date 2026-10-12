import { expect, test } from 'bun:test';

import type {
  GitHubResult,
  NotificationFeed,
  NotificationFeedRead,
  NotificationFeedRequest,
  NotificationPage,
  NotificationPoll,
  NotificationVerification,
} from '../github/github.ts';
import type { NotificationThread } from '../work/work.ts';
import { toThreadId } from '../work/work.ts';
import { createSession } from './session.ts';
import type { SessionEffects } from './session.ts';

type Call =
  | {
      kind: 'poll';
      feed: NotificationFeed;
      resolve: (result: GitHubResult<NotificationPoll>) => void;
      signal: AbortSignal;
    }
  | {
      kind: 'read';
      request: NotificationFeedRequest;
      resolve: (result: GitHubResult<NotificationFeedRead>) => void;
      signal: AbortSignal;
    }
  | {
      kind: 'verify';
      feed: NotificationFeed;
      resolve: (result: GitHubResult<NotificationVerification>) => void;
      signal: AbortSignal;
    };

interface FakeTimer {
  delay: number;
  callback: () => void;
  active: boolean;
}

const makeThread = (
  id: string,
  overrides: Partial<NotificationThread> = {},
): NotificationThread => ({
  id: toThreadId(id),
  reason: 'review_requested',
  unread: true,
  updatedAt: '2026-01-02T10:00:00Z',
  lastReadAt: null,
  title: `Thread ${id}`,
  subjectType: 'PullRequest',
  subjectUrl: `https://api.github.com/repos/acme/app/pulls/${id}`,
  repository: 'acme/app',
  ...overrides,
});

const settle = () => Bun.sleep(0);

const makePage = (label: string, threads: NotificationThread[] = []): NotificationPage => ({
  endpoint: '/notifications?all=true&per_page=50',
  etag: `"${label}"`,
  threads,
  next: null,
  body: '[]',
});

const makeFeed = (label: string, threads: NotificationThread[] = []): NotificationFeed => ({
  pages: [makePage(label, threads)],
});

const readOf = (
  label: string,
  threads: NotificationThread[],
  pollInterval: number | null = null,
): GitHubResult<NotificationFeedRead> => ({
  ok: true,
  value: { feed: makeFeed(label, threads), threads, pollInterval },
});

const verified = (
  kind: 'stable' | 'changed',
  pollInterval: number | null = null,
): GitHubResult<NotificationVerification> => ({ ok: true, value: { kind, pollInterval } });

const stable = verified('stable');
const changed = verified('changed');

const unchanged = (pollInterval: number | null = null): GitHubResult<NotificationPoll> => ({
  ok: true,
  value: { kind: 'unchanged', pollInterval },
});

const failure = (message: string) => ({
  ok: false as const,
  failure: { kind: 'requestFailed' as const, status: 500, message },
});

const makeHarness = (overrides: Partial<SessionEffects> = {}) => {
  const pending: Call[] = [];
  const history: Call[] = [];
  const timers: FakeTimer[] = [];
  const clock = { time: new Date('2026-02-01T12:00:00Z').getTime() };

  const record = (call: Call) => {
    pending.push(call);
    history.push(call);
  };

  const session = createSession({
    pollFeed: (feed, signal) =>
      new Promise((resolve) => {
        record({ kind: 'poll', feed, resolve, signal });
      }),
    readFeed: (request, signal) =>
      new Promise((resolve) => {
        record({ kind: 'read', request, resolve, signal });
      }),
    verifyFeed: (feed, signal) =>
      new Promise((resolve) => {
        record({ kind: 'verify', feed, resolve, signal });
      }),
    now: () => new Date(clock.time),
    setTimer: (delay, callback) => {
      const timer = { delay, callback, active: true };

      timers.push(timer);

      return () => {
        timer.active = false;
      };
    },
    ...overrides,
  });

  const take = <Kind extends Call['kind']>(kind: Kind) => {
    const index = pending.findIndex((call) => call.kind === kind);
    const [call] = pending.splice(index, 1);

    if (call === undefined) {
      throw new Error(`no pending ${kind} call`);
    }

    return call as Extract<Call, { kind: Kind }>;
  };

  const answerRead = async (result: GitHubResult<NotificationFeedRead>) => {
    take('read').resolve(result);
    await settle();
  };

  const answerVerify = async (result: GitHubResult<NotificationVerification>) => {
    take('verify').resolve(result);
    await settle();
  };

  const answerPoll = async (result: GitHubResult<NotificationPoll>) => {
    take('poll').resolve(result);
    await settle();
  };

  const countOf = (kind: Call['kind']) => history.filter((call) => call.kind === kind).length;

  const activeTimers = () => timers.filter((timer) => timer.active);

  const fireTimer = async () => {
    const timer = activeTimers().at(-1);

    if (timer === undefined) {
      throw new Error('no scheduled timer');
    }

    timer.active = false;
    clock.time += timer.delay;
    timer.callback();
    await settle();
  };

  const loadWith = async (label: string, threads: NotificationThread[], pollInterval?: number) => {
    session.send({ kind: 'refresh' });
    await answerRead(readOf(label, threads, pollInterval ?? null));
    await answerVerify(stable);
  };

  const load = (...threads: NotificationThread[]) => loadWith('feed', threads);

  const advance = (milliseconds: number) => {
    clock.time += milliseconds;
  };

  const selected = () => session.getSnapshot().selectedThreadId;
  const now = () => new Date(clock.time);

  return {
    session,
    pending,
    history,
    now,
    advance,
    take,
    answerRead,
    answerVerify,
    answerPoll,
    countOf,
    activeTimers,
    fireTimer,
    loadWith,
    load,
    selected,
  };
};

test('an unchanged poll sends one request and changes nothing', async () => {
  const { session, load, fireTimer, answerPoll, countOf, pending } = makeHarness();

  await load(makeThread('1'));

  const before = session.getSnapshot();
  const readsBefore = countOf('read');
  const verifiesBefore = countOf('verify');

  await fireTimer();

  expect(countOf('poll')).toBe(1);

  await answerPoll(unchanged());

  expect(countOf('poll')).toBe(1);
  expect(countOf('read')).toBe(readsBefore);
  expect(countOf('verify')).toBe(verifiesBefore);
  expect(pending).toHaveLength(0);
  expect(session.getSnapshot()).toBe(before);
});

test('a refresh holds the open threads in feed order and selects the first', async () => {
  const { session, pending, answerRead, answerVerify, now } = makeHarness();
  const first = makeThread('1');
  const second = makeThread('2');
  const done = makeThread('3', { unread: false, lastReadAt: null });

  session.send({ kind: 'refresh' });

  expect(pending).toHaveLength(1);
  expect(session.getSnapshot().refreshStatus).toBe('running');

  await answerRead(readOf('feed', [first, done, second]));

  expect(session.getSnapshot().threads).toEqual([]);
  expect(session.getSnapshot().refreshStatus).toBe('running');

  await answerVerify(stable);

  const snapshot = session.getSnapshot();

  expect(snapshot.threads).toEqual([first, second]);
  expect(snapshot.selectedThreadId).toBe(first.id);
  expect(snapshot.refreshStatus).toBe('idle');
  expect(snapshot.hasLoaded).toBe(true);
  expect(snapshot.refreshedAt).toEqual(now());
});

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

  const before = session.getSnapshot();
  const signal = pending[0]?.signal;
  const callsBeforeStop = calls;

  session.stop();

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
  session.stop();

  expect(activeTimers()).toHaveLength(0);
});

test('send after stop starts no refresh and changes nothing', () => {
  const { session, pending } = makeHarness();
  const before = session.getSnapshot();

  session.stop();
  session.send({ kind: 'refresh' });

  expect(pending).toHaveLength(0);
  expect(session.getSnapshot()).toBe(before);
});

test('three refresh intents during one refresh start exactly one follow-up', async () => {
  const { session, pending, answerRead, answerVerify } = makeHarness();

  session.send({ kind: 'refresh' });
  session.send({ kind: 'refresh' });
  session.send({ kind: 'refresh' });
  session.send({ kind: 'refresh' });

  expect(pending).toHaveLength(1);

  await answerRead(readOf('feed', [makeThread('1')]));
  await answerVerify(stable);

  expect(pending).toHaveLength(1);
  expect(pending[0]?.kind).toBe('read');
  expect(session.getSnapshot().refreshStatus).toBe('running');

  await answerRead(readOf('feed', [makeThread('1')]));
  await answerVerify(stable);

  expect(pending).toHaveLength(0);
  expect(session.getSnapshot().refreshStatus).toBe('idle');
});

test('r sends its first pass with no previous feed', async () => {
  const { session, history, load } = makeHarness();

  await load(makeThread('1'));
  session.send({ kind: 'refresh' });

  const request = history.findLast((call) => call.kind === 'read')?.request;

  expect(request).toEqual({ previous: null });
});

test('a failed refresh keeps the previous threads, sets the error, and schedules a poll', async () => {
  const { session, load, answerRead, activeTimers } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  session.send({ kind: 'refresh' });

  expect(activeTimers()).toHaveLength(0);

  await answerRead(failure('Server error'));

  const snapshot = session.getSnapshot();

  expect(snapshot.threads).toEqual([thread]);
  expect(snapshot.selectedThreadId).toBe(thread.id);
  expect(snapshot.errorMessage).toBe('Server error');
  expect(snapshot.notice).toBeNull();
  expect(snapshot.refreshStatus).toBe('idle');
  expect(activeTimers()).toHaveLength(1);

  await load(thread);

  expect(session.getSnapshot().errorMessage).toBeNull();
});

test('a failed second pass keeps the list and shows the error', async () => {
  const { session, load, answerRead, answerVerify } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  session.send({ kind: 'refresh' });
  await answerRead(readOf('next', []));
  await answerVerify(failure('Verify failed'));

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().errorMessage).toBe('Verify failed');
});

test('a failed poll keeps the list, shows the error, and schedules the next poll', async () => {
  const { session, load, fireTimer, answerPoll, activeTimers } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  await fireTimer();
  await answerPoll(failure('Poll failed'));

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().errorMessage).toBe('Poll failed');
  expect(activeTimers()).toHaveLength(1);
});

test('an unchanged poll after a failed poll clears the error and keeps the list', async () => {
  const { session, load, fireTimer, answerPoll } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  await fireTimer();
  await answerPoll(failure('Poll failed'));

  expect(session.getSnapshot().errorMessage).toBe('Poll failed');

  await fireTimer();
  await answerPoll(unchanged());

  expect(session.getSnapshot().errorMessage).toBeNull();
  expect(session.getSnapshot().notice).toBeNull();
  expect(session.getSnapshot().threads).toEqual([thread]);
});

test('a rejected read is a failed refresh and the session keeps running', async () => {
  let attempts = 0;
  const thread = makeThread('1');

  const { session } = makeHarness({
    readFeed: () => {
      attempts += 1;

      if (attempts === 1) {
        return Promise.reject(new Error('socket closed'));
      }

      return Promise.resolve(readOf('feed', [thread]));
    },
    verifyFeed: () => Promise.resolve(stable),
  });

  session.send({ kind: 'refresh' });
  await settle();

  expect(session.getSnapshot().errorMessage).toBe('socket closed');
  expect(session.getSnapshot().refreshStatus).toBe('idle');

  session.send({ kind: 'refresh' });
  await settle();

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().errorMessage).toBeNull();
});

test('a read that throws is a failed refresh', async () => {
  const { session } = makeHarness({
    readFeed: () => {
      throw new Error('spawn failed');
    },
  });

  session.send({ kind: 'refresh' });
  await settle();

  expect(session.getSnapshot().errorMessage).toBe('spawn failed');
  expect(session.getSnapshot().refreshStatus).toBe('idle');
});

test('ghMissing and notSignedIn set the notice and a later success clears it', async () => {
  const { session, load, answerRead } = makeHarness();
  const thread = makeThread('1');

  await load(thread);

  session.send({ kind: 'refresh' });
  await answerRead({ ok: false, failure: { kind: 'ghMissing' } });

  expect(session.getSnapshot().notice).toBe('ghMissing');
  expect(session.getSnapshot().errorMessage).toBeNull();
  expect(session.getSnapshot().threads).toEqual([thread]);

  session.send({ kind: 'refresh' });
  await answerRead({ ok: false, failure: { kind: 'notSignedIn' } });

  expect(session.getSnapshot().notice).toBe('notSignedIn');

  await load(thread);

  expect(session.getSnapshot().notice).toBeNull();
});

test('selectNext and selectPrevious move one row and stop at the ends', async () => {
  const { session, load, selected } = makeHarness();
  const [a, b, c] = [makeThread('1'), makeThread('2'), makeThread('3')] as const;

  await load(a, b, c);
  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe(a.id);

  session.send({ kind: 'selectNext' });

  expect(selected()).toBe(b.id);

  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectNext' });

  expect(selected()).toBe(c.id);

  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe(b.id);
});

test('selection stays on the same thread across a refresh that reorders threads', async () => {
  const { session, load, selected } = makeHarness();
  const [a, b, c] = [makeThread('1'), makeThread('2'), makeThread('3')] as const;

  await load(a, b, c);
  session.send({ kind: 'selectNext' });
  await load(c, b, a);

  expect(selected()).toBe(b.id);

  session.send({ kind: 'selectNext' });
  await load(b, a, c);

  expect(selected()).toBe(a.id);
});

test('when the selected thread leaves, the thread now in its row is selected', async () => {
  const { session, load, selected } = makeHarness();
  const [a, b, c] = [makeThread('1'), makeThread('2'), makeThread('3')] as const;

  await load(a, b, c);
  session.send({ kind: 'selectNext' });
  await load(a, c);

  expect(selected()).toBe(c.id);

  await load(a);

  expect(selected()).toBe(a.id);

  await load();

  expect(selected()).toBeNull();
  expect(session.getSnapshot().hasLoaded).toBe(true);

  session.send({ kind: 'selectNext' });

  expect(selected()).toBeNull();
});

test('a changed page 1 starts a full refresh that reuses that page, and a gone thread leaves', async () => {
  const { session, history, loadWith, fireTimer, answerPoll, answerRead, answerVerify } =
    makeHarness();

  const [a, b] = [makeThread('1'), makeThread('2')] as const;

  await loadWith('first', [a, b]);

  const feedAfterLoad = history.findLast((call) => call.kind === 'verify')?.feed;
  const page = makePage('second', [a]);

  await fireTimer();

  await answerPoll({ ok: true, value: { kind: 'changed', page, pollInterval: null } });

  expect(session.getSnapshot().refreshStatus).toBe('running');
  expect(session.getSnapshot().threads).toEqual([a, b]);

  const request = history.findLast((call) => call.kind === 'read')?.request;

  expect(request?.firstPage).toBe(page);
  expect(request?.previous).toBe(feedAfterLoad ?? null);

  await answerRead(readOf('second', [a]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([a]);
  expect(session.getSnapshot().refreshStatus).toBe('idle');
});

test('a second pass that sees a change leaves the list and runs again at once', async () => {
  const { session, load, answerRead, answerVerify, countOf, pending } = makeHarness();
  const old = makeThread('1');
  const fresh = makeThread('2');

  await load(old);
  session.send({ kind: 'refresh' });
  await answerRead(readOf('moved', [fresh]));
  await answerVerify(changed);

  expect(session.getSnapshot().threads).toEqual([old]);
  expect(session.getSnapshot().refreshStatus).toBe('running');
  expect(countOf('read')).toBe(3);
  expect(pending.map((call) => call.kind)).toEqual(['read']);

  await answerRead(readOf('settled', [fresh]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([fresh]);
  expect(session.getSnapshot().feedBusy).toBe(false);
});

test('the fourth failed attempt marks the feed busy and the next poll runs a full refresh', async () => {
  const { session, load, answerRead, answerVerify, countOf, activeTimers, fireTimer, pending } =
    makeHarness();

  const old = makeThread('1');
  const fresh = makeThread('2');

  await load(old);

  const readsBefore = countOf('read');

  session.send({ kind: 'refresh' });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await answerRead(readOf(`moved${attempt}`, [fresh]));
    await answerVerify(changed);
  }

  expect(countOf('read') - readsBefore).toBe(4);
  expect(pending).toHaveLength(0);

  const snapshot = session.getSnapshot();

  expect(snapshot.threads).toEqual([old]);
  expect(snapshot.feedBusy).toBe(true);
  expect(snapshot.refreshStatus).toBe('idle');
  expect(activeTimers()).toHaveLength(1);

  await fireTimer();

  expect(countOf('poll')).toBe(0);
  expect(pending.map((call) => call.kind)).toEqual(['read']);

  await answerRead(readOf('settled', [fresh]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([fresh]);
  expect(session.getSnapshot().feedBusy).toBe(false);
});

test('polls follow the poll interval with a 60 second floor', async () => {
  const { loadWith, activeTimers, fireTimer, answerPoll, session } = makeHarness();

  await loadWith('feed', [], 120);

  expect(activeTimers().map((timer) => timer.delay)).toEqual([120_000]);

  await fireTimer();
  await answerPoll(unchanged(null));

  expect(activeTimers().map((timer) => timer.delay)).toEqual([120_000]);

  await fireTimer();
  await answerPoll(unchanged(10));

  expect(activeTimers().map((timer) => timer.delay)).toEqual([60_000]);
  expect(session.getSnapshot().errorMessage).toBeNull();
});

test('the second pass interval sets the next poll', async () => {
  const { session, answerRead, answerVerify, activeTimers } = makeHarness();

  session.send({ kind: 'refresh' });
  await answerRead(readOf('feed', [], 60));
  await answerVerify(verified('stable', 120));

  expect(activeTimers().map((timer) => timer.delay)).toEqual([120_000]);
});

test('a second pass without an interval keeps the first pass interval', async () => {
  const { session, answerRead, answerVerify, activeTimers } = makeHarness();

  session.send({ kind: 'refresh' });
  await answerRead(readOf('feed', [], 120));
  await answerVerify(verified('stable', null));

  expect(activeTimers().map((timer) => timer.delay)).toEqual([120_000]);
});

test('polls use 60 seconds until GitHub sends an interval', async () => {
  const { load, activeTimers } = makeHarness();

  await load();

  expect(activeTimers().map((timer) => timer.delay)).toEqual([60_000]);
});

test('a full refresh runs when a poll is due 10 minutes after the last one', async () => {
  const { load, fireTimer, answerPoll, countOf, pending } = makeHarness();

  await load(makeThread('1'));

  for (let poll = 0; poll < 9; poll += 1) {
    await fireTimer();
    await answerPoll(unchanged());
  }

  expect(countOf('poll')).toBe(9);
  expect(countOf('read')).toBe(1);

  await fireTimer();

  expect(countOf('poll')).toBe(9);
  expect(pending.map((call) => call.kind)).toEqual(['read']);
});

test('a timer that fires during a refresh is dropped', async () => {
  const { session, load, activeTimers, pending, history } = makeHarness();

  await load(makeThread('1'));

  const staleCallback = activeTimers()[0]?.callback;
  session.send({ kind: 'refresh' });

  const callsBefore = history.length;

  staleCallback?.();

  expect(history).toHaveLength(callsBefore);
  expect(pending).toHaveLength(1);
});

const limitedUntil = (resetAt: Date) => ({
  ok: false as const,
  failure: { kind: 'rateLimited' as const, resetAt },
});

const fiveMinutes = 5 * 60_000;

test('a rate limit stops polls until the reset time', async () => {
  const { load, now, advance, fireTimer, answerPoll, activeTimers, countOf, pending } =
    makeHarness();

  await load(makeThread('1'));
  await fireTimer();
  await answerPoll(limitedUntil(new Date(now().getTime() + fiveMinutes)));

  expect(countOf('poll')).toBe(1);
  expect(activeTimers().map((timer) => timer.delay)).toEqual([fiveMinutes]);

  advance(120_000);

  expect(countOf('poll')).toBe(1);
  expect(countOf('read')).toBe(1);

  await fireTimer();

  expect(countOf('poll')).toBe(1);
  expect(countOf('read')).toBe(2);
  expect(pending.map((call) => call.kind)).toEqual(['read']);
});

test('a timer that fires before the reset time sends nothing and waits again', async () => {
  const { load, now, advance, fireTimer, answerPoll, activeTimers, countOf } = makeHarness();

  await load(makeThread('1'));
  await fireTimer();
  await answerPoll(limitedUntil(new Date(now().getTime() + fiveMinutes)));

  const early = activeTimers()[0];
  advance(60_000);
  early?.callback();

  expect(countOf('read')).toBe(1);
  expect(activeTimers().at(-1)?.delay).toBe(fiveMinutes - 60_000);
});

test('r during the pause sends no request and queues no follow-up', async () => {
  const { session, load, now, fireTimer, answerPoll, answerRead, answerVerify, countOf, pending } =
    makeHarness();

  await load(makeThread('1'));
  await fireTimer();
  await answerPoll(limitedUntil(new Date(now().getTime() + fiveMinutes)));

  session.send({ kind: 'refresh' });
  session.send({ kind: 'refresh' });

  expect(pending).toHaveLength(0);
  expect(countOf('read')).toBe(1);

  await fireTimer();
  await answerRead(readOf('feed', [makeThread('1')]));
  await answerVerify(stable);

  expect(countOf('read')).toBe(2);
  expect(pending).toHaveLength(0);
});

test('r after the reset time but before the timer fires refreshes once', async () => {
  const { session, load, now, advance, fireTimer, answerPoll, countOf } = makeHarness();

  await load(makeThread('1'));
  await fireTimer();
  await answerPoll(limitedUntil(new Date(now().getTime() + fiveMinutes)));
  advance(fiveMinutes);

  session.send({ kind: 'refresh' });

  expect(countOf('read')).toBe(2);
  expect(session.getSnapshot().pausedUntil).toBeNull();
});

test('a follow-up queued during the refresh that hit the limit sends nothing before the reset time', async () => {
  const { session, load, now, advance, fireTimer, answerRead, activeTimers, countOf, pending } =
    makeHarness();

  await load(makeThread('1'));
  session.send({ kind: 'refresh' });
  session.send({ kind: 'refresh' });
  await answerRead(limitedUntil(new Date(now().getTime() + fiveMinutes)));

  expect(countOf('read')).toBe(2);
  expect(pending).toHaveLength(0);
  expect(activeTimers().map((timer) => timer.delay)).toEqual([fiveMinutes]);

  advance(fiveMinutes - 1);
  expect(countOf('read')).toBe(2);

  await fireTimer();

  expect(countOf('read')).toBe(3);
});

test('a rate limit on the second pass pauses the session', async () => {
  const { session, load, now, answerRead, answerVerify, activeTimers, countOf, pending } =
    makeHarness();

  await load(makeThread('1'));
  session.send({ kind: 'refresh' });
  await answerRead(readOf('feed', [makeThread('1')]));
  await answerVerify(limitedUntil(new Date(now().getTime() + fiveMinutes)));

  expect(session.getSnapshot().threads).toHaveLength(1);
  expect(session.getSnapshot().pausedUntil).toEqual(new Date(now().getTime() + fiveMinutes));
  expect(pending).toHaveLength(0);
  expect(activeTimers().map((timer) => timer.delay)).toEqual([fiveMinutes]);
  expect(countOf('read')).toBe(2);
});

test('the pause clears when the refresh after it succeeds, and polls resume', async () => {
  const { session, load, now, fireTimer, answerPoll, answerRead, answerVerify, activeTimers } =
    makeHarness();

  await load(makeThread('1'));
  await fireTimer();
  await answerPoll(limitedUntil(new Date(now().getTime() + fiveMinutes)));
  await fireTimer();

  expect(session.getSnapshot().pausedUntil).toBeNull();

  await answerRead(readOf('feed', [makeThread('1')]));
  await answerVerify(stable);

  expect(session.getSnapshot().pausedUntil).toBeNull();
  expect(activeTimers().map((timer) => timer.delay)).toEqual([60_000]);
});
