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
