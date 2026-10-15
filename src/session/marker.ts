import type { NotificationThread, SubjectFacts, ThreadId, ViewerLogin } from '../work/work.ts';
import { selectedThreadOf } from './selectionMoves.ts';
import type { Snapshot } from './sessionState.ts';
import { keepSelectionVisible } from './sessionState.ts';

interface NewThreadInput {
  threads: NotificationThread[];
  seen: ReadonlyMap<ThreadId, string> | undefined;
  subjectFacts: ReadonlyMap<ThreadId, SubjectFacts>;
  viewerLogin: string;
  pendingThreadIds: ReadonlySet<ThreadId>;
}

export interface MarkerInputs {
  host: string;
  seen: Map<string, Map<ThreadId, string>>;
  currentLogin: () => ViewerLogin | null;
  pendingThreadIdsOf: (threads: readonly NotificationThread[]) => ReadonlySet<ThreadId>;
  getSnapshot: () => Snapshot;
  save: (grouping?: Snapshot['grouping']) => void;
}

export interface MarkerOwner {
  records: Map<string, Map<ThreadId, string>>;
  apply: (candidate: Snapshot) => Snapshot;
  applyLeaving: (candidate: Snapshot) => Snapshot;
  recordSelected: (candidate: Snapshot) => void;
  prune: (fetched: NotificationThread[]) => void;
}

const isViewerActor = (facts: SubjectFacts | undefined, viewerLogin: string): boolean =>
  facts?.latestActor?.toLowerCase() === viewerLogin.toLowerCase();

const newThreadIdsOf = (input: NewThreadInput): ReadonlySet<ThreadId> => {
  const { seen, subjectFacts, viewerLogin, pendingThreadIds } = input;
  const newIds = new Set<ThreadId>();

  if (seen === undefined) {
    return newIds;
  }

  for (const thread of input.threads) {
    const seenAt = seen.get(thread.id);

    const changed = seenAt === undefined || Date.parse(thread.updatedAt) > Date.parse(seenAt);

    const ownActivity = isViewerActor(subjectFacts.get(thread.id), viewerLogin);

    if (changed && !ownActivity && !pendingThreadIds.has(thread.id)) {
      newIds.add(thread.id);
    }
  }

  return newIds;
};

export const createMarker = (inputs: MarkerInputs): MarkerOwner => {
  const currentSeen = (): Map<ThreadId, string> | undefined => {
    const login = inputs.currentLogin();

    return login === null ? undefined : inputs.seen.get(`${inputs.host}/${login}`);
  };

  const recordSeen = (candidate: Snapshot, left: NotificationThread | undefined): boolean => {
    const seen = currentSeen();
    const login = inputs.currentLogin();

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
    const previous = selectedThreadOf(inputs.getSnapshot());

    return previous?.id === selectedThreadOf(candidate)?.id ? undefined : previous;
  };

  const withMarkers = (candidate: Snapshot, left?: NotificationThread): Snapshot => {
    if (recordSeen(candidate, left)) {
      inputs.save(candidate.grouping);
    }

    const pendingThreadIds = inputs.pendingThreadIdsOf(candidate.threads);

    const newThreadIds = newThreadIdsOf({
      threads: candidate.threads,
      seen: currentSeen(),
      subjectFacts: candidate.subjectFacts,
      viewerLogin: inputs.currentLogin() ?? '',
      pendingThreadIds,
    });

    const sameNewIds =
      newThreadIds.size === candidate.newThreadIds.size &&
      [...newThreadIds].every((threadId) => candidate.newThreadIds.has(threadId));

    if (sameNewIds && candidate.viewerLogin === inputs.currentLogin()) {
      return candidate;
    }

    return keepSelectionVisible(candidate, {
      ...candidate,
      newThreadIds,
      viewerLogin: inputs.currentLogin(),
    });
  };

  const apply = (candidate: Snapshot) => withMarkers(candidate);

  const applyLeaving = (candidate: Snapshot) => withMarkers(candidate, threadLeftBy(candidate));

  const recordSelected = (candidate: Snapshot) => {
    if (recordSeen(candidate, selectedThreadOf(candidate))) {
      inputs.save();
    }
  };

  const prune = (fetched: NotificationThread[]) => {
    const login = inputs.currentLogin();

    if (login === null) {
      return;
    }

    const account = `${inputs.host}/${login}`;
    const seen = inputs.seen.get(account);

    if (seen === undefined) {
      inputs.seen.set(account, new Map(fetched.map((thread) => [thread.id, thread.updatedAt])));

      inputs.save();

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
      inputs.save();
    }
  };

  return { records: inputs.seen, apply, applyLeaving, recordSelected, prune };
};
