import { expect, test } from 'bun:test';

import { makeHarness } from './sessionHarness.ts';

test('openCommandLine opens the line with empty text, and editCommandLine sets the text', () => {
  const { session } = makeHarness();

  session.send({ kind: 'openCommandLine' });
  session.send({ kind: 'editCommandLine', text: 'mess' });

  expect(session.getSnapshot().commandLineOpen).toBe(true);
  expect(session.getSnapshot().commandLineText).toBe('mess');
});

test('closeCommandLine closes the line and clears the text', () => {
  const { session } = makeHarness();

  session.send({ kind: 'openCommandLine' });
  session.send({ kind: 'editCommandLine', text: 'mess' });
  session.send({ kind: 'closeCommandLine' });

  expect(session.getSnapshot().commandLineOpen).toBe(false);
  expect(session.getSnapshot().commandLineText).toBe('');
});

test('command completion keeps the original prefix while cycling in either direction', () => {
  const { session } = makeHarness();
  const names = ['quit', 'q', 'quitall', 'qa'];

  const move = (direction: 1 | -1) => {
    session.send({ kind: 'moveCommandLineCompletion', names, direction });
  };

  session.send({ kind: 'openCommandLine' });
  session.send({ kind: 'editCommandLine', text: 'q' });
  move(-1);

  expect(session.getSnapshot().commandLineText).toBe('qa');

  move(1);

  expect(session.getSnapshot().commandLineText).toBe('quit');

  move(-1);

  expect(session.getSnapshot().commandLineText).toBe('qa');
});

test.each(['editCommandLine', 'closeCommandLine', 'openCommandLine'] as const)(
  '%s resets command completion',
  (kind) => {
    const { session } = makeHarness();
    const names = ['messages', 'mine'];

    session.send({ kind: 'openCommandLine' });
    session.send({ kind: 'editCommandLine', text: 'm' });
    session.send({ kind: 'moveCommandLineCompletion', names, direction: 1 });
    session.send({ kind, text: 'mi' });

    expect(session.getSnapshot().commandLineCompletion).toBeNull();

    session.send({ kind: 'moveCommandLineCompletion', names, direction: 1 });

    if (kind === 'editCommandLine') {
      expect(session.getSnapshot().commandLineText).toBe('mine');
    } else if (kind === 'closeCommandLine') {
      expect(session.getSnapshot().commandLineText).toBe('');
    } else {
      expect(session.getSnapshot().commandLineText).toBe('');
    }
  },
);

test('completion ignores a closed command line without publishing a snapshot', () => {
  const { session } = makeHarness();
  const before = session.getSnapshot();

  session.send({ kind: 'moveCommandLineCompletion', names: ['messages'], direction: 1 });

  expect(session.getSnapshot()).toBe(before);
});

test('reportUnknownCommand closes the line and shows an error toast naming the command', () => {
  const { session } = makeHarness();

  session.send({ kind: 'openCommandLine' });
  session.send({ kind: 'editCommandLine', text: 'foo' });
  session.send({ kind: 'reportUnknownCommand', name: 'foo' });

  const snapshot = session.getSnapshot();

  expect(snapshot.commandLineOpen).toBe(false);
  expect(snapshot.commandLineText).toBe('');
  expect(snapshot.toast?.tone).toBe('error');
  expect(snapshot.toast?.title).toContain('foo');
});
