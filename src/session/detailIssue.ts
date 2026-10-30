import type { GitHubFailure, GitHubResult, IssueDetailRequest } from '../github/github.ts';
import type { DetailViewer, IssueComment, IssueDetailRead, IssueId } from '../work/work.ts';
import type { DetailEntry, DetailSource, IssueEntry } from './detailTransitions.ts';
import {
  applyIssuePage,
  emptyIssueEntry,
  fitCacheBudget,
  keepNewer,
  setCoverage,
} from './detailTransitions.ts';
import { failureMessage } from './feedTransitions.ts';

interface IssueTraversalHost {
  coordinates: IssueDetailRequest['coordinates'];
  request: (
    request: IssueDetailRequest,
  ) => Promise<GitHubResult<IssueDetailRead> | 'paused' | null>;
  entry: () => IssueEntry | null;
  publish: (entry: IssueEntry) => void;
  acceptViewer: (entry: IssueEntry, viewer: DetailViewer) => boolean;
  pause: (resetAt: Date) => void;
  pausedMessage: () => string | null;
  now: () => Date;
}

interface Traversal {
  records: Map<string, IssueComment>;
  requests: number;
  cursor: string | null;
  subjectId: IssueId | null;
}

type IssueRead = Extract<IssueDetailRead, { kind: 'issue' }>;

const maximumRequests = 8;
const maximumRecords = 500;
const commentsPerPage = 50;

const bothSources: ReadonlySet<DetailSource> = new Set(['overview', 'discussion']);
const discussionOnly: ReadonlySet<DetailSource> = new Set(['discussion']);

const partialOrFailed = (hasContent: boolean) => (hasContent ? 'partial' : 'failed');

const pastFirstPage = (traversal: Traversal): boolean => traversal.cursor !== null;

const reachedLimit = (traversal: Traversal): boolean =>
  traversal.requests >= maximumRequests || traversal.records.size >= maximumRecords;

export const loadingIssueEntry = (entry: IssueEntry): IssueEntry =>
  setCoverage(entry, bothSources, () => 'loading', null);

export const pauseIssueEntry = (
  entry: IssueEntry,
  overviewDone: boolean,
  message: string | null,
): IssueEntry => {
  const sources = overviewDone ? discussionOnly : bothSources;

  return setCoverage(
    entry,
    sources,
    (hasContent) => (hasContent ? 'partial' : 'notRequested'),
    message,
  );
};

const applyFailure = (
  host: IssueTraversalHost,
  entry: IssueEntry,
  failure: GitHubFailure,
  overviewDone: boolean,
) => {
  if (failure.kind === 'rateLimited') {
    host.pause(failure.resetAt);
  }

  const sources = overviewDone ? discussionOnly : bothSources;

  const coverageOf =
    failure.kind === 'responseTooLarge' ? () => 'partial' as const : partialOrFailed;

  host.publish(setCoverage(entry, sources, coverageOf, failureMessage(failure)));
};

const acceptIssue = (
  host: IssueTraversalHost,
  entry: IssueEntry,
  read: IssueRead,
  traversal: Traversal,
): boolean => {
  const continuedAnother = traversal.subjectId !== null && read.subject.id !== traversal.subjectId;

  if (continuedAnother) {
    const failure = {
      kind: 'invalidResponse',
      message: 'The issue changed while loading',
    } as const;

    applyFailure(host, entry, failure, pastFirstPage(traversal));

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

  host.publish(next);

  return read.comments.hasNextPage && !partial;
};

const acceptPage = (
  host: IssueTraversalHost,
  entry: IssueEntry,
  result: GitHubResult<IssueDetailRead>,
  traversal: Traversal,
): boolean => {
  if (!result.ok) {
    applyFailure(host, entry, result.failure, pastFirstPage(traversal));

    return false;
  }

  const read = result.value;

  if (!host.acceptViewer(entry, read.viewer)) {
    return false;
  }

  if (read.kind !== 'issue') {
    const emptied = { ...emptyIssueEntry(entry.key, entry.threadId), subjectId: entry.subjectId };

    host.publish(setCoverage(emptied, bothSources, () => read.kind, null));

    return false;
  }

  return acceptIssue(host, entry, read, traversal);
};

export const traverseIssue = async (host: IssueTraversalHost): Promise<void> => {
  const subjectId = 'subjectId' in host.coordinates ? host.coordinates.subjectId : null;
  const traversal: Traversal = { records: new Map(), requests: 0, cursor: null, subjectId };
  let goesOn = true;

  while (goesOn) {
    const coordinates =
      traversal.subjectId === null ? host.coordinates : { subjectId: traversal.subjectId };

    const request = { coordinates, commentsAfter: traversal.cursor, pageSize: commentsPerPage };
    // oxlint-disable-next-line no-await-in-loop -- each page needs the cursor of the page before it
    const result = await host.request(request);
    const entry = host.entry();

    traversal.requests += 1;

    if (result === null || entry === null) {
      return;
    }

    if (result === 'paused') {
      host.publish(pauseIssueEntry(entry, pastFirstPage(traversal), host.pausedMessage()));

      return;
    }

    goesOn = acceptPage(host, entry, result, traversal);
  }
};

export const issueEntryOf = (entry: DetailEntry | undefined): IssueEntry | null =>
  entry?.kind === 'issue' ? entry : null;
