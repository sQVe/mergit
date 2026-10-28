import type { GitHubFailure, GitHubResult, IssueDetailRequest, Viewer } from '../github/github.ts';
import type {
  DetailSubjectKey,
  IssueComment,
  IssueDetailRead,
  IssueId,
  NotificationThread,
} from '../work/work.ts';
import { readSubjectNumber, toDetailSubjectKey } from '../work/work.ts';
import type { Admission } from './admission.ts';
import type { DetailEntry, DetailSource, DetailState, IssueEntry } from './detailTransitions.ts';
import {
  applyIssuePage,
  emptyIssueEntry,
  evictDetail,
  fitCacheBudget,
  initialDetail,
  isInterrupted,
  keepNewer,
  setCoverage,
  unsupportedEntry,
} from './detailTransitions.ts';
import { guardEffect, requestFailed } from './effectGuard.ts';
import { failureMessage } from './feedTransitions.ts';
import type { Snapshot } from './sessionState.ts';

export interface DetailOwner {
  show: (thread: NotificationThread) => void;
  revalidate: (thread: NotificationThread) => void;
  resume: () => void;
  clear: () => void;
  stop: () => void;
}

export interface DetailHost {
  host: string;
  readIssueDetail: (
    request: IssueDetailRequest,
    signal: AbortSignal,
  ) => Promise<GitHubResult<IssueDetailRead>>;
  lastViewer: () => Viewer | null;
  now: () => Date;
  getSnapshot: () => Snapshot;
  update: (next: Snapshot) => void;
  admission: Admission;
}

interface ShownIssue {
  key: DetailSubjectKey;
  coordinates: IssueDetailRequest['coordinates'];
}

interface Load extends ShownIssue {
  controller: AbortController;
  subjectId: IssueId | null;
}

interface Traversal {
  records: Map<string, IssueComment>;
  requests: number;
  cursor: string | null;
  subjectId: IssueId | null;
}

type IssueRead = Extract<IssueDetailRead, { kind: 'issue' }>;

const maximumProcesses = 2;
const maximumRequests = 8;
const maximumRecords = 500;
const commentsPerPage = 50;
const staleAfterMinutes = 5;
const millisecondsPerMinute = 60_000;
const staleAfterMilliseconds = staleAfterMinutes * millisecondsPerMinute;

const bothSources: ReadonlySet<DetailSource> = new Set(['overview', 'discussion']);
const discussionOnly: ReadonlySet<DetailSource> = new Set(['discussion']);

const partialOrFailed = (hasContent: boolean) => (hasContent ? 'partial' : 'failed');

const partialOrNotRequested = (hasContent: boolean) => (hasContent ? 'partial' : 'notRequested');

const coordinatesOf = (thread: NotificationThread): IssueDetailRequest['coordinates'] | null => {
  const number = readSubjectNumber(thread.subjectUrl);

  if (thread.subjectType !== 'Issue' || number === null) {
    return null;
  }

  const slash = thread.repository.indexOf('/');

  return {
    owner: thread.repository.slice(0, slash),
    name: thread.repository.slice(slash + 1),
    number,
  };
};

const pastFirstPage = (traversal: Traversal): boolean => traversal.cursor !== null;

const reachedLimit = (traversal: Traversal): boolean =>
  traversal.requests >= maximumRequests || traversal.records.size >= maximumRecords;

const loadingEntry = (entry: IssueEntry): IssueEntry =>
  setCoverage(entry, bothSources, () => 'loading', null);

export const createDetail = (host: DetailHost): DetailOwner => {
  const queue: (() => void)[] = [];
  let running = 0;
  let current: Load | null = null;
  let shownIssue: ShownIssue | null = null;

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

  const issueEntryOf = (key: DetailSubjectKey): IssueEntry | null => {
    const entry = detail().entries.get(key);

    return entry?.kind === 'issue' ? entry : null;
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

  const request = async (load: Load, traversal: Traversal) => {
    await takeSlot();

    if (load.controller.signal.aborted) {
      releaseSlot();

      return null;
    }

    if (host.admission.isPaused()) {
      releaseSlot();

      return 'paused';
    }

    const coordinates =
      traversal.subjectId === null ? load.coordinates : { subjectId: traversal.subjectId };

    const issueRequest = {
      coordinates,
      commentsAfter: traversal.cursor,
      pageSize: commentsPerPage,
    };

    try {
      return await guardEffect(
        () => host.readIssueDetail(issueRequest, load.controller.signal),
        requestFailed,
      );
    } finally {
      releaseSlot();
    }
  };

  const clearForMismatch = (entry: IssueEntry, read: IssueDetailRead) => {
    const entries = new Map([[entry.key, emptyIssueEntry(entry.key, entry.threadId)]]);

    publish({ activeKey: entry.key, entries, mismatch: { login: read.viewer.login } });
  };

  const applyFailure = (entry: IssueEntry, failure: GitHubFailure, overviewDone: boolean) => {
    if (failure.kind === 'rateLimited') {
      host.admission.pause(failure.resetAt);
    }

    const sources = overviewDone ? discussionOnly : bothSources;

    const coverageOf =
      failure.kind === 'responseTooLarge' ? () => 'partial' as const : partialOrFailed;

    replaceEntry(setCoverage(entry, sources, coverageOf, failureMessage(failure)));
  };

  const acceptIssue = (entry: IssueEntry, read: IssueRead, traversal: Traversal): boolean => {
    const continuedAnother =
      traversal.subjectId !== null && read.subject.id !== traversal.subjectId;

    if (continuedAnother) {
      const failure = {
        kind: 'invalidResponse',
        message: 'The issue changed while loading',
      } as const;

      applyFailure(entry, failure, pastFirstPage(traversal));

      return false;
    }

    keepNewer(traversal.records, read.comments.records);
    traversal.cursor = read.comments.endCursor;
    traversal.subjectId = read.subject.id;

    const fitted = fitCacheBudget(applyIssuePage(entry, read, traversal.records, host.now()));
    const cannotContinue = traversal.cursor === null || reachedLimit(traversal);
    const pagesLeft = read.comments.hasNextPage && cannotContinue;
    const partial = fitted.trimmed || pagesLeft;

    const next = partial
      ? setCoverage(fitted.entry, discussionOnly, () => 'partial', null)
      : fitted.entry;

    replaceEntry(next);

    return read.comments.hasNextPage && !partial;
  };

  const acceptPage = (
    entry: IssueEntry,
    result: GitHubResult<IssueDetailRead>,
    traversal: Traversal,
  ): boolean => {
    if (!result.ok) {
      applyFailure(entry, result.failure, pastFirstPage(traversal));

      return false;
    }

    const read = result.value;

    if (read.viewer.id !== host.lastViewer()?.id) {
      clearForMismatch(entry, read);

      return false;
    }

    if (detail().mismatch !== null) {
      publish({ ...detail(), mismatch: null });
    }

    if (read.kind !== 'issue') {
      const emptied = { ...emptyIssueEntry(entry.key, entry.threadId), subjectId: entry.subjectId };

      replaceEntry(setCoverage(emptied, bothSources, () => read.kind, null));

      return false;
    }

    return acceptIssue(entry, read, traversal);
  };

  const stopForPause = (entry: IssueEntry, sources: ReadonlySet<DetailSource>) => {
    const { pausedUntil } = host.getSnapshot();

    const message =
      pausedUntil === null ? null : failureMessage({ kind: 'rateLimited', resetAt: pausedUntil });

    replaceEntry(setCoverage(entry, sources, partialOrNotRequested, message));
  };

  const traverse = async (load: Load) => {
    const traversal: Traversal = {
      records: new Map(),
      requests: 0,
      cursor: null,
      subjectId: load.subjectId,
    };

    let goesOn = true;

    while (goesOn) {
      // oxlint-disable-next-line no-await-in-loop -- each page needs the cursor of the page before it
      const result = await request(load, traversal);
      const entry = issueEntryOf(load.key);

      traversal.requests += 1;

      if (result === null || load !== current || entry === null) {
        return;
      }

      if (result === 'paused') {
        stopForPause(entry, pastFirstPage(traversal) ? discussionOnly : bothSources);

        return;
      }

      goesOn = acceptPage(entry, result, traversal);
    }
  };

  const startLoad = ({ key, coordinates }: ShownIssue) => {
    const entry = issueEntryOf(key);

    abortCurrent();

    if (entry === null) {
      return;
    }

    if (host.admission.isPaused()) {
      stopForPause(entry, bothSources);

      return;
    }

    replaceEntry(loadingEntry(entry));

    if (host.lastViewer() === null) {
      return;
    }

    const load: Load = {
      key,
      coordinates,
      controller: new AbortController(),
      subjectId: entry.subjectId,
    };

    current = load;

    traverse(load)
      .finally(() => {
        if (current === load) {
          current = null;
        }
      })
      .catch(() => undefined);
  };

  const needsLoad = (entry: DetailEntry): boolean => {
    if (current?.key === entry.key) {
      return false;
    }

    if (entry.fetchedAt === null || isInterrupted(entry)) {
      return true;
    }

    return host.now().getTime() - entry.fetchedAt.getTime() > staleAfterMilliseconds;
  };

  const activate = (thread: NotificationThread): DetailEntry => {
    const key = toDetailSubjectKey(host.host, thread.id);
    const coordinates = coordinatesOf(thread);

    if (current?.key !== key) {
      abortCurrent();
    }

    shownIssue = coordinates === null ? null : { key, coordinates };

    const existing = detail().entries.get(key);

    const fallback =
      coordinates === null ? unsupportedEntry(key, thread.id) : emptyIssueEntry(key, thread.id);

    const entry = existing ?? fallback;

    showEntry(entry);

    return entry;
  };

  const show = (thread: NotificationThread) => {
    const entry = activate(thread);

    if (shownIssue !== null && needsLoad(entry)) {
      startLoad(shownIssue);
    }
  };

  const revalidate = (thread: NotificationThread) => {
    activate(thread);

    if (shownIssue !== null) {
      startLoad(shownIssue);
    }
  };

  const resume = () => {
    const entry = shownIssue === null ? undefined : detail().entries.get(shownIssue.key);
    const waiting = current === null && entry !== undefined && isInterrupted(entry);

    if (shownIssue !== null && waiting) {
      startLoad(shownIssue);
    }
  };

  const clear = () => {
    abortCurrent();

    const { activeKey, entries } = detail();
    const active = activeKey === null ? undefined : entries.get(activeKey);
    const kept = new Map<DetailSubjectKey, DetailEntry>();

    if (active?.kind === 'issue') {
      kept.set(active.key, loadingEntry(emptyIssueEntry(active.key, active.threadId)));
    } else if (active !== undefined) {
      kept.set(active.key, unsupportedEntry(active.key, active.threadId));
    }

    publish({ activeKey, entries: kept, mismatch: null });
  };

  const stop = () => {
    abortCurrent();
    shownIssue = null;

    if (detail() !== initialDetail) {
      publish(initialDetail);
    }
  };

  return { show, revalidate, resume, clear, stop };
};
