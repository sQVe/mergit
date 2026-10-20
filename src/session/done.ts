import type { GitHubFailure, GitHubResult } from '../github/github.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';
import { guardEffect } from './effectGuard.ts';

type UndoOutcome =
  | { kind: 'undone'; threads: readonly NotificationThread[] }
  | { kind: 'tooLate' }
  | { kind: 'nothing' };

export interface DoneQueueEffects {
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
  markThreadDone: (threadId: ThreadId, signal: AbortSignal) => Promise<GitHubResult<null>>;
  onSent: (thread: NotificationThread, account: string) => void;
  onEntrySent: () => void;
  onFailed: (failed: readonly FailedThread[], total: number) => void;
}

interface FailedThread {
  thread: NotificationThread;
  failure: GitHubFailure;
}

export interface DoneQueue {
  add: (threads: readonly NotificationThread[], account: string) => void;
  undoLatest: () => UndoOutcome;
  stop: (deadline: AbortSignal) => Promise<void>;
}

interface Entry {
  threads: readonly NotificationThread[];
  account: string;
  state: 'waiting' | 'due' | 'sending' | 'sent';
  cancelTimer: () => void;
}

export const undoWindowMilliseconds = 5000;

const failsEveryRequest = (failure: GitHubFailure) =>
  failure.kind === 'ghMissing' || failure.kind === 'notSignedIn' || failure.kind === 'rateLimited';

export const createDoneQueue = (effects: DoneQueueEffects): DoneQueue => {
  let entries: Entry[] = [];
  let running: Promise<void> | null = null;
  let stopping = false;
  const sends = new AbortController();

  const isAborted = () => sends.signal.aborted;

  const sendDueEntries = async () => {
    for (;;) {
      const entry = entries.find((candidate) => candidate.state === 'due');

      if (entry === undefined || isAborted()) {
        return;
      }

      entry.state = 'sending';

      const failed: FailedThread[] = [];
      let sentCount = 0;

      for (const [index, thread] of entry.threads.entries()) {
        if (isAborted()) {
          break;
        }

        // oxlint-disable-next-line eslint/no-await-in-loop -- dones go out one at a time
        const result = await guardEffect(
          () => effects.markThreadDone(thread.id, sends.signal),
          (message): GitHubResult<null> => ({
            ok: false,
            failure: { kind: 'requestFailed', status: null, message },
          }),
        );

        if (result.ok) {
          sentCount += 1;
          effects.onSent(thread, entry.account);

          continue;
        }

        failed.push({ thread, failure: result.failure });

        if (failsEveryRequest(result.failure)) {
          const unsent = entry.threads.slice(index + 1);

          failed.push(...unsent.map((rest) => ({ thread: rest, failure: result.failure })));

          break;
        }
      }

      entry.state = 'sent';

      if (sentCount > 0) {
        effects.onEntrySent();
      }

      if (failed.length === entry.threads.length) {
        entries = entries.filter((candidate) => candidate !== entry);
      }

      if (failed.length > 0 && !stopping) {
        effects.onFailed(failed, entry.threads.length);
      }
    }
  };

  const sendNext = (): Promise<void> => {
    running ??= sendDueEntries().finally(() => {
      running = null;
    });

    return running;
  };

  const add = (threads: readonly NotificationThread[], account: string) => {
    const entry: Entry = { threads, account, state: 'waiting', cancelTimer: () => undefined };

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

      return { kind: 'undone', threads: waiting.threads };
    }

    return entries.length > 0 ? { kind: 'tooLate' } : { kind: 'nothing' };
  };

  const stop = async (deadline: AbortSignal) => {
    stopping = true;

    if (deadline.aborted) {
      sends.abort();
    } else {
      deadline.addEventListener(
        'abort',
        () => {
          sends.abort();
        },
        { once: true },
      );
    }

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
