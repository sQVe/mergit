import type {
  GitHubResult,
  NotificationFeed,
  NotificationFeedRead,
  NotificationFeedRequest,
  NotificationPoll,
  NotificationVerification,
  SubjectLookupResult,
  Viewer,
} from '../github/github.ts';
import type { BrowserPage, Grouping, NotificationThread, ThreadId } from '../work/work.ts';
import { createAccountSwitch } from './accountSwitch.ts';
import { createAdmission } from './admission.ts';
import { createBrowserOpen } from './browserOpen.ts';
import type { BrowserOpenInputs } from './browserOpen.ts';
import {
  closeCommandLine,
  editCommandLine,
  openCommandLine,
  moveCommandLineCompletion,
} from './commandLine.ts';
import { copyAccountRecords, createDoneActions, moveAccountRecords } from './doneActions.ts';
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
import { clampListTop, placeSelectedRow, scrollPage, setListRows } from './listViewport.ts';
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
import { jumpTopLevel, moveSelection, selectRowNumber } from './selectionMoves.ts';
import type { Snapshot, UnsavedChange } from './sessionState.ts';
import { initialSnapshot, noticeMessageOf, visibleRows } from './sessionState.ts';
import { createSubjectLookup } from './subjectLookup.ts';
import {
  closeAllFolds,
  closeFold,
  cycleGrouping,
  openAllFolds,
  openFold,
  toggleFold,
} from './treeTransitions.ts';

export type { Snapshot } from './sessionState.ts';
export { filterCursorOf } from './filterComposer.ts';
export { filterRowsOf } from './filterRows.ts';
export type { FilterRow } from './filterRows.ts';
export { describeFilterRow } from './filterDescriptions.ts';
export { filterCombinationOf, formatFilter } from '../query.ts';
export type { Filter } from '../query.ts';
export { commandLineCandidatesOf } from './commandLine.ts';
export { chosenCandidateIndexOf, searchCandidatesOf } from './searchCompletion.ts';
export { matchCountOf, noticeMessageOf, openThreads, visibleRows } from './sessionState.ts';

export type ApplicationIntent =
  | { kind: 'refresh' }
  | { kind: 'selectNext'; count?: number | undefined }
  | { kind: 'selectPrevious'; count?: number | undefined }
  | { kind: 'selectFirst'; count?: number | undefined }
  | { kind: 'selectLast'; count?: number | undefined }
  | { kind: 'selectNextGroup' }
  | { kind: 'selectPreviousGroup' }
  | { kind: 'toggleFold' }
  | { kind: 'openFold' }
  | { kind: 'closeFold' }
  | { kind: 'openAllFolds' }
  | { kind: 'closeAllFolds' }
  | {
      kind: 'scrollPage';
      direction: 'down' | 'up';
      size: 'half' | 'full';
      count?: number | undefined;
    }
  | {
      kind: 'placeSelectedRow';
      position: 'center' | 'top' | 'bottom';
      count?: number | undefined;
    }
  | { kind: 'cycleGrouping' }
  | { kind: 'moveCommandLineCompletion'; names: readonly string[]; direction: 1 | -1 }
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
  | { kind: 'undoThreadDone'; threadId: ThreadId }
  | { kind: 'openInBrowser'; pages: readonly BrowserPage[] }
  | { kind: 'setListRows'; rows: number };

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
  // The readable text of the refresh key, such as `r`. Empty when the key is unbound.
  refreshKey: string | undefined;
  savedState: SavedState | null;
  saveState: (state: SavedState) => void;
  markThreadDone: (threadId: ThreadId, signal: AbortSignal) => Promise<GitHubResult<null>>;
  openInBrowser: BrowserOpenInputs['openInBrowser'];
  configNotices: readonly string[];
  stateWarning: { reason: string; path: string } | null;
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
  lookUpSubjects: (
    threads: NotificationThread[],
    signal: AbortSignal,
  ) => Promise<SubjectLookupResult>;
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
  | { kind: 'undoThreadDone'; threadId: ThreadId }
  | { kind: 'openInBrowser'; pages: readonly BrowserPage[] }
  | { kind: 'setListRows'; rows: number }
  | EditIntent
>;

type StateIntentByKind = { [Intent in StateIntent as Intent['kind']]: Intent };

type Transitions = {
  [Kind in keyof StateIntentByKind]: (
    snapshot: Snapshot,
    intent: StateIntentByKind[Kind],
  ) => Snapshot;
};

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

const transitions: Transitions = {
  selectNext: (snapshot, intent) => moveSelection(snapshot, intent.count ?? 1),
  selectPrevious: (snapshot, intent) => moveSelection(snapshot, -(intent.count ?? 1)),
  selectFirst: (snapshot, intent) => selectRowNumber(snapshot, intent.count ?? 1),
  selectLast: (snapshot, intent) =>
    selectRowNumber(snapshot, intent.count ?? Number.POSITIVE_INFINITY),
  selectNextGroup: (snapshot) => jumpTopLevel(snapshot, 1),
  selectPreviousGroup: (snapshot) => jumpTopLevel(snapshot, -1),
  toggleFold,
  openFold,
  closeFold,
  openAllFolds,
  closeAllFolds,
  scrollPage: (snapshot, intent) =>
    scrollPage(snapshot, intent.direction, intent.size, intent.count),
  placeSelectedRow: (snapshot, intent) => placeSelectedRow(snapshot, intent.position, intent.count),
  cycleGrouping,
  openCommandLine,
  closeCommandLine,
  moveCommandLineCompletion: (snapshot, intent) =>
    moveCommandLineCompletion(snapshot, intent.names, intent.direction),
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

// Generic over the kind, so TypeScript pairs each intent with its own transition.
const applyTransition = <Kind extends keyof StateIntentByKind>(
  snapshot: Snapshot,
  kind: Kind,
  intent: StateIntentByKind[Kind],
): Snapshot => transitions[kind](snapshot, intent);

const stateWarningMarker = 'state not saved';

export const createSession = (effects: SessionEffects): Session => {
  const { savedSnapshot } = effects;
  const listeners = new Set<() => void>();

  const accountSwitch = createAccountSwitch(savedSnapshot, (from, to) => {
    // oxlint-disable-next-line seam/helper-before-use -- a rename moves the records of owners that read this one
    moveAccount(`${effects.host}/${from}`, `${effects.host}/${to}`);
  });

  const doneActions = createDoneActions({
    host: effects.host,
    saved: effects.savedState?.done,
    setTimer: effects.setTimer,
    markThreadDone: effects.markThreadDone,
    currentLogin: accountSwitch.currentLogin,
    getSnapshot: () => snapshot,
    update: (candidate) => {
      // oxlint-disable-next-line seam/helper-before-use -- update reads the marker, which reads this owner's pending threads
      update(candidate);
    },
    showToast: (content, durationMilliseconds) => {
      toaster.show(content, durationMilliseconds);
    },
    saveState: (change) => {
      // oxlint-disable-next-line seam/helper-before-use -- saving reads the marker and this owner's records
      saveStateQuietly(change);
    },
    requestRefresh: () => {
      refresh.request();
    },
    isStopped: () => stopped,
  });

  const startSnapshot: Snapshot = {
    ...initialSnapshot,
    grouping: effects.savedState?.grouping ?? initialSnapshot.grouping,
    stateWarning: effects.stateWarning === null ? null : stateWarningMarker,
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
  let reporting = false;
  let unsavedChanges = new Set<UnsavedChange>();

  const publish = (candidate: Snapshot) => {
    // oxlint-disable-next-line seam/helper-before-use -- update reads the marker, which reads the subject lookup's pending threads
    update(candidate);
  };

  const subjectLookup = createSubjectLookup({
    saved: savedSnapshot,
    lookUpSubjects: effects.lookUpSubjects,
    getSnapshot: () => snapshot,
    update: publish,
    isStopped: () => stopped,
    admission: createAdmission({ now: effects.now, getSnapshot: () => snapshot, update: publish }),
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

  const moveAccount = (from: string, to: string) => {
    doneActions.moveAccount(from, to);
    moveAccountRecords(marker.records, from, to);
    unsavedChanges.add('done');
    saveStateQuietly('seen');
  };

  const announceNotice = (previous: Snapshot, next: Snapshot) => {
    if (next.notice === null || next.notice === previous.notice || visibleRows(next).length === 0) {
      return;
    }

    const message = noticeMessageOf(next.notice, effects.refreshKey);

    toaster.show({ title: message.title, lines: [message.text], tone: 'error' });
  };

  const update = (candidate: Snapshot) => {
    const next = clampListTop(marker.applyLeaving(candidate));

    if (next === snapshot) {
      return;
    }

    const previous = snapshot;

    snapshot = next;

    const failures: unknown[] = [];

    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        failures.push(error);
      }
    }

    announceNotice(previous, next);

    if (!reporting && failures.length > 0) {
      // oxlint-disable-next-line seam/helper-before-use -- the error toast publishes through update
      reportError(failures[0]);
    }
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

  const reportError = (error: unknown) => {
    if (stopped) {
      return;
    }

    reporting = true;

    try {
      toaster.show({
        title: 'Something went wrong',
        lines: [error instanceof Error ? error.message : String(error)],
        tone: 'error',
      });
    } finally {
      reporting = false;
    }
  };

  const toaster = createMessageToast({
    now: effects.now,
    setTimer: effects.setTimer,
    getSnapshot: () => snapshot,
    update,
  });

  if (effects.configNotices.length > 0) {
    toaster.show({
      title: 'Your config took keys from the defaults',
      lines: [...effects.configNotices],
      tone: 'info',
    });
  }

  if (effects.stateWarning !== null) {
    toaster.show({
      title: 'Mergit will not save state until the file is fixed or removed',
      lines: [effects.stateWarning.reason, effects.stateWarning.path],
      tone: 'error',
    });
  }

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
  };

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
    finish: finishFullRefresh,
    reportError,
  });

  const browserOpen = createBrowserOpen({
    openInBrowser: effects.openInBrowser,
    isStopped: () => stopped,
    showToast: toaster.show,
  });

  snapshot = clampListTop(marker.apply(snapshot));

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
    } else if (intent.kind === 'undoThreadDone') {
      doneActions.undoDone(intent.threadId);
    } else if (intent.kind === 'openInBrowser') {
      browserOpen.open(intent.pages);
    } else if (intent.kind === 'setListRows') {
      update(setListRows(snapshot, intent.rows));
    } else if (isEditIntent(intent)) {
      sendEdit(intent);
    } else {
      update(applyTransition(snapshot, intent.kind, intent));

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
