import type { ApplicationIntent, Snapshot } from './session/session.ts';
import { searchCandidatesOf, visibleRows } from './session/session.ts';
import type { BrowserPage } from './work/work.ts';
import { pagesOfRow } from './work/work.ts';

export type Intent =
  | { kind: 'application'; intent: ApplicationIntent }
  | {
      kind: 'ui';
      action:
        | 'toggleHelp'
        | 'closeHelp'
        | 'openDetail'
        | 'closeDetail'
        | 'runCommandLine'
        | 'openMessages'
        | 'closeMessages';
    }
  | { kind: 'ui'; action: 'askOpen'; pages: readonly BrowserPage[] }
  | { kind: 'ui'; action: 'confirmOpen' | 'cancelOpen' }
  | { kind: 'ui'; action: 'scrollHelp' | 'scrollMessages'; lines: number }
  | { kind: 'terminal'; action: 'quit' };

export type TerminalIntent = Extract<Intent, { kind: 'terminal' }>;

interface ParsedStroke {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}

export interface Command {
  id: string;
  // Input-line copies of one action share this id and show as one help row.
  configId?: string;
  label: string;
  scope:
    | 'global'
    | 'list'
    | 'preview'
    | 'help'
    | 'confirm'
    | 'input'
    | 'filter'
    | 'command'
    | 'messages';
  section: HelpSection;
  hiddenFromHelp?: true;
  // The words typed after `:` that run this command.
  names?: readonly string[];
  keys: readonly string[];
  disabledReason: (snapshot: Snapshot) => string | undefined;
  // A counted command takes the number typed before its key.
  counted?: true;
  // Keys that still run this command while a count is pending, on the list layer.
  keysDuringCount?: readonly string[];
  intent: (snapshot: Snapshot, count?: number) => Intent;
  // False lets the key reach the focused input after the command runs.
  preventDefault?: boolean;
}

export const helpSections = [
  'app',
  'moving',
  'folding',
  'threads',
  'search',
  'filters',
  'commandLine',
  'overlays',
] as const;

export type HelpSection = (typeof helpSections)[number];

// A higher number wins a key shared by active scopes, as the keymap sorts layers.
export const scopePriority: Record<Command['scope'], number> = {
  help: 50,
  messages: 50,
  confirm: 50,
  input: 40,
  command: 40,
  filter: 40,
  preview: 30,
  list: 20,
  global: 10,
};

const confirmAfterRepositories = 3;

const selectedRowOf = (snapshot: Snapshot) =>
  visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

const noCompletion = (snapshot: Snapshot) =>
  searchCandidatesOf(snapshot).length === 0 ? 'No completion for the last word.' : undefined;

export const catalog: readonly Command[] = [
  {
    id: 'quit',
    label: 'Quit',
    scope: 'global',
    section: 'app',
    names: ['quit', 'q', 'quitall', 'qa'],
    keys: ['q', 'ctrl+c'],
    keysDuringCount: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
  {
    id: 'help',
    label: 'Toggle help',
    scope: 'global',
    section: 'app',
    keys: ['?'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'toggleHelp' }),
  },
  {
    id: 'selectNext',
    label: 'Select next row',
    scope: 'list',
    section: 'moving',
    keys: ['j', 'down'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({ kind: 'application', intent: { kind: 'selectNext', count } }),
  },
  {
    id: 'selectPrevious',
    label: 'Select previous row',
    scope: 'list',
    section: 'moving',
    keys: ['k', 'up'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'selectPrevious', count },
    }),
  },
  {
    id: 'selectFirst',
    label: 'Select first row',
    scope: 'list',
    section: 'moving',
    keys: ['gg'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({ kind: 'application', intent: { kind: 'selectFirst', count } }),
  },
  {
    id: 'selectLast',
    label: 'Select last row',
    scope: 'list',
    section: 'moving',
    keys: ['shift+g'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({ kind: 'application', intent: { kind: 'selectLast', count } }),
  },
  {
    id: 'selectNextGroup',
    label: 'Select next group',
    scope: 'list',
    section: 'moving',
    keys: ['shift+j'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectNextGroup' } }),
  },
  {
    id: 'selectPreviousGroup',
    label: 'Select previous group',
    scope: 'list',
    section: 'moving',
    keys: ['shift+k'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectPreviousGroup' } }),
  },
  {
    id: 'toggleFold',
    label: 'Fold or unfold node',
    scope: 'list',
    section: 'folding',
    keys: ['za', 'space'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'toggleFold' } }),
  },
  {
    id: 'openFold',
    label: 'Open fold',
    scope: 'list',
    section: 'folding',
    keys: ['zo'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openFold' } }),
  },
  {
    id: 'closeFold',
    label: 'Close fold',
    scope: 'list',
    section: 'folding',
    keys: ['zc'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'closeFold' } }),
  },
  {
    id: 'openAllFolds',
    label: 'Open all folds',
    scope: 'list',
    section: 'folding',
    keys: ['zshift+r'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openAllFolds' } }),
  },
  {
    id: 'closeAllFolds',
    label: 'Close all folds',
    scope: 'list',
    section: 'folding',
    keys: ['zshift+m'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'closeAllFolds' } }),
  },
  {
    id: 'centerSelectedRow',
    label: 'Center the selected row',
    scope: 'list',
    section: 'moving',
    keys: ['zz'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'placeSelectedRow', position: 'center', count },
    }),
  },
  {
    id: 'topSelectedRow',
    label: 'Put the selected row at the top',
    scope: 'list',
    section: 'moving',
    keys: ['zt'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'placeSelectedRow', position: 'top', count },
    }),
  },
  {
    id: 'bottomSelectedRow',
    label: 'Put the selected row at the bottom',
    scope: 'list',
    section: 'moving',
    keys: ['zb'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'placeSelectedRow', position: 'bottom', count },
    }),
  },
  {
    id: 'halfPageDown',
    label: 'Half page down',
    scope: 'list',
    section: 'moving',
    keys: ['ctrl+d'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'scrollPage', direction: 'down', size: 'half', count },
    }),
  },
  {
    id: 'halfPageUp',
    label: 'Half page up',
    scope: 'list',
    section: 'moving',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'scrollPage', direction: 'up', size: 'half', count },
    }),
  },
  {
    id: 'pageDown',
    label: 'Page down',
    scope: 'list',
    section: 'moving',
    keys: ['ctrl+f'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'scrollPage', direction: 'down', size: 'full', count },
    }),
  },
  {
    id: 'pageUp',
    label: 'Page up',
    scope: 'list',
    section: 'moving',
    keys: ['ctrl+b'],
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, count) => ({
      kind: 'application',
      intent: { kind: 'scrollPage', direction: 'up', size: 'full', count },
    }),
  },
  {
    id: 'activateRow',
    label: 'Fold group or open thread detail',
    scope: 'list',
    section: 'threads',
    keys: ['return'],
    disabledReason: (snapshot) =>
      selectedRowOf(snapshot) === undefined ? 'No row is selected' : undefined,
    intent: (snapshot) =>
      selectedRowOf(snapshot)?.kind === 'thread'
        ? { kind: 'ui', action: 'openDetail' }
        : { kind: 'application', intent: { kind: 'toggleFold' } },
  },
  {
    id: 'cycleGrouping',
    label: 'Cycle grouping',
    scope: 'list',
    section: 'folding',
    keys: ['s'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'cycleGrouping' } }),
  },
  {
    id: 'refresh',
    label: 'Refresh',
    scope: 'list',
    section: 'app',
    keys: ['r'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'refresh' } }),
  },
  {
    id: 'markDone',
    label: 'Mark done',
    scope: 'list',
    section: 'threads',
    keys: ['d'],
    disabledReason: (snapshot) =>
      selectedRowOf(snapshot) === undefined ? 'Select a row to mark it done' : undefined,
    intent: (snapshot) => {
      const row = selectedRowOf(snapshot);

      if (row?.kind === 'node') {
        const threadIds = row.threads.map((thread) => thread.id);

        return { kind: 'application', intent: { kind: 'markThreadsDone', threadIds } };
      }

      return { kind: 'application', intent: { kind: 'markDone' } };
    },
  },
  {
    id: 'openInBrowser',
    label: 'Open in browser',
    scope: 'list',
    section: 'threads',
    keys: ['o', 'gx'],
    disabledReason: (snapshot) =>
      selectedRowOf(snapshot) === undefined ? 'Select a row to open it' : undefined,
    intent: (snapshot) => {
      const row = selectedRowOf(snapshot);
      const pages = row === undefined ? [] : pagesOfRow(row);

      if (row !== undefined && pages.length > confirmAfterRepositories) {
        return { kind: 'ui', action: 'askOpen', pages };
      }

      return { kind: 'application', intent: { kind: 'openInBrowser', pages } };
    },
  },
  {
    id: 'undoDone',
    label: 'Undo the last done',
    scope: 'list',
    section: 'threads',
    keys: ['u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'undoDone' } }),
  },
  {
    id: 'openSearch',
    label: 'Search the list',
    scope: 'list',
    section: 'search',
    keys: ['/'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openSearch' } }),
  },
  {
    id: 'clearSearch',
    label: 'Clear the search',
    scope: 'list',
    section: 'search',
    keys: ['escape'],
    disabledReason: (snapshot) => (snapshot.searchText === '' ? 'No search is active.' : undefined),
    intent: () => ({ kind: 'application', intent: { kind: 'clearSearch' } }),
  },
  {
    id: 'openCommandLine',
    label: 'Open the command line',
    scope: 'list',
    section: 'commandLine',
    keys: [':'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openCommandLine' } }),
  },
  {
    id: 'openFilters',
    label: 'Filter the list',
    scope: 'list',
    section: 'filters',
    keys: ['f'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openFilters' } }),
  },
  {
    id: 'clearFilters',
    label: 'Clear all filters',
    scope: 'list',
    section: 'filters',
    keys: ['shift+f'],
    disabledReason: (snapshot) =>
      snapshot.filters.length === 0 ? 'No filter is active.' : undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'clearFilters' } }),
  },
  {
    id: 'submitInput',
    label: 'Keep the search',
    scope: 'input',
    section: 'search',
    keys: ['return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'keepSearch' } }),
  },
  {
    id: 'nextSearchCompletion',
    label: 'Complete the last word',
    scope: 'input',
    section: 'search',
    keys: ['tab'],
    disabledReason: noCompletion,
    intent: () => ({ kind: 'application', intent: { kind: 'nextSearchCompletion' } }),
  },
  {
    id: 'previousSearchCompletion',
    label: 'Complete the last word backwards',
    scope: 'input',
    section: 'search',
    keys: ['shift+tab'],
    disabledReason: noCompletion,
    intent: () => ({ kind: 'application', intent: { kind: 'previousSearchCompletion' } }),
  },
  {
    id: 'quitFromInput',
    hiddenFromHelp: true,
    label: 'Quit',
    scope: 'input',
    section: 'app',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
  {
    id: 'cancelInput',
    label: 'Restore the previous search',
    scope: 'input',
    section: 'search',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'restoreSearch' } }),
  },
  {
    id: 'clearInput',
    configId: 'clearLine',
    label: 'Clear an input line',
    scope: 'input',
    section: 'app',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'editSearch', text: '' } }),
  },
  {
    id: 'closeEmptyInput',
    configId: 'closeEmptyLine',
    label: 'Close an empty input line',
    scope: 'input',
    section: 'app',
    keys: ['backspace'],
    preventDefault: false,
    disabledReason: (snapshot) =>
      snapshot.searchText === '' ? undefined : 'The line has text to delete.',
    intent: () => ({ kind: 'application', intent: { kind: 'keepSearch' } }),
  },
  {
    id: 'runCommandLine',
    label: 'Run the command',
    scope: 'command',
    section: 'commandLine',
    keys: ['return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'runCommandLine' }),
  },
  {
    id: 'closeCommandLine',
    label: 'Close the command line',
    scope: 'command',
    section: 'commandLine',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'closeCommandLine' } }),
  },
  {
    id: 'clearCommandLine',
    configId: 'clearLine',
    label: 'Clear an input line',
    scope: 'command',
    section: 'app',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'editCommandLine', text: '' } }),
  },
  {
    id: 'quitFromCommandLine',
    hiddenFromHelp: true,
    label: 'Quit',
    scope: 'command',
    section: 'app',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
  {
    id: 'closeEmptyCommandLine',
    configId: 'closeEmptyLine',
    label: 'Close an empty input line',
    scope: 'command',
    section: 'app',
    keys: ['backspace'],
    preventDefault: false,
    disabledReason: (snapshot) =>
      snapshot.commandLineText === '' ? undefined : 'The line has text to delete.',
    intent: () => ({ kind: 'application', intent: { kind: 'closeCommandLine' } }),
  },
  {
    id: 'closeDetail',
    label: 'Close thread detail',
    scope: 'preview',
    section: 'threads',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeDetail' }),
  },
  {
    id: 'closeHelp',
    label: 'Close help',
    scope: 'help',
    section: 'overlays',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeHelp' }),
  },
  {
    id: 'showMessages',
    label: 'Show recent messages',
    scope: 'global',
    section: 'app',
    names: ['messages'],
    keys: [],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'openMessages' }),
  },
  {
    id: 'closeMessages',
    label: 'Close messages',
    scope: 'messages',
    section: 'overlays',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeMessages' }),
  },
  {
    id: 'scrollMessagesDown',
    label: 'Scroll messages down',
    scope: 'messages',
    section: 'overlays',
    keys: ['j', 'down'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollMessages', lines: 1 }),
  },
  {
    id: 'scrollMessagesUp',
    label: 'Scroll messages up',
    scope: 'messages',
    section: 'overlays',
    keys: ['k', 'up'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollMessages', lines: -1 }),
  },
  {
    id: 'scrollHelpDown',
    label: 'Scroll help down',
    scope: 'help',
    section: 'overlays',
    keys: ['j', 'down'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollHelp', lines: 1 }),
  },
  {
    id: 'scrollHelpUp',
    label: 'Scroll help up',
    scope: 'help',
    section: 'overlays',
    keys: ['k', 'up'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollHelp', lines: -1 }),
  },
  {
    id: 'confirmOpen',
    hiddenFromHelp: true,
    label: 'Confirm opening the repos',
    scope: 'confirm',
    section: 'threads',
    keys: ['y', 'return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'confirmOpen' }),
  },
  {
    id: 'cancelOpen',
    hiddenFromHelp: true,
    label: 'Cancel opening the repos',
    scope: 'confirm',
    section: 'threads',
    keys: ['n', 'escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'cancelOpen' }),
  },
  {
    id: 'applyFilterRow',
    label: 'Apply the filter row',
    scope: 'filter',
    section: 'filters',
    keys: ['return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'applyFilterRow' } }),
  },
  {
    id: 'takeFilterRow',
    label: 'Copy the filter row to the line',
    scope: 'filter',
    section: 'filters',
    keys: ['tab'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'takeFilterRow' } }),
  },
  {
    id: 'moveFilterUp',
    label: 'Move up a filter row',
    scope: 'filter',
    section: 'filters',
    keys: ['up', 'ctrl+p'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'moveFilterCursor', direction: 'up' } }),
  },
  {
    id: 'moveFilterDown',
    label: 'Move down a filter row',
    scope: 'filter',
    section: 'filters',
    keys: ['down', 'ctrl+n'],
    disabledReason: () => undefined,
    intent: () => ({
      kind: 'application',
      intent: { kind: 'moveFilterCursor', direction: 'down' },
    }),
  },
  {
    id: 'closeFilters',
    label: 'Close the composer or cancel the edit',
    scope: 'filter',
    section: 'filters',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'closeFilters' } }),
  },
  {
    id: 'clearFilterDraft',
    configId: 'clearLine',
    label: 'Clear an input line',
    scope: 'filter',
    section: 'app',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'editFilterDraft', text: '' } }),
  },
  {
    id: 'closeEmptyFilterDraft',
    configId: 'closeEmptyLine',
    label: 'Close an empty input line',
    scope: 'filter',
    section: 'app',
    keys: ['backspace'],
    preventDefault: false,
    disabledReason: (snapshot) =>
      snapshot.filterDraft === '' ? undefined : 'The line has text to delete.',
    intent: () => ({ kind: 'application', intent: { kind: 'leaveFilters' } }),
  },
  {
    id: 'quitFromFilters',
    hiddenFromHelp: true,
    label: 'Quit',
    scope: 'filter',
    section: 'app',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
];

const readableKeyNames: Record<string, string> = {
  return: 'Enter',
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  'shift+tab': 'Shift+Tab',
  backspace: 'Backspace',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

export const readableStrokeOf = (stroke: ParsedStroke): string => {
  if (stroke.ctrl === true) {
    return `Ctrl+${stroke.name.toUpperCase()}`;
  }

  if (stroke.shift !== true) {
    return readableKeyNames[stroke.name] ?? stroke.name;
  }

  const shiftedName = readableKeyNames[`shift+${stroke.name}`];

  if (shiftedName !== undefined) {
    return shiftedName;
  }

  return /^[a-z]$/.test(stroke.name) ? stroke.name.toUpperCase() : `shift+${stroke.name}`;
};

const modifiedStroke = /^(ctrl|shift)\+(.+)$/;

const strokeOf = (key: string): string => {
  const modified = modifiedStroke.exec(key);
  const modifier = modified?.[1];
  const name = modified?.[2];

  if (name === undefined) {
    return readableStrokeOf({ name: key });
  }

  return readableStrokeOf({ name, ctrl: modifier === 'ctrl', shift: modifier === 'shift' });
};

// A known name or modifier form is one stroke, and any other character is one stroke.
const strokePattern =
  /shift\+tab|return|escape|space|tab|backspace|up|down|left|right|(?:shift|ctrl)\+[a-z]|./gu;

const strokesOf = (key: string): string[] => key.match(strokePattern) ?? [];

export const readableKeyOf = (key: string): string => {
  if (key in readableKeyNames) {
    return strokeOf(key);
  }

  return strokesOf(key)
    .map((stroke) => strokeOf(stroke))
    .join('');
};

export const keyNamesOf = (commands: readonly Command[], id: string): string[] => {
  const keys = commands.find((command) => command.id === id)?.keys ?? [];

  return keys.map((key) => readableKeyOf(key));
};

export const keyHintOf = (
  commands: readonly Command[],
  id: string,
  separator = '/',
): string | undefined => {
  const names = keyNamesOf(commands, id);

  return names.length === 0 ? undefined : names.join(separator);
};
