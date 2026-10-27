import { expect, test } from 'bun:test';

import type { GitHubEffects } from '../src/github/github.ts';
import { lookUpSubjects } from '../src/github/github.ts';
import { makeHarness, makeThread } from '../src/session/sessionHarness.ts';

const resetAt = new Date('2026-02-01T12:05:00Z');

const rateLimitedEffects: GitHubEffects = {
  runGh: async () => ({
    kind: 'exited',
    exitCode: 0,
    stdout: `HTTP/2.0 200 OK\r\nx-ratelimit-reset: ${resetAt.getTime() / 1000}\r\n\r\n${JSON.stringify(
      { data: null, errors: [{ type: 'RATE_LIMITED', message: 'Slow down' }] },
    )}`,
    stderr: '',
  }),
  now: () => new Date('2026-02-01T12:00:00Z'),
  host: 'github.com',
};

test('a GraphQL rate limit from a subject lookup holds feed requests until the reset time', async () => {
  const harness = makeHarness({
    lookUpSubjects: (threads, signal) => lookUpSubjects(rateLimitedEffects, threads, signal),
  });

  await harness.load(makeThread('1'));
  await harness.fireTimer();

  expect(harness.now().getTime()).toBeLessThan(resetAt.getTime());
  expect(harness.countOf('poll')).toBe(0);
  expect(harness.countOf('read')).toBe(1);

  await harness.fireTimer();

  expect(harness.now()).toEqual(resetAt);
  expect(harness.countOf('poll')).toBe(0);
  expect(harness.countOf('read')).toBe(2);
});
