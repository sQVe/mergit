import type {
  GitHubResult,
  NotificationFeed,
  NotificationFeedRead,
  NotificationFeedRequest,
  NotificationPage,
  NotificationPoll,
  NotificationVerification,
  SubjectLookup,
  Viewer,
} from '../github/github.ts';
import type { BrowserPage, NotificationThread, ThreadId, ViewerLogin } from '../work/work.ts';
import { toThreadId, toViewerLogin } from '../work/work.ts';
import { createSession, formatFilter, visibleRows } from './session.ts';
import type { FilterRow, SavedSnapshot, SavedState, Session, SessionEffects } from './session.ts';

type Call =
  | {
      kind: 'poll';
      feed: NotificationFeed;
      resolve: (result: GitHubResult<NotificationPoll>) => void;
      signal: AbortSignal;
    }
  | {
      kind: 'read';
      request: NotificationFeedRequest;
      resolve: (result: GitHubResult<NotificationFeedRead>) => void;
      signal: AbortSignal;
    }
  | {
      kind: 'verify';
      feed: NotificationFeed;
      resolve: (result: GitHubResult<NotificationVerification>) => void;
      signal: AbortSignal;
    }
  | {
      kind: 'viewer';
      previous: Viewer | null;
      resolve: (result: GitHubResult<Viewer>) => void;
      signal: AbortSignal;
    };

interface LookupCall {
  threads: NotificationThread[];
  resolve: (lookups: SubjectLookup[]) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
}

interface SendCall {
  threadId: ThreadId;
  signal: AbortSignal;
  resolve: (result: GitHubResult<null>) => void;
}

interface FakeTimer {
  delay: number;
  callback: () => void;
  active: boolean;
}

interface HarnessOptions {
  holdViewer?: boolean;
}

export interface Harness {
  session: Session;
  pending: Call[];
  history: Call[];
  lookups: LookupCall[];
  sends: SendCall[];
  opens: BrowserPage[];
  saves: SavedState[];
  timers: FakeTimer[];
  now: () => Date;
  advance: (milliseconds: number) => void;
  take: <Kind extends Call['kind']>(kind: Kind) => Extract<Call, { kind: Kind }>;
  answerRead: (result: GitHubResult<NotificationFeedRead>) => Promise<void>;
  answerVerify: (result: GitHubResult<NotificationVerification>) => Promise<void>;
  answerPoll: (result: GitHubResult<NotificationPoll>) => Promise<void>;
  answerViewer: (result: GitHubResult<Viewer>) => Promise<void>;
  countOf: (kind: Call['kind']) => number;
  activeTimers: () => FakeTimer[];
  fireTimer: () => Promise<void>;
  loadWith: (label: string, threads: NotificationThread[], pollInterval?: number) => Promise<void>;
  load: (...threads: NotificationThread[]) => Promise<void>;
  selected: () => string | null;
  selectThread: (thread: NotificationThread) => void;
}

export interface SavedHarness extends Harness {
  send: () => Promise<void>;
}

export const makeThread = (
  id: string,
  overrides: Partial<NotificationThread> = {},
): NotificationThread => ({
  id: toThreadId(id),
  reason: 'review_requested',
  unread: true,
  updatedAt: '2026-01-02T10:00:00Z',
  lastReadAt: null,
  title: `Thread ${id}`,
  subjectType: 'PullRequest',
  subjectUrl: `https://api.github.com/repos/acme/app/pulls/${id}`,
  repository: 'acme/app',
  ...overrides,
});

export const settle = (): Promise<void> => Bun.sleep(0);

export const makePage = (label: string, threads: NotificationThread[] = []): NotificationPage => ({
  endpoint: '/notifications?all=true&per_page=50',
  etag: `"${label}"`,
  threads,
  next: null,
  body: '[]',
});

export const makeFeed = (label: string, threads: NotificationThread[] = []): NotificationFeed => ({
  pages: [makePage(label, threads)],
});

export const readOf = (
  label: string,
  threads: NotificationThread[],
  pollInterval: number | null = null,
): GitHubResult<NotificationFeedRead> => ({
  ok: true,
  value: { feed: makeFeed(label, threads), threads, pollInterval },
});

export const verified = (
  kind: 'stable' | 'changed',
  pollInterval: number | null = null,
): GitHubResult<NotificationVerification> => ({
  ok: true,
  value: { kind, pollInterval },
});

export const stable = verified('stable');
export const changed = verified('changed');

export const unchanged = (pollInterval: number | null = null): GitHubResult<NotificationPoll> => ({
  ok: true,
  value: { kind: 'unchanged', pollInterval },
});

export const failure = (
  message: string,
): {
  ok: false;
  failure: { kind: 'requestFailed'; status: number; message: string };
} => ({
  ok: false as const,
  failure: { kind: 'requestFailed' as const, status: 500, message },
});

export const octocat = toViewerLogin('octocat');

export const viewerOf = (login: ViewerLogin, etag: string | null = null): GitHubResult<Viewer> => ({
  ok: true,
  value: { login, etag },
});

export const makeHarness = (
  overrides: Partial<SessionEffects> = {},
  { holdViewer = false }: HarnessOptions = {},
): Harness => {
  const pending: Call[] = [];
  const history: Call[] = [];
  const lookups: LookupCall[] = [];
  const timers: FakeTimer[] = [];
  const sends: SendCall[] = [];
  const opens: BrowserPage[] = [];
  const saves: SavedState[] = [];
  const clock = { time: new Date('2026-02-01T12:00:00Z').getTime() };

  const record = (call: Call) => {
    pending.push(call);
    history.push(call);
  };

  const session = createSession({
    savedSnapshot: null,
    host: 'github.com',
    savedState: null,
    saveState: (state) => {
      saves.push(state);
    },
    markThreadDone: (threadId, signal) =>
      new Promise((resolve) => {
        sends.push({ threadId, signal, resolve });

        signal.addEventListener('abort', () => {
          resolve({
            ok: false,
            failure: {
              kind: 'requestFailed',
              status: null,
              message: 'aborted',
            },
          });
        });
      }),
    openInBrowser: (page) => {
      opens.push(page);

      return Promise.resolve({ ok: true });
    },
    stateWarning: null,
    readViewer: (previous, signal) =>
      new Promise((resolve) => {
        if (holdViewer) {
          record({ kind: 'viewer', previous, resolve, signal });
        } else {
          history.push({ kind: 'viewer', previous, resolve, signal });
          resolve(viewerOf(octocat));
        }
      }),
    saveSnapshot: () => undefined,
    pollFeed: (feed, signal) =>
      new Promise((resolve) => {
        record({ kind: 'poll', feed, resolve, signal });
      }),
    readFeed: (request, signal) =>
      new Promise((resolve) => {
        record({ kind: 'read', request, resolve, signal });
      }),
    verifyFeed: (feed, signal) =>
      new Promise((resolve) => {
        record({ kind: 'verify', feed, resolve, signal });
      }),
    lookUpSubjects: (threads, signal) =>
      new Promise((resolve, reject) => {
        lookups.push({ threads, resolve, reject, signal });
      }),
    now: () => new Date(clock.time),
    setTimer: (delay, callback) => {
      const timer = { delay, callback, active: true };

      timers.push(timer);

      return () => {
        timer.active = false;
      };
    },
    ...overrides,
  });

  const take = <Kind extends Call['kind']>(kind: Kind) => {
    const index = pending.findIndex((call) => call.kind === kind);
    const [call] = pending.splice(index, 1);

    if (call === undefined) {
      throw new Error(`no pending ${kind} call`);
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the kind was matched above
    return call as Extract<Call, { kind: Kind }>;
  };

  const answerRead = async (result: GitHubResult<NotificationFeedRead>) => {
    take('read').resolve(result);
    await settle();
  };

  const answerVerify = async (result: GitHubResult<NotificationVerification>) => {
    take('verify').resolve(result);
    await settle();
  };

  const answerViewer = async (result: GitHubResult<Viewer>) => {
    take('viewer').resolve(result);
    await settle();
  };

  const answerPoll = async (result: GitHubResult<NotificationPoll>) => {
    take('poll').resolve(result);
    await settle();
  };

  const countOf = (kind: Call['kind']) => history.filter((call) => call.kind === kind).length;

  const activeTimers = () => timers.filter((timer) => timer.active);

  const fireTimer = async () => {
    const timer = activeTimers().at(-1);

    if (timer === undefined) {
      throw new Error('no scheduled timer');
    }

    timer.active = false;
    clock.time += timer.delay;
    timer.callback();
    await settle();
  };

  const loadWith = async (label: string, threads: NotificationThread[], pollInterval?: number) => {
    session.send({ kind: 'refresh' });
    await settle();
    await answerRead(readOf(label, threads, pollInterval ?? null));
    await answerVerify(stable);
  };

  const load = (...threads: NotificationThread[]) => loadWith('feed', threads);

  const advance = (milliseconds: number) => {
    clock.time += milliseconds;
  };

  const selected = () => session.getSnapshot().selectedRowKey;

  const selectThread = (thread: NotificationThread) => {
    session.send({ kind: 'selectFirst' });

    while (selected() !== `thread:${thread.id}` && selected() !== null) {
      const before = selected();

      session.send({ kind: 'selectNext' });

      if (selected() === before) {
        break;
      }
    }
  };

  const now = () => new Date(clock.time);

  return {
    session,
    pending,
    history,
    lookups,
    sends,
    opens,
    saves,
    now,
    advance,
    take,
    answerRead,
    answerVerify,
    answerPoll,
    answerViewer,
    countOf,
    activeTimers,
    timers,
    fireTimer,
    loadWith,
    load,
    selected,
    selectThread,
  };
};

export const savedThreads = [makeThread('1'), makeThread('2')];
export const savedAt = new Date('2026-01-05T08:00:00Z');

export const savedSnapshotOf = (login: ViewerLogin, etag: string | null = null): SavedSnapshot => ({
  viewer: { login, etag },
  savedAt,
  feed: makeFeed('saved', savedThreads),
  threads: savedThreads,
});

export const makeSavedHarness = (
  login: ViewerLogin,
  overrides: Partial<SessionEffects> = {},
): SavedHarness => {
  const harness = makeHarness(
    { savedSnapshot: savedSnapshotOf(login), ...overrides },
    { holdViewer: true },
  );

  const send = async () => {
    harness.session.send({ kind: 'refresh' });
    await settle();
  };

  return { ...harness, send };
};

export const factsOf = (thread: NotificationThread, author = 'hubot'): SubjectLookup => ({
  threadId: thread.id,
  updatedAt: thread.updatedAt,
  facts: { state: 'open', author, latestActor: null },
});

export const accountKeyOf = (login: ViewerLogin): string => `github.com/${login}`;

export const seenFor = (
  login: ViewerLogin,
  ...entries: [NotificationThread, string][]
): Map<string, Map<ThreadId, string>> =>
  new Map([[accountKeyOf(login), new Map(entries.map(([thread, seenAt]) => [thread.id, seenAt]))]]);

export const stateWithSeen = (seen: SavedState['seen']): SavedState => ({
  grouping: 'reason',
  done: new Map(),
  seen,
});

export const releaseOf = (id: string, updatedAt = '2026-01-02T10:00:00Z'): NotificationThread =>
  makeThread(id, { subjectType: 'Release', subjectUrl: null, updatedAt });

export const newThreadsFixture = (): {
  a: NotificationThread;
  b: NotificationThread;
  savedState: SavedState;
} => {
  const [a, b] = [releaseOf('1'), releaseOf('2', '2026-01-03T10:00:00Z')];

  return {
    a,
    b,
    savedState: stateWithSeen(seenFor(octocat, [a, a.updatedAt], [b, '2026-01-01T10:00:00Z'])),
  };
};

export const seenOf = (
  state: SavedState | undefined,
  thread: NotificationThread,
): string | undefined => state?.seen.get(accountKeyOf(octocat))?.get(thread.id);

export const doneOf = (...threads: NotificationThread[]): Map<ThreadId, string> =>
  new Map(threads.map((thread) => [thread.id, thread.updatedAt]));

export const doneFor = (
  login: ViewerLogin,
  ...threads: NotificationThread[]
): Map<string, Map<ThreadId, string>> => new Map([[accountKeyOf(login), doneOf(...threads)]]);

export const sentOk: GitHubResult<null> = { ok: true, value: null };

export const rowKeysOf = (session: ReturnType<typeof makeHarness>['session']): string[] =>
  visibleRows(session.getSnapshot()).map((row) => row.key);

export const threadKeysOf = (session: ReturnType<typeof makeHarness>['session']): string[] =>
  rowKeysOf(session).filter((key) => key.startsWith('thread:'));

export const sortedThreadKeysOf = (session: ReturnType<typeof makeHarness>['session']): string[] =>
  threadKeysOf(session).toSorted();

export const addFilters = (
  session: ReturnType<typeof makeHarness>['session'],
  text: string,
): void => {
  session.send({ kind: 'editFilterDraft', text });
  session.send({ kind: 'applyFilterRow' });
};

export const describeRow = (row: FilterRow): string => {
  if (row.kind === 'active') {
    return `active ${formatFilter(row.filter)}${row.count === null ? '' : ` ${row.count}`}`;
  }

  if (row.kind === 'field') {
    return `field ${row.field}`;
  }

  if (row.kind === 'candidate') {
    return `candidate ${formatFilter(row.filter)} ${row.count}`;
  }

  if (row.kind === 'typed') {
    return `typed ${row.filters.map(formatFilter).join(' ')} ${row.count}`;
  }

  return 'error';
};

export const flatHarness = async (
  ...threads: NotificationThread[]
): Promise<ReturnType<typeof makeHarness>> => {
  const harness = makeHarness();

  await harness.load(...threads);
  harness.session.send({ kind: 'cycleGrouping' });
  harness.session.send({ kind: 'cycleGrouping' });

  return harness;
};

export const fireDoneTimerAt = async (
  harness: ReturnType<typeof makeHarness>,
  index: number,
): Promise<void> => {
  const timer = harness.timers[index];

  if (timer?.active !== true) {
    return;
  }

  timer.active = false;
  timer.callback();
  await settle();
};
