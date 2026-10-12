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
import { cacheDirectory, loadSnapshot, saveSnapshot } from './localState.ts';
import { createSession } from './session/session.ts';
import type { SavedSnapshot } from './session/session.ts';
import { startTerminal } from './terminal.tsx';

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

  const { login, savedAt } = loaded.value;

  return { login, savedAt, ...restored.value };
};

await startTerminal({
  session: createSession({
    savedSnapshot: readSavedSnapshot(),
    readViewer: (signal) => readViewer(githubEffects, signal),
    saveSnapshot: (login, feed, savedAt) => {
      if (directory !== null) {
        saveSnapshot(directory, { host, login, savedAt, pages: feed.pages.map(toSavedPage) });
      }
    },
    pollFeed: (feed, signal) => pollNotificationFeed(githubEffects, feed, signal),
    readFeed: (request, signal) => readNotificationFeed(githubEffects, request, signal),
    verifyFeed: (feed, signal) => verifyNotificationFeed(githubEffects, feed, signal),
    now,
    setTimer,
  }),
  catalog,
});
