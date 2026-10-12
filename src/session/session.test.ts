import { expect, test } from 'bun:test';

import type {
  GitHubResult,
  NotificationFeed,
  NotificationFeedRead,
  NotificationFeedRequest,
  NotificationPage,
  NotificationPoll,
  NotificationVerification,
  SubjectLookup,
  Viewer,
} from '../github/github.ts';
import type { NotificationThread, ViewerLogin } from '../work/work.ts';
import { toThreadId, toViewerLogin } from '../work/work.ts';
import { createSession, visibleRows } from './session.ts';
import type { SavedSnapshot, SessionEffects } from './session.ts';

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
    }
  | {
      kind: 'viewer';
      previous: Viewer | null;
      resolve: (result: GitHubResult<Viewer>) => void;
      signal: AbortSignal;
    };

interface LookupCall {
  threads: NotificationThread[];
  resolve: (lookups: SubjectLookup[]) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
}

interface FakeTimer {
  delay: number;
  callback: () => void;
  active: boolean;
}

interface HarnessOptions {
  holdViewer?: boolean;
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
): GitHubResult<NotificationVerification> => ({
  ok: true,
  value: { kind, pollInterval },
});

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

const octocat = toViewerLogin('octocat');

const viewerOf = (login: ViewerLogin, etag: string | null = null): GitHubResult<Viewer> => ({
  ok: true,
  value: { login, etag },
});

const makeHarness = (
  overrides: Partial<SessionEffects> = {},
  { holdViewer = false }: HarnessOptions = {},
) => {
  const pending: Call[] = [];
  const history: Call[] = [];
  const lookups: LookupCall[] = [];
  const timers: FakeTimer[] = [];
  const clock = { time: new Date('2026-02-01T12:00:00Z').getTime() };

  const record = (call: Call) => {
    pending.push(call);
    history.push(call);
  };

  const session = createSession({
    savedSnapshot: null,
    savedGrouping: null,
    saveGrouping: () => undefined,
    stateWarning: null,
    readViewer: (previous, signal) =>
      new Promise((resolve) => {
        if (holdViewer) {
          record({ kind: 'viewer', previous, resolve, signal });
        } else {
          history.push({ kind: 'viewer', previous, resolve, signal });
          resolve(viewerOf(octocat));
        }
      }),
    saveSnapshot: () => undefined,
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
    lookUpSubjects: (threads, signal) =>
      new Promise((resolve, reject) => {
        lookups.push({ threads, resolve, reject, signal });
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

  const answerViewer = async (result: GitHubResult<Viewer>) => {
    take('viewer').resolve(result);
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
    await settle();
    await answerRead(readOf(label, threads, pollInterval ?? null));
    await answerVerify(stable);
  };

  const load = (...threads: NotificationThread[]) => loadWith('feed', threads);

  const advance = (milliseconds: number) => {
    clock.time += milliseconds;
  };

  const selected = () => session.getSnapshot().selectedRowKey;

  const selectThread = (thread: NotificationThread) => {
    session.send({ kind: 'selectFirst' });

    while (selected() !== `thread:${thread.id}` && selected() !== null) {
      const before = selected();

      session.send({ kind: 'selectNext' });

      if (selected() === before) {
        break;
      }
    }
  };

  const now = () => new Date(clock.time);

  return {
    session,
    pending,
    history,
    lookups,
    now,
    advance,
    take,
    answerRead,
    answerVerify,
    answerPoll,
    answerViewer,
    countOf,
    activeTimers,
    fireTimer,
    loadWith,
    load,
    selected,
    selectThread,
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
  await settle();

  expect(pending).toHaveLength(1);
  expect(session.getSnapshot().refreshStatus).toBe('running');

  await answerRead(readOf('feed', [first, done, second]));

  expect(session.getSnapshot().threads).toEqual([]);
  expect(session.getSnapshot().refreshStatus).toBe('running');

  await answerVerify(stable);

  const snapshot = session.getSnapshot();

  expect(snapshot.threads).toEqual([first, second]);
  expect(snapshot.selectedRowKey).toBe('node:review');
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
  await settle();

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

test('send after stop starts no refresh and changes nothing', async () => {
  const { session, pending } = makeHarness();
  const before = session.getSnapshot();

  session.stop();
  session.send({ kind: 'refresh' });
  await settle();

  expect(pending).toHaveLength(0);
  expect(session.getSnapshot()).toBe(before);
});

test('three refresh intents during one refresh start exactly one follow-up', async () => {
  const { session, pending, answerRead, answerVerify } = makeHarness();

  session.send({ kind: 'refresh' });
  await settle();
  session.send({ kind: 'refresh' });
  await settle();
  session.send({ kind: 'refresh' });
  await settle();
  session.send({ kind: 'refresh' });
  await settle();

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
  await settle();

  const request = history.findLast((call) => call.kind === 'read')?.request;

  expect(request).toEqual({ previous: null });
});

test('a failed refresh keeps the previous threads, sets the error, and schedules a poll', async () => {
  const { session, load, answerRead, activeTimers } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  session.send({ kind: 'refresh' });
  await settle();

  expect(activeTimers()).toHaveLength(0);

  await answerRead(failure('Server error'));

  const snapshot = session.getSnapshot();

  expect(snapshot.threads).toEqual([thread]);
  expect(snapshot.selectedRowKey).toBe('node:review');
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
  await settle();
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
  await settle();

  expect(session.getSnapshot().errorMessage).toBe('socket closed');
  expect(session.getSnapshot().refreshStatus).toBe('idle');

  session.send({ kind: 'refresh' });
  await settle();
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
  await settle();

  expect(session.getSnapshot().errorMessage).toBe('spawn failed');
  expect(session.getSnapshot().refreshStatus).toBe('idle');
});

test('ghMissing and notSignedIn set the notice and a later success clears it', async () => {
  const { session, load, answerRead } = makeHarness();
  const thread = makeThread('1');

  await load(thread);

  session.send({ kind: 'refresh' });
  await settle();
  await answerRead({ ok: false, failure: { kind: 'ghMissing' } });

  expect(session.getSnapshot().notice).toBe('ghMissing');
  expect(session.getSnapshot().errorMessage).toBeNull();
  expect(session.getSnapshot().threads).toEqual([thread]);

  session.send({ kind: 'refresh' });
  await settle();
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

test('a changed page 1 starts a full refresh that reuses that page, and a gone thread leaves', async () => {
  const { session, history, loadWith, fireTimer, answerPoll, answerRead, answerVerify } =
    makeHarness();

  const [a, b] = [makeThread('1'), makeThread('2')] as const;

  await loadWith('first', [a, b]);

  const feedAfterLoad = history.findLast((call) => call.kind === 'verify')?.feed;

  const page = makePage('second', [a]);

  await fireTimer();

  await answerPoll({
    ok: true,
    value: { kind: 'changed', page, pollInterval: null },
  });

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
  await settle();
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
  await settle();

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
  await settle();
  await answerRead(readOf('feed', [], 60));
  await answerVerify(verified('stable', 120));

  expect(activeTimers().map((timer) => timer.delay)).toEqual([120_000]);
});

test('a second pass without an interval keeps the first pass interval', async () => {
  const { session, answerRead, answerVerify, activeTimers } = makeHarness();

  session.send({ kind: 'refresh' });
  await settle();
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
  await settle();

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
  await settle();
  session.send({ kind: 'refresh' });
  await settle();

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
  await settle();

  expect(countOf('read')).toBe(2);
  expect(session.getSnapshot().pausedUntil).toBeNull();
});

test('a follow-up queued during the refresh that hit the limit sends nothing before the reset time', async () => {
  const { session, load, now, advance, fireTimer, answerRead, activeTimers, countOf, pending } =
    makeHarness();

  await load(makeThread('1'));
  session.send({ kind: 'refresh' });
  await settle();
  session.send({ kind: 'refresh' });
  await settle();
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
  await settle();
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

const savedThreads = [makeThread('1'), makeThread('2')];
const savedAt = new Date('2026-01-05T08:00:00Z');

const savedSnapshotOf = (login: ViewerLogin, etag: string | null = null): SavedSnapshot => ({
  viewer: { login, etag },
  savedAt,
  feed: makeFeed('saved', savedThreads),
  threads: savedThreads,
});

const makeSavedHarness = (login: ViewerLogin, overrides: Partial<SessionEffects> = {}) => {
  const harness = makeHarness(
    { savedSnapshot: savedSnapshotOf(login), ...overrides },
    { holdViewer: true },
  );

  const send = async () => {
    harness.session.send({ kind: 'refresh' });
    await settle();
  };

  return { ...harness, send };
};

test('a saved snapshot shows its threads at start and its feed goes out on the first refresh', async () => {
  const { session, send, answerViewer, take } = makeSavedHarness(octocat);

  expect(session.getSnapshot().threads).toEqual(savedThreads);
  expect(session.getSnapshot().savedAt).toEqual(savedAt);
  expect(session.getSnapshot().hasLoaded).toBe(true);

  await send();
  await answerViewer(viewerOf(octocat));

  expect(take('read').request.previous).toEqual(makeFeed('saved', savedThreads));
});

test('another account empties the list before the feed answers and reads without a previous feed', async () => {
  const { session, send, answerViewer, take } = makeSavedHarness(octocat);

  await send();
  await answerViewer(viewerOf(toViewerLogin('hubot')));

  expect(session.getSnapshot().threads).toEqual([]);
  expect(session.getSnapshot().selectedRowKey).toBeNull();
  expect(session.getSnapshot().savedAt).toBeNull();
  expect(take('read').request.previous).toBeNull();
});

test('a loaded refresh saves the new feed once and applyThreads clears the saved time', async () => {
  const saves: { viewer: Viewer; feed: NotificationFeed; savedAt: Date }[] = [];

  const { session, send, answerViewer, answerRead, answerVerify, now } = makeSavedHarness(octocat, {
    saveSnapshot: (viewer, feed, savedAtTime) => {
      saves.push({ viewer, feed, savedAt: savedAtTime });
    },
  });

  await send();
  await answerViewer(viewerOf(octocat));
  await answerRead(readOf('fresh', [makeThread('3')]));
  await answerVerify(stable);

  expect(saves).toEqual([
    {
      viewer: { login: octocat, etag: null },
      feed: makeFeed('fresh', [makeThread('3')]),
      savedAt: now(),
    },
  ]);

  expect(session.getSnapshot().savedAt).toBeNull();
});

test('a busy or failed refresh saves nothing', async () => {
  const saves: unknown[] = [];

  const { send, answerViewer, answerRead, answerVerify, take } = makeSavedHarness(octocat, {
    saveSnapshot: (...args) => {
      saves.push(args);
    },
  });

  await send();
  await answerViewer(viewerOf(octocat));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await answerRead(readOf('moving', []));
    await answerVerify(changed);
  }

  await send();
  take('read');

  expect(saves).toEqual([]);
});

test('a failed read saves nothing', async () => {
  const saves: unknown[] = [];

  const { send, answerViewer, answerRead } = makeSavedHarness(octocat, {
    saveSnapshot: (...args) => {
      saves.push(args);
    },
  });

  await send();
  await answerViewer(viewerOf(octocat));
  await answerRead(failure('boom'));

  expect(saves).toEqual([]);
});

test('a save that throws does not stop the session', async () => {
  const { session, send, answerViewer, answerRead, answerVerify, fireTimer, countOf } =
    makeSavedHarness(octocat, {
      saveSnapshot: () => {
        throw new Error('disk full');
      },
    });

  await send();
  await answerViewer(viewerOf(octocat));
  await answerRead(readOf('fresh', [makeThread('3')]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([makeThread('3')]);

  await fireTimer();

  expect(countOf('poll')).toBe(1);
});

test('a failed viewer read shows the failure and keeps the saved threads', async () => {
  const { session, send, answerViewer, countOf } = makeSavedHarness(octocat);

  await send();
  await answerViewer(failure('offline'));

  const snapshot = session.getSnapshot();

  expect(snapshot.errorMessage).toBe('offline');
  expect(snapshot.threads).toEqual(savedThreads);
  expect(snapshot.refreshStatus).toBe('idle');
  expect(countOf('read')).toBe(0);
});

test('a poll timer after a failed viewer read runs a full refresh, not a poll', async () => {
  const { send, answerViewer, fireTimer, countOf } = makeSavedHarness(octocat);

  await send();
  await answerViewer(failure('offline'));
  await fireTimer();

  expect(countOf('poll')).toBe(0);
  expect(countOf('viewer')).toBe(2);
});

test('a second full refresh reads the viewer again', async () => {
  const { send, answerViewer, answerRead, answerVerify, countOf } = makeSavedHarness(octocat);

  await send();
  await answerViewer(viewerOf(octocat));
  await answerRead(readOf('fresh', []));
  await answerVerify(stable);
  await send();

  expect(countOf('viewer')).toBe(2);
});

test('a login that changes between refreshes clears the list, reads without a previous feed, and saves under the new login', async () => {
  const saves: { viewer: Viewer; feed: NotificationFeed }[] = [];
  const hubot = toViewerLogin('hubot');

  const { session, send, answerViewer, answerVerify, take } = makeSavedHarness(octocat, {
    saveSnapshot: (viewer, feed) => {
      saves.push({ viewer, feed });
    },
  });

  await send();
  await answerViewer(viewerOf(octocat));
  take('read').resolve(readOf('first', [makeThread('3')]));
  await settle();
  await answerVerify(stable);
  await send();
  await answerViewer(viewerOf(hubot));

  const secondRead = take('read');

  expect(session.getSnapshot().threads).toEqual([]);
  expect(secondRead.request.previous).toBeNull();

  secondRead.resolve(readOf('second', [makeThread('4')]));
  await settle();
  await answerVerify(stable);

  expect(saves.map((save) => save.viewer.login)).toEqual([octocat, hubot]);
  expect(saves[1]?.feed).toEqual(makeFeed('second', [makeThread('4')]));
});

test('a saved snapshot sends its viewer etag on the first read', async () => {
  const { send, take } = makeSavedHarness(octocat, {
    savedSnapshot: savedSnapshotOf(octocat, '"saved-viewer"'),
  });

  await send();

  expect(take('viewer').previous).toEqual({ login: octocat, etag: '"saved-viewer"' });
});

test('the next full refresh sends the etag of the previous viewer read', async () => {
  const { send, answerViewer, answerRead, answerVerify, take } = makeSavedHarness(octocat);

  await send();
  await answerViewer(viewerOf(octocat, '"first"'));
  await answerRead(readOf('fresh', []));
  await answerVerify(stable);
  await send();

  expect(take('viewer').previous).toEqual({ login: octocat, etag: '"first"' });
});

test('a changed login saves the new viewer etag', async () => {
  const saves: Viewer[] = [];
  const hubot = toViewerLogin('hubot');

  const { send, answerViewer, answerRead, answerVerify } = makeSavedHarness(octocat, {
    saveSnapshot: (viewer) => {
      saves.push(viewer);
    },
  });

  await send();
  await answerViewer(viewerOf(hubot, '"hubot-tag"'));
  await answerRead(readOf('second', []));
  await answerVerify(stable);

  expect(saves).toEqual([{ login: hubot, etag: '"hubot-tag"' }]);
});

const reviewThread = makeThread('1');

const mentionThread = makeThread('2', { reason: 'mention', repository: 'acme/lib' });

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
  const issue = makeThread('3', { subjectType: 'Issue', repository: 'acme/lib' });

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

test('savedGrouping sets the starting grouping', () => {
  const { session } = makeHarness({ savedGrouping: 'type' });

  expect(session.getSnapshot().grouping).toBe('type');
});

test('savedGrouping sets the starting grouping next to a saved snapshot', () => {
  const { session } = makeHarness({
    savedGrouping: 'none',
    savedSnapshot: savedSnapshotOf(octocat),
  });

  expect(session.getSnapshot().grouping).toBe('none');
  expect(session.getSnapshot().threads.length).toBeGreaterThan(0);
});

test('each cycleGrouping intent saves the new grouping once, and nothing else saves it', async () => {
  const saved: string[] = [];

  const { session } = makeHarness({
    saveGrouping: (grouping) => {
      saved.push(grouping);
    },
  });

  await settle();
  session.send({ kind: 'selectNext' });
  session.send({ kind: 'toggleAllFolds' });

  expect(saved).toEqual([]);

  session.send({ kind: 'cycleGrouping' });

  expect(saved).toEqual(['type']);

  session.send({ kind: 'cycleGrouping' });

  expect(saved).toEqual(['type', 'none']);
});

test('a saveGrouping that throws leaves the session running with the new grouping', () => {
  const { session } = makeHarness({
    saveGrouping: () => {
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

const factsOf = (thread: NotificationThread, author = 'hubot'): SubjectLookup => ({
  threadId: thread.id,
  updatedAt: thread.updatedAt,
  facts: { state: 'open', author, latestActor: null },
});

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
  session.stop();

  expect(lookups[0]?.signal.aborted).toBe(true);

  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  expect(session.getSnapshot().subjectFacts.size).toBe(0);
});
