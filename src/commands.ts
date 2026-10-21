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

export interface Command {
  id: string;
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
  // The word typed after `:` that runs this command.
  name?: string;
  keys: readonly string[];
  disabledReason: (snapshot: Snapshot) => string | undefined;
  intent: (snapshot: Snapshot) => Intent;
  // False lets the key reach the focused input after the command runs.
  preventDefault?: boolean;
}

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
    keys: ['q', 'ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
  {
    id: 'help',
    label: 'Toggle help',
    scope: 'global',
    keys: ['?'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'toggleHelp' }),
  },
  {
    id: 'selectNext',
    label: 'Select next row',
    scope: 'list',
    keys: ['j', 'down'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectNext' } }),
  },
  {
    id: 'selectPrevious',
    label: 'Select previous row',
    scope: 'list',
    keys: ['k', 'up'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectPrevious' } }),
  },
  {
    id: 'selectFirst',
    label: 'Select first row',
    scope: 'list',
    keys: ['g'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectFirst' } }),
  },
  {
    id: 'selectLast',
    label: 'Select last row',
    scope: 'list',
    keys: ['shift+g'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectLast' } }),
  },
  {
    id: 'selectNextGroup',
    label: 'Select next group',
    scope: 'list',
    keys: ['shift+j'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectNextGroup' } }),
  },
  {
    id: 'selectPreviousGroup',
    label: 'Select previous group',
    scope: 'list',
    keys: ['shift+k'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'selectPreviousGroup' } }),
  },
  {
    id: 'toggleFold',
    label: 'Fold or unfold node',
    scope: 'list',
    keys: ['z', 'space'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'toggleFold' } }),
  },
  {
    id: 'activateRow',
    label: 'Fold group or open thread detail',
    scope: 'list',
    keys: ['return'],
    disabledReason: (snapshot) =>
      selectedRowOf(snapshot) === undefined ? 'No row is selected' : undefined,
    intent: (snapshot) =>
      selectedRowOf(snapshot)?.kind === 'thread'
        ? { kind: 'ui', action: 'openDetail' }
        : { kind: 'application', intent: { kind: 'toggleFold' } },
  },
  {
    id: 'toggleAllFolds',
    label: 'Fold or unfold all groups',
    scope: 'list',
    keys: ['shift+z'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'toggleAllFolds' } }),
  },
  {
    id: 'cycleGrouping',
    label: 'Cycle grouping',
    scope: 'list',
    keys: ['s'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'cycleGrouping' } }),
  },
  {
    id: 'refresh',
    label: 'Refresh',
    scope: 'list',
    keys: ['r'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'refresh' } }),
  },
  {
    id: 'markDone',
    label: 'Mark done',
    scope: 'list',
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
    keys: ['o'],
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
    keys: ['u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'undoDone' } }),
  },
  {
    id: 'openSearch',
    label: 'Search the list',
    scope: 'list',
    keys: ['/'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openSearch' } }),
  },
  {
    id: 'clearSearch',
    label: 'Clear the search',
    scope: 'list',
    keys: ['escape'],
    disabledReason: (snapshot) => (snapshot.searchText === '' ? 'No search is active.' : undefined),
    intent: () => ({ kind: 'application', intent: { kind: 'clearSearch' } }),
  },
  {
    id: 'openCommandLine',
    label: 'Open the command line',
    scope: 'list',
    keys: [':'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openCommandLine' } }),
  },
  {
    id: 'openFilters',
    label: 'Filter the list',
    scope: 'list',
    keys: ['f'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'openFilters' } }),
  },
  {
    id: 'clearFilters',
    label: 'Clear all filters',
    scope: 'list',
    keys: ['shift+f'],
    disabledReason: (snapshot) =>
      snapshot.filters.length === 0 ? 'No filter is active.' : undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'clearFilters' } }),
  },
  {
    id: 'submitInput',
    label: 'Keep the search',
    scope: 'input',
    keys: ['return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'keepSearch' } }),
  },
  {
    id: 'nextSearchCompletion',
    label: 'Complete the last word',
    scope: 'input',
    keys: ['tab'],
    disabledReason: noCompletion,
    intent: () => ({ kind: 'application', intent: { kind: 'nextSearchCompletion' } }),
  },
  {
    id: 'previousSearchCompletion',
    label: 'Complete the last word backwards',
    scope: 'input',
    keys: ['shift+tab'],
    disabledReason: noCompletion,
    intent: () => ({ kind: 'application', intent: { kind: 'previousSearchCompletion' } }),
  },
  {
    id: 'quitFromInput',
    label: 'Quit',
    scope: 'input',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
  {
    id: 'cancelInput',
    label: 'Restore the previous search',
    scope: 'input',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'restoreSearch' } }),
  },
  {
    id: 'clearInput',
    label: 'Clear the line',
    scope: 'input',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'editSearch', text: '' } }),
  },
  {
    id: 'closeEmptyInput',
    label: 'Close the empty line',
    scope: 'input',
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
    keys: ['return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'runCommandLine' }),
  },
  {
    id: 'closeCommandLine',
    label: 'Close the command line',
    scope: 'command',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'closeCommandLine' } }),
  },
  {
    id: 'clearCommandLine',
    label: 'Clear the line',
    scope: 'command',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'editCommandLine', text: '' } }),
  },
  {
    id: 'quitFromCommandLine',
    label: 'Quit',
    scope: 'command',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
  {
    id: 'closeEmptyCommandLine',
    label: 'Close the empty line',
    scope: 'command',
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
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeDetail' }),
  },
  {
    id: 'closeHelp',
    label: 'Close help',
    scope: 'help',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeHelp' }),
  },
  {
    id: 'showMessages',
    label: 'Show recent messages',
    scope: 'global',
    name: 'messages',
    keys: [],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'openMessages' }),
  },
  {
    id: 'closeMessages',
    label: 'Close messages',
    scope: 'messages',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeMessages' }),
  },
  {
    id: 'scrollMessagesDown',
    label: 'Scroll messages down',
    scope: 'messages',
    keys: ['j', 'down'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollMessages', lines: 1 }),
  },
  {
    id: 'scrollMessagesUp',
    label: 'Scroll messages up',
    scope: 'messages',
    keys: ['k', 'up'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollMessages', lines: -1 }),
  },
  {
    id: 'scrollHelpDown',
    label: 'Scroll help down',
    scope: 'help',
    keys: ['j', 'down'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollHelp', lines: 1 }),
  },
  {
    id: 'scrollHelpUp',
    label: 'Scroll help up',
    scope: 'help',
    keys: ['k', 'up'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollHelp', lines: -1 }),
  },
  {
    id: 'confirmOpen',
    label: 'Confirm opening the repos',
    scope: 'confirm',
    keys: ['y', 'return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'confirmOpen' }),
  },
  {
    id: 'cancelOpen',
    label: 'Cancel opening the repos',
    scope: 'confirm',
    keys: ['n', 'escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'cancelOpen' }),
  },
  {
    id: 'applyFilterRow',
    label: 'Apply the filter row',
    scope: 'filter',
    keys: ['return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'applyFilterRow' } }),
  },
  {
    id: 'takeFilterRow',
    label: 'Copy the filter row to the line',
    scope: 'filter',
    keys: ['tab'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'takeFilterRow' } }),
  },
  {
    id: 'moveFilterUp',
    label: 'Move up a filter row',
    scope: 'filter',
    keys: ['up', 'ctrl+p'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'moveFilterCursor', direction: 'up' } }),
  },
  {
    id: 'moveFilterDown',
    label: 'Move down a filter row',
    scope: 'filter',
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
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'closeFilters' } }),
  },
  {
    id: 'clearFilterDraft',
    label: 'Clear the line',
    scope: 'filter',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'application', intent: { kind: 'editFilterDraft', text: '' } }),
  },
  {
    id: 'closeEmptyFilterDraft',
    label: 'Close the composer when the line is empty',
    scope: 'filter',
    keys: ['backspace'],
    preventDefault: false,
    disabledReason: (snapshot) =>
      snapshot.filterDraft === '' ? undefined : 'The line has text to delete.',
    intent: () => ({ kind: 'application', intent: { kind: 'leaveFilters' } }),
  },
  {
    id: 'quitFromFilters',
    label: 'Quit',
    scope: 'filter',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
];
