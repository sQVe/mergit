import { expect, test } from 'bun:test';

import type { BrowserPage } from '../work/work.ts';
import { visibleRows } from './session.ts';
import type { SessionEffects } from './session.ts';
import { makeHarness, makeThread, settle } from './sessionHarness.ts';

const repoPage = (repository: string): BrowserPage => ({ kind: 'repo', repository });

test('a successful open leaves the rows, the selection, and saved state unchanged', async () => {
  const harness = makeHarness();
  const threads = [makeThread('1'), makeThread('2')];

  await harness.load(...threads);
  harness.session.send({ kind: 'selectNext' });

  const before = harness.session.getSnapshot();
  const savesBefore = harness.saves.length;

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();

  const after = harness.session.getSnapshot();

  expect(harness.opens).toEqual([repoPage('acme/app')]);
  expect(visibleRows(after)).toEqual(visibleRows(before));
  expect(after.selectedRowKey).toBe(before.selectedRowKey);
  expect(after.hiddenThreadIds).toEqual(before.hiddenThreadIds);
  expect(harness.saves).toHaveLength(savesBefore);
});

test('a successful open shows an info toast and adds it to messages', async () => {
  const harness = makeHarness();

  await harness.load(makeThread('1'));
  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();

  const { toast, messages } = harness.session.getSnapshot();

  expect(toast?.tone).toBe('info');
  expect(toast?.lines).toEqual([]);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.tone).toBe('info');
});

test('a failed open shows an error toast with the failure message', async () => {
  const harness = makeHarness({
    openInBrowser: () => Promise.resolve({ ok: false, message: 'no such repository' }),
  });

  await harness.load(makeThread('1'));
  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();

  const { toast } = harness.session.getSnapshot();

  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toEqual(['no such repository']);
  expect(harness.session.getSnapshot().messages).toHaveLength(1);
});

test('an open intent with several pages opens each page once and reports the failure count', async () => {
  const harness = makeHarness({
    openInBrowser: (page) =>
      Promise.resolve(
        page.repository === 'acme/b' ? { ok: false, message: 'broken' } : { ok: true },
      ),
  });

  const pages = [repoPage('acme/a'), repoPage('acme/b'), repoPage('acme/c')];

  harness.session.send({ kind: 'openInBrowser', pages });
  await settle();

  const { toast } = harness.session.getSnapshot();

  expect(toast?.title).toContain('1 of 3');
  expect(toast?.lines).toEqual(['broken']);

  const quiet = makeHarness();

  quiet.session.send({ kind: 'openInBrowser', pages });
  await settle();

  expect(quiet.opens).toEqual(pages);
});

const makeDeferredOpens = () => {
  const started: BrowserPage[] = [];
  const resolvers: ((result: { ok: true }) => void)[] = [];

  const openInBrowser: SessionEffects['openInBrowser'] = (page) =>
    new Promise((resolve) => {
      started.push(page);
      resolvers.push(resolve);
    });

  const finish = async (index: number) => {
    resolvers[index]?.({ ok: true });
    await settle();
  };

  return { started, openInBrowser, finish };
};

test('the opens of one batch run one at a time in order', async () => {
  const opens = makeDeferredOpens();
  const harness = makeHarness({ openInBrowser: opens.openInBrowser });
  const [first, second, third] = [repoPage('acme/a'), repoPage('acme/b'), repoPage('acme/c')];
  const pages = [first, second, third];

  harness.session.send({ kind: 'openInBrowser', pages });
  await settle();

  expect(opens.started).toEqual([first]);

  await opens.finish(0);

  expect(opens.started).toEqual([first, second]);

  await opens.finish(1);

  expect(opens.started).toEqual(pages);
});

test('a second batch waits for the first batch to finish', async () => {
  const opens = makeDeferredOpens();
  const harness = makeHarness({ openInBrowser: opens.openInBrowser });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/a')] });
  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/b')] });
  await settle();

  expect(opens.started).toEqual([repoPage('acme/a')]);

  await opens.finish(0);

  expect(opens.started).toEqual([repoPage('acme/a'), repoPage('acme/b')]);
});

test('no open starts after stop and no toast shows', async () => {
  const opens = makeDeferredOpens();
  const harness = makeHarness({ openInBrowser: opens.openInBrowser });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/a'), repoPage('acme/b')] });
  await settle();
  await harness.session.stop(new AbortController().signal);
  await opens.finish(0);

  expect(opens.started).toEqual([repoPage('acme/a')]);
  expect(harness.session.getSnapshot().toast).toBeNull();
});

test('a page whose open fails after stop shows no toast', async () => {
  const resolvers: ((result: { ok: false; message: string }) => void)[] = [];

  const harness = makeHarness({
    openInBrowser: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/a')] });
  await settle();
  await harness.session.stop(new AbortController().signal);
  resolvers[0]?.({ ok: false, message: 'broken' });
  await settle();

  expect(harness.session.getSnapshot().toast).toBeNull();
  expect(harness.session.getSnapshot().messages).toHaveLength(0);
});

test('stop aborts the signal of an open in flight', async () => {
  const signals: AbortSignal[] = [];

  const harness = makeHarness({
    openInBrowser: (_page, signal) =>
      new Promise(() => {
        signals.push(signal);
      }),
  });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/a')] });
  await settle();

  expect(signals[0]?.aborted).toBe(false);

  await harness.session.stop(new AbortController().signal);

  expect(signals[0]?.aborted).toBe(true);
});

test('an open whose effect throws shows an error toast with the error message', async () => {
  const harness = makeHarness({
    openInBrowser: () => {
      throw new Error('boom');
    },
  });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();

  const { toast, messages } = harness.session.getSnapshot();

  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toEqual(['boom']);
  expect(messages).toHaveLength(1);
});

test('an open whose effect rejects shows an error toast with the error message', async () => {
  const harness = makeHarness({
    openInBrowser: () => Promise.reject(new Error('rejected')),
  });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();

  const { toast, messages } = harness.session.getSnapshot();

  expect(toast?.tone).toBe('error');
  expect(toast?.lines).toEqual(['rejected']);
  expect(messages).toHaveLength(1);
});

test('a batch after a throwing batch still opens its page and shows its toast', async () => {
  let calls = 0;

  const harness = makeHarness({
    openInBrowser: (page) => {
      calls += 1;

      if (calls === 1) {
        throw new Error('boom');
      }

      harness.opens.push(page);

      return Promise.resolve({ ok: true });
    },
  });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/a')] });
  await settle();
  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/b')] });
  await settle();

  const { toast, messages } = harness.session.getSnapshot();

  expect(harness.opens).toEqual([repoPage('acme/b')]);
  expect(toast?.tone).toBe('info');
  expect(messages).toHaveLength(2);
});

test('a subscriber that throws during an open toast leaves one toast timer, and stop cancels it', async () => {
  const harness = makeHarness({
    openInBrowser: () => Promise.resolve({ ok: false, message: 'no such repository' }),
  });

  const toastTimers = () => harness.activeTimers().filter((timer) => timer.delay === 4000);
  let thrown = false;

  await harness.load(makeThread('1'));

  harness.session.subscribe(() => {
    if (!thrown && harness.session.getSnapshot().toast?.lines[0] === 'no such repository') {
      thrown = true;

      throw new Error('subscriber broke');
    }
  });

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();

  expect(thrown).toBe(true);
  expect(toastTimers()).toHaveLength(1);

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();

  expect(toastTimers()).toHaveLength(1);

  const expiring = toastTimers()[0];

  expiring?.callback();

  if (expiring !== undefined) {
    expiring.active = false;
  }

  expect(harness.session.getSnapshot().toast).toBeNull();

  harness.session.send({ kind: 'openInBrowser', pages: [repoPage('acme/app')] });
  await settle();
  await harness.session.stop(new AbortController().signal);

  expect(toastTimers()).toHaveLength(0);
});
