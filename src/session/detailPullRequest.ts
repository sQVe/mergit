import type { GitHubFailure, GitHubResult, PullRequestDetailRequest } from '../github/github.ts';
import type {
  DetailCoverage,
  DetailSubjectKey,
  DetailViewer,
  PullRequestDetailRead,
  PullRequestRef,
  ThreadId,
} from '../work/work.ts';
import { preservePullRequestRows } from './detailPullRequestRecords.ts';
import type {
  DetailEntry,
  PullRequestEntry,
  PullRequestSourceState,
  PullRequestTab,
} from './detailTransitions.ts';

type SourceRead = Exclude<PullRequestDetailRead, { kind: 'unavailable' | 'unsupported' }>;
type RequestResult = GitHubResult<PullRequestDetailRead> | 'paused' | null;

interface PullRequestTraversalHost {
  source: PullRequestTab;
  coordinates: PullRequestDetailRequest['coordinates'];
  request: (request: PullRequestDetailRequest) => Promise<RequestResult>;
  entry: () => PullRequestEntry | null;
  publish: (entry: PullRequestEntry) => void;
  acceptViewer: (viewer: DetailViewer) => boolean;
  pause: (resetAt: Date) => void;
  pausedMessage: () => string | null;
  now: () => Date;
  failureMessage: (failure: GitHubFailure) => string;
}

interface Traversal {
  replacement: PullRequestEntry['sources'] | null;
  first: PullRequestRef | null;
  after: string | null;
  restarted: boolean;
  requests: number;
}

const maximumRequests = 8;
const maximumRecords = 500;
const pageSize = 50;
const staleAfterMinutes = 5;
const millisecondsPerMinute = 60_000;
const staleAfterMilliseconds = staleAfterMinutes * millisecondsPerMinute;

const emptySource = (): PullRequestSourceState => ({
  coverage: 'notRequested',
  message: null,
  fetchedAt: null,
  headOid: null,
  baseOid: null,
});

export const emptyPullRequestEntry = (
  key: DetailSubjectKey,
  threadId: ThreadId,
  host: string,
): PullRequestEntry => ({
  key,
  threadId,
  host,
  kind: 'pullRequest',
  tabs: ['overview', 'commits', 'checks', 'files'],
  tab: 'overview',
  anchors: {},
  fetchedAt: null,
  subjectId: null,
  headOid: null,
  baseOid: null,
  sources: {
    overview: { ...emptySource(), record: null },
    commits: { ...emptySource(), records: [], totalCount: null },
    checks: { ...emptySource(), records: [], totalCount: null, state: null, commitOid: null },
    files: { ...emptySource(), records: [], totalCount: null, totals: null },
  },
});

export const setPullRequestCoverage = (
  entry: PullRequestEntry,
  source: PullRequestTab,
  coverage: DetailCoverage,
  message: string | null,
): PullRequestEntry => ({
  ...entry,
  sources: { ...entry.sources, [source]: { ...entry.sources[source], coverage, message } },
});

export const pullRequestNeedsLoad = (entry: PullRequestEntry, now: Date): boolean => {
  const source = entry.sources[entry.tab];
  const unfinished = ['notRequested', 'failed', 'loading'].includes(source.coverage);
  const changed = source.headOid !== entry.headOid || source.baseOid !== entry.baseOid;

  if (unfinished || changed || source.fetchedAt === null) {
    return true;
  }

  return now.getTime() - source.fetchedAt.getTime() > staleAfterMilliseconds;
};

const rowCount = (entry: PullRequestEntry, source: PullRequestTab): number => {
  const state = entry.sources[source];

  return 'records' in state ? state.records.length : Number(state.record !== null);
};

export const pausePullRequest = (
  entry: PullRequestEntry,
  message: string | null,
): PullRequestEntry => {
  const coverage = rowCount(entry, entry.tab) > 0 ? 'partial' : 'notRequested';

  return setPullRequestCoverage(entry, entry.tab, coverage, message);
};

const resetSource = (entry: PullRequestEntry, source: PullRequestTab): PullRequestEntry => {
  const empty = emptyPullRequestEntry(entry.key, entry.threadId, entry.host);

  return { ...entry, sources: { ...entry.sources, [source]: empty.sources[source] } };
};

const pageOf = (read: SourceRead) => {
  if (read.kind === 'overview') {
    return null;
  }

  if (read.kind === 'commits') {
    return read.commits;
  }

  return read.kind === 'checks' ? (read.rollup?.checks ?? null) : read.files;
};

const checksSource = (
  state: PullRequestSourceState,
  previous: PullRequestEntry['sources']['checks'],
  read: Extract<SourceRead, { kind: 'checks' }>,
): PullRequestEntry['sources']['checks'] => ({
  ...state,
  state: read.rollup?.state ?? null,
  commitOid: read.rollup?.commitOid ?? null,
  totalCount: read.rollup?.checks.totalCount ?? 0,
  records: [...previous.records, ...(read.rollup?.checks.records ?? [])].slice(0, maximumRecords),
});

const applyPage = (entry: PullRequestEntry, read: SourceRead, now: Date): PullRequestEntry => {
  const state = {
    coverage: 'loaded' as const,
    message: null,
    fetchedAt: now,
    headOid: read.pullRequest.headOid,
    baseOid: read.pullRequest.baseOid,
  };

  const sources = { ...entry.sources };

  switch (read.kind) {
    case 'overview':
      sources.overview = { ...state, record: read.overview };

      break;
    case 'commits':
      sources.commits = {
        ...state,
        totalCount: read.commits.totalCount,
        records: [...sources.commits.records, ...read.commits.records].slice(0, maximumRecords),
      };

      break;
    case 'checks':
      sources.checks = checksSource(state, sources.checks, read);

      break;
    case 'files':
      sources.files = {
        ...state,
        totals: read.totals,
        totalCount: read.files?.totalCount ?? null,
        records: [...sources.files.records, ...(read.files?.records ?? [])].slice(
          0,
          maximumRecords,
        ),
      };

      break;
  }

  return {
    ...entry,
    sources,
    fetchedAt: now,
    subjectId: read.pullRequest.id,
    headOid: read.pullRequest.headOid,
    baseOid: read.pullRequest.baseOid,
  };
};

const sameRevision = (first: PullRequestRef, next: PullRequestRef): boolean =>
  first.id === next.id && first.headOid === next.headOid && first.baseOid === next.baseOid;

const applyFailure = (
  host: PullRequestTraversalHost,
  entry: PullRequestEntry,
  result: Exclude<RequestResult, null>,
): SourceRead | null => {
  if (result === 'paused') {
    host.publish(pausePullRequest(entry, host.pausedMessage()));

    return null;
  }

  if (!result.ok) {
    const { failure } = result;

    if (failure.kind === 'rateLimited') {
      host.pause(failure.resetAt);
    }

    const partial = failure.kind === 'responseTooLarge' || rowCount(entry, host.source) > 0;
    const coverage = partial ? 'partial' : 'failed';

    host.publish(
      setPullRequestCoverage(entry, host.source, coverage, host.failureMessage(failure)),
    );

    return null;
  }

  const read = result.value;

  if (!host.acceptViewer(read.viewer)) {
    return null;
  }

  if (read.kind === 'unavailable' || read.kind === 'unsupported') {
    host.publish(
      setPullRequestCoverage(resetSource(entry, host.source), host.source, read.kind, null),
    );

    return null;
  }

  if (read.kind !== host.source) {
    host.publish(
      setPullRequestCoverage(entry, host.source, 'failed', 'Unexpected pull request source'),
    );

    return null;
  }

  return read;
};

const restartTraversal = (
  host: PullRequestTraversalHost,
  entry: PullRequestEntry,
  reference: PullRequestRef,
  traversal: Traversal,
): boolean => {
  const cleared = resetSource(entry, host.source);
  const { headOid, baseOid } = reference;

  const changed = {
    ...cleared,
    subjectId: reference.id,
    headOid,
    baseOid,
    sources: {
      ...cleared.sources,
      [host.source]: { ...cleared.sources[host.source], headOid, baseOid },
    },
  };

  const cannotRestart = traversal.restarted || traversal.requests === maximumRequests;
  const coverage = cannotRestart ? 'partial' : 'loading';
  const message = cannotRestart ? 'The pull request changed while loading' : null;

  host.publish(setPullRequestCoverage(changed, host.source, coverage, message));
  traversal.replacement = null;
  traversal.first = null;
  traversal.after = null;
  traversal.restarted = true;

  return !cannotRestart;
};

const reachedPageLimit = (
  page: ReturnType<typeof pageOf>,
  rows: number,
  requests: number,
): boolean => {
  const missingCursor = page?.endCursor === null;

  return requests === maximumRequests || rows >= maximumRecords || missingCursor;
};

const pageCoverage = (read: SourceRead, previousRows: number, requests: number): DetailCoverage => {
  const page = pageOf(read);
  const rows = previousRows + (page?.records.length ?? 0);
  const cannotContinue = reachedPageLimit(page, rows, requests);
  const incompleteFiles = read.kind === 'files' && read.files === null;
  const pagesLeft = page?.hasNextPage === true && cannotContinue;

  if (incompleteFiles || rows > maximumRecords || pagesLeft) {
    return 'partial';
  }

  return page?.hasNextPage === true ? 'loading' : 'loaded';
};

const acceptRead = (
  host: PullRequestTraversalHost,
  entry: PullRequestEntry,
  read: SourceRead,
  traversal: Traversal,
): boolean => {
  if (traversal.first !== null && !sameRevision(traversal.first, read.pullRequest)) {
    return restartTraversal(host, entry, read.pullRequest, traversal);
  }

  const previous =
    traversal.replacement === null
      ? resetSource(entry, host.source)
      : {
          ...entry,
          sources: { ...entry.sources, [host.source]: traversal.replacement[host.source] },
        };

  const next = applyPage(previous, read, host.now());
  const previousRows = rowCount(previous, host.source);
  const coverage = pageCoverage(read, previousRows, traversal.requests);

  const published =
    coverage === 'loaded'
      ? next
      : preservePullRequestRows(next, entry, host.source, maximumRecords);

  traversal.replacement = next.sources;
  host.publish(setPullRequestCoverage(published, host.source, coverage, null));
  traversal.first = read.pullRequest;
  traversal.after = pageOf(read)?.endCursor ?? null;

  return coverage === 'loading';
};

export const traversePullRequest = async (host: PullRequestTraversalHost): Promise<void> => {
  const traversal: Traversal = {
    replacement: null,
    first: null,
    after: null,
    restarted: false,
    requests: 0,
  };

  while (traversal.requests < maximumRequests) {
    const { first, after } = traversal;
    const coordinates = first === null ? host.coordinates : { subjectId: first.id };
    const request = { coordinates, source: host.source, after, pageSize };
    // oxlint-disable-next-line no-await-in-loop -- each page needs the cursor of the page before it
    const result = await host.request(request);
    const entry = host.entry();

    traversal.requests += 1;

    if (result === null || entry === null) {
      return;
    }

    const read = applyFailure(host, entry, result);

    if (read === null || !acceptRead(host, entry, read, traversal)) {
      return;
    }
  }
};

export const pullRequestEntryOf = (entry: DetailEntry | undefined): PullRequestEntry | null =>
  entry?.kind === 'pullRequest' ? entry : null;
