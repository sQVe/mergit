import { expect, test } from 'bun:test';

import {
  failure,
  makeHarness,
  makeThread,
  readOf,
  settle,
  stable,
  unchanged,
} from './sessionHarness.ts';

test('a failed second pass keeps the list and shows the error', async () => {
  const { session, load, answerRead, answerVerify } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  session.send({ kind: 'refresh' });
  await settle();
  await answerRead(readOf('next', []));
  await answerVerify(failure('Verify failed'));

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().errorMessage).toBe('Verify failed');
});

test('a rejected read is a failed refresh and the session keeps running', async () => {
  let attempts = 0;
  const thread = makeThread('1');

  const { session } = makeHarness({
    readFeed: () => {
      attempts += 1;

      if (attempts === 1) {
        return Promise.reject(new Error('socket closed'));
      }

      return Promise.resolve(readOf('feed', [thread]));
    },
    verifyFeed: () => Promise.resolve(stable),
  });

  session.send({ kind: 'refresh' });
  await settle();
  await settle();

  expect(session.getSnapshot().errorMessage).toBe('socket closed');
  expect(session.getSnapshot().refreshStatus).toBe('idle');

  session.send({ kind: 'refresh' });
  await settle();
  await settle();

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().errorMessage).toBeNull();
});

test('a read that throws is a failed refresh', async () => {
  const { session } = makeHarness({
    readFeed: () => {
      throw new Error('spawn failed');
    },
  });

  session.send({ kind: 'refresh' });
  await settle();
  await settle();

  expect(session.getSnapshot().errorMessage).toBe('spawn failed');
  expect(session.getSnapshot().refreshStatus).toBe('idle');
});

test('ghMissing and notSignedIn set the notice and a later success clears it', async () => {
  const { session, load, answerRead } = makeHarness();
  const thread = makeThread('1');

  await load(thread);

  session.send({ kind: 'refresh' });
  await settle();
  await answerRead({ ok: false, failure: { kind: 'ghMissing' } });

  expect(session.getSnapshot().notice).toBe('ghMissing');
  expect(session.getSnapshot().errorMessage).toBeNull();
  expect(session.getSnapshot().threads).toEqual([thread]);

  session.send({ kind: 'refresh' });
  await settle();
  await answerRead({ ok: false, failure: { kind: 'notSignedIn' } });

  expect(session.getSnapshot().notice).toBe('notSignedIn');

  await load(thread);

  expect(session.getSnapshot().notice).toBeNull();
});

test('an unchanged poll after a notSignedIn poll failure clears the notice', async () => {
  const { session, load, fireTimer, answerPoll } = makeHarness();

  await load(makeThread('1'));
  await fireTimer();
  await answerPoll({ ok: false, failure: { kind: 'notSignedIn' } });

  expect(session.getSnapshot().notice).toBe('notSignedIn');

  await fireTimer();
  await answerPoll(unchanged());

  expect(session.getSnapshot().notice).toBeNull();
});

test('a responseTooLarge read keeps the list and shows an error', async () => {
  const { session, load, answerRead } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  session.send({ kind: 'refresh' });
  await settle();
  await answerRead({ ok: false, failure: { kind: 'responseTooLarge', limitBytes: 1024 } });

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().notice).toBeNull();
  expect(session.getSnapshot().errorMessage ?? '').toContain('1024');
});
