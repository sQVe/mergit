import type {
  GitHubFailure,
  GitHubResult,
  NotificationFeed,
  NotificationFeedRead,
  NotificationFeedRequest,
  NotificationPoll,
  NotificationVerification,
  SubjectLookup,
  Viewer,
} from '../github/github.ts';
import type { Grouping, NotificationThread, ThreadId, ViewerLogin } from '../work/work.ts';
import type { Snapshot, Toast, UnsavedChange } from './sessionState.ts';
import {
  applyFailure,
  applySubjectLookups,
  applyThreads,
  clearAccount,
  clearFailure,
  initialSnapshot,
  markFeedBusy,
  cycleGrouping,
  jumpTopLevel,
  moveSelection,
  selectEdge,
  toggleAllFolds,
  toggleFold,
  showSavedThreads,
  startRefresh,
} from './sessionState.ts';

export type { Snapshot } from './sessionState.ts';
export { visibleRows } from './sessionState.ts';

export type ApplicationIntent =
  | { kind: 'refresh' }
  | { kind: 'selectNext' }
  | { kind: 'selectPrevious' }
  | { kind: 'selectFirst' }
  | { kind: 'selectLast' }
  | { kind: 'selectNextGroup' }
  | { kind: 'selectPreviousGroup' }
  | { kind: 'toggleFold' }
  | { kind: 'toggleAllFolds' }
  | { kind: 'cycleGrouping' };

export interface SavedSnapshot {
  viewer: Viewer;
  savedAt: Date;
  feed: NotificationFeed;
  threads: NotificationThread[];
}

export interface SessionEffects {
  savedSnapshot: SavedSnapshot | null;
  savedGrouping: Grouping | null;
  saveGrouping: (grouping: Grouping) => void;
  stateWarning: string | null;
  readViewer: (previous: Viewer | null, signal: AbortSignal) => Promise<GitHubResult<Viewer>>;
  saveSnapshot: (viewer: Viewer, feed: NotificationFeed, savedAt: Date) => void;
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
  lookUpSubjects: (threads: NotificationThread[], signal: AbortSignal) => Promise<SubjectLookup[]>;
  now: () => Date;
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
}

type FullRefreshOutcome =
  | { kind: 'loaded'; read: NotificationFeedRead; viewer: Viewer }
  | { kind: 'busy' }
  | { kind: 'aborted' }
  | { kind: 'failed'; failure: GitHubFailure };

type StateWriteOutcome = { ok: true } | { ok: false; reason: string; path: string };

export interface Session {
  getSnapshot: () => Snapshot;
  subscribe: (listener: () => void) => () => void;
  send: (intent: ApplicationIntent) => void;
  reportStateWrite: (outcome: StateWriteOutcome) => void;
  stop: () => void;
}

type StateIntent = Exclude<ApplicationIntent, { kind: 'refresh' }>;

const minimumPollSeconds = 60;
const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const fullRefreshAfterMinutes = 10;

const fullRefreshAfterMilliseconds =
  fullRefreshAfterMinutes * secondsPerMinute * millisecondsPerSecond;

const maximumRetries = 3;
const toastMilliseconds = 5000;

const unsavedLabels: Record<UnsavedChange, string> = {
  grouping: 'Grouping',
};

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

const isSubject = (thread: NotificationThread) =>
  thread.subjectType === 'PullRequest' || thread.subjectType === 'Issue';

const transitions: Record<StateIntent['kind'], (snapshot: Snapshot) => Snapshot> = {
  selectNext: (snapshot) => moveSelection(snapshot, 1),
  selectPrevious: (snapshot) => moveSelection(snapshot, -1),
  selectFirst: (snapshot) => selectEdge(snapshot, 'first'),
  selectLast: (snapshot) => selectEdge(snapshot, 'last'),
  selectNextGroup: (snapshot) => jumpTopLevel(snapshot, 1),
  selectPreviousGroup: (snapshot) => jumpTopLevel(snapshot, -1),
  toggleFold,
  toggleAllFolds,
  cycleGrouping,
};

export const createSession = (effects: SessionEffects): Session => {
  const { savedSnapshot } = effects;
  const listeners = new Set<() => void>();

  const startSnapshot: Snapshot = {
    ...initialSnapshot,
    grouping: effects.savedGrouping ?? initialSnapshot.grouping,
    stateWarning: effects.stateWarning,
  };

  let snapshot: Snapshot =
    savedSnapshot === null
      ? startSnapshot
      : showSavedThreads(startSnapshot, savedSnapshot.threads, savedSnapshot.savedAt);

  let viewerLogin: ViewerLogin | null = null;
  let lastViewer: Viewer | null = savedSnapshot?.viewer ?? null;
  let stopped = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let followUpPending = false;
  let feed: NotificationFeed | null = savedSnapshot?.feed ?? null;
  let cancelTimer: (() => void) | null = null;
  let cancelToastTimer: (() => void) | null = null;
  let unsavedChanges = new Set<UnsavedChange>();
  let pollSeconds = minimumPollSeconds;
  let lastFullRefreshAt = 0;
  let lookupController: AbortController | null = null;
  const lookedUp = new Map<ThreadId, string>();

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
    viewer: Viewer,
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
      return { kind: 'loaded', read: read.value, viewer };
    }

    if (retriesLeft === 0) {
      return { kind: 'busy' };
    }

    return checkedRead({ previous: read.value.feed }, signal, retriesLeft - 1, viewer);
  };

  // The feed from a saved snapshot only serves an account that matches the saved login.
  const acceptViewer = (viewer: Viewer, request: NotificationFeedRequest) => {
    const firstRead = viewerLogin === null;
    const accountChanged = lastViewer !== null && lastViewer.login !== viewer.login;

    viewerLogin = viewer.login;
    lastViewer = viewer;

    if (accountChanged) {
      feed = null;
      lookupController?.abort();
      lookupController = null;
      lookedUp.clear();
      update(clearAccount(snapshot));

      return { ...request, previous: null };
    }

    if (firstRead && savedSnapshot !== null) {
      return { ...request, previous: feed };
    }

    return request;
  };

  const fullRefresh = async (
    request: NotificationFeedRequest,
    signal: AbortSignal,
  ): Promise<FullRefreshOutcome> => {
    const viewer = await guard(() => effects.readViewer(lastViewer, signal));

    if (!viewer.ok) {
      return { kind: 'failed', failure: viewer.failure };
    }

    if (signal.aborted) {
      return { kind: 'aborted' };
    }

    return checkedRead(acceptViewer(viewer.value, request), signal, maximumRetries, viewer.value);
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

  const saveQuietly = (viewer: Viewer, savedAt: Date) => {
    if (feed === null) {
      return;
    }

    try {
      effects.saveSnapshot(viewer, feed, savedAt);
    } catch {
      // A failed save must not stop the session.
    }
  };

  const showToast = (toast: Toast) => {
    cancelToastTimer?.();
    update({ ...snapshot, toast });

    cancelToastTimer = effects.setTimer(toastMilliseconds, () => {
      cancelToastTimer = null;
      update({ ...snapshot, toast: null });
    });
  };

  const reportStateWrite = (outcome: StateWriteOutcome) => {
    if (stopped) {
      return;
    }

    if (outcome.ok) {
      unsavedChanges = new Set();

      return;
    }

    const names = [...unsavedChanges].map((change) => unsavedLabels[change]);

    showToast({
      title: `${names.join(' and ')} not saved`,
      lines: [outcome.reason, outcome.path],
      tone: 'error',
    });
  };

  const saveGroupingQuietly = (grouping: Grouping) => {
    unsavedChanges.add('grouping');

    try {
      effects.saveGrouping(grouping);
    } catch {
      // A failed save must not stop the session.
    }
  };

  const pruneLookedUp = () => {
    const currentIds = new Set(snapshot.threads.map((thread) => thread.id));

    for (const threadId of lookedUp.keys()) {
      if (!currentIds.has(threadId)) {
        lookedUp.delete(threadId);
      }
    }
  };

  const acceptLookups = (lookups: SubjectLookup[]) => {
    const current = new Map(snapshot.threads.map((thread) => [thread.id, thread.updatedAt]));

    const fresh = lookups.filter((lookup) => current.get(lookup.threadId) === lookup.updatedAt);

    for (const lookup of fresh) {
      lookedUp.set(lookup.threadId, lookup.updatedAt);
    }

    update(applySubjectLookups(snapshot, fresh));
  };

  const startLookup = () => {
    pruneLookedUp();

    const unknown = snapshot.threads.filter(
      (thread) => isSubject(thread) && lookedUp.get(thread.id) !== thread.updatedAt,
    );

    lookupController?.abort();
    lookupController = null;

    if (unknown.length === 0) {
      return;
    }

    const own = new AbortController();

    lookupController = own;

    // A lookup that fails changes nothing, so the next loaded refresh sends its threads again.
    Promise.resolve()
      .then(() => effects.lookUpSubjects(unknown, own.signal))
      .then((lookups) => {
        if (!own.signal.aborted && !stopped) {
          acceptLookups(lookups);
        }
      })
      .catch(() => undefined);
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
      saveQuietly(outcome.viewer, now);
      startLookup();
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
      update(transitions[intent.kind](snapshot));

      if (intent.kind === 'cycleGrouping') {
        saveGroupingQuietly(snapshot.grouping);
      }
    }
  };

  const stop = () => {
    stopped = true;
    controller?.abort();
    controller = null;
    lookupController?.abort();
    lookupController = null;
    cancelTimer?.();
    cancelTimer = null;
    cancelToastTimer?.();
    cancelToastTimer = null;
    listeners.clear();
  };

  return { getSnapshot, subscribe, send, reportStateWrite, stop };
};
