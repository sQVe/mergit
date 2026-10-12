import type {
  GitHubFailure,
  GitHubResult,
  NotificationFeed,
  NotificationFeedRead,
  NotificationFeedRequest,
  NotificationPoll,
  NotificationVerification,
} from '../github/github.ts';
import type { NotificationThread, ViewerLogin } from '../work/work.ts';
import type { Snapshot } from './sessionState.ts';
import {
  applyFailure,
  applyThreads,
  clearAccount,
  clearFailure,
  initialSnapshot,
  markFeedBusy,
  moveSelection,
  showSavedThreads,
  startRefresh,
} from './sessionState.ts';

export type { Snapshot } from './sessionState.ts';

export type ApplicationIntent =
  | { kind: 'refresh' }
  | { kind: 'selectNext' }
  | { kind: 'selectPrevious' };

export interface SavedSnapshot {
  login: ViewerLogin;
  savedAt: Date;
  feed: NotificationFeed;
  threads: NotificationThread[];
}

export interface SessionEffects {
  savedSnapshot: SavedSnapshot | null;
  readViewer: (signal: AbortSignal) => Promise<GitHubResult<ViewerLogin>>;
  saveSnapshot: (login: ViewerLogin, feed: NotificationFeed, savedAt: Date) => void;
  pollFeed: (
    feed: NotificationFeed,
    signal: AbortSignal,
  ) => Promise<GitHubResult<NotificationPoll>>;
  readFeed: (
    request: NotificationFeedRequest,
    signal: AbortSignal,
  ) => Promise<GitHubResult<NotificationFeedRead>>;
  verifyFeed: (
    feed: NotificationFeed,
    signal: AbortSignal,
  ) => Promise<GitHubResult<NotificationVerification>>;
  now: () => Date;
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
}

type FullRefreshOutcome =
  | { kind: 'loaded'; read: NotificationFeedRead }
  | { kind: 'busy' }
  | { kind: 'aborted' }
  | { kind: 'failed'; failure: GitHubFailure };

export interface Session {
  getSnapshot: () => Snapshot;
  subscribe: (listener: () => void) => () => void;
  send: (intent: ApplicationIntent) => void;
  stop: () => void;
}

const minimumPollSeconds = 60;
const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const fullRefreshAfterMinutes = 10;

const fullRefreshAfterMilliseconds =
  fullRefreshAfterMinutes * secondsPerMinute * millisecondsPerSecond;

const maximumRetries = 3;

const guard = async <Value>(
  read: () => Promise<GitHubResult<Value>>,
): Promise<GitHubResult<Value>> => {
  try {
    return await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { ok: false, failure: { kind: 'requestFailed', status: null, message } };
  }
};

export const createSession = (effects: SessionEffects): Session => {
  const { savedSnapshot } = effects;
  const listeners = new Set<() => void>();

  let snapshot: Snapshot =
    savedSnapshot === null
      ? initialSnapshot
      : showSavedThreads(savedSnapshot.threads, savedSnapshot.savedAt);

  let viewerLogin: ViewerLogin | null = null;
  let stopped = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let followUpPending = false;
  let feed: NotificationFeed | null = savedSnapshot?.feed ?? null;
  let cancelTimer: (() => void) | null = null;
  let pollSeconds = minimumPollSeconds;
  let lastFullRefreshAt = 0;

  const getSnapshot = () => snapshot;

  const subscribe = (listener: () => void) => {
    if (stopped) {
      return () => undefined;
    }

    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const update = (next: Snapshot) => {
    if (next === snapshot) {
      return;
    }

    snapshot = next;

    for (const listener of listeners) {
      listener();
    }
  };

  const rememberInterval = (seconds: number | null) => {
    if (seconds !== null) {
      pollSeconds = Math.max(seconds, minimumPollSeconds);
    }
  };

  const checkedRead = async (
    request: NotificationFeedRequest,
    signal: AbortSignal,
    retriesLeft: number,
  ): Promise<FullRefreshOutcome> => {
    const read = await guard(() => effects.readFeed(request, signal));

    if (!read.ok) {
      return { kind: 'failed', failure: read.failure };
    }

    if (signal.aborted) {
      return { kind: 'aborted' };
    }

    rememberInterval(read.value.pollInterval);

    const verification = await guard(() => effects.verifyFeed(read.value.feed, signal));

    if (!verification.ok) {
      return { kind: 'failed', failure: verification.failure };
    }

    rememberInterval(verification.value.pollInterval);

    if (verification.value.kind === 'stable') {
      return { kind: 'loaded', read: read.value };
    }

    if (retriesLeft === 0) {
      return { kind: 'busy' };
    }

    return checkedRead({ previous: read.value.feed }, signal, retriesLeft - 1);
  };

  // The saved feed only serves an account that matches the saved login.
  const acceptViewer = (login: ViewerLogin, request: NotificationFeedRequest) => {
    viewerLogin = login;

    if (savedSnapshot === null) {
      return request;
    }

    if (savedSnapshot.login === login) {
      return { ...request, previous: feed };
    }

    feed = null;
    update(clearAccount(snapshot));

    return { ...request, previous: null };
  };

  const fullRefresh = async (
    request: NotificationFeedRequest,
    signal: AbortSignal,
  ): Promise<FullRefreshOutcome> => {
    if (viewerLogin !== null) {
      return checkedRead(request, signal, maximumRetries);
    }

    const viewer = await guard(() => effects.readViewer(signal));

    if (!viewer.ok) {
      return { kind: 'failed', failure: viewer.failure };
    }

    if (signal.aborted) {
      return { kind: 'aborted' };
    }

    return checkedRead(acceptViewer(viewer.value, request), signal, maximumRetries);
  };

  const begin = () => {
    cancelTimer?.();
    cancelTimer = null;
    generation += 1;
    controller = new AbortController();

    return { own: generation, signal: controller.signal };
  };

  const isCurrent = (own: number) => !stopped && own === generation;

  // A refresh ends by scheduling a poll or starting a follow-up, and both start another refresh.
  const later: {
    startFullRefresh?: (request: NotificationFeedRequest) => void;
    onTimer?: () => void;
  } = {};

  const schedule = (delayMilliseconds: number) => {
    cancelTimer = effects.setTimer(delayMilliseconds, () => later.onTimer?.());
  };

  const pauseRemaining = () => {
    const { pausedUntil } = snapshot;

    if (pausedUntil === null) {
      return 0;
    }

    return Math.max(pausedUntil.getTime() - effects.now().getTime(), 0);
  };

  const endOperation = () => {
    controller = null;

    const paused = pauseRemaining();

    if (paused > 0) {
      followUpPending = false;
      schedule(paused);

      return;
    }

    if (followUpPending) {
      followUpPending = false;
      later.startFullRefresh?.({ previous: null });

      return;
    }

    schedule(pollSeconds * millisecondsPerSecond);
  };

  const saveQuietly = (savedAt: Date) => {
    if (viewerLogin === null || feed === null) {
      return;
    }

    try {
      effects.saveSnapshot(viewerLogin, feed, savedAt);
    } catch {
      // A failed save must not stop the session.
    }
  };

  const finishFullRefresh = (outcome: FullRefreshOutcome) => {
    if (outcome.kind === 'aborted') {
      return;
    }

    const now = effects.now();

    lastFullRefreshAt = now.getTime();

    if (outcome.kind === 'loaded') {
      feed = outcome.read.feed;
      update(applyThreads(snapshot, outcome.read.threads, now));
      saveQuietly(now);
    } else if (outcome.kind === 'busy') {
      update(markFeedBusy(snapshot));
    } else {
      update(applyFailure(snapshot, outcome.failure, now));
    }

    endOperation();
  };

  const runFullRefresh = (own: number, signal: AbortSignal, request: NotificationFeedRequest) => {
    update(startRefresh(snapshot));

    // A listener that throws must not stop the session.
    fullRefresh(request, signal)
      .then((outcome) => {
        if (isCurrent(own)) {
          finishFullRefresh(outcome);
        }
      })
      .catch(() => undefined);
  };

  later.startFullRefresh = (request) => {
    const { own, signal } = begin();

    runFullRefresh(own, signal, request);
  };

  const handlePoll = (
    own: number,
    signal: AbortSignal,
    stored: NotificationFeed,
    result: GitHubResult<NotificationPoll>,
  ) => {
    if (!result.ok) {
      update(applyFailure(snapshot, result.failure, effects.now()));
      endOperation();

      return;
    }

    rememberInterval(result.value.pollInterval);

    if (result.value.kind === 'unchanged') {
      update(clearFailure(snapshot));
      endOperation();

      return;
    }

    runFullRefresh(own, signal, { previous: stored, firstPage: result.value.page });
  };

  const startPoll = (stored: NotificationFeed) => {
    const { own, signal } = begin();

    guard(() => effects.pollFeed(stored, signal))
      .then((result) => {
        if (isCurrent(own)) {
          handlePoll(own, signal, stored, result);
        }
      })
      .catch(() => undefined);
  };

  const fullRefreshIsDue = () =>
    snapshot.feedBusy ||
    effects.now().getTime() - lastFullRefreshAt >= fullRefreshAfterMilliseconds;

  later.onTimer = () => {
    cancelTimer = null;

    if (stopped || controller !== null) {
      return;
    }

    const paused = pauseRemaining();

    if (paused > 0) {
      schedule(paused);

      return;
    }

    const stored = feed;
    const viewerUnknown = viewerLogin === null;
    const needsFullRefresh = snapshot.pausedUntil !== null || viewerUnknown || fullRefreshIsDue();

    if (stored === null || needsFullRefresh) {
      later.startFullRefresh?.({ previous: stored });

      return;
    }

    startPoll(stored);
  };

  const requestRefresh = () => {
    if (pauseRemaining() > 0) {
      return;
    }

    if (controller !== null) {
      followUpPending = true;

      return;
    }

    later.startFullRefresh?.({ previous: null });
  };

  const send = (intent: ApplicationIntent) => {
    if (stopped) {
      return;
    }

    if (intent.kind === 'refresh') {
      requestRefresh();
    } else {
      update(moveSelection(snapshot, intent.kind === 'selectNext' ? 1 : -1));
    }
  };

  const stop = () => {
    stopped = true;
    controller?.abort();
    controller = null;
    cancelTimer?.();
    cancelTimer = null;
    listeners.clear();
  };

  return { getSnapshot, subscribe, send, stop };
};
