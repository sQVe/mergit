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
import type { BrowserPage, Grouping, NotificationThread, ThreadId } from '../work/work.ts';
import { createAccountSwitch } from './accountSwitch.ts';
import { createBrowserOpen } from './browserOpen.ts';
import type { BrowserOpenInputs } from './browserOpen.ts';
import { closeCommandLine, editCommandLine, openCommandLine } from './commandLine.ts';
import { copyAccountRecords, createDoneActions } from './doneActions.ts';
import { createFeedRefresh } from './feedRefresh.ts';
import type { SettledRefresh } from './feedRefresh.ts';
import {
  applyFailure,
  applyThreads,
  clearAccount,
  markFeedBusy,
  showSavedThreads,
} from './feedTransitions.ts';
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
import { createMarker } from './marker.ts';
import { createMessageToast } from './messageToast.ts';
import { moveSearchCompletion } from './searchCompletion.ts';
import {
  clearSearch,
  editSearch,
  keepSearch,
  openSearch,
  restoreSearch,
} from './searchTransitions.ts';
import { jumpTopLevel, moveSelection, selectEdge } from './selectionMoves.ts';
import type { Snapshot, UnsavedChange } from './sessionState.ts';
import { initialSnapshot } from './sessionState.ts';
import { createSubjectLookup } from './subjectLookup.ts';
import { cycleGrouping, toggleAllFolds, toggleFold } from './treeTransitions.ts';

export type { Snapshot } from './sessionState.ts';
export { filterCursorOf, filterRowsOf } from './filterComposer.ts';
export type { FilterRow } from './filterComposer.ts';
export { describeFilterRow } from './filterDescriptions.ts';
export { formatFilter } from '../query.ts';
export type { Filter } from '../query.ts';
export { searchCandidatesOf } from './searchCompletion.ts';
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
  | { kind: 'openCommandLine' }
  | { kind: 'editCommandLine'; text: string }
  | { kind: 'closeCommandLine' }
  | { kind: 'reportUnknownCommand'; name: string }
  | { kind: 'openSearch' }
  | { kind: 'editSearch'; text: string }
  | { kind: 'keepSearch' }
  | { kind: 'restoreSearch' }
  | { kind: 'clearSearch' }
  | { kind: 'nextSearchCompletion' }
  | { kind: 'previousSearchCompletion' }
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
  openInBrowser: BrowserOpenInputs['openInBrowser'];
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

type EditIntent = Extract<
  ApplicationIntent,
  {
    kind:
      | 'editSearch'
      | 'editCommandLine'
      | 'reportUnknownCommand'
      | 'editFilterDraft'
      | 'moveFilterCursor';
  }
>;

type StateIntent = Exclude<
  ApplicationIntent,
  | { kind: 'refresh' }
  | { kind: 'markDone' }
  | { kind: 'markThreadsDone'; threadIds: readonly ThreadId[] }
  | { kind: 'undoDone' }
  | { kind: 'openInBrowser'; pages: readonly BrowserPage[] }
  | EditIntent
>;

const editKinds = new Set<string>([
  'editSearch',
  'editCommandLine',
  'reportUnknownCommand',
  'editFilterDraft',
  'moveFilterCursor',
]);

const isEditIntent = (intent: ApplicationIntent): intent is EditIntent =>
  editKinds.has(intent.kind);

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
  openCommandLine,
  closeCommandLine,
  openSearch,
  keepSearch,
  restoreSearch,
  clearSearch,
  nextSearchCompletion: (snapshot) => moveSearchCompletion(snapshot, 1),
  previousSearchCompletion: (snapshot) => moveSearchCompletion(snapshot, -1),
  openFilters,
  takeFilterRow,
  applyFilterRow,
  closeFilters,
  leaveFilters,
  clearFilters,
};

export const createSession = (effects: SessionEffects): Session => {
  const { savedSnapshot } = effects;
  const listeners = new Set<() => void>();

  const accountSwitch = createAccountSwitch(savedSnapshot);

  // A refresh outcome publishes through `finish`, and a lookup answer publishes through `update`, which reads the lookup's pending threads.
  const later: {
    update?: (candidate: Snapshot) => void;
    saveState?: (change: UnsavedChange) => void;
    finish?: (outcome: SettledRefresh, now: Date) => void;
  } = {};

  const doneActions = createDoneActions({
    host: effects.host,
    saved: effects.savedState?.done,
    setTimer: effects.setTimer,
    markThreadDone: effects.markThreadDone,
    currentLogin: accountSwitch.currentLogin,
    getSnapshot: () => snapshot,
    update: (candidate) => {
      later.update?.(candidate);
    },
    showToast: (content, durationMilliseconds) => {
      toaster.show(content, durationMilliseconds);
    },
    saveState: (change) => {
      later.saveState?.(change);
    },
    requestRefresh: () => {
      refresh.request();
    },
    isStopped: () => stopped,
  });

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
          doneActions.currentRecords(),
          savedSnapshot.savedAt,
        );

  let stopped = false;
  let unsavedChanges = new Set<UnsavedChange>();

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
      effects.saveState({ grouping, done: doneActions.records, seen: marker.records });
    } catch {
      // A failed save must not stop the session.
    }
  };

  const marker = createMarker({
    host: effects.host,
    seen: copyAccountRecords(effects.savedState?.seen),
    currentLogin: accountSwitch.currentLogin,
    pendingThreadIdsOf: subjectLookup.pendingThreadIdsOf,
    getSnapshot,
    save: (grouping) => {
      saveStateQuietly('seen', grouping);
    },
  });

  const update = (candidate: Snapshot) => {
    const next = marker.applyLeaving(candidate);

    if (next === snapshot) {
      return;
    }

    snapshot = next;

    for (const listener of listeners) {
      listener();
    }
  };

  later.update = update;

  later.saveState = (change) => {
    saveStateQuietly(change);
  };

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

  const toaster = createMessageToast({
    now: effects.now,
    setTimer: effects.setTimer,
    getSnapshot: () => snapshot,
    update,
  });

  const reportUnknownCommand = (name: string) => {
    update(closeCommandLine(snapshot));
    toaster.show({ title: `Unknown command: ${name}`, lines: [], tone: 'error' });
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

    toaster.show({
      title: `${names.join(' and ')} not saved`,
      lines: [outcome.reason, outcome.path],
      tone: 'error',
    });
  };

  const finishFullRefresh = (outcome: SettledRefresh, now: Date) => {
    if (outcome.kind === 'loaded') {
      doneActions.prune(outcome.read.threads);
      const next = applyThreads(snapshot, outcome.read.threads, doneActions.currentRecords(), now);

      subjectLookup.start(next.threads);
      update(next);
      // After the update, so a selected thread that left the feed is not saved again as seen.
      marker.prune(outcome.read.threads);
      doneActions.releaseSent();
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

  const browserOpen = createBrowserOpen({
    openInBrowser: effects.openInBrowser,
    isStopped: () => stopped,
    showToast: toaster.show,
  });

  snapshot = marker.apply(snapshot);

  const sendEdit = (intent: EditIntent) => {
    switch (intent.kind) {
      case 'editSearch':
        update(editSearch(snapshot, intent.text));

        break;
      case 'editCommandLine':
        update(editCommandLine(snapshot, intent.text));

        break;
      case 'reportUnknownCommand':
        reportUnknownCommand(intent.name);

        break;
      case 'editFilterDraft':
        update(editFilterDraft(snapshot, intent.text));

        break;
      case 'moveFilterCursor':
        update(moveFilterCursor(snapshot, intent.direction));

        break;
    }
  };

  const send = (intent: ApplicationIntent) => {
    if (stopped) {
      return;
    }

    if (intent.kind === 'refresh') {
      refresh.request();
    } else if (intent.kind === 'markDone') {
      doneActions.markDone();
    } else if (intent.kind === 'markThreadsDone') {
      doneActions.markThreadsDone(intent.threadIds);
    } else if (intent.kind === 'undoDone') {
      doneActions.undoDone();
    } else if (intent.kind === 'openInBrowser') {
      browserOpen.open(intent.pages);
    } else if (isEditIntent(intent)) {
      sendEdit(intent);
    } else {
      update(transitions[intent.kind](snapshot));

      if (intent.kind === 'cycleGrouping') {
        saveStateQuietly('grouping');
      }
    }
  };

  const stop = (deadline: AbortSignal): Promise<void> => {
    marker.recordSelected(snapshot);

    stopped = true;
    browserOpen.stop();
    refresh.abort();
    subjectLookup.abort();
    refresh.cancelTimer();
    toaster.cancel();
    listeners.clear();

    return doneActions.stop(deadline);
  };

  return { getSnapshot, subscribe, send, reportStateWrite, stop };
};
