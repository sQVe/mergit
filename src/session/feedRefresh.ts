import type {
  GitHubFailure,
  GitHubResult,
  NotificationFeed,
  NotificationFeedRead,
  NotificationFeedRequest,
  NotificationPoll,
  NotificationVerification,
  Viewer,
} from '../github/github.ts';
import type { AccountSwitchOwner } from './accountSwitch.ts';
import { guardEffect } from './effectGuard.ts';
import { applyFailure, clearFailure, startRefresh } from './feedTransitions.ts';
import type { Snapshot } from './sessionState.ts';

type FullRefreshOutcome =
  | { kind: 'loaded'; read: NotificationFeedRead; viewer: Viewer }
  | { kind: 'busy' }
  | { kind: 'aborted' }
  | { kind: 'failed'; failure: GitHubFailure };

export type SettledRefresh = Exclude<FullRefreshOutcome, { kind: 'aborted' }>;

export interface FeedRefreshOwner {
  request: () => void;
  endOperation: () => void;
  abort: () => void;
  cancelTimer: () => void;
  storedFeed: () => NotificationFeed | null;
}

export interface FeedRefreshHost {
  savedFeed: NotificationFeed | null;
  readViewer: (previous: Viewer | null, signal: AbortSignal) => Promise<GitHubResult<Viewer>>;
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
  accountSwitch: AccountSwitchOwner;
  clearAccount: () => void;
  getSnapshot: () => Snapshot;
  update: (next: Snapshot) => void;
  isStopped: () => boolean;
  finish: (outcome: SettledRefresh, now: Date) => void;
}

const minimumPollSeconds = 60;
const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const fullRefreshAfterMinutes = 10;

const fullRefreshAfterMilliseconds =
  fullRefreshAfterMinutes * secondsPerMinute * millisecondsPerSecond;

const maximumRetries = 3;

const requestFailed = (message: string): GitHubResult<never> => ({
  ok: false,
  failure: { kind: 'requestFailed', status: null, message },
});

export const createFeedRefresh = (host: FeedRefreshHost): FeedRefreshOwner => {
  let generation = 0;
  let controller: AbortController | null = null;
  let followUpPending = false;
  let feed: NotificationFeed | null = host.savedFeed;
  let cancelTimer: (() => void) | null = null;
  let pollSeconds = minimumPollSeconds;
  let lastFullRefreshAt = 0;

  // A refresh ends by scheduling a poll or starting a follow-up, and both start another refresh.
  const later: {
    startFullRefresh?: (request: NotificationFeedRequest) => void;
    onTimer?: () => void;
  } = {};

  const rememberInterval = (seconds: number | null) => {
    if (seconds !== null) {
      pollSeconds = Math.max(seconds, minimumPollSeconds);
    }
  };

  const checkedRead = async (
    request: NotificationFeedRequest,
    signal: AbortSignal,
    retriesLeft: number,
    viewer: Viewer,
  ): Promise<FullRefreshOutcome> => {
    const read = await guardEffect(() => host.readFeed(request, signal), requestFailed);

    if (!read.ok) {
      return { kind: 'failed', failure: read.failure };
    }

    if (signal.aborted) {
      return { kind: 'aborted' };
    }

    rememberInterval(read.value.pollInterval);

    const verification = await guardEffect(
      () => host.verifyFeed(read.value.feed, signal),
      requestFailed,
    );

    if (!verification.ok) {
      return { kind: 'failed', failure: verification.failure };
    }

    rememberInterval(verification.value.pollInterval);

    if (verification.value.kind === 'stable') {
      return { kind: 'loaded', read: read.value, viewer };
    }

    if (retriesLeft === 0) {
      return { kind: 'busy' };
    }

    return checkedRead({ previous: read.value.feed }, signal, retriesLeft - 1, viewer);
  };

  const forgetFeed = () => {
    feed = null;
    host.clearAccount();
  };

  const fullRefresh = async (
    request: NotificationFeedRequest,
    signal: AbortSignal,
  ): Promise<FullRefreshOutcome> => {
    const viewer = await guardEffect(
      () => host.readViewer(host.accountSwitch.lastViewer(), signal),
      requestFailed,
    );

    if (!viewer.ok) {
      return { kind: 'failed', failure: viewer.failure };
    }

    if (signal.aborted) {
      return { kind: 'aborted' };
    }

    const accepted = host.accountSwitch.accept(viewer.value, request, feed, forgetFeed);

    return checkedRead(accepted, signal, maximumRetries, viewer.value);
  };

  const begin = () => {
    cancelTimer?.();
    cancelTimer = null;
    generation += 1;
    controller = new AbortController();

    return { own: generation, signal: controller.signal };
  };

  const isCurrent = (own: number) => !host.isStopped() && own === generation;

  const schedule = (delayMilliseconds: number) => {
    cancelTimer = host.setTimer(delayMilliseconds, () => later.onTimer?.());
  };

  const pauseRemaining = () => {
    const { pausedUntil } = host.getSnapshot();

    if (pausedUntil === null) {
      return 0;
    }

    return Math.max(pausedUntil.getTime() - host.now().getTime(), 0);
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

  const finishFullRefresh = (outcome: FullRefreshOutcome) => {
    if (outcome.kind === 'aborted') {
      return;
    }

    const now = host.now();

    lastFullRefreshAt = now.getTime();

    if (outcome.kind === 'loaded') {
      feed = outcome.read.feed;
    }

    host.finish(outcome, now);
  };

  const runFullRefresh = (own: number, signal: AbortSignal, request: NotificationFeedRequest) => {
    host.update(startRefresh(host.getSnapshot()));

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
      host.update(applyFailure(host.getSnapshot(), result.failure, host.now()));
      endOperation();

      return;
    }

    rememberInterval(result.value.pollInterval);

    if (result.value.kind === 'unchanged') {
      host.update(clearFailure(host.getSnapshot()));
      endOperation();

      return;
    }

    runFullRefresh(own, signal, {
      previous: stored,
      firstPage: result.value.page,
    });
  };

  const startPoll = (stored: NotificationFeed) => {
    const { own, signal } = begin();

    guardEffect(() => host.pollFeed(stored, signal), requestFailed)
      .then((result) => {
        if (isCurrent(own)) {
          handlePoll(own, signal, stored, result);
        }
      })
      .catch(() => undefined);
  };

  const fullRefreshIsDue = () =>
    host.getSnapshot().feedBusy ||
    host.now().getTime() - lastFullRefreshAt >= fullRefreshAfterMilliseconds;

  later.onTimer = () => {
    cancelTimer = null;

    if (host.isStopped() || controller !== null) {
      return;
    }

    const paused = pauseRemaining();

    if (paused > 0) {
      schedule(paused);

      return;
    }

    const stored = feed;
    const viewerUnknown = !host.accountSwitch.viewerKnown();

    const needsFullRefresh =
      host.getSnapshot().pausedUntil !== null || viewerUnknown || fullRefreshIsDue();

    if (stored === null || needsFullRefresh) {
      later.startFullRefresh?.({ previous: stored });

      return;
    }

    startPoll(stored);
  };

  const request = () => {
    if (pauseRemaining() > 0) {
      return;
    }

    if (controller !== null) {
      followUpPending = true;

      return;
    }

    later.startFullRefresh?.({ previous: null });
  };

  return {
    request,
    endOperation,
    abort: () => {
      controller?.abort();
      controller = null;
    },
    cancelTimer: () => {
      cancelTimer?.();
      cancelTimer = null;
    },
    storedFeed: () => feed,
  };
};
