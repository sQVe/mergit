import { expect, test } from 'bun:test';

import { stringifyKeySequence } from '@opentui/keymap';
import { createTestKeymap } from '@opentui/keymap/testing';

import type { Command } from '../src/commands.ts';
import { catalog } from '../src/commands.ts';

const { keymap } = createTestKeymap({ defaultKeys: true });

const strokesOf = (command: Command): string[] =>
  command.keys.map((key) => stringifyKeySequence(keymap.parseKeySequence(key)));

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

test('a help command and a global command may share a key', () => {
  const clashes = overlappingKeys([
    stubCommand('closeHelp', 'help', ['q']),
    stubCommand('quit', 'global', ['q']),
  ]);

  expect(clashes).toEqual([]);
});
