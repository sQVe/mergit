import type { OpenResult } from '../actions.ts';
import type {
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
import type { BrowserPage, Grouping, NotificationThread, ThreadId } from '../work/work.ts';
import { createAccountSwitch } from './accountSwitch.ts';
import { createDoneQueue, undoWindowMilliseconds } from './done.ts';
import { createFeedRefresh } from './feedRefresh.ts';
import type { SettledRefresh } from './feedRefresh.ts';
import {
  applyFilterRow,
  clearFilters,
  closeFilters,
  editFilterDraft,
  leaveFilters,
  moveFilterCursor,
  openFilters,
  takeFilterRow,
} from './filterComposer.ts';
import type { Snapshot, Toast, UnsavedChange } from './sessionState.ts';
import {
  applyFailure,
  applyThreads,
  clearAccount,
  clearSearch,
  editSearch,
  failureMessage,
  hideThreads,
  initialSnapshot,
  isViewerActor,
  keepSearch,
  keepSelectionVisible,
  openSearch,
  restoreSearch,
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
} from './sessionState.ts';
import { createSubjectLookup } from './subjectLookup.ts';

export type { Snapshot } from './sessionState.ts';
export { filterCursorOf, filterRowsOf } from './filterComposer.ts';
export type { FilterRow } from './filterComposer.ts';
export { describeFilterRow } from './filterDescriptions.ts';
export { formatFilter } from '../query.ts';
export type { Filter } from '../query.ts';
export { matchCountOf, openThreads, visibleRows } from './sessionState.ts';

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
  | { kind: 'openSearch' }
  | { kind: 'editSearch'; text: string }
  | { kind: 'keepSearch' }
  | { kind: 'restoreSearch' }
  | { kind: 'clearSearch' }
  | { kind: 'openFilters' }
  | { kind: 'editFilterDraft'; text: string }
  | { kind: 'moveFilterCursor'; direction: 'up' | 'down' }
  | { kind: 'takeFilterRow' }
  | { kind: 'applyFilterRow' }
  | { kind: 'closeFilters' }
  | { kind: 'leaveFilters' }
  | { kind: 'clearFilters' }
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
  | { kind: 'editSearch'; text: string }
  | { kind: 'editFilterDraft'; text: string }
  | { kind: 'moveFilterCursor'; direction: 'up' | 'down' }
>;

const toastMilliseconds = 4000;

const unsavedLabels: Record<UnsavedChange, string> = {
  grouping: 'Grouping',
  done: 'Done thread',
  seen: 'Seen thread',
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
  openSearch,
  keepSearch,
  restoreSearch,
  clearSearch,
  openFilters,
  takeFilterRow,
  applyFilterRow,
  closeFilters,
  leaveFilters,
  clearFilters,
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

  const accountSwitch = createAccountSwitch(savedSnapshot);
  const noRecords: ReadonlyMap<ThreadId, string> = new Map();

  const currentRecords = (): ReadonlyMap<ThreadId, string> => {
    const login = accountSwitch.currentLogin();

    return login === null
      ? noRecords
      : (accountRecords.get(`${effects.host}/${login}`) ?? noRecords);
  };

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

  let stopped = false;
  const openController = new AbortController();
  let cancelToastTimer: (() => void) | null = null;
  let unsavedChanges = new Set<UnsavedChange>();
  const sentThreadIds = new Set<ThreadId>();

  // A refresh outcome publishes through `finish`, and a lookup answer publishes through `update`, which reads the lookup's pending threads.
  const later: {
    update?: (candidate: Snapshot) => void;
    finish?: (outcome: SettledRefresh, now: Date) => void;
  } = {};

  const subjectLookup = createSubjectLookup({
    saved: savedSnapshot,
    lookUpSubjects: effects.lookUpSubjects,
    getSnapshot: () => snapshot,
    update: (candidate) => {
      later.update?.(candidate);
    },
    isStopped: () => stopped,
  });

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
    accountSwitch.currentLogin() === null
      ? undefined
      : seenRecords.get(`${effects.host}/${accountSwitch.currentLogin()}`);

  const recordSeen = (candidate: Snapshot, left: NotificationThread | undefined): boolean => {
    const seen = currentSeen();
    const login = accountSwitch.currentLogin();

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

    const pendingThreadIds = subjectLookup.pendingThreadIdsOf(candidate.threads);

    const newThreadIds = newThreadIdsOf({
      threads: candidate.threads,
      seen: currentSeen(),
      subjectFacts: candidate.subjectFacts,
      viewerLogin: accountSwitch.currentLogin() ?? '',
      pendingThreadIds,
    });

    const sameNewIds =
      newThreadIds.size === candidate.newThreadIds.size &&
      [...newThreadIds].every((threadId) => candidate.newThreadIds.has(threadId));

    if (sameNewIds && candidate.viewerLogin === accountSwitch.currentLogin()) {
      return candidate;
    }

    return keepSelectionVisible(candidate, {
      ...candidate,
      newThreadIds,
      viewerLogin: accountSwitch.currentLogin(),
    });
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

  later.update = update;

  const saveQuietly = (viewer: Viewer, savedAt: Date) => {
    const feed = refresh.storedFeed();

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

  const pruneDoneRecords = (fetched: NotificationThread[]) => {
    const login = accountSwitch.currentLogin();

    if (login === null) {
      return;
    }

    const records = accountRecords.get(`${effects.host}/${login}`);
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
    const login = accountSwitch.currentLogin();

    if (login === null) {
      return;
    }

    const account = `${effects.host}/${login}`;
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

  const finishFullRefresh = (outcome: SettledRefresh, now: Date) => {
    if (outcome.kind === 'loaded') {
      pruneDoneRecords(outcome.read.threads);
      const next = applyThreads(snapshot, outcome.read.threads, currentRecords(), now);

      subjectLookup.start(next.threads);
      update(next);
      // After the update, so a selected thread that left the feed is not saved again as seen.
      pruneSeenRecords(outcome.read.threads);
      releaseSentThreads();
      saveQuietly(outcome.viewer, now);
    } else if (outcome.kind === 'busy') {
      subjectLookup.releaseStartup();
      update(markFeedBusy(snapshot));
    } else {
      subjectLookup.releaseStartup();
      update(applyFailure(snapshot, outcome.failure, now));
    }

    refresh.endOperation();
  };

  later.finish = finishFullRefresh;

  const refresh = createFeedRefresh({
    savedFeed: savedSnapshot?.feed ?? null,
    readViewer: effects.readViewer,
    pollFeed: effects.pollFeed,
    readFeed: effects.readFeed,
    verifyFeed: effects.verifyFeed,
    now: effects.now,
    setTimer: effects.setTimer,
    accountSwitch,
    clearAccount: () => {
      subjectLookup.clear();
      update(clearAccount(snapshot));
    },
    getSnapshot: () => snapshot,
    update,
    isStopped: () => stopped,
    finish: (outcome, now) => {
      later.finish?.(outcome, now);
    },
  });

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
        refresh.request();
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

    const login = accountSwitch.currentLogin();

    if (first === undefined || login === null) {
      return;
    }

    doneQueue.add(threads, `${effects.host}/${login}`);
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
      refresh.request();
    } else if (intent.kind === 'markDone') {
      markDone();
    } else if (intent.kind === 'markThreadsDone') {
      markThreadsDone(intent.threadIds);
    } else if (intent.kind === 'undoDone') {
      undoDone();
    } else if (intent.kind === 'openInBrowser') {
      openQueue = openQueue.then(() => openInBrowser(intent.pages)).catch(() => undefined);
    } else if (intent.kind === 'editSearch') {
      update(editSearch(snapshot, intent.text));
    } else if (intent.kind === 'editFilterDraft') {
      update(editFilterDraft(snapshot, intent.text));
    } else if (intent.kind === 'moveFilterCursor') {
      update(moveFilterCursor(snapshot, intent.direction));
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
    refresh.abort();
    subjectLookup.abort();
    refresh.cancelTimer();
    cancelToastTimer?.();
    cancelToastTimer = null;
    listeners.clear();

    return doneQueue.stop(deadline);
  };

  return { getSnapshot, subscribe, send, reportStateWrite, stop };
};
