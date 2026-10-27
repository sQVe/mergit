import { expect, test } from 'bun:test';

import type { NotificationFeed, Viewer } from '../github/github.ts';
import { toViewerId, toViewerLogin } from '../work/work.ts';
import {
  failure,
  makeFeed,
  makeSavedHarness,
  makeThread,
  octocat,
  readOf,
  savedSnapshotOf,
  savedThreads,
  settle,
  stable,
  viewerIdOf,
  viewerOf,
} from './sessionHarness.ts';

test('another account empties the list before the feed answers and reads without a previous feed', async () => {
  const { session, send, answerViewer, take } = makeSavedHarness(octocat);

  await send();
  await answerViewer(viewerOf(toViewerLogin('hubot')));

  expect(session.getSnapshot().threads).toEqual([]);
  expect(session.getSnapshot().selectedRowKey).toBeNull();
  expect(session.getSnapshot().savedAt).toBeNull();
  expect(take('read').request.previous).toBeNull();
});

test('the same login with another node ID empties the list and reads without a previous feed', async () => {
  const { session, send, answerViewer, take } = makeSavedHarness(octocat, {
    savedSnapshot: savedSnapshotOf(octocat, null, toViewerId('U_a')),
  });

  await send();
  await answerViewer(viewerOf(octocat, null, toViewerId('U_b')));

  expect(session.getSnapshot().threads).toEqual([]);
  expect(take('read').request.previous).toBeNull();
});

test('a changed login with the same node ID keeps the saved threads', async () => {
  const { session, send, answerViewer, take } = makeSavedHarness(octocat, {
    savedSnapshot: savedSnapshotOf(octocat, null, toViewerId('U_a')),
  });

  await send();
  await answerViewer(viewerOf(toViewerLogin('hubot'), null, toViewerId('U_a')));

  expect(session.getSnapshot().threads).toEqual(savedThreads);
  expect(take('read').request.previous).toEqual(makeFeed('saved', savedThreads));
});

test('a failed viewer read shows the failure and keeps the saved threads', async () => {
  const { session, send, answerViewer, countOf } = makeSavedHarness(octocat);

  await send();
  await answerViewer(failure('offline'));

  const snapshot = session.getSnapshot();

  expect(snapshot.errorMessage).toBe('offline');
  expect(snapshot.threads).toEqual(savedThreads);
  expect(snapshot.refreshStatus).toBe('idle');
  expect(countOf('read')).toBe(0);
});

test('a poll timer after a failed viewer read runs a full refresh, not a poll', async () => {
  const { send, answerViewer, fireTimer, countOf } = makeSavedHarness(octocat);

  await send();
  await answerViewer(failure('offline'));
  await fireTimer();

  expect(countOf('poll')).toBe(0);
  expect(countOf('viewer')).toBe(2);
});

test('a second full refresh reads the viewer again', async () => {
  const { send, answerViewer, answerRead, answerVerify, countOf } = makeSavedHarness(octocat);

  await send();
  await answerViewer(viewerOf(octocat));
  await answerRead(readOf('fresh', []));
  await answerVerify(stable);
  await send();

  expect(countOf('viewer')).toBe(2);
});

test('a login that changes between refreshes clears the list, reads without a previous feed, and saves under the new login', async () => {
  const saves: { viewer: Viewer; feed: NotificationFeed }[] = [];
  const hubot = toViewerLogin('hubot');

  const { session, send, answerViewer, answerVerify, take } = makeSavedHarness(octocat, {
    saveSnapshot: (viewer, feed) => {
      saves.push({ viewer, feed });
    },
  });

  await send();
  await answerViewer(viewerOf(octocat));
  take('read').resolve(readOf('first', [makeThread('3')]));
  await settle();
  await answerVerify(stable);
  await send();
  await answerViewer(viewerOf(hubot));

  const secondRead = take('read');

  expect(session.getSnapshot().threads).toEqual([]);
  expect(secondRead.request.previous).toBeNull();

  secondRead.resolve(readOf('second', [makeThread('4')]));
  await settle();
  await answerVerify(stable);

  expect(saves.map((save) => save.viewer.login)).toEqual([octocat, hubot]);
  expect(saves[1]?.feed).toEqual(makeFeed('second', [makeThread('4')]));
});

test('a saved snapshot sends its viewer etag on the first read', async () => {
  const { send, take } = makeSavedHarness(octocat, {
    savedSnapshot: savedSnapshotOf(octocat, '"saved-viewer"'),
  });

  await send();

  expect(take('viewer').previous).toEqual({
    id: viewerIdOf(octocat),
    login: octocat,
    etag: '"saved-viewer"',
  });
});

test('the next full refresh sends the etag of the previous viewer read', async () => {
  const { send, answerViewer, answerRead, answerVerify, take } = makeSavedHarness(octocat);

  await send();
  await answerViewer(viewerOf(octocat, '"first"'));
  await answerRead(readOf('fresh', []));
  await answerVerify(stable);
  await send();

  expect(take('viewer').previous).toEqual({
    id: viewerIdOf(octocat),
    login: octocat,
    etag: '"first"',
  });
});

test('a changed login saves the new viewer etag', async () => {
  const saves: Viewer[] = [];
  const hubot = toViewerLogin('hubot');

  const { send, answerViewer, answerRead, answerVerify } = makeSavedHarness(octocat, {
    saveSnapshot: (viewer) => {
      saves.push(viewer);
    },
  });

  await send();
  await answerViewer(viewerOf(hubot, '"hubot-tag"'));
  await answerRead(readOf('second', []));
  await answerVerify(stable);

  expect(saves).toEqual([{ id: viewerIdOf(hubot), login: hubot, etag: '"hubot-tag"' }]);
});

test('a second manual refresh after the first load sends no previous feed', async () => {
  const harness = makeSavedHarness(octocat);

  await harness.send();
  await harness.answerViewer(viewerOf(octocat));
  await harness.answerRead(readOf('fresh', []));
  await harness.answerVerify(stable);
  await harness.send();
  await harness.answerViewer(viewerOf(octocat));

  expect(harness.take('read').request.previous).toBeNull();
});

test('an account switch marks the list as not loaded until the new feed loads', async () => {
  const { session, send, answerViewer, answerRead, answerVerify } = makeSavedHarness(octocat);

  expect(session.getSnapshot().hasLoaded).toBe(true);

  await send();
  await answerViewer(viewerOf(toViewerLogin('hubot')));

  expect(session.getSnapshot().hasLoaded).toBe(false);

  await answerRead(readOf('fresh', [makeThread('7')]));
  await answerVerify(stable);

  expect(session.getSnapshot().hasLoaded).toBe(true);
});
