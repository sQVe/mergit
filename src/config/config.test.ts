import { expect, test } from 'bun:test';

import { stringifyKeySequence } from '@opentui/keymap';
import { createTestKeymap } from '@opentui/keymap/testing';

import type { Command } from '../commands.ts';
import { catalog, commandsOfLayer } from '../commands.ts';
import { loadConfig } from './config.ts';

const configPath = '/test-config/mergit/config.json';

const loadText = (text: string) =>
  loadConfig({ XDG_CONFIG_HOME: '/test-config' }, { readFile: () => ({ kind: 'text', text }) });

const loaded = (config: unknown) => {
  const result = loadText(JSON.stringify(config));

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result;
};

const failure = (config: unknown) => {
  const result = loadText(JSON.stringify(config));

  if (result.ok) {
    throw new Error('The config loaded.');
  }

  return { path: configPath, message: result.message };
};

const commandOf = (commands: readonly Command[], id: string): Command => {
  const command = commands.find((candidate) => candidate.id === id);

  if (command === undefined) {
    throw new Error(`No command ${id}.`);
  }

  return command;
};

const configIds = [
  'quit',
  'help',
  'selectNext',
  'selectPrevious',
  'selectFirst',
  'selectLast',
  'selectNextGroup',
  'selectPreviousGroup',
  'toggleFold',
  'openFold',
  'closeFold',
  'openAllFolds',
  'closeAllFolds',
  'centerSelectedRow',
  'topSelectedRow',
  'bottomSelectedRow',
  'halfPageDown',
  'halfPageUp',
  'pageDown',
  'pageUp',
  'activateRow',
  'cycleGrouping',
  'refresh',
  'markDone',
  'openInBrowser',
  'undoDone',
  'openSearch',
  'clearSearch',
  'openCommandLine',
  'openFilters',
  'clearFilters',
  'submitInput',
  'nextSearchCompletion',
  'previousSearchCompletion',
  'cancelInput',
  'clearLine',
  'closeEmptyLine',
  'runCommandLine',
  'closeCommandLine',
  'closeDetail',
  'openHelpSearch',
  'keepHelpSearch',
  'cancelHelpSearch',
  'clearHelpSearch',
  'closeHelp',
  'showMessages',
  'closeMessages',
  'confirmOpen',
  'cancelOpen',
  'applyFilterRow',
  'takeFilterRow',
  'moveFilterUp',
  'moveFilterDown',
  'closeFilters',
];

const defaultKeysInVim: Record<string, string[]> = {
  quit: ['q', '<C-c>'],
  help: ['?'],
  selectNext: ['j', '<Down>'],
  selectPrevious: ['k', '<Up>'],
  selectFirst: ['gg'],
  selectLast: ['G'],
  selectNextGroup: ['J'],
  selectPreviousGroup: ['K'],
  toggleFold: ['za', '<Space>'],
  openFold: ['zo'],
  closeFold: ['zc'],
  openAllFolds: ['zR'],
  closeAllFolds: ['zM'],
  centerSelectedRow: ['zz'],
  topSelectedRow: ['zt'],
  bottomSelectedRow: ['zb'],
  halfPageDown: ['<C-d>'],
  halfPageUp: ['<C-u>'],
  pageDown: ['<C-f>'],
  pageUp: ['<C-b>'],
  activateRow: ['<CR>'],
  cycleGrouping: ['s'],
  refresh: ['r'],
  markDone: ['d'],
  openInBrowser: ['o', 'gx'],
  undoDone: ['u'],
  openSearch: ['/'],
  clearSearch: ['<Esc>'],
  openCommandLine: [':'],
  openFilters: ['f'],
  clearFilters: ['F'],
  submitInput: ['<CR>'],
  nextSearchCompletion: ['<Tab>'],
  previousSearchCompletion: ['<S-Tab>'],
  cancelInput: ['<Esc>'],
  clearLine: ['<C-u>'],
  closeEmptyLine: ['<BS>'],
  runCommandLine: ['<CR>'],
  closeCommandLine: ['<Esc>'],
  closeDetail: ['<Esc>'],
  openHelpSearch: ['/'],
  keepHelpSearch: ['<CR>'],
  cancelHelpSearch: ['<Esc>'],
  clearHelpSearch: ['<C-u>'],
  closeHelp: ['q', '<Esc>'],
  showMessages: [],
  closeMessages: ['q', '<Esc>'],
  confirmOpen: ['y', '<CR>'],
  cancelOpen: ['n', '<Esc>'],
  applyFilterRow: ['<CR>'],
  takeFilterRow: ['<Tab>'],
  moveFilterUp: ['<Up>', '<C-p>'],
  moveFilterDown: ['<Down>', '<C-n>'],
  closeFilters: ['<Esc>'],
};

test('version 1 clearLine on Escape keeps its original input scopes and help cancel binding', () => {
  const config = {
    version: 1,
    keys: {
      clearLine: ['<Esc>'],
      cancelInput: ['<C-x>'],
      closeCommandLine: ['<C-x>'],
      closeFilters: ['<C-x>'],
    },
  };

  const result = loaded(config);
  const clearing = result.catalog.filter((command) => command.configId === 'clearLine');

  expect(result.notices).toEqual([]);
  expect(clearing.map((command) => command.scope)).toEqual(['input', 'command', 'filter']);

  for (const command of clearing) {
    expect(command.keys).toEqual(['escape']);
  }

  expect(commandOf(result.catalog, 'cancelHelpSearch').keys).toEqual(['escape']);
  expect(commandOf(result.catalog, 'clearHelpSearch').keys).toEqual(['ctrl+u']);
});

test('help clearing has an independent version 1 public remap', () => {
  const result = loaded({ version: 1, keys: { clearHelpSearch: ['<C-x>'] } });

  expect(commandOf(result.catalog, 'clearHelpSearch').keys).toEqual(['ctrl+x']);

  const clearing = result.catalog.filter((command) => command.configId === 'clearLine');

  for (const command of clearing) {
    expect(command.keys).toEqual(['ctrl+u']);
  }
});

test('a key in Vim notation replaces the default keys of a command', () => {
  const result = loaded({ version: 1, keys: { selectLast: ['G'] } });

  expect(commandOf(result.catalog, 'selectLast').keys).toEqual(['shift+g']);
});

test('Vim notation becomes the catalog key strings', () => {
  const result = loaded({
    version: 1,
    keys: {
      cycleGrouping: ['esc'],
      selectLast: ['G'],
      openAllFolds: ['zR'],
      clearSearch: ['<Esc>'],
      activateRow: ['<CR>', '<c-X>', '<lt>', '<S-Tab>'],
    },
  });

  const keysOf = (id: string) => commandOf(result.catalog, id).keys;

  const { keymap } = createTestKeymap({ defaultKeys: true });

  const strokes = keymap
    .parseKeySequence(keysOf('cycleGrouping').join(''))
    .map((part) => stringifyKeySequence([part]));

  expect(strokes).toEqual(['e', 's', 'c']);
  expect(keysOf('selectLast')).toEqual(['shift+g']);
  expect(keysOf('openAllFolds')).toEqual(['zshift+r']);
  expect(keysOf('clearSearch')).toEqual(['escape']);
  expect(keysOf('activateRow')).toEqual(['return', 'ctrl+x', '<', 'shift+tab']);
});

test('the letters of a key name must be written in brackets', () => {
  const { path, message } = failure({ version: 1, keys: { refresh: ['enter'] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.refresh');
  expect(message).toContain('"enter"');
  expect(message).toContain('<CR>');
});

test('a missing version stops and names the version', () => {
  const { path, message } = failure({ keys: {} });

  expect(message).toContain(path);
  expect(message).toContain('version');
  expect(message).toContain('1');
});

test('an unknown version stops and names the valid version', () => {
  const { path, message } = failure({ version: 2 });

  expect(message).toContain(path);
  expect(message).toContain('version 2');
  expect(message).toContain('Use version 1');
});

test('an unknown top-level field stops and lists the fields', () => {
  const { path, message } = failure({ version: 1, theme: 'dark' });

  expect(message).toContain(path);
  expect(message).toContain('"theme"');
  expect(message).toContain('version, keys, aliases');
});

test('an unknown config id stops and lists the config ids', () => {
  const { path, message } = failure({ version: 1, keys: { selectLaster: ['G'] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.selectLaster');
  expect(message.split('Valid ids: ')[1]?.split(', ')).toEqual(configIds);
});

const knownNameList =
  '<CR>, <Enter>, <Return>, <Esc>, <Space>, <Tab>, <S-Tab>, <BS>, <Up>, <Down>, <Left>, <Right>, <lt>, <C-a> to <C-z>';

test('a list key lost to a user key stays on the overlay layers', () => {
  const result = loaded({ version: 1, keys: { refresh: ['j'] } });
  const selectNext = commandOf(result.catalog, 'selectNext');

  const layerKeysOf = (scope: Command['scope']) =>
    commandsOfLayer(result.catalog, scope).find((command) => command.id === 'selectNext')?.keys;

  expect(selectNext.keys).toEqual(['down']);
  expect(layerKeysOf('list')).toEqual(['down']);
  expect(layerKeysOf('help')).toEqual(['j', 'down']);
  expect(layerKeysOf('messages')).toEqual(['j', 'down']);
  expect(result.notices).toHaveLength(1);
});

test('a hidden quit copy has no config id', () => {
  const { message } = failure({ version: 1, keys: { quitFromInput: ['x'] } });

  expect(message).toContain('keys.quitFromInput');
});

test('a key with a literal space stops and names the entry', () => {
  const { path, message } = failure({ version: 1, keys: { refresh: ['a b'] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.refresh');
  expect(message).toContain('"a b"');
  expect(message).toContain(knownNameList);
});

test('an empty key stops and names the entry', () => {
  const { path, message } = failure({ version: 1, keys: { refresh: [''] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.refresh');
  expect(message).toContain(knownNameList);
});

test('an unclosed bracket stops and names the entry', () => {
  const { path, message } = failure({ version: 1, keys: { refresh: ['<CR'] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.refresh');
  expect(message).toContain('"<CR"');
  expect(message).toContain(knownNameList);
});

test('an unknown bracket name stops and lists the key names', () => {
  const { path, message } = failure({ version: 1, keys: { refresh: ['<Foo>'] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.refresh');
  expect(message).toContain('<Foo>');

  for (const name of ['<CR>', '<Esc>', '<Space>', '<Tab>', '<S-Tab>', '<BS>', '<lt>', '<C-a>']) {
    expect(message).toContain(name);
  }
});

test('two user entries on one key stop and name both ids', () => {
  const { path, message } = failure({
    version: 1,
    keys: { refresh: ['x'], markDone: ['x'] },
  });

  expect(message).toContain(path);
  expect(message).toContain('refresh');
  expect(message).toContain('markDone');
  expect(message).toContain('"x"');
});

test('a user single key that blocks a user sequence stops and names both ids', () => {
  const { path, message } = failure({
    version: 1,
    keys: { refresh: ['x'], markDone: ['xx'] },
  });

  expect(message).toContain(path);
  expect(message).toContain('refresh');
  expect(message).toContain('markDone');
  expect(message).toContain('"xx"');
});

test('a close command left without a key stops and lists the commands that need one', () => {
  const { path, message } = failure({ version: 1, keys: { closeHelp: [] } });

  expect(message).toContain(path);
  expect(message).toContain('closeHelp');

  for (const id of [
    'closeHelp',
    'closeMessages',
    'cancelOpen',
    'cancelInput',
    'closeCommandLine',
    'closeFilters',
    'closeDetail',
  ]) {
    expect(message).toContain(id);
  }
});

test('a close command whose keys all go to a user key stops', () => {
  const { message } = failure({
    version: 1,
    keys: { selectNext: ['q'], selectPrevious: ['<Esc>'] },
  });

  expect(message).toContain('closeHelp');
});

test('Ctrl+C on a command other than quit stops and names the entry', () => {
  const { path, message } = failure({ version: 1, keys: { refresh: ['<C-c>'] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.refresh');
  expect(message).toContain('<C-c>');
  expect(message).toContain('quit');
});

test('a list key that starts with a digit stops and names the entry', () => {
  const { path, message } = failure({ version: 1, keys: { refresh: ['2r'] } });

  expect(message).toContain(path);
  expect(message).toContain('keys.refresh');
  expect(message).toContain('"2r"');
  expect(message).toContain('digit');
});

test('a digit key on an input command is allowed', () => {
  const result = loaded({ version: 1, keys: { clearLine: ['1'] } });

  expect(commandOf(result.catalog, 'clearInput').keys).toEqual(['1']);
});

test('an alias that another command uses stops and names both ids', () => {
  const { path, message } = failure({ version: 1, aliases: { refresh: ['q'] } });

  expect(message).toContain(path);
  expect(message).toContain('aliases.refresh');
  expect(message).toContain('"q"');
  expect(message).toContain('quit');
});

test('two user aliases with one name stop and name both ids', () => {
  const { message } = failure({
    version: 1,
    aliases: { refresh: ['rr'], markDone: ['rr'] },
  });

  expect(message).toContain('markDone');
  expect(message).toContain('refresh');
});

test('an alias for an id of another scope stops and lists the ids that take aliases', () => {
  const { path, message } = failure({ version: 1, aliases: { closeHelp: ['ch'] } });

  expect(message).toContain(path);
  expect(message).toContain('aliases.closeHelp');

  const listed = message.split('Ids that take aliases: ')[1]?.split(', ') ?? [];

  expect(listed).toContain('quit');
  expect(listed).toContain('refresh');
  expect(listed).not.toContain('closeHelp');
});

test('an alias with whitespace stops and names the entry', () => {
  const { path, message } = failure({ version: 1, aliases: { refresh: ['re fresh'] } });

  expect(message).toContain(path);
  expect(message).toContain('aliases.refresh');
  expect(message).toContain('"re fresh"');
});

test('an alias adds a name the command line runs', () => {
  const result = loaded({ version: 1, aliases: { refresh: ['rf'] } });

  expect(commandOf(result.catalog, 'refresh').names).toContain('rf');
});

test('a user key equal to a default key wins and the notice names both ids', () => {
  const result = loaded({ version: 1, keys: { selectNext: ['k'] } });

  expect(commandOf(result.catalog, 'selectNext').keys).toEqual(['k']);
  expect(commandOf(result.catalog, 'selectPrevious').keys).toEqual(['up']);

  const [notice] = result.notices;

  expect(result.notices).toHaveLength(1);
  expect(notice).toContain('"k"');
  expect(notice).toContain('selectNext');
  expect(notice).toContain('selectPrevious');
});

test('a user key that shadows a default sequence takes the sequence', () => {
  const result = loaded({ version: 1, keys: { refresh: ['g'] } });

  expect(commandOf(result.catalog, 'selectFirst').keys).toEqual([]);
  expect(result.notices.join('\n')).toContain('selectFirst');
});

test('an overlay copy that loses a key leaves the list command its key', () => {
  const result = loaded({ version: 1, keys: { closeHelp: ['j', '<Esc>'] } });

  const selectNext = commandOf(result.catalog, 'selectNext');

  expect(selectNext.keys).toEqual(['j', 'down']);
  expect(selectNext.overlayKeys?.help).toEqual(['down']);
  expect(selectNext.overlayKeys?.messages).toBeUndefined();
});

test('quit keeps Ctrl+C on quit and on the input quit copies', () => {
  const result = loaded({ version: 1, keys: { quit: ['q'] } });

  expect(commandOf(result.catalog, 'quit').keys).toEqual(['q', 'ctrl+c']);

  for (const id of ['quitFromInput', 'quitFromCommandLine', 'quitFromFilters']) {
    expect(commandOf(result.catalog, id).keys).toEqual(['ctrl+c']);
  }

  expect(result.notices).toEqual([]);
});

test('quit with only Ctrl+C unbinds the other keys', () => {
  const result = loaded({ version: 1, keys: { quit: ['<C-c>'] } });

  expect(commandOf(result.catalog, 'quit').keys).toEqual(['ctrl+c']);
});

test('one entry sets every copy of a shared config id', () => {
  const result = loaded({ version: 1, keys: { clearLine: ['<C-k>'] } });

  for (const id of ['clearInput', 'clearCommandLine', 'clearFilterDraft']) {
    expect(commandOf(result.catalog, id).keys).toEqual(['ctrl+k']);
  }
});

test('repeated encoded keys keep the last notation in both diagnostic entries', () => {
  const { message } = failure({ version: 1, keys: { refresh: ['<CR>', '<Enter>'] } });

  expect(message.match(/keys\.refresh "<Enter>"/gu)).toHaveLength(2);
  expect(message).not.toContain('<CR>');
});

test.each([
  [{ markDone: ['x'], refresh: ['x'], help: ['z'], quit: ['z'] }, 'quit', 'help', 'global'],
  [
    { markDone: ['x'], refresh: ['x'], selectPrevious: ['z'], selectNext: ['z'] },
    'selectNext',
    'selectPrevious',
    'list',
  ],
])(
  'conflicts follow layer and catalog order rather than config order: %j',
  (keys, first, second, scope) => {
    const { message } = failure({ version: 1, keys });

    expect(message).toContain(`keys.${first}`);
    expect(message).toContain(`keys.${second}`);
    expect(message.indexOf(`keys.${first}`)).toBeLessThan(message.indexOf(`keys.${second}`));
    expect(message).toContain(`the ${scope} layer`);
    expect(message).not.toContain('keys.markDone');
  },
);

test('default removals remain independent across list and overlay layers', () => {
  const result = loaded({ version: 1, keys: { refresh: ['j'], closeHelp: ['<Down>'] } });

  const keysIn = (scope: Command['scope']) =>
    commandsOfLayer(result.catalog, scope).find((command) => command.id === 'selectNext')?.keys;

  expect(keysIn('list')).toEqual(['down']);
  expect(keysIn('help')).toEqual(['j']);
  expect(keysIn('messages')).toEqual(['j', 'down']);
  expect(result.notices).toHaveLength(2);
  expect(result.notices[0]).toContain('in the list layers');
  expect(result.notices[1]).toContain('in the help layers');
});

test('one replacement notice groups movement layers in traversal order', () => {
  const result = loaded({ version: 1, keys: { selectNext: ['k'] } });

  expect(result.notices).toHaveLength(1);
  expect(result.notices[0]).toContain('in the list, help, messages layers');
});

test('the v1 config ids stay frozen and their default keys load without notices', () => {
  expect(Object.keys(defaultKeysInVim)).toEqual(configIds);

  const result = loaded({ version: 1, keys: defaultKeysInVim });

  expect(result.notices).toEqual([]);

  const keysOfCatalog = result.catalog.map((command) => command.keys);
  const keysOfDefaults = catalog.map((command) => command.keys);

  expect(keysOfCatalog).toEqual(keysOfDefaults);
});
