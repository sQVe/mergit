import { expect, test } from 'bun:test';

import type { NotificationFeed, Viewer } from '../github/github.ts';
import { createAccountSwitch } from './accountSwitch.ts';
import { createFeedRefresh } from './feedRefresh.ts';
import type { FeedRefreshHost } from './feedRefresh.ts';
import { showSavedThreads } from './feedTransitions.ts';
import { visibleRows } from './session.ts';
import {
  changed,
  failure,
  makeFeed,
  makeHarness,
  makePage,
  makeSavedHarness,
  makeThread,
  octocat,
  readOf,
  savedAt,
  savedThreads,
  settle,
  stable,
  unchanged,
  verified,
  viewerOf,
} from './sessionHarness.ts';
import { initialSnapshot } from './sessionState.ts';

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

test('a saved snapshot shows its threads at start and its feed goes out on the first refresh', async () => {
  const { session, send, answerViewer, take } = makeSavedHarness(octocat);

  expect(session.getSnapshot().threads).toEqual(savedThreads);
  expect(session.getSnapshot().savedAt).toEqual(savedAt);
  expect(session.getSnapshot().hasLoaded).toBe(true);

  await send();
  await answerViewer(viewerOf(octocat));

  expect(take('read').request.previous).toEqual(makeFeed('saved', savedThreads));
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

test('a changed verification retries the read with the first read feed as previous', async () => {
  const harness = makeHarness();

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerRead(readOf('first', [makeThread('1')]));
  await harness.answerVerify(changed);

  expect(harness.take('read').request.previous).toEqual(makeFeed('first', [makeThread('1')]));
});

test('a viewer answer after stop starts no feed read', async () => {
  const harness = makeHarness({}, { holdViewer: true });

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.session.stop(new AbortController().signal);
  await harness.answerViewer(viewerOf(octocat));

  expect(harness.pending).toHaveLength(0);
  expect(harness.countOf('read')).toBe(0);
});

test('a poll failure after stop leaves the snapshot unchanged', async () => {
  const harness = makeHarness();

  await harness.load(makeThread('1'));
  await harness.fireTimer();

  const before = harness.session.getSnapshot();

  await harness.session.stop(new AbortController().signal);
  await harness.answerPoll(failure('offline'));

  expect(harness.session.getSnapshot()).toBe(before);
});

test('the timer after a first feed read that failed with no saved feed runs a full read', async () => {
  const harness = makeHarness();

  harness.session.send({ kind: 'refresh' });
  await settle();
  await harness.answerRead(failure('offline'));
  await harness.fireTimer();

  expect(harness.countOf('poll')).toBe(0);
  expect(harness.countOf('read')).toBe(2);
});

test('the full refresh due after 10 minutes sends the stored feed as previous', async () => {
  const harness = makeHarness();
  const thread = makeThread('1');

  await harness.load(thread);

  for (let poll = 0; poll < 9; poll += 1) {
    await harness.fireTimer();
    await harness.answerPoll(unchanged());
  }

  await harness.fireTimer();

  expect(harness.take('read').request.previous).toEqual(makeFeed('feed', [thread]));
});

test('a saved snapshot with no open threads starts with no selection', () => {
  const harness = makeHarness(
    {
      savedSnapshot: {
        viewer: { login: octocat, etag: null },
        savedAt,
        feed: makeFeed('saved', []),
        threads: [],
      },
    },
    { holdViewer: true },
  );

  expect(harness.session.getSnapshot().threads).toEqual([]);
  expect(harness.session.getSnapshot().selectedRowKey).toBeNull();
});

test('a saved snapshot with threads selects its first row at start', () => {
  const { session } = makeSavedHarness(octocat);
  const snapshot = session.getSnapshot();

  expect(snapshot.selectedRowKey).not.toBeNull();
  expect(snapshot.selectedRowKey).toBe(visibleRows(snapshot)[0]?.key ?? null);
});

test('showing saved threads selects the first visible row', () => {
  const shown = showSavedThreads(initialSnapshot, savedThreads, new Map(), savedAt);

  expect(shown.selectedRowKey).toBe('node:review');
  expect(shown.selectedRowKey).toBe(visibleRows(shown)[0]?.key ?? null);
  expect(shown.hasLoaded).toBe(true);
});

const throwOnce = () => {
  let thrown = false;

  return () => {
    if (!thrown) {
      thrown = true;

      throw new Error('subscriber broke');
    }
  };
};

test('a subscriber that throws during refresh start leaves later refreshes working', async () => {
  const { session, load, countOf, answerRead, answerVerify } = makeHarness();

  await load(makeThread('1'));

  session.subscribe(throwOnce());

  const readsBefore = countOf('read');

  session.send({ kind: 'refresh' });
  await settle();

  expect(countOf('read')).toBe(readsBefore + 1);

  await answerRead(readOf('feed', [makeThread('1')]));
  await answerVerify(stable);

  session.send({ kind: 'refresh' });
  await settle();

  expect(countOf('read')).toBe(readsBefore + 2);
});

test('a subscriber that throws during refresh completion leaves a poll timer and later refreshes working', async () => {
  const { session, load, countOf, answerRead, answerVerify, activeTimers } = makeHarness();

  await load(makeThread('1'));

  session.send({ kind: 'refresh' });
  await settle();
  await answerRead(readOf('feed', [makeThread('1')]));

  session.subscribe(throwOnce());
  await answerVerify(stable);

  // The error toast holds its own dismiss timer next to the poll timer.
  const pollTimers = activeTimers().filter((timer) => timer.delay === 60_000);

  expect(pollTimers).toHaveLength(1);

  const readsBefore = countOf('read');

  session.send({ kind: 'refresh' });
  await settle();

  expect(countOf('read')).toBe(readsBefore + 1);
});

test('a throwing subscriber shows an error toast and other subscribers still run', async () => {
  const { session } = makeHarness();
  const seen: string[] = [];

  session.subscribe(() => {
    throw new Error('subscriber broke');
  });

  session.subscribe(() => {
    seen.push(session.getSnapshot().refreshStatus);
  });

  session.send({ kind: 'refresh' });
  await settle();

  const { toast } = session.getSnapshot();

  expect(seen[0]).toBe('running');
  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toEqual(['subscriber broke']);
});

const neverAnswered = <Value>() =>
  new Promise<Value>(() => {
    // Left pending on purpose.
  });

const fakeRefreshHost = (overrides: Partial<FeedRefreshHost> = {}) => {
  const timers: { delay: number; active: boolean }[] = [];
  const reads: unknown[] = [];
  const errors: unknown[] = [];

  const host: FeedRefreshHost = {
    savedFeed: null,
    readViewer: () => Promise.resolve(viewerOf(octocat)),
    pollFeed: () => neverAnswered(),
    readFeed: (request) => {
      reads.push(request);

      return neverAnswered();
    },
    verifyFeed: () => neverAnswered(),
    now: () => savedAt,
    setTimer: (delay) => {
      const timer = { delay, active: true };

      timers.push(timer);

      return () => {
        timer.active = false;
      };
    },
    accountSwitch: createAccountSwitch(null),
    clearAccount: () => undefined,
    getSnapshot: () => initialSnapshot,
    update: () => undefined,
    isStopped: () => false,
    finish: () => undefined,
    reportError: (error) => {
      errors.push(error);
    },
    ...overrides,
  };

  return { host, timers, reads, errors };
};

test('a throw from finish is reported and the next poll timer is scheduled', async () => {
  const failureToReport = new Error('finish broke');

  const { host, timers, errors } = fakeRefreshHost({
    readFeed: () => Promise.resolve(readOf('feed', [])),
    verifyFeed: () => Promise.resolve(stable),
    finish: () => {
      throw failureToReport;
    },
  });

  createFeedRefresh(host).request();
  await settle();

  expect(errors).toEqual([failureToReport]);
  expect(timers.filter((timer) => timer.active)).toHaveLength(1);
});

test('a throw from start publication is reported and a later request starts a new read', async () => {
  const failureToReport = new Error('start broke');
  let failing = true;

  const { host, reads, errors } = fakeRefreshHost({
    update: () => {
      if (failing) {
        failing = false;

        throw failureToReport;
      }
    },
  });

  const refresh = createFeedRefresh(host);

  refresh.request();
  await settle();

  expect(errors).toEqual([failureToReport]);
  expect(reads).toHaveLength(0);

  refresh.request();
  await settle();

  expect(reads).toHaveLength(1);
});

test('stop during refresh publication leaves no active timer', async () => {
  const { session, activeTimers, answerRead, answerVerify } = makeHarness();

  session.send({ kind: 'refresh' });
  await settle();
  await answerRead(readOf('feed', [makeThread('1')]));

  session.subscribe(() => {
    if (session.getSnapshot().refreshStatus === 'idle') {
      session.stop(new AbortController().signal).catch(() => undefined);
    }
  });

  await answerVerify(stable);

  expect(activeTimers()).toHaveLength(0);
});

test('a subscriber that stops the session and then throws adds no message and no timer', async () => {
  const { session, activeTimers, answerRead, answerVerify } = makeHarness();

  session.send({ kind: 'refresh' });
  await settle();
  await answerRead(readOf('feed', [makeThread('1')]));

  const messagesBefore = session.getSnapshot().messages.length;

  session.subscribe(() => {
    if (session.getSnapshot().refreshStatus === 'idle') {
      session.stop(new AbortController().signal).catch(() => undefined);

      throw new Error('subscriber broke');
    }
  });

  await answerVerify(stable);

  expect(session.getSnapshot().messages).toHaveLength(messagesBefore);
  expect(activeTimers()).toHaveLength(0);
});
