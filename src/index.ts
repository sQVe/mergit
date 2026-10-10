import { catalog } from './commands.ts';
import {
  createGhRunner,
  pollNotificationFeed,
  readNotificationFeed,
  verifyNotificationFeed,
} from './github/github.ts';
import { createSession } from './session/session.ts';
import { startTerminal } from './terminal.tsx';

const now = () => new Date();
const githubEffects = { runGh: createGhRunner(), now };

const setTimer = (delayMilliseconds: number, callback: () => void) => {
  const handle = setTimeout(callback, delayMilliseconds);

  return () => {
    clearTimeout(handle);
  };
};

await startTerminal({
  session: createSession({
    pollFeed: (feed, signal) => pollNotificationFeed(githubEffects, feed, signal),
    readFeed: (request, signal) => readNotificationFeed(githubEffects, request, signal),
    verifyFeed: (feed, signal) => verifyNotificationFeed(githubEffects, feed, signal),
    now,
    setTimer,
  }),
  catalog,
});
