import type {
  GitHubResult,
  IssueDetailRequest,
  PullRequestDetailRequest,
  Viewer,
} from '../github/github.ts';
import type {
  DetailSubjectKey,
  DetailViewer,
  PullRequestDetailRead,
  IssueDetailRead,
  NotificationThread,
} from '../work/work.ts';
import { toDetailSubjectKey } from '../work/work.ts';
import type { Admission } from './admission.ts';
import { issueEntryOf, loadingIssueEntry, pauseIssueEntry, traverseIssue } from './detailIssue.ts';
import {
  pausePullRequest,
  pullRequestEntryOf,
  setPullRequestCoverage,
  traversePullRequest,
} from './detailPullRequest.ts';
import type { DetailEntry, DetailState, PullRequestTab } from './detailTransitions.ts';
import {
  clearedDetail,
  detailNeedsLoad,
  emptyDetailEntry,
  newDetailEntry,
  detailCoordinatesOf,
  evictDetail,
  initialDetail,
} from './detailTransitions.ts';
import { guardEffect, requestFailed } from './effectGuard.ts';
import { failureMessage } from './feedTransitions.ts';
import type { Snapshot } from './sessionState.ts';

export interface DetailOwner {
  show: (thread: NotificationThread) => void;
  revalidate: (thread: NotificationThread) => void;
  resume: () => void;
  visitTab: () => void;
  hide: () => void;
  clear: () => void;
  stop: () => void;
}

export interface DetailHost {
  host: string;
  readIssueDetail: (
    request: IssueDetailRequest,
    signal: AbortSignal,
  ) => Promise<GitHubResult<IssueDetailRead>>;
  readPullRequestDetail: (
    request: PullRequestDetailRequest,
    signal: AbortSignal,
  ) => Promise<GitHubResult<PullRequestDetailRead>>;
  lastViewer: () => Viewer | null;
  now: () => Date;
  getSnapshot: () => Snapshot;
  update: (next: Snapshot) => void;
  admission: Admission;
}

interface ShownSubject {
  key: DetailSubjectKey;
  coordinates: NonNullable<ReturnType<typeof detailCoordinatesOf>>;
}

interface Load {
  key: DetailSubjectKey;
  controller: AbortController;
  source: 'issue' | PullRequestTab;
}

const maximumProcesses = 2;

export const createDetail = (host: DetailHost): DetailOwner => {
  const queue: (() => void)[] = [];
  let running = 0;
  let current: Load | null = null;
  let shownSubject: ShownSubject | null = null;

  const detail = () => host.getSnapshot().detail;

  const publish = (next: DetailState) => {
    host.update({ ...host.getSnapshot(), detail: evictDetail(next) });
  };

  const showEntry = (entry: DetailEntry) => {
    const state = detail();

    const entries = new Map(state.entries);

    entries.delete(entry.key);
    entries.set(entry.key, entry);
    publish({ ...state, activeKey: entry.key, entries });
  };

  const replaceEntry = (entry: DetailEntry) => {
    const state = detail();

    publish({ ...state, entries: new Map(state.entries).set(entry.key, entry) });
  };

  const abortCurrent = () => {
    current?.controller.abort();
    current = null;
  };

  const takeSlot = (): Promise<void> => {
    if (running < maximumProcesses) {
      running += 1;

      return Promise.resolve();
    }

    return new Promise((resolve) => {
      queue.push(resolve);
    });
  };

  const releaseSlot = () => {
    const next = queue.shift();

    if (next === undefined) {
      running -= 1;
    } else {
      next();
    }
  };

  const request = async <Read>(load: Load, effect: () => Promise<GitHubResult<Read>>) => {
    await takeSlot();

    if (load.controller.signal.aborted) {
      releaseSlot();

      return null;
    }

    if (host.admission.isPaused()) {
      releaseSlot();

      return 'paused';
    }

    try {
      return await guardEffect(effect, requestFailed);
    } finally {
      releaseSlot();
    }
  };

  const acceptViewer = (entry: DetailEntry, viewer: DetailViewer): boolean => {
    if (viewer.id === host.lastViewer()?.id) {
      if (detail().mismatch !== null) {
        publish({ ...detail(), mismatch: null });
      }

      return true;
    }

    const empty = emptyDetailEntry(entry);
    const entries = new Map([[entry.key, empty]]);

    publish({ activeKey: entry.key, entries, mismatch: { login: viewer.login } });

    return false;
  };

  const pausedMessage = () => {
    const { pausedUntil } = host.getSnapshot();

    return pausedUntil === null
      ? null
      : failureMessage({ kind: 'rateLimited', resetAt: pausedUntil });
  };

  const traverse = (
    entry: Exclude<DetailEntry, { kind: 'unsupported' }>,
    load: Load,
    coordinates: ShownSubject['coordinates'],
  ): Promise<void> => {
    const { key } = load;

    if (entry.kind === 'issue') {
      return traverseIssue({
        coordinates: entry.subjectId === null ? coordinates : { subjectId: entry.subjectId },
        request: (query) =>
          request(load, () => host.readIssueDetail(query, load.controller.signal)),
        entry: () => (load === current ? issueEntryOf(detail().entries.get(key)) : null),
        publish: replaceEntry,
        acceptViewer,
        pause: host.admission.pause,
        pausedMessage,
        now: host.now,
      });
    }

    return traversePullRequest({
      source: entry.tab,
      coordinates: entry.subjectId === null ? coordinates : { subjectId: entry.subjectId },
      request: (query) =>
        request(load, () => host.readPullRequestDetail(query, load.controller.signal)),
      entry: () => (load === current ? pullRequestEntryOf(detail().entries.get(key)) : null),
      publish: replaceEntry,
      acceptViewer: (viewer) => acceptViewer(entry, viewer),
      pause: host.admission.pause,
      pausedMessage,
      now: host.now,
      failureMessage,
    });
  };

  const startLoad = ({ key, coordinates }: ShownSubject) => {
    const entry = detail().entries.get(key);

    abortCurrent();

    if (entry === undefined || entry.kind === 'unsupported') {
      return;
    }

    if (host.admission.isPaused()) {
      const message = pausedMessage();

      const paused =
        entry.kind === 'issue'
          ? pauseIssueEntry(entry, false, message)
          : pausePullRequest(entry, message);

      replaceEntry(paused);

      return;
    }

    const loading =
      entry.kind === 'issue'
        ? loadingIssueEntry(entry)
        : setPullRequestCoverage(entry, entry.tab, 'loading', null);

    replaceEntry(loading);

    if (host.lastViewer() === null) {
      return;
    }

    const load: Load = {
      key,
      controller: new AbortController(),
      source: entry.kind === 'pullRequest' ? entry.tab : 'issue',
    };

    current = load;

    traverse(entry, load, coordinates)
      .finally(() => {
        if (current === load) {
          current = null;
        }
      })
      .catch(() => undefined);
  };

  const needsLoad = (entry: DetailEntry): boolean => {
    if (
      current?.key === entry.key &&
      current.source === (entry.kind === 'pullRequest' ? entry.tab : 'issue')
    ) {
      return false;
    }

    return detailNeedsLoad(entry, host.now());
  };

  const activate = (thread: NotificationThread): DetailEntry => {
    const key = toDetailSubjectKey(host.host, thread.id);
    const coordinates = detailCoordinatesOf(thread);

    if (current?.key !== key) {
      abortCurrent();
    }

    shownSubject = coordinates === null ? null : { key, coordinates };

    const existing = detail().entries.get(key);

    const entry = existing ?? newDetailEntry(thread, host.host);

    showEntry(entry);

    return entry;
  };

  const show = (thread: NotificationThread) => {
    const entry = activate(thread);

    if (shownSubject !== null && needsLoad(entry)) {
      startLoad(shownSubject);
    }
  };

  const revalidate = (thread: NotificationThread) => {
    activate(thread);

    if (shownSubject !== null) {
      startLoad(shownSubject);
    }
  };

  const feedHasThread = (key: DetailSubjectKey): boolean =>
    host.getSnapshot().threads.some((thread) => toDetailSubjectKey(host.host, thread.id) === key);

  const resume = () => {
    const entry = shownSubject === null ? undefined : detail().entries.get(shownSubject.key);
    const waiting = current === null && entry !== undefined && needsLoad(entry);

    if (shownSubject === null || !waiting) {
      return;
    }

    if (feedHasThread(shownSubject.key)) {
      startLoad(shownSubject);
    } else {
      shownSubject = null;
    }
  };

  const clear = () => {
    abortCurrent();

    publish(clearedDetail(detail()));
  };

  const hide = () => {
    abortCurrent();
    shownSubject = null;
  };

  const stop = () => {
    hide();

    if (detail() !== initialDetail) {
      publish(initialDetail);
    }
  };

  const visitTab = () => {
    const entry = shownSubject === null ? undefined : detail().entries.get(shownSubject.key);

    if (entry?.kind !== 'pullRequest' || shownSubject === null) {
      return;
    }

    if (current?.source !== entry.tab) {
      abortCurrent();
    }

    if (needsLoad(entry)) {
      startLoad(shownSubject);
    }
  };

  return { show, revalidate, resume, clear, stop, visitTab, hide };
};
