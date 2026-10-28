import { afterEach, expect, test } from 'bun:test';

import type { DetailAnchor, SessionEffects, Snapshot } from '../session/session.ts';
import type { NotificationThread } from '../work/work.ts';
import { toIssueCommentId, toIssueId, toViewerId, toViewerLogin } from '../work/work.ts';
import type { frameLines } from './uiHarness.tsx';
import {
  makeThread,
  pressAll,
  threadsEffects,
  track,
  mount as untrackedMount,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const issueThread: NotificationThread = {
  ...makeThread(1, 'Login redirect drops the workspace'),
  subjectType: 'Issue',
  subjectUrl: 'https://api.github.com/repos/harbor/console/issues/218',
  repository: 'harbor/console',
  reason: 'mention',
};

const releaseThread: NotificationThread = {
  ...makeThread(2, 'Version 2.0 shipped'),
  subjectType: 'Release',
  subjectUrl: 'https://api.github.com/repos/harbor/console/releases/9',
  repository: 'harbor/console',
  reason: 'subscribed',
};

const viewerOf = (login: string) => ({
  id: toViewerId(`U_${login}`),
  login: toViewerLogin(login),
});

const overviewBody = 'After signing in from a workspace link the browser returns to the dashboard.';

const longComment = Array.from(
  { length: 80 },
  (_, index) => `Sentence ${index + 1} explains the retry identity in more detail.`,
).join(' ');

const commentOf = (id: string, author: string, body: string) => ({
  id: toIssueCommentId(id),
  author,
  body,
  createdAt: '1970-01-01T01:00:00Z',
  updatedAt: '1970-01-01T01:00:00Z',
  lastEditedAt: null,
  url: `https://github.com/harbor/console/issues/218#${id}`,
  digest: `digest-${id}`,
});

const issueRead = (comments: ReturnType<typeof commentOf>[], login = 'octocat') => ({
  kind: 'issue' as const,
  viewer: viewerOf(login),
  subject: {
    id: toIssueId('I_218'),
    number: 218,
    url: 'https://github.com/harbor/console/issues/218',
  },
  overview: {
    id: toIssueId('I_218'),
    number: 218,
    url: 'https://github.com/harbor/console/issues/218',
    title: 'Login redirect drops the workspace',
    body: overviewBody,
    state: 'open' as const,
    author: 'nora',
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
    lastEditedAt: null,
    labels: { names: [], totalCount: 0 },
    assignees: { logins: [], totalCount: 0 },
    digest: 'overview-digest',
  },
  comments: { records: comments, totalCount: comments.length, hasNextPage: false, endCursor: null },
});

const twoComments = [
  commentOf('C_1', 'sam', 'Can you check whether the callback removes the workspace query?'),
  commentOf('C_2', 'mira', longComment),
];

const detailEffects = (
  readIssueDetail: SessionEffects['readIssueDetail'],
  threads: readonly NotificationThread[] = [issueThread],
): SessionEffects => ({ ...threadsEffects(threads), readIssueDetail });

const issueEffects = (login = 'octocat') =>
  detailEffects(() => Promise.resolve({ ok: true as const, value: issueRead(twoComments, login) }));

const openReader = async (press: (key: string) => Promise<void>) => {
  await pressAll(press, ['r', 'j', 'j', 'return']);
};

const frameOf = (setup: Parameters<typeof frameLines>[0]): string => setup.captureCharFrame();

for (const [width, height] of [
  [80, 24],
  [120, 40],
] as const) {
  test(`at ${width}x${height}, a focused issue shows identity, reason, tabs, and both texts`, async () => {
    const { setup, press } = await mount({ effects: issueEffects(), width, height });

    await openReader(press);

    const overview = frameOf(setup);

    expect(overview).toContain('harbor/console');
    expect(overview).toContain('Issue #218');
    expect(overview).toContain('mention');
    expect(overview).toContain('Overview');
    expect(overview).toContain('Discussion');
    expect(overview).toContain('After signing in from a workspace link');

    await press('l');

    const discussion = frameOf(setup);

    expect(discussion).toContain('Can you check whether the callback');
    expect(discussion).toContain('@sam');
  });

  test(`at ${width}x${height}, the reader hint line keeps whole close, tab, and scroll hints`, async () => {
    const { setup, press } = await mount({ effects: issueEffects(), width, height });

    await openReader(press);

    const hint = frameOf(setup)
      .split('\n')
      .find((line) => line.includes(' close'));

    expect(hint).toBeDefined();
    expect(hint).toContain('Esc close');
    expect(hint).toContain(' tab');
    expect(hint).toContain(' scroll');
    expect(hint).not.toContain('…');
  });
}

const readerTextOf = (line: string): string => (line.split('│').at(-1) ?? '').trim();

const topBodyLine = (setup: Parameters<typeof frameLines>[0]): string => {
  const lines = setup.captureCharFrame().split('\n');
  const tabRow = lines.findIndex((line) => line.includes('*]'));

  return readerTextOf(lines[tabRow + 1] ?? '');
};

const discussionAnchorOf = (session: { getSnapshot: () => Snapshot }) => {
  const { activeKey, entries } = session.getSnapshot().detail;

  return activeKey === null ? undefined : entries.get(activeKey)?.anchors.discussion;
};

const anchorOffset = (anchor: DetailAnchor | undefined): number | undefined =>
  anchor?.position.kind === 'text' ? anchor.position.offset : undefined;

test('Discussion keeps its top line across tab switches and holds the anchor offset after a resize', async () => {
  const { setup, press, resize, session } = await mount({
    effects: issueEffects(),
    width: 120,
    height: 40,
  });

  await openReader(press);
  await press('l');

  await pressAll(
    press,
    Array.from({ length: 10 }, () => 'j'),
  );

  const scrolled = topBodyLine(setup);

  expect(longComment).toContain(scrolled);
  expect(longComment.startsWith(scrolled)).toBe(false);

  await press('h');

  expect(setup.captureCharFrame()).toContain('[Overview*]');

  await press('l');

  expect(topBodyLine(setup)).toBe(scrolled);

  await resize(80, 24);

  const anchor = discussionAnchorOf(session);
  const narrow = topBodyLine(setup);
  const start = longComment.indexOf(narrow);

  expect(anchor?.recordId).toBe('C_2');
  expect(start).toBeGreaterThan(-1);
  expect(start).toBeLessThanOrEqual(anchorOffset(anchor) ?? -1);
  expect(start + narrow.length).toBeGreaterThan(anchorOffset(anchor) ?? Infinity);
});

test('a release shows its metadata, the unsupported note, and the Open hint', async () => {
  const { setup, press } = await mount({
    effects: detailEffects(
      () => Promise.resolve({ ok: false as const, failure: { kind: 'ghMissing' as const } }),
      [releaseThread],
    ),
    width: 80,
    height: 24,
  });

  await openReader(press);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('harbor/console / Release');
  expect(frame).toContain('Version 2.0 shipped');
  expect(frame).toContain('subscribed');
  expect(frame).toContain('Updated 3h ago');
  expect(frame).toContain('Unread yes');
  expect(frame).toContain('Mergit cannot show this content yet.');
  expect(frame).toContain('Press o/gx to open it in the browser.');
});

test('a failed later comment page leaves Discussion partial with the loaded comments', async () => {
  const pagedRead = (request: { commentsAfter: string | null }) => {
    if (request.commentsAfter !== null) {
      return Promise.resolve({
        ok: false as const,
        failure: { kind: 'invalidResponse' as const, message: 'Response body is not JSON' },
      });
    }

    const first = issueRead(twoComments);

    return Promise.resolve({
      ok: true as const,
      value: {
        ...first,
        comments: { ...first.comments, totalCount: 5, hasNextPage: true, endCursor: 'page-1' },
      },
    });
  };

  const { setup, press } = await mount({
    effects: detailEffects(pagedRead),
    width: 80,
    height: 24,
  });

  await openReader(press);
  await press('l');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Overview [Discussion*] 5');
  expect(frame).toContain('Partial: 2 loaded, more may exist');
  expect(frame).toContain('Can you check whether the callback');
});

test('a detail read from another account shows a notice naming it and no content', async () => {
  const { setup, press } = await mount({ effects: issueEffects('someone'), width: 80, height: 24 });

  await openReader(press);

  const overview = setup.captureCharFrame();

  expect(overview).toContain('@someone');
  expect(overview).not.toContain(overviewBody.slice(0, 30));

  await press('l');

  expect(setup.captureCharFrame()).not.toContain('Can you check whether the callback');
});

const pressUntilTop = async (
  press: (key: string) => Promise<void>,
  setup: Parameters<typeof frameLines>[0],
  text: string,
) => {
  for (let step = 0; step < 40 && !topBodyLine(setup).startsWith(text); step += 1) {
    await press('j');
  }
};

test('a refresh that removes the anchored comment shows the nearest comment before it', async () => {
  const fourComments = [
    commentOf('C_a', 'ana', 'First short comment.'),
    commentOf('C_b', 'ben', 'Second short comment.'),
    commentOf('C_c', 'cai', 'Third short comment.'),
    commentOf('C_d', 'dee', longComment),
  ];

  let reads = 0;

  const read = () => {
    reads += 1;

    const comments = reads === 1 ? fourComments : fourComments.filter(({ id }) => id !== 'C_c');

    return Promise.resolve({ ok: true as const, value: issueRead(comments) });
  };

  const { setup, press } = await mount({ effects: detailEffects(read), width: 80, height: 24 });

  await openReader(press);
  await press('l');
  await pressUntilTop(press, setup, '@cai');

  expect(topBodyLine(setup)).toStartWith('@cai');

  await press('r');

  expect(reads).toBe(2);
  expect(topBodyLine(setup)).toStartWith('@ben');
});

test('scrolling one line at a time from a comment heading shows every text line in order', async () => {
  const { setup, press } = await mount({ effects: issueEffects(), width: 80, height: 24 });

  await openReader(press);
  await press('l');
  await pressUntilTop(press, setup, '@mira');

  const tops: string[] = [];

  for (let step = 0; step < 8; step += 1) {
    await press('j');
    tops.push(topBodyLine(setup));
  }

  expect(longComment.startsWith(tops.join(' '))).toBe(true);
});

test('growing the terminal near the end keeps the anchored line at the top', async () => {
  const { setup, press, resize } = await mount({ effects: issueEffects(), width: 120, height: 24 });

  await openReader(press);
  await press('l');

  await pressAll(
    press,
    Array.from({ length: 8 }, () => 'ctrl+d'),
  );

  const bottom = topBodyLine(setup);

  expect(longComment).toContain(bottom);

  await resize(120, 40);

  expect(topBodyLine(setup)).toBe(bottom);
});

test('a narrow-to-wide resize near the end keeps the line holding the anchor offset at the top', async () => {
  const { setup, press, resize, session } = await mount({
    effects: issueEffects(),
    width: 80,
    height: 24,
  });

  await openReader(press);
  await press('l');

  await pressAll(
    press,
    Array.from({ length: 12 }, () => 'ctrl+d'),
  );

  await resize(120, 24);

  const anchor = discussionAnchorOf(session);
  const wide = topBodyLine(setup);
  const start = longComment.indexOf(wide);

  expect(anchor?.recordId).toBe('C_2');
  expect(start).toBeGreaterThan(-1);
  expect(start).toBeLessThanOrEqual(anchorOffset(anchor) ?? -1);
  expect(start + wide.length).toBeGreaterThan(anchorOffset(anchor) ?? Infinity);
});

test('returning to an issue after reading another keeps its tab and top line', async () => {
  const otherThread: NotificationThread = {
    ...issueThread,
    ...makeThread(3, 'Another issue'),
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/harbor/console/issues/219',
    repository: 'harbor/console',
    reason: 'mention',
  };

  const { setup, press } = await mount({
    effects: detailEffects(
      () => Promise.resolve({ ok: true as const, value: issueRead(twoComments) }),
      [issueThread, otherThread],
    ),
    width: 80,
    height: 24,
  });

  await openReader(press);
  await press('l');

  await pressAll(
    press,
    Array.from({ length: 9 }, () => 'j'),
  );

  const scrolled = topBodyLine(setup);
  const firstNumber = setup.captureCharFrame().includes('Issue #218') ? '#218' : '#219';

  expect(longComment).toContain(scrolled);

  await pressAll(press, ['escape', 'j', 'return']);

  expect(setup.captureCharFrame()).not.toContain(`Issue ${firstNumber}`);
  expect(setup.captureCharFrame()).toContain('[Overview*]');

  await pressAll(press, ['escape', 'k', 'return']);

  expect(setup.captureCharFrame()).toContain(`Issue ${firstNumber}`);
  expect(topBodyLine(setup)).toBe(scrolled);
});

test('a separator anchor whose earlier records all disappear shows its record at the top', async () => {
  const threeComments = [
    commentOf('C_a', 'ana', 'First short comment.'),
    commentOf('C_b', 'ben', 'Second short comment.'),
    commentOf('C_d', 'dee', longComment),
  ];

  let reads = 0;

  const read = () => {
    reads += 1;

    const comments = reads === 1 ? threeComments : threeComments.filter(({ id }) => id !== 'C_a');

    return Promise.resolve({ ok: true as const, value: issueRead(comments) });
  };

  const { setup, press } = await mount({ effects: detailEffects(read), width: 80, height: 24 });

  await openReader(press);
  await press('l');
  await pressUntilTop(press, setup, '@ben');
  await press('k');

  expect(topBodyLine(setup)).toBe('');

  await press('r');

  const lines = setup.captureCharFrame().split('\n');
  const tabRow = lines.findIndex((line) => line.includes('[Discussion*]'));

  expect(reads).toBe(2);
  expect(readerTextOf(lines[tabRow + 1] ?? '')).toStartWith('@ben');
  expect(readerTextOf(lines[tabRow + 2] ?? '')).toBe('Second short comment.');
});

test('a failed issue read shows the failure on both tabs', async () => {
  const failure = { kind: 'invalidResponse' as const, message: 'Response body is not JSON' };

  const { setup, press } = await mount({
    effects: detailEffects(() => Promise.resolve({ ok: false as const, failure })),
    width: 80,
    height: 24,
  });

  await openReader(press);

  expect(setup.captureCharFrame()).toContain('Failed: ');
  expect(setup.captureCharFrame()).toContain('Response body is not JSON');
  expect(setup.captureCharFrame()).not.toContain('Showing loaded content');

  await press('l');

  expect(setup.captureCharFrame()).toContain('Failed: ');
});

test('an issue that is gone shows Unavailable and no content', async () => {
  const unavailable = { kind: 'unavailable' as const, viewer: viewerOf('octocat') };

  const { setup, press } = await mount({
    effects: detailEffects(() => Promise.resolve({ ok: true as const, value: unavailable })),
    width: 80,
    height: 24,
  });

  await openReader(press);

  expect(setup.captureCharFrame()).toContain('Unavailable');
  expect(setup.captureCharFrame()).not.toContain('Loading');
});

test('an issue without comments shows the empty Discussion notice', async () => {
  const { setup, press } = await mount({
    effects: detailEffects(() => Promise.resolve({ ok: true as const, value: issueRead([]) })),
    width: 80,
    height: 24,
  });

  await openReader(press);
  await press('l');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Overview [Discussion*] 0');
  expect(frame).toContain('No comments.');
});

test('the header shows the state, author, and title of the fetched issue over the notification', async () => {
  const fetched = issueRead(twoComments);

  const changed = {
    ...fetched,
    overview: {
      ...fetched.overview,
      title: 'Workspace lost after login',
      state: 'closed' as const,
      author: 'zed',
    },
  };

  const { setup, press } = await mount({
    effects: detailEffects(() => Promise.resolve({ ok: true as const, value: changed })),
    width: 80,
    height: 24,
  });

  await openReader(press);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Issue #218 / closed / @zed');
  expect(frame).toContain('Workspace lost after login');
});

const bodyReadWith = (body: string) => {
  const fetched = issueRead(twoComments);

  return { ...fetched, overview: { ...fetched.overview, body } };
};

test('control characters in an issue body show as replacement text and never reach the frame', async () => {
  const body = 'Restart \x1b[31mred\x07 and\x9b done.';

  const { setup, press } = await mount({
    effects: detailEffects(() => Promise.resolve({ ok: true as const, value: bodyReadWith(body) })),
    width: 80,
    height: 24,
  });

  await openReader(press);

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Restart \uFFFD[31mred\uFFFD and\uFFFD done.');
  expect(frame).not.toContain('\x1b');
  expect(frame).not.toContain('\x07');
  expect(frame).not.toContain('\x9b');
});

test('a CRLF issue body keeps each line break and shows no replacement text', async () => {
  const { setup, press } = await mount({
    effects: detailEffects(() =>
      Promise.resolve({ ok: true as const, value: bodyReadWith('First line\r\nSecond line') }),
    ),
    width: 80,
    height: 24,
  });

  await openReader(press);

  const frame = setup.captureCharFrame();
  const lines = frame.split('\n');
  const rowOf = (text: string) => lines.findIndex((line) => line.includes(text));

  expect(rowOf('Second line')).toBe(rowOf('First line') + 1);
  expect(frame).not.toContain('\uFFFD');
});

test('moving the other pane in the reader shows the next issue and returns to the first tab and top line', async () => {
  const otherThread: NotificationThread = {
    ...issueThread,
    ...makeThread(3, 'Session expiry ignores the workspace'),
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/harbor/console/issues/219',
    repository: 'harbor/console',
    reason: 'mention',
  };

  const otherBody = 'The session timer keeps running after the workspace switch.';

  const readOf = (number: number) => {
    const read = issueRead(twoComments);

    if (number !== 219) {
      return read;
    }

    const id = toIssueId('I_219');
    const url = 'https://github.com/harbor/console/issues/219';

    return {
      ...read,
      subject: { id, number, url },
      overview: { ...read.overview, id, number, url, body: otherBody },
    };
  };

  const { setup, press } = await mount({
    effects: detailEffects(
      (request) => {
        const number = 'number' in request.coordinates ? request.coordinates.number : 218;

        return Promise.resolve({ ok: true as const, value: readOf(number) });
      },
      [issueThread, otherThread],
    ),
    width: 80,
    height: 24,
  });

  await openReader(press);

  const firstIsOther = setup.captureCharFrame().includes('Issue #219');
  const [firstNumber, secondNumber] = firstIsOther ? ['#219', '#218'] : ['#218', '#219'];
  const secondBody = firstIsOther ? overviewBody : otherBody;

  await press('l');

  await pressAll(
    press,
    Array.from({ length: 9 }, () => 'j'),
  );

  const scrolled = topBodyLine(setup);

  expect(longComment).toContain(scrolled);

  await press('ctrl+n');

  const second = setup.captureCharFrame();

  expect(second).toContain(`Issue ${secondNumber}`);
  expect(second).toContain('[Overview*]');
  expect(second).toContain(secondBody.slice(0, 40));

  await press('ctrl+p');

  expect(setup.captureCharFrame()).toContain(`Issue ${firstNumber}`);
  expect(topBodyLine(setup)).toBe(scrolled);
});

const pressUntil = async (
  press: (key: string) => Promise<void>,
  key: string,
  isDone: () => boolean,
) => {
  for (let step = 0; step < 40 && !isDone(); step += 1) {
    await press(key);
  }
};

const openHint = 'Press o/gx to open it in the browser.';

test('a release notice taller than the pane scrolls down to the open hint and back up', async () => {
  const { setup, press } = await mount({
    effects: detailEffects(
      () => Promise.resolve({ ok: false as const, failure: { kind: 'ghMissing' as const } }),
      [releaseThread],
    ),
    width: 40,
    height: 8,
  });

  await openReader(press);

  expect(frameOf(setup)).not.toContain(openHint);

  await pressUntil(press, 'j', () => frameOf(setup).includes(openHint));

  expect(frameOf(setup)).toContain(openHint);

  await pressUntil(press, 'k', () => frameOf(setup).includes('Updated 3h ago'));

  expect(frameOf(setup)).toContain('Updated 3h ago');
});

test('a viewer-mismatch notice in a short narrow pane scrolls to its last line', async () => {
  const { setup, press } = await mount({ effects: issueEffects('someone'), width: 30, height: 8 });

  await openReader(press);

  const readerLines = () => frameOf(setup).split('\n').map(readerTextOf);

  expect(frameOf(setup)).toContain('This content was read as');
  expect(readerLines()).not.toContain('it.');

  await pressUntil(press, 'j', () => readerLines().includes('it.'));

  expect(readerLines()).toContain('it.');
  expect(frameOf(setup)).not.toContain('This content was read as');
});

test('switching from a scrolled release to an issue shows the issue from its top', async () => {
  const { setup, press } = await mount({
    effects: detailEffects(
      () => Promise.resolve({ ok: true as const, value: issueRead(twoComments) }),
      [issueThread, releaseThread],
    ),
    width: 40,
    height: 8,
  });

  await openReader(press);

  await pressUntil(press, 'ctrl+n', () =>
    frameOf(setup).includes('Mergit cannot show this content yet.'),
  );

  await pressUntil(press, 'j', () => frameOf(setup).includes(openHint));

  expect(frameOf(setup)).toContain(openHint);

  await press('ctrl+p');

  const issue = frameOf(setup);

  expect(issue).toContain('Issue #218');
  expect(issue).toContain('[Overview*]');
  expect(overviewBody.startsWith(topBodyLine(setup))).toBe(true);
});

test('a release scrolled during a viewer mismatch shows its own notice from the top after the mismatch clears', async () => {
  let reads = 0;

  const { setup, press } = await mount({
    effects: detailEffects(() => {
      reads += 1;

      const login = reads === 1 ? 'someone' : 'octocat';

      return Promise.resolve({
        ok: true as const,
        value: { kind: 'unavailable' as const, viewer: viewerOf(login) },
      });
    }, [issueThread, releaseThread]),
    width: 30,
    height: 8,
  });

  await openReader(press);
  await press('ctrl+n');

  const readerLines = () => frameOf(setup).split('\n').map(readerTextOf);

  await pressUntil(press, 'j', () => readerLines().includes('it.'));
  await press('ctrl+p');
  await press('ctrl+n');

  expect(frameOf(setup)).toContain('Updated 3h ago');
});
