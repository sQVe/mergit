import type { OpenResult } from '../actions.ts';
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
import { invariant } from '../invariant.ts';
import type {
  BrowserPage,
  Grouping,
  NotificationThread,
  ThreadId,
  ViewerLogin,
} from '../work/work.ts';
import { createDoneQueue, undoWindowMilliseconds } from './done.ts';
import type { Snapshot, Toast, UnsavedChange } from './sessionState.ts';
import {
  applyFailure,
  applySubjectLookups,
  applyThreads,
  clearAccount,
  clearFailure,
  failureMessage,
  hideThreads,
  initialSnapshot,
  isViewerActor,
  markFeedBusy,
  cycleGrouping,
  jumpTopLevel,
  moveSelection,
  newThreadIdsOf,
  releaseThreads,
  selectEdge,
  selectedThreadOf,
  showThreads,
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
  | { kind: 'cycleGrouping' }
  | { kind: 'markDone' }
  | { kind: 'markThreadsDone'; threadIds: readonly ThreadId[] }
  | { kind: 'undoDone' }
  | { kind: 'openInBrowser'; pages: readonly BrowserPage[] };

export interface SavedState {
  grouping: Grouping;
  done: ReadonlyMap<string, ReadonlyMap<ThreadId, string>>;
  seen: ReadonlyMap<string, ReadonlyMap<ThreadId, string>>;
}

export interface SavedSnapshot {
  viewer: Viewer;
  savedAt: Date;
  feed: NotificationFeed;
  threads: NotificationThread[];
}

export interface SessionEffects {
  savedSnapshot: SavedSnapshot | null;
  host: string;
  savedState: SavedState | null;
  saveState: (state: SavedState) => void;
  markThreadDone: (threadId: ThreadId, signal: AbortSignal) => Promise<GitHubResult<null>>;
  openInBrowser: (page: BrowserPage, signal: AbortSignal) => Promise<OpenResult>;
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
  stop: (deadline: AbortSignal) => Promise<void>;
}

type StateIntent = Exclude<
  ApplicationIntent,
  | { kind: 'refresh' }
  | { kind: 'markDone' }
  | { kind: 'markThreadsDone'; threadIds: readonly ThreadId[] }
  | { kind: 'undoDone' }
  | { kind: 'openInBrowser'; pages: readonly BrowserPage[] }
>;

const minimumPollSeconds = 60;
const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const fullRefreshAfterMinutes = 10;

const fullRefreshAfterMilliseconds =
  fullRefreshAfterMinutes * secondsPerMinute * millisecondsPerSecond;

const maximumRetries = 3;
const toastMilliseconds = 4000;

const unsavedLabels: Record<UnsavedChange, string> = {
  grouping: 'Grouping',
  done: 'Done thread',
  seen: 'Seen thread',
};

const guard = async <Value>(
  read: () => Promise<GitHubResult<Value>>,
): Promise<GitHubResult<Value>> => {
  try {
    return await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      failure: { kind: 'requestFailed', status: null, message },
    };
  }
};

const isSubject = (thread: NotificationThread) =>
  thread.subjectType === 'PullRequest' || thread.subjectType === 'Issue';

const subjectVersionsOf = (saved: SavedSnapshot | null | undefined) => {
  const threads = saved?.threads.filter(isSubject) ?? [];

  return new Map(threads.map((thread) => [thread.id, thread.updatedAt]));
};

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

const copyAccountRecords = (
  accounts: ReadonlyMap<string, ReadonlyMap<ThreadId, string>> = new Map(),
): Map<string, Map<ThreadId, string>> =>
  new Map([...accounts].map(([account, records]) => [account, new Map(records)]));

export const createSession = (effects: SessionEffects): Session => {
  const { savedSnapshot } = effects;
  const listeners = new Set<() => void>();

  const accountRecords = copyAccountRecords(effects.savedState?.done);
  const seenRecords = copyAccountRecords(effects.savedState?.seen);

  let currentLogin: ViewerLogin | null = savedSnapshot?.viewer.login ?? null;
  const noRecords: ReadonlyMap<ThreadId, string> = new Map();

  const currentRecords = (): ReadonlyMap<ThreadId, string> =>
    currentLogin === null
      ? noRecords
      : (accountRecords.get(`${effects.host}/${currentLogin}`) ?? noRecords);

  const startSnapshot: Snapshot = {
    ...initialSnapshot,
    grouping: effects.savedState?.grouping ?? initialSnapshot.grouping,
    stateWarning: effects.stateWarning,
  };

  let snapshot: Snapshot =
    savedSnapshot === null
      ? startSnapshot
      : showSavedThreads(
          startSnapshot,
          savedSnapshot.threads,
          currentRecords(),
          savedSnapshot.savedAt,
        );

  let viewerLogin: ViewerLogin | null = null;
  let lastViewer: Viewer | null = savedSnapshot?.viewer ?? null;
  let stopped = false;
  let generation = 0;
  let controller: AbortController | null = null;
  const openController = new AbortController();
  let followUpPending = false;
  let feed: NotificationFeed | null = savedSnapshot?.feed ?? null;
  let cancelTimer: (() => void) | null = null;
  let cancelToastTimer: (() => void) | null = null;
  let unsavedChanges = new Set<UnsavedChange>();
  let pollSeconds = minimumPollSeconds;
  let lastFullRefreshAt = 0;
  let lookupController: AbortController | null = null;
  const lookedUp = new Map<ThreadId, string>();
  const sentThreadIds = new Set<ThreadId>();
  const pendingLookups = subjectVersionsOf(savedSnapshot);
  let startupLookupsPending = pendingLookups.size > 0;

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

  const saveStateQuietly = (change: UnsavedChange, grouping = snapshot.grouping) => {
    unsavedChanges.add(change);

    try {
      effects.saveState({ grouping, done: accountRecords, seen: seenRecords });
    } catch {
      // A failed save must not stop the session.
    }
  };

  const currentSeen = (): Map<ThreadId, string> | undefined =>
    currentLogin === null ? undefined : seenRecords.get(`${effects.host}/${currentLogin}`);

  const recordSeen = (candidate: Snapshot, left: NotificationThread | undefined): boolean => {
    const seen = currentSeen();
    const login = currentLogin;

    if (seen === undefined || login === null) {
      return false;
    }

    const seenNow = candidate.threads.filter((thread) =>
      isViewerActor(candidate.subjectFacts.get(thread.id), login),
    );

    if (left !== undefined) {
      seenNow.push(candidate.threads.find((thread) => thread.id === left.id) ?? left);
    }

    let changed = false;

    for (const thread of seenNow) {
      if (seen.get(thread.id) !== thread.updatedAt) {
        seen.set(thread.id, thread.updatedAt);
        changed = true;
      }
    }

    return changed;
  };

  const threadLeftBy = (candidate: Snapshot): NotificationThread | undefined => {
    const previous = selectedThreadOf(snapshot);

    return previous?.id === selectedThreadOf(candidate)?.id ? undefined : previous;
  };

  const withMarkers = (candidate: Snapshot, left?: NotificationThread): Snapshot => {
    if (recordSeen(candidate, left)) {
      saveStateQuietly('seen', candidate.grouping);
    }

    const pendingThreadIds = new Set(
      candidate.threads
        .filter((thread) => pendingLookups.get(thread.id) === thread.updatedAt)
        .map((thread) => thread.id),
    );

    const newThreadIds = newThreadIdsOf({
      threads: candidate.threads,
      seen: currentSeen(),
      subjectFacts: candidate.subjectFacts,
      viewerLogin: currentLogin ?? '',
      pendingThreadIds,
    });

    const unchanged =
      newThreadIds.size === candidate.newThreadIds.size &&
      [...newThreadIds].every((threadId) => candidate.newThreadIds.has(threadId));

    return unchanged ? candidate : { ...candidate, newThreadIds };
  };

  const update = (candidate: Snapshot) => {
    const next = withMarkers(candidate, threadLeftBy(candidate));

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

    // Clear before the login changes, so the thread the cursor leaves is seen by its own account.
    if (accountChanged) {
      feed = null;
      lookupController?.abort();
      lookupController = null;
      lookedUp.clear();
      pendingLookups.clear();
      update(clearAccount(snapshot));
    }

    viewerLogin = viewer.login;
    currentLogin = viewer.login;
    lastViewer = viewer;

    if (accountChanged) {
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

  const showToast = (
    content: Omit<Toast, 'durationMilliseconds'>,
    durationMilliseconds = toastMilliseconds,
  ) => {
    const toast = { ...content, durationMilliseconds };

    cancelToastTimer?.();
    update({ ...snapshot, toast });

    cancelToastTimer = effects.setTimer(toast.durationMilliseconds, () => {
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

  const pruneLookedUp = (threads: NotificationThread[]) => {
    const currentIds = new Set(threads.map((thread) => thread.id));

    for (const threadId of lookedUp.keys()) {
      if (!currentIds.has(threadId)) {
        lookedUp.delete(threadId);
      }
    }
  };

  const forgetPending = (sent: NotificationThread[]) => {
    for (const thread of sent) {
      if (pendingLookups.get(thread.id) === thread.updatedAt) {
        pendingLookups.delete(thread.id);
      }
    }
  };

  const acceptLookups = (sent: NotificationThread[], lookups: SubjectLookup[]) => {
    forgetPending(sent);

    const current = new Map(snapshot.threads.map((thread) => [thread.id, thread.updatedAt]));

    const fresh = lookups.filter((lookup) => current.get(lookup.threadId) === lookup.updatedAt);

    for (const lookup of fresh) {
      lookedUp.set(lookup.threadId, lookup.updatedAt);
    }

    update(applySubjectLookups(snapshot, fresh));
  };

  const startLookup = (threads: NotificationThread[]) => {
    pruneLookedUp(threads);
    pendingLookups.clear();
    startupLookupsPending = false;

    const unknown = threads.filter(
      (thread) => isSubject(thread) && lookedUp.get(thread.id) !== thread.updatedAt,
    );

    lookupController?.abort();
    lookupController = null;

    if (unknown.length === 0) {
      return;
    }

    const own = new AbortController();

    lookupController = own;

    for (const thread of unknown) {
      pendingLookups.set(thread.id, thread.updatedAt);
    }

    // A lookup that fails leaves its threads new by updated_at alone, and the next loaded refresh
    // sends them again.
    Promise.resolve()
      .then(() => effects.lookUpSubjects(unknown, own.signal))
      .then((lookups) => {
        if (!own.signal.aborted && !stopped) {
          acceptLookups(unknown, lookups);
        }
      })
      .catch(() => {
        if (!own.signal.aborted && !stopped) {
          forgetPending(unknown);
          update(snapshot);
        }
      });
  };

  const pruneDoneRecords = (fetched: NotificationThread[]) => {
    if (currentLogin === null) {
      return;
    }

    const records = accountRecords.get(`${effects.host}/${currentLogin}`);
    const fetchedIds = new Set(fetched.map((thread) => thread.id));
    let changed = false;

    for (const threadId of records?.keys() ?? []) {
      if (!fetchedIds.has(threadId)) {
        records?.delete(threadId);
        changed = true;
      }
    }

    if (changed) {
      saveStateQuietly('done');
    }
  };

  const pruneSeenRecords = (fetched: NotificationThread[]) => {
    if (currentLogin === null) {
      return;
    }

    const account = `${effects.host}/${currentLogin}`;
    const seen = seenRecords.get(account);

    if (seen === undefined) {
      seenRecords.set(account, new Map(fetched.map((thread) => [thread.id, thread.updatedAt])));

      saveStateQuietly('seen');

      return;
    }

    const fetchedIds = new Set(fetched.map((thread) => thread.id));
    let changed = false;

    for (const threadId of seen.keys()) {
      if (!fetchedIds.has(threadId)) {
        seen.delete(threadId);
        changed = true;
      }
    }

    if (changed) {
      saveStateQuietly('seen');
    }
  };

  const releaseSentThreads = () => {
    update(releaseThreads(snapshot, sentThreadIds));
    sentThreadIds.clear();
  };

  const releaseStartupLookups = () => {
    if (startupLookupsPending) {
      pendingLookups.clear();
      startupLookupsPending = false;
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
      pruneDoneRecords(outcome.read.threads);
      const next = applyThreads(snapshot, outcome.read.threads, currentRecords(), now);

      startLookup(next.threads);
      update(next);
      // After the update, so a selected thread that left the feed is not saved again as seen.
      pruneSeenRecords(outcome.read.threads);
      releaseSentThreads();
      saveQuietly(outcome.viewer, now);
    } else if (outcome.kind === 'busy') {
      releaseStartupLookups();
      update(markFeedBusy(snapshot));
    } else {
      releaseStartupLookups();
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

    runFullRefresh(own, signal, {
      previous: stored,
      firstPage: result.value.page,
    });
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

  const recordDone = (thread: NotificationThread, key: string) => {
    const records = accountRecords.get(key) ?? new Map<ThreadId, string>();

    records.set(thread.id, thread.updatedAt);
    accountRecords.set(key, records);
  };

  const doneQueue = createDoneQueue({
    setTimer: effects.setTimer,
    markThreadDone: effects.markThreadDone,
    onSent: (thread, account) => {
      recordDone(thread, account);
      sentThreadIds.add(thread.id);
      saveStateQuietly('done');
    },
    onEntrySent: () => {
      if (!stopped) {
        requestRefresh();
      }
    },
    onFailed: (failed, total) => {
      const [first] = failed;

      invariant(first !== undefined, 'a failed action has a failed thread');

      update(
        showThreads(
          snapshot,
          failed.map((entry) => entry.thread.id),
        ),
      );

      const title =
        total === 1
          ? `Could not mark ${first.thread.title} done`
          : `Could not mark ${failed.length} of ${total} threads done`;

      showToast({ title, lines: [failureMessage(first.failure)], tone: 'error' });
    },
  });

  const markThreads = (threads: readonly NotificationThread[]) => {
    const [first] = threads;

    if (first === undefined || currentLogin === null) {
      return;
    }

    doneQueue.add(threads, `${effects.host}/${currentLogin}`);
    update(hideThreads(snapshot, new Set(threads.map((thread) => thread.id))));

    const title =
      threads.length === 1 ? `Marked ${first.title} done` : `Marked ${threads.length} threads done`;

    showToast(
      { title, lines: ['You can undo for 5 seconds'], tone: 'info' },
      undoWindowMilliseconds,
    );
  };

  const markDone = () => {
    const thread = selectedThreadOf(snapshot);

    if (thread !== undefined) {
      markThreads([thread]);
    }
  };

  const markThreadsDone = (threadIds: readonly ThreadId[]) => {
    const requested = new Set(threadIds);

    const threads = snapshot.threads.filter(
      (thread) => requested.has(thread.id) && !snapshot.hiddenThreadIds.has(thread.id),
    );

    markThreads(threads);
  };

  const undoDone = () => {
    const outcome = doneQueue.undoLatest();

    if (outcome.kind === 'undone') {
      const [first] = outcome.threads;

      const title =
        outcome.threads.length === 1 && first !== undefined
          ? `Undid marking ${first.title} done`
          : `Undid marking ${outcome.threads.length} threads done`;

      update(
        showThreads(
          snapshot,
          outcome.threads.map((thread) => thread.id),
        ),
      );

      showToast({ title, lines: [], tone: 'info' });
    } else if (outcome.kind === 'tooLate') {
      showToast({
        title: 'The last done cannot be undone',
        lines: [],
        tone: 'info',
      });
    }
  };

  let openQueue: Promise<void> = Promise.resolve();

  const openInBrowser = async (pages: readonly BrowserPage[]) => {
    const results: OpenResult[] = [];

    for (const page of pages) {
      if (stopped) {
        return;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- opens run one at a time, in order
      results.push(await effects.openInBrowser(page, openController.signal));
    }

    if (stopped) {
      return;
    }

    const failures = results.filter((result) => !result.ok);
    const [first] = failures;

    if (first === undefined) {
      return;
    }

    const title =
      pages.length === 1
        ? 'Could not open the page in the browser'
        : `Could not open ${failures.length} of ${pages.length} pages in the browser`;

    showToast({ title, lines: [first.message], tone: 'error' });
  };

  snapshot = withMarkers(snapshot);

  const send = (intent: ApplicationIntent) => {
    if (stopped) {
      return;
    }

    if (intent.kind === 'refresh') {
      requestRefresh();
    } else if (intent.kind === 'markDone') {
      markDone();
    } else if (intent.kind === 'markThreadsDone') {
      markThreadsDone(intent.threadIds);
    } else if (intent.kind === 'undoDone') {
      undoDone();
    } else if (intent.kind === 'openInBrowser') {
      openQueue = openQueue.then(() => openInBrowser(intent.pages)).catch(() => undefined);
    } else {
      update(transitions[intent.kind](snapshot));

      if (intent.kind === 'cycleGrouping') {
        saveStateQuietly('grouping');
      }
    }
  };

  const stop = (deadline: AbortSignal): Promise<void> => {
    if (recordSeen(snapshot, selectedThreadOf(snapshot))) {
      saveStateQuietly('seen');
    }

    stopped = true;
    openController.abort();
    controller?.abort();
    controller = null;
    lookupController?.abort();
    lookupController = null;
    cancelTimer?.();
    cancelTimer = null;
    cancelToastTimer?.();
    cancelToastTimer = null;
    listeners.clear();

    return doneQueue.stop(deadline);
  };

  return { getSnapshot, subscribe, send, reportStateWrite, stop };
};
