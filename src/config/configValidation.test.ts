import { expect, test } from 'bun:test';

import { catalog } from '../commands.ts';
import { loadConfig } from './config.ts';

const path = '/test-config/mergit/config.json';

const loadText = (text: string) =>
  loadConfig({ XDG_CONFIG_HOME: '/test-config' }, { readFile: () => ({ kind: 'text', text }) });

const failureOf = (text: string): string => {
  const result = loadText(text);

  expect(result.ok).toBe(false);

  if (result.ok) {
    throw new Error('The config loaded.');
  }

  expect(result.message).toContain(path);

  return result.message;
};

test('Escape after a prefix is refused with the entry and cancellation rule', () => {
  const before = catalog.map((command) => [...command.keys]);
  const message = failureOf('{"version":1,"keys":{"cancelInput":["x<Esc>"]}}');

  expect(message).toContain('keys.cancelInput "x<Esc>"');
  expect(message).toContain('Escape cancels a pending sequence');
  expect(message).toContain('first stroke');
  expect(catalog.map((command) => command.keys)).toEqual(before);
});

test('standalone Escape and Escape as the first stroke remain usable config keys', () => {
  const result = loadText('{"version":1,"keys":{"cancelInput":["<Esc>"],"refresh":["<Esc>x"]}}');

  expect(result.ok).toBe(true);

  if (result.ok) {
    expect(result.catalog.find((command) => command.id === 'cancelInput')?.keys).toEqual([
      'escape',
    ]);

    expect(result.catalog.find((command) => command.id === 'refresh')?.keys).toEqual(['escapex']);
  }
});

for (const field of ['keys', 'aliases']) {
  test(`literal JSON __proto__ is refused as an unknown ${field} id`, () => {
    const before = catalog.map((command) => [...command.keys]);
    const message = failureOf(`{"version":1,"${field}":{"__proto__":["x"]}}`);

    expect(message).toContain(`${field}.__proto__`);
    expect(message).toContain('not a config id');
    expect(catalog.map((command) => command.keys)).toEqual(before);
  });
}

for (const text of ['null', '[]', '"config"', '1']) {
  test(`non-object config ${text} is refused with its path`, () => {
    const message = failureOf(text);

    expect(message).toContain('one JSON object');
  });
}

for (const [text, entry] of [
  ['{"version":1,"keys":{"refresh":"R"}}', 'keys.refresh'],
  ['{"version":1,"keys":{"refresh":[1]}}', 'keys.refresh.0'],
  ['{"version":1,"aliases":{"refresh":null}}', 'aliases.refresh'],
  ['{"version":1,"aliases":[]}', 'aliases'],
] as const) {
  test(`malformed entry ${text} names the invalid value's path`, () => {
    const message = failureOf(text);

    expect(message).toContain(entry);
    expect(message).toContain('list of strings');
  });
}

test.each([
  ['x', 'xx', 'keys.refresh "x" starts keys.markDone "xx"'],
  ['xx', 'x', 'keys.markDone "x" starts keys.refresh "xx"'],
])('prefix conflict %s versus %s names the blocking direction', (refresh, markDone, relation) => {
  const text = JSON.stringify({ version: 1, keys: { refresh: [refresh], markDone: [markDone] } });
  const message = failureOf(text);

  expect(message).toContain(relation);
  expect(message).toContain('can never run');
});

test('equal user keys report equality rather than a prefix relation', () => {
  const message = failureOf('{"version":1,"keys":{"refresh":["x"],"markDone":["x"]}}');

  expect(message).toContain('use the same key in the list layer');
  expect(message).toContain('Give one of them another key');
  expect(message).not.toContain('starts');
});

for (const sequence of ['<C-c>x', 'x<C-c>', 'x<C-c>y']) {
  test(`quit refuses Ctrl+C inside the sequence ${sequence} without changing defaults`, () => {
    const before = catalog.map((command) =>
      Object.assign({}, command, { keys: [...command.keys] }),
    );

    const text = JSON.stringify({ version: 1, keys: { quit: [sequence] } });
    const message = failureOf(text);

    expect(message).toContain('keys.quit');
    expect(message).toContain(sequence);
    expect(message).toContain('Ctrl+C');
    expect(catalog).toEqual(before);
  });
}

const requiredCommands = [
  'cancelInput',
  'closeCommandLine',
  'closeDetail',
  'closeHelp',
  'closeMessages',
  'cancelOpen',
  'closeFilters',
];

const protocolControls = ['<C-i>', '<C-m>', '<C-h>', '<C-j>'];

for (const command of requiredCommands) {
  for (const control of protocolControls) {
    test(`${command} cannot rely only on ${control} to close on legacy terminals`, () => {
      const before = catalog.map((entry) => [...entry.keys]);
      const text = JSON.stringify({ version: 1, keys: { [command]: [control] } });
      const message = failureOf(text);

      expect(message).toContain(command);
      expect(message).toContain('Ctrl+I, Ctrl+M, Ctrl+H, and Ctrl+J require Kitty');
      expect(message).toContain('Keep or add another portable key');
      expect(catalog.map((entry) => entry.keys)).toEqual(before);
    });
  }

  test(`${command} may retain protocol-dependent controls beside a portable Escape key`, () => {
    const keys = [...protocolControls, '<Esc>'];
    const text = JSON.stringify({ version: 1, keys: { [command]: keys } });
    const result = loadText(text);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.catalog.find((entry) => entry.id === command)?.keys).toEqual([
        'ctrl+i',
        'ctrl+m',
        'ctrl+h',
        'ctrl+j',
        'escape',
      ]);
    }
  });
}

test('several protocol-dependent variants do not provide a portable close key', () => {
  const text = JSON.stringify({ version: 1, keys: { closeHelp: protocolControls } });
  const message = failureOf(text);

  expect(message).toContain('closeHelp');
  expect(message).toContain('portable key');
});

for (const control of protocolControls) {
  for (const sequence of [`${control}x`, `x${control}y`, `x${control}`]) {
    test(`required sequence ${sequence} depends on Kitty at one of its strokes`, () => {
      const text = JSON.stringify({ version: 1, keys: { closeHelp: [sequence] } });
      const message = failureOf(text);

      expect(message).toContain('closeHelp');
      expect(message).toContain('Kitty');
      expect(message).toContain('portable key');
    });
  }
}

test('ordinary letters in a required sequence remain portable', () => {
  const result = loadText('{"version":1,"keys":{"closeHelp":["himj"]}}');

  expect(result.ok).toBe(true);

  if (result.ok) {
    expect(result.catalog.find((command) => command.id === 'closeHelp')?.keys).toEqual(['himj']);
  }
});

test('non-required controls keep their distinct meanings beside legacy-equivalent keys', () => {
  const keys = [...protocolControls, '<Tab>', '<CR>', '<BS>'];
  const text = JSON.stringify({ version: 1, keys: { refresh: keys } });
  const result = loadText(text);

  expect(result.ok).toBe(true);

  if (result.ok) {
    expect(result.catalog.find((command) => command.id === 'refresh')?.keys).toEqual([
      'ctrl+i',
      'ctrl+m',
      'ctrl+h',
      'ctrl+j',
      'tab',
      'return',
      'backspace',
    ]);
  }
});

test('removing the last portable default refuses a required command with a nonportable survivor', () => {
  const closeHelp = catalog.find((command) => command.id === 'closeHelp');

  if (closeHelp === undefined) {
    throw new Error('The catalog must have closeHelp.');
  }

  const originalKeys = closeHelp.keys;

  try {
    closeHelp.keys = ['ctrl+i', 'escape'];

    const beforeConflict = loadText('{"version":1}');

    expect(beforeConflict.ok).toBe(true);

    if (beforeConflict.ok) {
      expect(beforeConflict.catalog.find((command) => command.id === 'closeHelp')?.keys).toEqual([
        'ctrl+i',
        'escape',
      ]);
    }

    const message = failureOf('{"version":1,"keys":{"selectNext":["<Esc>"]}}');

    expect(message).toContain('closeHelp');
    expect(message).toContain('Kitty');
    expect(message).toContain('Keep or add another portable key');
    expect(closeHelp.keys).toEqual(['ctrl+i', 'escape']);
  } finally {
    closeHelp.keys = originalKeys;
  }

  expect(closeHelp.keys).toBe(originalKeys);
});

test.each([
  ['enter', 'Write <CR> in brackets instead.'],
  ['ctrl+x', 'Write <C-x> in brackets instead.'],
])('ambiguous key %s suggests the usable bracket notation', (key, suggestion) => {
  const text = JSON.stringify({ version: 1, keys: { refresh: [key] } });
  const message = failureOf(text);

  expect(message).toContain('keys.refresh');
  expect(message).toContain(suggestion);
});
