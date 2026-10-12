import { catalog } from './commands.ts';
import {
  createGhRunner,
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
} from './localState.ts';
import type { StateWriter } from './localState.ts';
import { createSession } from './session/session.ts';
import type { SavedSnapshot } from './session/session.ts';
import { startTerminal } from './terminal.tsx';
import type { Grouping } from './work/work.ts';

const now = () => new Date();
const githubEffects = { runGh: createGhRunner(), now };

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

const stateHome = stateDirectory(Bun.env);
const loadedState = stateHome === null ? null : loadState(stateHome);
let writer: StateWriter | undefined;
let savedGrouping: Grouping | null = null;
let stateWarning: string | null = null;
let newerVersion: string | null = null;

if (stateHome !== null && loadedState?.kind !== 'invalid' && loadedState?.kind !== 'newer') {
  writer = createStateWriter(stateHome, { onFailure: () => undefined });
}

if (loadedState?.kind === 'loaded') {
  savedGrouping = loadedState.state.grouping;
}

if (loadedState?.kind === 'invalid') {
  stateWarning = `Zeta will not save state until the file is fixed or removed: ${loadedState.path}: ${loadedState.reason}`;
}

if (loadedState?.kind === 'newer') {
  newerVersion = `Cannot start: ${loadedState.path} has version ${loadedState.version}, and this Zeta reads version 1.\n`;
}

if (newerVersion !== null) {
  process.stderr.write(newerVersion);
  process.exitCode = 1;
} else {
  await startTerminal({
    session: createSession({
      savedSnapshot: readSavedSnapshot(),
      savedGrouping,
      saveGrouping: (grouping) => writer?.save({ grouping }),
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
      now,
      setTimer,
    }),
    catalog,
    flushState: () => writer?.flush() ?? Promise.resolve(),
  });
}
