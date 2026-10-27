import type { GitHubResult } from '../github/github.ts';
import { invariant } from '../invariant.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';
import { createDoneQueue, undoWindowMilliseconds } from './done.ts';
import { hideThreads, releaseThreads, showThreads } from './doneHiding.ts';
import { failureMessage } from './feedTransitions.ts';
import type { MessageToastOwner } from './messageToast.ts';
import { selectedThreadOf } from './selectionMoves.ts';
import type { Snapshot, UnsavedChange } from './sessionState.ts';

export interface DoneActionsInputs {
  host: string;
  saved: ReadonlyMap<string, ReadonlyMap<ThreadId, string>> | undefined;
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
  markThreadDone: (threadId: ThreadId, signal: AbortSignal) => Promise<GitHubResult<null>>;
  currentLogin: () => string | null;
  getSnapshot: () => Snapshot;
  update: (candidate: Snapshot) => void;
  showToast: MessageToastOwner['show'];
  saveState: (change: UnsavedChange) => void;
  requestRefresh: () => void;
  isStopped: () => boolean;
}

export interface DoneActionsOwner {
  records: Map<string, Map<ThreadId, string>>;
  currentRecords: () => ReadonlyMap<ThreadId, string>;
  markDone: () => void;
  markThreadsDone: (threadIds: readonly ThreadId[]) => void;
  undoDone: (threadId?: ThreadId) => void;
  prune: (fetched: NotificationThread[]) => void;
  releaseSent: () => void;
  stop: (deadline: AbortSignal) => Promise<void>;
}

export const copyAccountRecords = (
  accounts: ReadonlyMap<string, ReadonlyMap<ThreadId, string>> = new Map(),
): Map<string, Map<ThreadId, string>> =>
  new Map([...accounts].map(([account, records]) => [account, new Map(records)]));

export const createDoneActions = (inputs: DoneActionsInputs): DoneActionsOwner => {
  const records = copyAccountRecords(inputs.saved);
  const noRecords: ReadonlyMap<ThreadId, string> = new Map();
  const sentThreadIds = new Set<ThreadId>();

  const currentRecords = (): ReadonlyMap<ThreadId, string> => {
    const login = inputs.currentLogin();

    return login === null ? noRecords : (records.get(`${inputs.host}/${login}`) ?? noRecords);
  };

  const recordDone = (thread: NotificationThread, key: string) => {
    const accountRecords = records.get(key) ?? new Map<ThreadId, string>();

    accountRecords.set(thread.id, thread.updatedAt);
    records.set(key, accountRecords);
  };

  const doneQueue = createDoneQueue({
    setTimer: inputs.setTimer,
    markThreadDone: inputs.markThreadDone,
    onSent: (thread, account) => {
      recordDone(thread, account);
      sentThreadIds.add(thread.id);
      inputs.saveState('done');
    },
    onEntrySent: () => {
      if (!inputs.isStopped()) {
        inputs.requestRefresh();
      }
    },
    onFailed: (failed, total) => {
      const [first] = failed;

      invariant(first !== undefined, 'a failed action has a failed thread');

      inputs.update(
        showThreads(
          inputs.getSnapshot(),
          failed.map((entry) => entry.thread.id),
        ),
      );

      const title =
        total === 1
          ? `Could not mark ${first.thread.title} done`
          : `Could not mark ${failed.length} of ${total} threads done`;

      inputs.showToast({ title, lines: [failureMessage(first.failure)], tone: 'error' });
    },
  });

  const markThreads = (threads: readonly NotificationThread[]) => {
    const [first] = threads;

    const login = inputs.currentLogin();

    if (first === undefined || login === null) {
      return;
    }

    doneQueue.add(threads, `${inputs.host}/${login}`);
    inputs.update(hideThreads(inputs.getSnapshot(), new Set(threads.map((thread) => thread.id))));

    const title =
      threads.length === 1 ? `Marked ${first.title} done` : `Marked ${threads.length} threads done`;

    inputs.showToast(
      { title, lines: ['You can undo for 5 seconds'], tone: 'info' },
      undoWindowMilliseconds,
    );
  };

  const markDone = () => {
    const thread = selectedThreadOf(inputs.getSnapshot());

    if (thread !== undefined) {
      markThreads([thread]);
    }
  };

  const markThreadsDone = (threadIds: readonly ThreadId[]) => {
    const requested = new Set(threadIds);
    const snapshot = inputs.getSnapshot();

    const threads = snapshot.threads.filter(
      (thread) => requested.has(thread.id) && !snapshot.hiddenThreadIds.has(thread.id),
    );

    markThreads(threads);
  };

  const undoDone = (threadId?: ThreadId) => {
    const outcome = doneQueue.undoLatest(threadId);

    if (outcome.kind === 'undone') {
      const [first] = outcome.threads;

      const title =
        outcome.threads.length === 1 && first !== undefined
          ? `Undid marking ${first.title} done`
          : `Undid marking ${outcome.threads.length} threads done`;

      inputs.update(
        showThreads(
          inputs.getSnapshot(),
          outcome.threads.map((thread) => thread.id),
        ),
      );

      inputs.showToast({ title, lines: [], tone: 'info' });
    } else if (outcome.kind === 'tooLate') {
      inputs.showToast({
        title: 'The last done cannot be undone',
        lines: [],
        tone: 'info',
      });
    } else if (outcome.kind === 'otherThread') {
      inputs.showToast({
        title: 'The last done is for another thread',
        lines: [],
        tone: 'info',
      });
    }
  };

  const prune = (fetched: NotificationThread[]) => {
    const login = inputs.currentLogin();

    if (login === null) {
      return;
    }

    const accountRecords = records.get(`${inputs.host}/${login}`);
    const fetchedIds = new Set(fetched.map((thread) => thread.id));
    let changed = false;

    for (const threadId of accountRecords?.keys() ?? []) {
      if (!fetchedIds.has(threadId)) {
        accountRecords?.delete(threadId);
        changed = true;
      }
    }

    if (changed) {
      inputs.saveState('done');
    }
  };

  const releaseSent = () => {
    inputs.update(releaseThreads(inputs.getSnapshot(), sentThreadIds));
    sentThreadIds.clear();
  };

  return {
    records,
    currentRecords,
    markDone,
    markThreadsDone,
    undoDone,
    prune,
    releaseSent,
    stop: doneQueue.stop,
  };
};
