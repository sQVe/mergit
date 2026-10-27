import { openInBrowser } from './actions.ts';
import { keyHintOf } from './commands.ts';
import { loadConfig } from './config/config.ts';
import {
  createGhRunner,
  lookUpSubjects,
  markThreadDone,
  pollNotificationFeed,
  readNotificationFeed,
  readViewer,
  resolveGitHubHost,
  restoreNotificationFeed,
  verifyNotificationFeed,
} from './github/github.ts';
import type { NotificationPage, SavedNotificationPage } from './github/github.ts';
import {
  cacheDirectory,
  createStateWriter,
  loadSnapshot,
  loadState,
  saveSnapshot,
  stateDirectory,
  stateVersion,
} from './localState/localState.ts';
import type { StateWriter } from './localState/localState.ts';
import { createSession } from './session/session.ts';
import type { SavedSnapshot, Session } from './session/session.ts';
import { refuseStart, startTerminal } from './terminal.tsx';

const now = () => new Date();

const setTimer = (delayMilliseconds: number, callback: () => void) => {
  const handle = setTimeout(callback, delayMilliseconds);

  return () => {
    clearTimeout(handle);
  };
};

const toSavedPage = (page: NotificationPage): SavedNotificationPage => ({
  path: page.endpoint,
  etag: page.etag,
  next: page.next,
  body: page.body,
});

const shortenHome = (path: string): string => {
  const home = Bun.env['HOME'];

  if (home === undefined || home === '' || !path.startsWith(`${home}/`)) {
    return path;
  }

  return `~${path.slice(home.length)}`;
};

const readSavedSnapshot = (directory: string | null, host: string): SavedSnapshot | null => {
  if (directory === null) {
    return null;
  }

  const loaded = loadSnapshot(directory);

  if (!loaded.ok || loaded.value === null || loaded.value.host !== host) {
    return null;
  }

  const restored = restoreNotificationFeed(loaded.value.pages);

  if (!restored.ok) {
    return null;
  }

  const { login, viewerId, viewerEtag, savedAt } = loaded.value;

  return { viewer: { id: viewerId, login, etag: viewerEtag }, savedAt, ...restored.value };
};

const start = async (): Promise<void> => {
  const config = loadConfig(Bun.env);

  if (!config.ok) {
    refuseStart(config.message);

    return;
  }

  const { catalog, notices } = config;
  const runGh = createGhRunner();
  const host = await resolveGitHubHost({ runGh }, Bun.env, new AbortController().signal);
  const githubEffects = { runGh, now, host };
  const directory = cacheDirectory(Bun.env);
  const stateHome = stateDirectory(Bun.env);
  const loadedState = stateHome === null ? { kind: 'missing' as const } : loadState(stateHome);

  if (loadedState.kind === 'newer') {
    refuseStart(
      `Cannot start: ${loadedState.path} has version ${loadedState.version}, and this Mergit reads version ${stateVersion}.`,
    );

    return;
  }

  let writer: StateWriter | undefined;
  let session: Session | undefined = undefined;

  if (stateHome !== null && loadedState.kind !== 'invalid') {
    writer = createStateWriter(stateHome, {
      onFailure: (failure) =>
        session?.reportStateWrite({
          ok: false,
          reason: failure.reason,
          path: shortenHome(failure.path),
        }),
      onSaved: () => session?.reportStateWrite({ ok: true }),
    });
  }

  const savedState = loadedState.kind === 'loaded' ? loadedState.state : null;

  const stateWarning =
    loadedState.kind === 'invalid'
      ? { reason: loadedState.reason, path: shortenHome(loadedState.path) }
      : null;

  session = createSession({
    savedSnapshot: readSavedSnapshot(directory, host),
    host,
    refreshKey: keyHintOf(catalog, 'refresh'),
    savedState,
    saveState: (state) => writer?.save(state),
    markThreadDone: (threadId, signal) => markThreadDone(githubEffects, threadId, signal),
    openInBrowser: (page, signal) => openInBrowser({ runGh, host }, page, signal),
    configNotices: notices,
    stateWarning,
    readViewer: (previous, signal) => readViewer(githubEffects, previous, signal),
    saveSnapshot: (viewer, feed, savedAt) => {
      if (directory !== null) {
        saveSnapshot(directory, {
          host,
          login: viewer.login,
          viewerId: viewer.id,
          viewerEtag: viewer.etag,
          savedAt,
          pages: feed.pages.map(toSavedPage),
        });
      }
    },
    pollFeed: (feed, signal) => pollNotificationFeed(githubEffects, feed, signal),
    readFeed: (request, signal) => readNotificationFeed(githubEffects, request, signal),
    verifyFeed: (feed, signal) => verifyNotificationFeed(githubEffects, feed, signal),
    lookUpSubjects: (threads, signal) => lookUpSubjects(githubEffects, threads, signal),
    now,
    setTimer,
  });

  await startTerminal({
    session,
    catalog,
    flushState: () => writer?.flush() ?? Promise.resolve(),
  });
};

await start();
