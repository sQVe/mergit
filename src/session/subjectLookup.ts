import type { SubjectLookup } from '../github/github.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';
import type { Snapshot } from './sessionState.ts';
import { keepSelectionVisible } from './sessionState.ts';

export interface SubjectLookupOwner {
  start: (threads: NotificationThread[]) => void;
  releaseStartup: () => void;
  clear: () => void;
  abort: () => void;
  pendingThreadIdsOf: (threads: readonly NotificationThread[]) => Set<ThreadId>;
}

export interface SubjectLookupHost {
  saved: { threads: readonly NotificationThread[] } | null;
  lookUpSubjects: (threads: NotificationThread[], signal: AbortSignal) => Promise<SubjectLookup[]>;
  getSnapshot: () => Snapshot;
  update: (next: Snapshot) => void;
  isStopped: () => boolean;
}

const isSubject = (thread: NotificationThread) =>
  thread.subjectType === 'PullRequest' || thread.subjectType === 'Issue';

const subjectVersionsOf = (threads: readonly NotificationThread[] = []) =>
  new Map(threads.filter(isSubject).map((thread) => [thread.id, thread.updatedAt]));

const applySubjectLookups = (snapshot: Snapshot, lookups: SubjectLookup[]): Snapshot => {
  const subjectFacts = new Map(snapshot.subjectFacts);

  for (const lookup of lookups) {
    if (lookup.facts === null) {
      subjectFacts.delete(lookup.threadId);
    } else {
      subjectFacts.set(lookup.threadId, lookup.facts);
    }
  }

  return keepSelectionVisible(snapshot, { ...snapshot, subjectFacts });
};

export const createSubjectLookup = (host: SubjectLookupHost): SubjectLookupOwner => {
  let lookupController: AbortController | null = null;
  const lookedUp = new Map<ThreadId, string>();
  const pendingLookups = subjectVersionsOf(host.saved?.threads);
  let startupLookupsPending = pendingLookups.size > 0;

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

    const snapshot = host.getSnapshot();
    const current = new Map(snapshot.threads.map((thread) => [thread.id, thread.updatedAt]));

    const fresh = lookups.filter((lookup) => current.get(lookup.threadId) === lookup.updatedAt);

    for (const lookup of fresh) {
      lookedUp.set(lookup.threadId, lookup.updatedAt);
    }

    host.update(applySubjectLookups(snapshot, fresh));
  };

  const abort = () => {
    lookupController?.abort();
    lookupController = null;
  };

  const start = (threads: NotificationThread[]) => {
    pruneLookedUp(threads);
    pendingLookups.clear();
    startupLookupsPending = false;

    const unknown = threads.filter(
      (thread) => isSubject(thread) && lookedUp.get(thread.id) !== thread.updatedAt,
    );

    abort();

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
      .then(() => host.lookUpSubjects(unknown, own.signal))
      .then((lookups) => {
        if (!own.signal.aborted && !host.isStopped()) {
          acceptLookups(unknown, lookups);
        }
      })
      .catch(() => {
        if (!own.signal.aborted && !host.isStopped()) {
          forgetPending(unknown);
          host.update(host.getSnapshot());
        }
      });
  };

  const releaseStartup = () => {
    if (startupLookupsPending) {
      pendingLookups.clear();
      startupLookupsPending = false;
    }
  };

  const clear = () => {
    abort();
    lookedUp.clear();
    pendingLookups.clear();
  };

  const pendingThreadIdsOf = (threads: readonly NotificationThread[]) =>
    new Set(
      threads
        .filter((thread) => pendingLookups.get(thread.id) === thread.updatedAt)
        .map((thread) => thread.id),
    );

  return { start, releaseStartup, clear, abort, pendingThreadIdsOf };
};
