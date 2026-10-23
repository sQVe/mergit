import { expect, test } from 'bun:test';

import { makeHarness } from './sessionHarness.ts';

test('the toast clears after four seconds, and a newer toast replaces it and restarts the timer', () => {
  const { session, timers } = makeHarness();

  session.send({ kind: 'cycleGrouping' });

  session.reportStateWrite({
    ok: false,
    reason: 'first',
    path: '~/state.json',
  });

  const firstTimer = timers.at(-1);

  session.reportStateWrite({
    ok: false,
    reason: 'second',
    path: '~/state.json',
  });

  const secondTimer = timers.at(-1);

  expect(firstTimer?.active).toBe(false);
  expect(secondTimer).not.toBe(firstTimer);
  expect(secondTimer?.delay).toBe(4000);
  expect(session.getSnapshot().toast?.durationMilliseconds).toBe(4000);
  expect(session.getSnapshot().toast?.lines[0]).toBe('second');

  secondTimer?.callback();

  expect(session.getSnapshot().toast).toBeNull();
});

test("a toast's duration equals the delay of its expiry timer", () => {
  const { session, timers } = makeHarness();

  session.send({ kind: 'cycleGrouping' });

  session.reportStateWrite({
    ok: false,
    reason: 'disk full',
    path: '~/state.json',
  });

  const toastTimer = timers.at(-1);

  expect(toastTimer?.delay).toBeDefined();

  expect(session.getSnapshot().toast?.durationMilliseconds).toBe(toastTimer?.delay);
});

test('toasts stay in messages newest first with time and tone after the toast clears', () => {
  const { session, timers, now, advance } = makeHarness();

  session.send({ kind: 'cycleGrouping' });

  const firstShownAt = now();

  session.reportStateWrite({ ok: false, reason: 'first', path: '~/state.json' });
  advance(1000);

  const secondShownAt = now();

  session.send({ kind: 'reportUnknownCommand', name: 'foo' });
  timers.at(-1)?.callback();

  const { toast, messages } = session.getSnapshot();

  expect(toast).toBeNull();

  expect(messages.map((message) => message.title)).toEqual([
    'Unknown command: foo',
    'Grouping not saved',
  ]);

  expect(messages.map((message) => message.tone)).toEqual(['error', 'error']);
  expect(messages.map((message) => message.shownAt)).toEqual([secondShownAt, firstShownAt]);
  expect(messages[1]?.lines).toEqual(['first', '~/state.json']);
});

test('the message history keeps at most 100 entries and drops the oldest', () => {
  const { session } = makeHarness();

  for (let index = 0; index < 105; index += 1) {
    session.send({ kind: 'reportUnknownCommand', name: `command${index}` });
  }

  const { messages } = session.getSnapshot();

  expect(messages).toHaveLength(100);
  expect(messages[0]?.title).toBe('Unknown command: command104');
  expect(messages.at(-1)?.title).toBe('Unknown command: command5');
});

test('config notices appear together in one startup toast and message', () => {
  const notices = ['refresh took x from a default', 'help took z from a default'];
  const { session } = makeHarness({ configNotices: notices });
  const { toast, messages } = session.getSnapshot();

  expect(toast?.tone).toBe('info');
  expect(toast?.lines).toEqual(notices);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.lines).toEqual(notices);
});

test('an empty config notice list shows no startup toast or message', () => {
  const { session } = makeHarness({ configNotices: [] });

  expect(session.getSnapshot().toast).toBeNull();
  expect(session.getSnapshot().messages).toEqual([]);
});

test('the state warning stays on screen after config notices and both stay in messages', () => {
  const notices = ['refresh took x from a default'];
  const warning = { reason: 'bad state', path: '/state.json' };
  const { session } = makeHarness({ configNotices: notices, stateWarning: warning });
  const { toast, messages } = session.getSnapshot();

  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toEqual([warning.reason, warning.path]);

  expect(messages.map((message) => message.lines)).toEqual([
    [warning.reason, warning.path],
    notices,
  ]);
});

test('stop leaves no active toast timer', async () => {
  const { session, activeTimers } = makeHarness();

  session.send({ kind: 'cycleGrouping' });
  session.reportStateWrite({ ok: false, reason: 'first', path: '~/state.json' });

  expect(activeTimers()).toHaveLength(1);

  await session.stop(new AbortController().signal);

  expect(activeTimers()).toEqual([]);
});
