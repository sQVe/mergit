import { expect, test } from 'bun:test';

import type { NotificationFeed, Viewer } from '../github/github.ts';
import { toViewerId, toViewerLogin } from '../work/work.ts';
import {
  accountKeyOf,
  doneFor,
  failure,
  makeFeed,
  makeSavedHarness,
  makeThread,
  octocat,
  readOf,
  releaseOf,
  savedSnapshotOf,
  savedThreads,
  seenFor,
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

test('a changed login with the same node ID keeps done records and seen markers under the new login', async () => {
  const [done, seen, unseen] = [releaseOf('5'), releaseOf('6'), releaseOf('7')];
  const renamed = toViewerLogin('octocat2');

  const { session, send, answerViewer, answerRead, answerVerify, saves } = makeSavedHarness(
    octocat,
    {
      savedState: {
        grouping: 'reason',
        done: doneFor(octocat, done),
        seen: seenFor(octocat, [seen, seen.updatedAt]),
      },
    },
  );

  await send();
  await answerViewer(viewerOf(renamed, null, viewerIdOf(octocat)));
  await answerRead(readOf('fresh', [done, seen, unseen]));
  await answerVerify(stable);

  const snapshot = session.getSnapshot();
  const lastSave = saves.at(-1);

  expect(snapshot.threads).toEqual([seen, unseen]);
  expect([...snapshot.newThreadIds]).toEqual([unseen.id]);
  expect(lastSave?.done).toEqual(doneFor(renamed, done));
  expect(lastSave?.seen.get(accountKeyOf(renamed))?.get(seen.id)).toBe(seen.updatedAt);
  expect(lastSave?.seen.has(accountKeyOf(octocat))).toBe(false);
});

test('a changed login with another node ID clears the list and moves no records', async () => {
  const [done, seen] = [releaseOf('5'), releaseOf('6')];
  const hubot = toViewerLogin('hubot');

  const { session, send, answerViewer, answerRead, answerVerify, saves } = makeSavedHarness(
    octocat,
    {
      savedState: {
        grouping: 'reason',
        done: doneFor(octocat, done),
        seen: seenFor(octocat, [seen, seen.updatedAt]),
      },
    },
  );

  await send();
  await answerViewer(viewerOf(hubot));

  expect(session.getSnapshot().threads).toEqual([]);

  await answerRead(readOf('fresh', [done, seen]));
  await answerVerify(stable);

  const lastSave = saves.at(-1);

  expect(session.getSnapshot().threads).toEqual([done, seen]);
  expect(lastSave?.done).toEqual(doneFor(octocat, done));

  expect(lastSave?.seen.get(accountKeyOf(octocat))).toEqual(
    seenFor(octocat, [seen, seen.updatedAt]).get(accountKeyOf(octocat)),
  );
});

test('a changed login merges the old seen markers into the new login and keeps the newer one per thread', async () => {
  const [oldNewer, newNewer] = [releaseOf('5'), releaseOf('6')];
  const older = '2026-01-01T10:00:00Z';
  const renamed = toViewerLogin('octocat2');

  const { session, send, answerViewer, answerRead, answerVerify, saves } = makeSavedHarness(
    octocat,
    {
      savedState: {
        grouping: 'reason',
        done: new Map(),
        seen: new Map([
          ...seenFor(octocat, [oldNewer, oldNewer.updatedAt], [newNewer, older]),
          ...seenFor(renamed, [oldNewer, older], [newNewer, newNewer.updatedAt]),
        ]),
      },
    },
  );

  await send();
  await answerViewer(viewerOf(renamed, null, viewerIdOf(octocat)));
  await answerRead(readOf('fresh', [oldNewer, newNewer]));
  await answerVerify(stable);

  expect(session.getSnapshot().newThreadIds.size).toBe(0);

  expect(saves.at(-1)?.seen).toEqual(
    seenFor(renamed, [oldNewer, oldNewer.updatedAt], [newNewer, newNewer.updatedAt]),
  );
});

test('a failed state write after a changed login names the done and seen records', async () => {
  const { session, send, answerViewer } = makeSavedHarness(octocat, {
    savedState: {
      grouping: 'reason',
      done: doneFor(octocat, releaseOf('5')),
      seen: seenFor(octocat, [releaseOf('6'), '2026-01-01T10:00:00Z']),
    },
  });

  await send();
  await answerViewer(viewerOf(toViewerLogin('octocat2'), null, viewerIdOf(octocat)));
  session.reportStateWrite({ ok: false, reason: 'disk full', path: '~/state.json' });

  const title = session.getSnapshot().toast?.title.toLowerCase();

  expect(title).toContain('done');
  expect(title).toContain('seen');
});

test('a viewer read with the same login saves no state', async () => {
  const { send, answerViewer, saves } = makeSavedHarness(octocat, {
    savedState: {
      grouping: 'reason',
      done: doneFor(octocat, releaseOf('5')),
      seen: seenFor(octocat, [releaseOf('6'), '2026-01-01T10:00:00Z']),
    },
  });

  await send();
  await answerViewer(viewerOf(octocat));

  expect(saves).toEqual([]);
});

test('a changed login keeps the done record already under the new login when both name the same instant', async () => {
  const done = releaseOf('5');
  const renamed = toViewerLogin('octocat2');

  const { session, send, answerViewer, answerRead, answerVerify, saves } = makeSavedHarness(
    octocat,
    {
      savedState: {
        grouping: 'reason',
        done: new Map([
          [accountKeyOf(octocat), new Map([[done.id, '2026-01-02T11:00:00+01:00']])],
          ...doneFor(renamed, done),
        ]),
        seen: new Map(),
      },
    },
  );

  await send();
  await answerViewer(viewerOf(renamed, null, viewerIdOf(octocat)));
  await answerRead(readOf('fresh', [done]));
  await answerVerify(stable);

  expect(session.getSnapshot().threads).toEqual([]);
  expect(saves.at(-1)?.done).toEqual(doneFor(renamed, done));
});
