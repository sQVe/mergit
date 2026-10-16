import type { Filter, Query } from '../query.ts';
import { evaluate, filterQuery, searchQuery } from '../query.ts';
import type {
  Grouping,
  NotificationThread,
  SubjectFacts,
  ThreadId,
  TreeRow,
  ViewerLogin,
} from '../work/work.ts';
import { treeRows } from '../work/work.ts';
import type { SearchCompletion } from './searchCompletion.ts';
import { selectAfterRefresh } from './selectionRepair.ts';

type Notice = 'ghMissing' | 'notSignedIn';

export interface Toast {
  title: string;
  lines: string[];
  tone: 'info' | 'error';
  durationMilliseconds: number;
}

interface Message {
  id: number;
  title: string;
  lines: string[];
  tone: Toast['tone'];
  shownAt: Date;
}

export type UnsavedChange = 'grouping' | 'done' | 'seen';

export interface Snapshot {
  threads: NotificationThread[];
  hiddenThreadIds: ReadonlySet<ThreadId>;
  subjectFacts: ReadonlyMap<ThreadId, SubjectFacts>;
  newThreadIds: ReadonlySet<ThreadId>;
  selectedRowKey: string | null;
  grouping: Grouping;
  foldedNodes: Record<Grouping, ReadonlySet<string>>;
  refreshStatus: 'idle' | 'running';
  errorMessage: string | null;
  notice: Notice | null;
  hasLoaded: boolean;
  refreshedAt: Date | null;
  savedAt: Date | null;
  feedBusy: boolean;
  pausedUntil: Date | null;
  stateWarning: string | null;
  toast: Toast | null;
  messages: Message[];
  viewerLogin: ViewerLogin | null;
  searchText: string;
  searchOpen: boolean;
  searchTextBefore: string;
  commandLineOpen: boolean;
  commandLineText: string;
  searchCompletion: SearchCompletion | null;
  filters: Filter[];
  filtersOpen: boolean;
  filterDraft: string;
  filterCursor: number;
  filterError: string | null;
  filterEditing: Filter | null;
}

export const noticeMessages: Record<Notice, { title: string; text: string }> = {
  ghMissing: {
    title: 'GitHub CLI not found',
    text: 'Install GitHub CLI from https://cli.github.com, then press r',
  },
  notSignedIn: { title: 'Not signed in to GitHub', text: 'Run gh auth login, then press r' },
};

export const initialSnapshot: Snapshot = {
  threads: [],
  hiddenThreadIds: new Set(),
  subjectFacts: new Map(),
  newThreadIds: new Set(),
  selectedRowKey: null,
  grouping: 'reason',
  foldedNodes: {
    reason: new Set(),
    type: new Set(),
    none: new Set(),
  },
  refreshStatus: 'idle',
  errorMessage: null,
  notice: null,
  hasLoaded: false,
  refreshedAt: null,
  savedAt: null,
  feedBusy: false,
  pausedUntil: null,
  stateWarning: null,
  toast: null,
  messages: [],
  viewerLogin: null,
  searchText: '',
  searchOpen: false,
  searchTextBefore: '',
  commandLineOpen: false,
  commandLineText: '',
  searchCompletion: null,
  filters: [],
  filtersOpen: false,
  filterDraft: '',
  filterCursor: -1,
  filterError: null,
  filterEditing: null,
};

export const openThreads = (snapshot: Snapshot): NotificationThread[] =>
  snapshot.threads.filter((thread) => !snapshot.hiddenThreadIds.has(thread.id));

const evaluateThread = (
  snapshot: Snapshot,
  thread: NotificationThread,
  query: Query,
): boolean | 'unknown' =>
  evaluate(query, thread, {
    facts: snapshot.subjectFacts.get(thread.id),
    isNew: snapshot.newThreadIds.has(thread.id),
    viewerLogin: snapshot.viewerLogin,
    now: snapshot.savedAt ?? snapshot.refreshedAt,
  });

export const threadsMatching = (
  snapshot: Snapshot,
  threads: NotificationThread[],
  query: Query | null,
): NotificationThread[] => {
  if (query === null) {
    return threads;
  }

  return threads.filter((thread) => evaluateThread(snapshot, thread, query) !== false);
};

export const threadsKnownMatching = (
  snapshot: Snapshot,
  threads: NotificationThread[],
  query: Query,
): NotificationThread[] =>
  threads.filter((thread) => evaluateThread(snapshot, thread, query) === true);

const searchedThreads = (snapshot: Snapshot): NotificationThread[] => {
  const searched = threadsMatching(
    snapshot,
    openThreads(snapshot),
    searchQuery(snapshot.searchText),
  );

  return threadsMatching(snapshot, searched, filterQuery(snapshot.filters));
};

export const matchCountOf = (snapshot: Snapshot): number => searchedThreads(snapshot).length;

export const visibleRows = (snapshot: Snapshot): TreeRow[] =>
  treeRows(searchedThreads(snapshot), snapshot.grouping, snapshot.foldedNodes[snapshot.grouping]);

export const keepSelectionVisible = (previous: Snapshot, next: Snapshot): Snapshot => {
  const selectedRowKey = selectAfterRefresh(
    visibleRows(previous),
    previous.selectedRowKey,
    visibleRows(next),
  );

  return selectedRowKey === next.selectedRowKey ? next : { ...next, selectedRowKey };
};
