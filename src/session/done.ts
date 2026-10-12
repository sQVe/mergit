import type { GitHubFailure, GitHubResult } from '../github/github.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';

type UndoOutcome =
  | { kind: 'undone'; thread: NotificationThread }
  | { kind: 'tooLate' }
  | { kind: 'nothing' };

export interface DoneQueueEffects {
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
  markThreadDone: (threadId: ThreadId, signal: AbortSignal) => Promise<GitHubResult<null>>;
  onSent: (thread: NotificationThread) => void;
  onFailed: (thread: NotificationThread, failure: GitHubFailure) => void;
}

export interface DoneQueue {
  add: (thread: NotificationThread) => void;
  undoLatest: () => UndoOutcome;
  stop: () => void;
}

interface Entry {
  thread: NotificationThread;
  state: 'waiting' | 'due' | 'sending' | 'sent';
  cancelTimer: () => void;
}

export const undoWindowMilliseconds = 5000;

const sendSafely = async (
  effects: DoneQueueEffects,
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<GitHubResult<null>> => {
  try {
    return await effects.markThreadDone(threadId, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { ok: false, failure: { kind: 'requestFailed', status: null, message } };
  }
};

export const createDoneQueue = (effects: DoneQueueEffects): DoneQueue => {
  const controller = new AbortController();
  let entries: Entry[] = [];
  let sending = false;
  let stopped = false;

  const sendNext = () => {
    const entry = entries.find((candidate) => candidate.state === 'due');

    if (sending || stopped || entry === undefined) {
      return;
    }

    sending = true;
    entry.state = 'sending';

    sendSafely(effects, entry.thread.id, controller.signal)
      .then((result) => {
        sending = false;

        if (stopped) {
          return;
        }

        if (result.ok) {
          entry.state = 'sent';
          effects.onSent(entry.thread);
        } else {
          entries = entries.filter((candidate) => candidate !== entry);
          effects.onFailed(entry.thread, result.failure);
        }

        sendNext();
      })
      .catch(() => undefined);
  };

  const add = (thread: NotificationThread) => {
    const entry: Entry = { thread, state: 'waiting', cancelTimer: () => undefined };

    entry.cancelTimer = effects.setTimer(undoWindowMilliseconds, () => {
      entry.state = 'due';
      sendNext();
    });

    entries.push(entry);
  };

  const undoLatest = (): UndoOutcome => {
    const waiting = entries.findLast((entry) => entry.state === 'waiting');

    if (waiting !== undefined) {
      waiting.cancelTimer();
      entries = entries.filter((entry) => entry !== waiting);

      return { kind: 'undone', thread: waiting.thread };
    }

    return entries.length > 0 ? { kind: 'tooLate' } : { kind: 'nothing' };
  };

  const stop = () => {
    stopped = true;
    controller.abort();

    for (const entry of entries) {
      entry.cancelTimer();
    }
  };

  return { add, undoLatest, stop };
};
