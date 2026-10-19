import { openInBrowser } from './actions.ts';
import { catalog } from './commands.ts';
import {
  createGhRunner,
  lookUpSubjects,
  markThreadDone,
  pollNotificationFeed,
  readNotificationFeed,
  readViewer,
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
} from './localState.ts';
import type { StateWriter } from './localState.ts';
import { createSession } from './session/session.ts';
import type { SavedSnapshot, SavedState, Session } from './session/session.ts';
import { refuseStart, startTerminal } from './terminal.tsx';

const now = () => new Date();
const runGh = createGhRunner();
const githubEffects = { runGh, now };

const setTimer = (delayMilliseconds: number, callback: () => void) => {
  const handle = setTimeout(callback, delayMilliseconds);

  return () => {
    clearTimeout(handle);
  };
};

const host = Bun.env['GH_HOST'] ?? 'github.com';
const directory = cacheDirectory(Bun.env);

const toSavedPage = (page: NotificationPage): SavedNotificationPage => ({
  path: page.endpoint,
  etag: page.etag,
  next: page.next,
  body: page.body,
});

const readSavedSnapshot = (): SavedSnapshot | null => {
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

  const { login, viewerEtag, savedAt } = loaded.value;

  return { viewer: { login, etag: viewerEtag }, savedAt, ...restored.value };
};

const shortenHome = (path: string): string => {
  const home = Bun.env['HOME'];

  if (home === undefined || home === '' || !path.startsWith(`${home}/`)) {
    return path;
  }

  return `~${path.slice(home.length)}`;
};

const stateHome = stateDirectory(Bun.env);
const loadedState = stateHome === null ? null : loadState(stateHome);
let writer: StateWriter | undefined;
let session: Session | undefined;
let savedState: SavedState | null = null;
let stateWarning: { reason: string; path: string } | null = null;
let newerVersion: string | null = null;

if (stateHome !== null && loadedState?.kind !== 'invalid' && loadedState?.kind !== 'newer') {
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

if (loadedState?.kind === 'loaded') {
  savedState = loadedState.state;
}

if (loadedState?.kind === 'invalid') {
  stateWarning = { reason: loadedState.reason, path: shortenHome(loadedState.path) };
}

if (loadedState?.kind === 'newer') {
  newerVersion = `Cannot start: ${loadedState.path} has version ${loadedState.version}, and this Mergit reads version ${stateVersion}.`;
}

if (newerVersion !== null) {
  refuseStart(newerVersion);
} else {
  session = createSession({
    savedSnapshot: readSavedSnapshot(),
    host,
    savedState,
    saveState: (state) => writer?.save(state),
    markThreadDone: (threadId, signal) => markThreadDone(githubEffects, threadId, signal),
    openInBrowser: (page, signal) => openInBrowser({ runGh }, page, signal),
    stateWarning,
    readViewer: (previous, signal) => readViewer(githubEffects, previous, signal),
    saveSnapshot: (viewer, feed, savedAt) => {
      if (directory !== null) {
        saveSnapshot(directory, {
          host,
          login: viewer.login,
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
}
