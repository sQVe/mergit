import type {
  DetailCoverage,
  DetailSubjectKey,
  IssueComment,
  IssueDetailRead,
  IssueId,
  IssueOverview,
  NotificationThread,
  PullRequestCheck,
  PullRequestCommit,
  PullRequestDetailRead,
  PullRequestFile,
  PullRequestOverview,
  PullRequestRef,
  ThreadId,
  ViewerLogin,
} from '../work/work.ts';
import { readSubjectNumber, toDetailSubjectKey } from '../work/work.ts';
import { emptyPullRequestEntry, pullRequestNeedsLoad } from './detailPullRequest.ts';
import type { Snapshot } from './sessionState.ts';

type IssueTab = 'overview' | 'discussion';
export type PullRequestTab = 'overview' | 'commits' | 'checks' | 'files';
export type DetailTab = IssueTab | PullRequestTab;

export type DetailPosition =
  | { kind: 'separator' }
  | { kind: 'heading' }
  | { kind: 'text'; offset: number };

export interface DetailAnchor {
  recordId: string;
  digest: string;
  position: DetailPosition;
  earlierRecordIds: readonly string[];
}

interface SourceState {
  coverage: DetailCoverage;
  message: string | null;
}

interface OverviewSource extends SourceState {
  record: IssueOverview | null;
}

interface DiscussionSource extends SourceState {
  records: IssueComment[];
  totalCount: number | null;
}

interface IssueSources {
  overview: OverviewSource;
  discussion: DiscussionSource;
}

export type DetailSource = keyof IssueSources;

interface EntryBase {
  key: DetailSubjectKey;
  threadId: ThreadId;
  tabs: readonly DetailTab[];
  tab: DetailTab;
  anchors: Partial<Record<DetailTab, DetailAnchor>>;
  fetchedAt: Date | null;
}

export interface IssueEntry extends EntryBase {
  kind: 'issue';
  tab: IssueTab;
  tabs: readonly IssueTab[];
  subjectId: IssueId | null;
  sources: IssueSources;
}

export interface PullRequestSourceState extends SourceState {
  fetchedAt: Date | null;
  headOid: string | null;
  baseOid: string | null;
}

interface PullRequestRows<Record> extends PullRequestSourceState {
  records: Record[];
  totalCount: number | null;
}

export interface PullRequestEntry extends EntryBase {
  kind: 'pullRequest';
  host: string;
  tab: PullRequestTab;
  tabs: readonly PullRequestTab[];
  subjectId: PullRequestRef['id'] | null;
  headOid: string | null;
  baseOid: string | null;
  sources: {
    overview: PullRequestSourceState & { record: PullRequestOverview | null };
    commits: PullRequestRows<PullRequestCommit>;
    checks: PullRequestRows<PullRequestCheck> & { state: string | null; commitOid: string | null };
    files: PullRequestRows<PullRequestFile> & {
      totals: Extract<PullRequestDetailRead, { kind: 'files' }>['totals'] | null;
    };
  };
}

interface UnsupportedEntry extends EntryBase {
  kind: 'unsupported';
  coverage: 'unsupported';
}

export type DetailEntry = IssueEntry | PullRequestEntry | UnsupportedEntry;

export interface DetailState {
  activeKey: DetailSubjectKey | null;
  entries: ReadonlyMap<DetailSubjectKey, DetailEntry>;
  mismatch: { login: ViewerLogin } | null;
}

export const detailCoordinatesOf = (
  thread: NotificationThread,
): {
  owner: string;
  name: string;
  number: number;
} | null => {
  const number = readSubjectNumber(thread.subjectUrl);
  const supported = thread.subjectType === 'Issue' || thread.subjectType === 'PullRequest';

  if (!supported || number === null) {
    return null;
  }

  const slash = thread.repository.indexOf('/');

  return {
    owner: thread.repository.slice(0, slash),
    name: thread.repository.slice(slash + 1),
    number,
  };
};

export const initialDetail: DetailState = { activeKey: null, entries: new Map(), mismatch: null };

const maximumCachedSubjects = 20;
const bytesPerKibibyte = 1024;
const maximumCachedMebibytes = 32;
const maximumCachedBytes = maximumCachedMebibytes * bytesPerKibibyte * bytesPerKibibyte;

const textEncoder = new TextEncoder();

const recordBytes = new WeakMap<object, number>();

const bodyBytesOf = (record: { body: string }): number => {
  const known = recordBytes.get(record);

  if (known !== undefined) {
    return known;
  }

  const bytes = textEncoder.encode(record.body).byteLength;

  recordBytes.set(record, bytes);

  return bytes;
};

const issueTabs: readonly IssueTab[] = ['overview', 'discussion'];

export const emptyIssueEntry = (key: DetailSubjectKey, threadId: ThreadId): IssueEntry => ({
  key,
  threadId,
  kind: 'issue',
  tabs: issueTabs,
  tab: 'overview',
  anchors: {},
  fetchedAt: null,
  subjectId: null,
  sources: {
    overview: { coverage: 'notRequested', message: null, record: null },
    discussion: { coverage: 'notRequested', message: null, records: [], totalCount: null },
  },
});

const unsupportedEntry = (key: DetailSubjectKey, threadId: ThreadId): DetailEntry => ({
  key,
  threadId,
  kind: 'unsupported',
  coverage: 'unsupported',
  tabs: ['overview'],
  tab: 'overview',
  anchors: {},
  fetchedAt: null,
});

export const emptyDetailEntry = (entry: DetailEntry): DetailEntry => {
  if (entry.kind === 'pullRequest') {
    return emptyPullRequestEntry(entry.key, entry.threadId, entry.host);
  }

  return entry.kind === 'issue'
    ? emptyIssueEntry(entry.key, entry.threadId)
    : unsupportedEntry(entry.key, entry.threadId);
};

export const newDetailEntry = (thread: NotificationThread, host: string): DetailEntry => {
  const key = toDetailSubjectKey(host, thread.id);

  if (detailCoordinatesOf(thread) === null) {
    return unsupportedEntry(key, thread.id);
  }

  return thread.subjectType === 'PullRequest'
    ? emptyPullRequestEntry(key, thread.id, host)
    : emptyIssueEntry(key, thread.id);
};

const hasContent = (entry: IssueEntry, source: DetailSource): boolean =>
  source === 'overview'
    ? entry.sources.overview.record !== null
    : entry.sources.discussion.records.length > 0;

const isLoading = (entry: IssueEntry): boolean =>
  entry.sources.overview.coverage === 'loading' || entry.sources.discussion.coverage === 'loading';

const isInterrupted = (entry: DetailEntry): boolean => {
  if (entry.kind === 'pullRequest') {
    const { coverage } = entry.sources[entry.tab];

    return coverage === 'loading' || coverage === 'notRequested';
  }

  return entry.kind === 'issue' && isLoading(entry);
};

export const setCoverage = (
  entry: IssueEntry,
  sources: ReadonlySet<DetailSource>,
  coverageOf: (hasContent: boolean) => DetailCoverage,
  message: string | null,
): IssueEntry => {
  const stateOf = (source: DetailSource): SourceState =>
    sources.has(source)
      ? { coverage: coverageOf(hasContent(entry, source)), message }
      : entry.sources[source];

  return {
    ...entry,
    sources: {
      overview: { ...entry.sources.overview, ...stateOf('overview') },
      discussion: { ...entry.sources.discussion, ...stateOf('discussion') },
    },
  };
};

export const clearedDetail = (detail: DetailState): DetailState => {
  const active = detail.activeKey === null ? undefined : detail.entries.get(detail.activeKey);
  const entries = new Map<DetailSubjectKey, DetailEntry>();

  if (active !== undefined) {
    const empty = emptyDetailEntry(active);

    const reset =
      empty.kind === 'issue'
        ? setCoverage(empty, new Set(['overview', 'discussion']), () => 'loading', null)
        : empty;

    entries.set(active.key, reset);
  }

  return { activeKey: detail.activeKey, entries, mismatch: null };
};

export const detailNeedsLoad = (entry: DetailEntry, now: Date): boolean => {
  if (entry.kind === 'pullRequest') {
    return pullRequestNeedsLoad(entry, now);
  }

  if (entry.fetchedAt === null || isInterrupted(entry)) {
    return true;
  }

  const staleAfterMinutes = 5;
  const millisecondsPerMinute = 60_000;
  const staleAfterMilliseconds = staleAfterMinutes * millisecondsPerMinute;

  return now.getTime() - entry.fetchedAt.getTime() > staleAfterMilliseconds;
};

const isNewer = (candidate: { updatedAt: string }, current: { updatedAt: string }): boolean =>
  Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt);

export const keepNewer = (
  records: Map<string, IssueComment>,
  incoming: readonly IssueComment[],
): void => {
  for (const record of incoming) {
    const current = records.get(record.id);

    if (current === undefined || isNewer(record, current)) {
      records.set(record.id, record);
    }
  }
};

const discussionRecordsOf = (
  previous: readonly IssueComment[],
  traversal: ReadonlyMap<string, IssueComment>,
  complete: boolean,
): IssueComment[] => {
  const merged = new Map(traversal);

  keepNewer(
    merged,
    previous.filter((record) => traversal.has(record.id)),
  );

  const kept = complete ? [] : previous.filter((record) => !traversal.has(record.id));

  return [...merged.values(), ...kept];
};

export const applyIssuePage = (
  entry: IssueEntry,
  read: Extract<IssueDetailRead, { kind: 'issue' }>,
  traversal: ReadonlyMap<string, IssueComment>,
  fetchedAt: Date,
): IssueEntry => {
  const complete = !read.comments.hasNextPage;
  const records = discussionRecordsOf(entry.sources.discussion.records, traversal, complete);
  const current = entry.sources.overview.record;
  const keepsCurrent = current !== null && isNewer(current, read.overview);

  return {
    ...entry,
    subjectId: read.subject.id,
    fetchedAt,
    sources: {
      overview: {
        coverage: 'loaded',
        message: null,
        record: keepsCurrent ? current : read.overview,
      },
      discussion: {
        coverage: complete ? 'loaded' : 'loading',
        message: null,
        records,
        totalCount: read.comments.totalCount,
      },
    },
  };
};

const anchorBytesOf = (entry: DetailEntry): number =>
  Object.values(entry.anchors).reduce(
    (total, anchor) => total + textEncoder.encode(JSON.stringify(anchor)).byteLength,
    0,
  );

const entryBytesOf = (entry: DetailEntry): number => {
  if (entry.kind === 'pullRequest') {
    return textEncoder.encode(JSON.stringify(entry)).byteLength;
  }

  if (entry.kind !== 'issue') {
    return anchorBytesOf(entry);
  }

  const { overview, discussion } = entry.sources;

  const records =
    overview.record === null ? discussion.records : [overview.record, ...discussion.records];

  return records.reduce((total, record) => total + bodyBytesOf(record), anchorBytesOf(entry));
};

export const fitCacheBudget = (entry: IssueEntry): { entry: IssueEntry; trimmed: boolean } => {
  const { overview, discussion } = entry.sources;
  const overviewBytes = overview.record === null ? 0 : bodyBytesOf(overview.record);
  const kept: IssueComment[] = [];
  let bytes = anchorBytesOf(entry) + overviewBytes;

  for (const record of discussion.records) {
    bytes += bodyBytesOf(record);

    if (bytes > maximumCachedBytes) {
      break;
    }

    kept.push(record);
  }

  if (kept.length === discussion.records.length) {
    return { entry, trimmed: false };
  }

  const sources = { ...entry.sources, discussion: { ...discussion, records: kept } };

  return { entry: { ...entry, sources }, trimmed: true };
};

const totalBytesOf = (entries: ReadonlyMap<DetailSubjectKey, DetailEntry>): number =>
  [...entries.values()].reduce((total, entry) => total + entryBytesOf(entry), 0);

const isOverLimits = (entries: ReadonlyMap<DetailSubjectKey, DetailEntry>): boolean =>
  entries.size > maximumCachedSubjects || totalBytesOf(entries) > maximumCachedBytes;

export const evictDetail = (detail: DetailState): DetailState => {
  const entries = new Map(detail.entries);

  while (isOverLimits(entries)) {
    const evicted = [...entries.keys()].find((key) => key !== detail.activeKey);

    if (evicted === undefined) {
      break;
    }

    entries.delete(evicted);
  }

  return { ...detail, entries };
};

const updateActiveEntry = (
  snapshot: Snapshot,
  change: (entry: DetailEntry) => DetailEntry,
): Snapshot => {
  const { detail } = snapshot;
  const entry = detail.activeKey === null ? undefined : detail.entries.get(detail.activeKey);

  if (entry === undefined) {
    return snapshot;
  }

  const entries = new Map(detail.entries).set(entry.key, change(entry));

  return { ...snapshot, detail: { ...detail, entries } };
};

export const switchDetailTab = (snapshot: Snapshot, direction: 1 | -1): Snapshot =>
  updateActiveEntry(snapshot, (entry) => {
    const tabs: readonly DetailTab[] = entry.tabs;
    const index = tabs.indexOf(entry.tab);
    const nextIndex = (index + direction + entry.tabs.length) % entry.tabs.length;

    if (entry.kind === 'issue') {
      return { ...entry, tab: entry.tabs[nextIndex] ?? entry.tab };
    }

    if (entry.kind === 'pullRequest') {
      return { ...entry, tab: entry.tabs[nextIndex] ?? entry.tab };
    }

    return entry;
  });

export const setDetailAnchor = (
  snapshot: Snapshot,
  tab: DetailTab,
  anchor: DetailAnchor,
): Snapshot =>
  updateActiveEntry(snapshot, (entry) => {
    const tabs: readonly DetailTab[] = entry.tabs;

    return tabs.includes(tab) ? { ...entry, anchors: { ...entry.anchors, [tab]: anchor } } : entry;
  });
