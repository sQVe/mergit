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
import { createSession } from './session.ts';
import type { SavedSnapshot, SavedState, Session, SessionEffects } from './session.ts';

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
