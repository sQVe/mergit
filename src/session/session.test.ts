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
import type { NotificationThread, ThreadId, ViewerLogin } from '../work/work.ts';
import { toThreadId, toViewerLogin } from '../work/work.ts';
import { createSession, visibleRows } from './session.ts';
import type { SavedSnapshot, SavedState, SessionEffects } from './session.ts';

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

interface SendCall {
  threadId: ThreadId;
  signal: AbortSignal;
  resolve: (result: GitHubResult<null>) => void;
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
  const sends: SendCall[] = [];
  const saves: SavedState[] = [];
  const clock = { time: new Date('2026-02-01T12:00:00Z').getTime() };

  const record = (call: Call) => {
    pending.push(call);
    history.push(call);
  };

  const session = createSession({
    savedSnapshot: null,
    host: 'github.com',
    savedState: null,
    saveState: (state) => {
      saves.push(state);
    },
    markThreadDone: (threadId, signal) =>
      new Promise((resolve) => {
        sends.push({ threadId, signal, resolve });

        signal.addEventListener('abort', () => {
          resolve({
            ok: false,
            failure: {
              kind: 'requestFailed',
              status: null,
              message: 'aborted',
            },
          });
        });
      }),
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
    sends,
    saves,
    now,
    advance,
    take,
    answerRead,
    answerVerify,
    answerPoll,
    answerViewer,
    countOf,
    activeTimers,
    timers,
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

  expect(take('viewer').previous).toEqual({
    login: octocat,
    etag: '"saved-viewer"',
  });
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

const doneOf = (...threads: NotificationThread[]) =>
  new Map(threads.map((thread) => [thread.id, thread.updatedAt]));

const accountKeyOf = (login: ViewerLogin) => `github.com/${login}`;

const doneFor = (login: ViewerLogin, ...threads: NotificationThread[]) =>
  new Map([[accountKeyOf(login), doneOf(...threads)]]);

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
  await session.stop(new AbortController().signal);

  expect(lookups[0]?.signal.aborted).toBe(true);

  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  expect(session.getSnapshot().subjectFacts.size).toBe(0);
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

test('the toast clears after four seconds, and a newer toast replaces it and restarts the timer', () => {
  const { session, timers } = makeHarness();

  session.send({ kind: 'cycleGrouping' });

  session.reportStateWrite({
    ok: false,
    reason: 'first',
    path: '~/state.json',
  });

  const firstTimer = timers.at(-1);

  session.reportStateWrite({
    ok: false,
    reason: 'second',
    path: '~/state.json',
  });

  const secondTimer = timers.at(-1);

  expect(firstTimer?.active).toBe(false);
  expect(secondTimer).not.toBe(firstTimer);
  expect(secondTimer?.delay).toBe(4000);
  expect(session.getSnapshot().toast?.durationMilliseconds).toBe(4000);
  expect(session.getSnapshot().toast?.lines[0]).toBe('second');

  secondTimer?.callback();

  expect(session.getSnapshot().toast).toBeNull();
});

test("a toast's duration equals the delay of its expiry timer", () => {
  const { session, timers } = makeHarness();

  session.send({ kind: 'cycleGrouping' });

  session.reportStateWrite({
    ok: false,
    reason: 'disk full',
    path: '~/state.json',
  });

  const toastTimer = timers.at(-1);

  expect(toastTimer?.delay).toBeDefined();

  expect(session.getSnapshot().toast?.durationMilliseconds).toBe(toastTimer?.delay);
});

const doneWindow = 5000;
const sentOk: GitHubResult<null> = { ok: true, value: null };

const rowKeysOf = (session: ReturnType<typeof makeHarness>['session']) =>
  visibleRows(session.getSnapshot()).map((row) => row.key);

const fireDoneTimerAt = async (harness: ReturnType<typeof makeHarness>, index: number) => {
  const timer = harness.timers[index];

  if (timer?.active !== true) {
    return;
  }

  timer.active = false;
  timer.callback();
  await settle();
};

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

  await resolveSend(harness, 0, sentOk);

  expect(harness.saves).toHaveLength(1);
  expect(recordsOf()?.get(threads[0]?.id as ThreadId)).toBe('2026-01-05T08:00:01Z');

  await resolveSend(harness, 1, sentOk);

  expect(harness.saves).toHaveLength(2);
  expect(recordsOf()?.get(threads[1]?.id as ThreadId)).toBe('2026-01-05T08:00:02Z');
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

const seenFor = (login: ViewerLogin, ...entries: [NotificationThread, string][]) =>
  new Map([[accountKeyOf(login), new Map(entries.map(([thread, seenAt]) => [thread.id, seenAt]))]]);

const stateWithSeen = (seen: SavedState['seen']): SavedState => ({
  grouping: 'reason',
  done: new Map(),
  seen,
});

const releaseOf = (id: string, updatedAt = '2026-01-02T10:00:00Z') =>
  makeThread(id, { subjectType: 'Release', subjectUrl: null, updatedAt });

const newThreadsFixture = () => {
  const [a, b] = [releaseOf('1'), releaseOf('2', '2026-01-03T10:00:00Z')];

  return {
    a,
    b,
    savedState: stateWithSeen(seenFor(octocat, [a, a.updatedAt], [b, '2026-01-01T10:00:00Z'])),
  };
};

const seenOf = (state: SavedState | undefined, thread: NotificationThread) =>
  state?.seen.get(accountKeyOf(octocat))?.get(thread.id);

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

test('marking the selected new thread done records it as seen', async () => {
  const { a, b, savedState } = newThreadsFixture();
  const harness = makeHarness({ savedState });

  await harness.load(a, b);
  harness.selectThread(b);

  expect(seenOf(harness.saves.at(-1), b)).toBeUndefined();

  harness.session.send({ kind: 'markDone' });

  expect(seenOf(harness.saves.at(-1), b)).toBe(b.updatedAt);
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
