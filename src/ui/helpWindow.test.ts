import { expect, test } from 'bun:test';

import { catalog } from '../commands.ts';
import { footerOf } from './helpWindow.ts';

const withKeys = (keys: Record<string, readonly string[]>) =>
  catalog.map((command) => Object.assign({}, command, { keys: keys[command.id] ?? command.keys }));

test('the help footer shows the first key of each command', () => {
  const moved = withKeys({ scrollHelpDown: ['n', 'x'], scrollHelpUp: ['p'], closeHelp: ['q'] });

  expect(footerOf(moved, '1-5 of 9')).toBe('1-5 of 9  n/p scroll  q close');
});

test('the help footer leaves out the key of a command without keys', () => {
  const bare = withKeys({ scrollHelpDown: [], scrollHelpUp: [], closeHelp: [] });

  expect(footerOf(bare, '1-5 of 9')).toBe('1-5 of 9  / scroll   close');
});
