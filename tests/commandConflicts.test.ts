import { expect, test } from 'bun:test';

import { stringifyKeySequence } from '@opentui/keymap';
import { createTestKeymap } from '@opentui/keymap/testing';

import type { Command } from '../src/commands.ts';
import { catalog } from '../src/commands.ts';

const { keymap } = createTestKeymap({ defaultKeys: true });

const strokesOf = (command: Command): string[] =>
  command.keys.map((key) => stringifyKeySequence(keymap.parseKeySequence(key)));

const firstStrokesOf = (command: Command): string[] =>
  command.keys.flatMap((key) => {
    const parts = keymap.parseKeySequence(key);

    return parts.length > 1 ? [stringifyKeySequence(parts.slice(0, 1))] : [];
  });

const singleStrokesOf = (command: Command): string[] =>
  command.keys.flatMap((key) => {
    const parts = keymap.parseKeySequence(key);

    return parts.length === 1 ? [stringifyKeySequence(parts)] : [];
  });

const overlappingKeys = (commands: readonly Command[]): string[] => {
  const clashes: string[] = [];

  for (const [index, command] of commands.entries()) {
    const strokes = strokesOf(command);

    for (const other of commands.slice(index + 1)) {
      if (other.scope !== command.scope) {
        continue;
      }

      const otherStrokes = strokesOf(other);

      for (const stroke of new Set(strokes.filter((entry) => otherStrokes.includes(entry)))) {
        clashes.push(`${command.scope} ${stroke}: ${command.id}, ${other.id}`);
      }

      const pairs = [
        [command, other],
        [other, command],
      ] as const;

      for (const [single, longer] of pairs) {
        const prefixes = firstStrokesOf(longer);

        for (const stroke of singleStrokesOf(single).filter((entry) => prefixes.includes(entry))) {
          clashes.push(`${command.scope} ${stroke} starts a sequence: ${single.id}, ${longer.id}`);
        }
      }
    }
  }

  return clashes;
};

const stubCommand = (id: string, scope: Command['scope'], keys: string[]): Command => ({
  id,
  label: id,
  scope,
  section: 'app',
  keys,
  disabledReason: () => undefined,
  intent: () => ({ kind: 'ui', action: 'openDetail' }),
});

test('no key is bound to two commands whose scopes can be active together', () => {
  expect(overlappingKeys(catalog)).toEqual([]);
});

test('two list commands on spellings of one stroke clash once', () => {
  const clashes = overlappingKeys([
    stubCommand('first', 'list', ['shift+g']),
    stubCommand('second', 'list', ['Shift+G']),
  ]);

  expect(clashes).toEqual(['list shift+g: first, second']);
});

test('a key that starts another command sequence in one scope clashes', () => {
  const clashes = overlappingKeys([
    stubCommand('single', 'list', ['g']),
    stubCommand('double', 'list', ['gg']),
  ]);

  expect(clashes).toHaveLength(1);
  expect(clashes[0]).toContain('list g starts a sequence: single, double');
});

test('a help command and a global command may share a key', () => {
  const clashes = overlappingKeys([
    stubCommand('closeHelp', 'help', ['q']),
    stubCommand('quit', 'global', ['q']),
  ]);

  expect(clashes).toEqual([]);
});

const bindingsOfLayer = (commands: readonly Command[], scope: Command['scope']): Command[] => [
  ...commands.filter((command) => command.scope === scope),
  ...commands
    .filter((command) => command.overlayMove !== undefined)
    .map((command) => Object.assign({}, command, { scope })),
];

test('no overlay layer binds a key to two commands, counting the list move keys', () => {
  for (const scope of ['help', 'messages'] as const) {
    expect(overlappingKeys(bindingsOfLayer(catalog, scope))).toEqual([]);
  }
});

test('an overlay command that takes a list move key clashes in its layer', () => {
  const clashes = overlappingKeys(
    bindingsOfLayer([...catalog, stubCommand('closeHelp2', 'help', ['j'])], 'help'),
  );

  expect(clashes).toEqual(['help j: closeHelp2, selectNext']);
});
