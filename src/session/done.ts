import type { GitHubFailure, GitHubResult } from '../github/github.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';

type UndoOutcome =
  | { kind: 'undone'; thread: NotificationThread }
  | { kind: 'tooLate' }
  | { kind: 'nothing' };

export interface DoneQueueEffects {
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
  markThreadDone: (threadId: ThreadId) => Promise<GitHubResult<null>>;
  onSent: (thread: NotificationThread) => void;
  onFailed: (thread: NotificationThread, failure: GitHubFailure) => void;
}

export interface DoneQueue {
  add: (thread: NotificationThread) => void;
  undoLatest: () => UndoOutcome;
  stop: () => Promise<void>;
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
): Promise<GitHubResult<null>> => {
  try {
    return await effects.markThreadDone(threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { ok: false, failure: { kind: 'requestFailed', status: null, message } };
  }
};

export const createDoneQueue = (effects: DoneQueueEffects): DoneQueue => {
  let entries: Entry[] = [];
  let running: Promise<void> | null = null;
  let stopping = false;

  const sendDueEntries = async () => {
    for (;;) {
      const entry = entries.find((candidate) => candidate.state === 'due');

      if (entry === undefined) {
        return;
      }

      entry.state = 'sending';

      // oxlint-disable-next-line eslint/no-await-in-loop -- dones go out one at a time
      const result = await sendSafely(effects, entry.thread.id);

      if (result.ok) {
        entry.state = 'sent';
        effects.onSent(entry.thread);
      } else {
        entries = entries.filter((candidate) => candidate !== entry);

        if (!stopping) {
          effects.onFailed(entry.thread, result.failure);
        }
      }
    }
  };

  const sendNext = (): Promise<void> => {
    running ??= sendDueEntries().finally(() => {
      running = null;
    });

    return running;
  };

  const add = (thread: NotificationThread) => {
    const entry: Entry = { thread, state: 'waiting', cancelTimer: () => undefined };

    entry.cancelTimer = effects.setTimer(undoWindowMilliseconds, () => {
      entry.state = 'due';
      sendNext().catch(() => undefined);
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

  const stop = async () => {
    stopping = true;

    for (const entry of entries) {
      if (entry.state === 'waiting') {
        entry.cancelTimer();
        entry.state = 'due';
      }
    }

    await sendNext();
  };

  return { add, undoLatest, stop };
};
