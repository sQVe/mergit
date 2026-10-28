import { invariant } from './invariant.ts';
import type { ApplicationIntent, Snapshot } from './session/session.ts';
import { adjacentThreadRowOf, searchCandidatesOf, visibleRows } from './session/session.ts';
import type { BrowserPage, ThreadRow } from './work/work.ts';
import { pagesOfRow } from './work/work.ts';

export type ReaderContext = { kind: 'inbox' } | { kind: 'reader'; row: ThreadRow };

export type Intent =
  | { kind: 'application'; intent: ApplicationIntent }
  | {
      kind: 'ui';
      action:
        | 'toggleHelp'
        | 'closeHelp'
        | 'openHelpSearch'
        | 'keepHelpSearch'
        | 'cancelHelpSearch'
        | 'clearHelpSearch'
        | 'closeEmptyHelpSearch'
        | 'closeDetail'
        | 'runCommandLine'
        | 'nextCommandLineCompletion'
        | 'previousCommandLineCompletion'
        | 'openMessages'
        | 'closeMessages';
    }
  | { kind: 'ui'; action: 'openDetail'; row: ThreadRow }
  | { kind: 'ui'; action: 'editHelpSearch'; text: string }
  | { kind: 'ui'; action: 'askOpen'; pages: readonly BrowserPage[] }
  | { kind: 'ui'; action: 'confirmOpen' | 'cancelOpen' }
  | { kind: 'ui'; action: 'scrollOverlay'; move: OverlayMove }
  | { kind: 'ui'; action: 'scrollPreview'; lines: 1 | -1 }
  | { kind: 'terminal'; action: 'quit' };

export type OverlayMove =
  | { kind: 'lines'; lines: number }
  | { kind: 'page'; direction: 'down' | 'up'; size: 'half' | 'full' }
  | { kind: 'edge'; edge: 'top' | 'bottom' };

export type OverlayScope = 'help' | 'messages';

export type TerminalIntent = Extract<Intent, { kind: 'terminal' }>;

interface ParsedStroke {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface Command {
  id: string;
  // Input-line copies of one action share this id and show as one help row.
  configId?: string;
  label: string;
  scope:
    | 'global'
    | 'list'
    | 'reader'
    | 'help'
    | 'helpSearch'
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
  overlayKeys?: Partial<Record<OverlayScope, readonly string[]>>;
  configurable?: false;
  mustKeepKey?: true;
  disabledReason: (snapshot: Snapshot, reader: ReaderContext) => string | undefined;
  // The help and messages layers also bind this command's keys, and run this move on the open
  // overlay.
  overlayMove?: OverlayMove;
  // A counted command takes the number typed before its key.
  counted?: true;
  // Keys that still run this command while a count is pending, on the list layer.
  keysDuringCount?: readonly string[];
  intent: (snapshot: Snapshot, reader: ReaderContext, count?: number) => Intent;
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
  helpSearch: 60,
  messages: 50,
  confirm: 50,
  input: 40,
  command: 40,
  filter: 40,
  reader: 30,
  list: 20,
  global: 10,
};

export const isOverlayScope = (scope: Command['scope']): scope is OverlayScope =>
  scope === 'help' || scope === 'messages';

export const configIdOf = (command: Command): string => command.configId ?? command.id;

const scrollCopyOf = (command: Command, scope: OverlayScope, move: OverlayMove): Command => ({
  ...command,
  scope,
  keys: command.overlayKeys?.[scope] ?? command.keys,
  intent: () => ({ kind: 'ui', action: 'scrollOverlay', move }),
});

export const commandsOfLayer = (
  commands: readonly Command[],
  scope: Command['scope'],
): Command[] => {
  const own = commands.filter((command) => command.scope === scope);
  const copies: Command[] = [];

  if (isOverlayScope(scope)) {
    for (const command of commands) {
      if (command.overlayMove !== undefined) {
        copies.push(scrollCopyOf(command, scope, command.overlayMove));
      }
    }
  }

  return [...own, ...copies];
};

const confirmAfterRepositories = 3;

const selectedRowOf = (snapshot: Snapshot) =>
  visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

const openIntentOf = (pages: readonly BrowserPage[]): Intent =>
  pages.length > confirmAfterRepositories
    ? { kind: 'ui', action: 'askOpen', pages }
    : { kind: 'application', intent: { kind: 'openInBrowser', pages } };

const readerRowOf = (reader: ReaderContext): ThreadRow => {
  invariant(reader.kind === 'reader', 'Reader commands run only while a thread detail is open.');

  return reader.row;
};

const noReaderReason = (reader: ReaderContext): string | undefined =>
  reader.kind === 'inbox' ? 'No thread detail is open.' : undefined;

export const isReaderDetached = (snapshot: Snapshot, reader: ReaderContext): boolean =>
  reader.kind === 'reader' &&
  !visibleRows(snapshot).some(
    (candidate) => candidate.kind === 'thread' && candidate.thread.id === reader.row.thread.id,
  );

const readerUndoReason = (snapshot: Snapshot, reader: ReaderContext): string | undefined => {
  if (reader.kind === 'inbox') {
    return noReaderReason(reader);
  }

  return snapshot.hiddenThreadIds.has(reader.row.thread.id)
    ? undefined
    : 'This thread is not marked done.';
};

const readerDoneReason = (snapshot: Snapshot, reader: ReaderContext): string | undefined => {
  if (reader.kind === 'inbox') {
    return noReaderReason(reader);
  }

  return isReaderDetached(snapshot, reader) ? 'This thread is no longer in the list.' : undefined;
};

const readerAdjacentRowOf = (
  snapshot: Snapshot,
  reader: ReaderContext,
  step: 1 | -1,
): ThreadRow => {
  const row = adjacentThreadRowOf(snapshot, readerRowOf(reader).thread.id, step);

  invariant(row !== undefined, 'Reader moves run only when a thread lies that way.');

  return row;
};

const readerAdjacentReason =
  (step: 1 | -1) =>
  (snapshot: Snapshot, reader: ReaderContext): string | undefined => {
    if (reader.kind === 'inbox') {
      return noReaderReason(reader);
    }

    return adjacentThreadRowOf(snapshot, reader.row.thread.id, step) === undefined
      ? 'No thread lies that way.'
      : undefined;
  };

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
    overlayMove: { kind: 'lines', lines: 1 },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
      kind: 'application',
      intent: { kind: 'selectNext', count },
    }),
  },
  {
    id: 'selectPrevious',
    label: 'Select previous row',
    scope: 'list',
    section: 'moving',
    keys: ['k', 'up'],
    overlayMove: { kind: 'lines', lines: -1 },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
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
    overlayMove: { kind: 'edge', edge: 'top' },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
      kind: 'application',
      intent: { kind: 'selectFirst', count },
    }),
  },
  {
    id: 'selectLast',
    label: 'Select last row',
    scope: 'list',
    section: 'moving',
    keys: ['shift+g'],
    overlayMove: { kind: 'edge', edge: 'bottom' },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
      kind: 'application',
      intent: { kind: 'selectLast', count },
    }),
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
    intent: (_snapshot, _reader, count) => ({
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
    intent: (_snapshot, _reader, count) => ({
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
    intent: (_snapshot, _reader, count) => ({
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
    overlayMove: { kind: 'page', direction: 'down', size: 'half' },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
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
    overlayMove: { kind: 'page', direction: 'up', size: 'half' },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
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
    overlayMove: { kind: 'page', direction: 'down', size: 'full' },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
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
    overlayMove: { kind: 'page', direction: 'up', size: 'full' },
    disabledReason: () => undefined,
    counted: true,
    intent: (_snapshot, _reader, count) => ({
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
    intent: (snapshot) => {
      const row = selectedRowOf(snapshot);

      return row?.kind === 'thread'
        ? { kind: 'ui', action: 'openDetail', row }
        : { kind: 'application', intent: { kind: 'toggleFold' } };
    },
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

      return openIntentOf(row === undefined ? [] : pagesOfRow(row));
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
    label: 'Open filters',
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
    configurable: false,
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
    mustKeepKey: true,
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
    id: 'nextCommandLineCompletion',
    label: 'Complete the command name',
    scope: 'command',
    section: 'commandLine',
    keys: ['tab'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'nextCommandLineCompletion' }),
  },
  {
    id: 'previousCommandLineCompletion',
    label: 'Complete the command name backwards',
    scope: 'command',
    section: 'commandLine',
    keys: ['shift+tab'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'previousCommandLineCompletion' }),
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
    mustKeepKey: true,
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
    configurable: false,
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
    mustKeepKey: true,
    label: 'Close thread detail',
    scope: 'reader',
    section: 'threads',
    keys: ['escape'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: () => ({ kind: 'ui', action: 'closeDetail' }),
  },
  {
    id: 'readerMarkDone',
    configId: 'markDone',
    label: 'Mark done',
    scope: 'reader',
    section: 'threads',
    keys: ['d'],
    disabledReason: readerDoneReason,
    intent: (_snapshot, reader) => ({
      kind: 'application',
      intent: { kind: 'markThreadsDone', threadIds: [readerRowOf(reader).thread.id] },
    }),
  },
  {
    id: 'readerOpenInBrowser',
    configId: 'openInBrowser',
    label: 'Open in browser',
    scope: 'reader',
    section: 'threads',
    keys: ['o', 'gx'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: (_snapshot, reader) => openIntentOf(pagesOfRow(readerRowOf(reader))),
  },
  {
    id: 'readerRefresh',
    configId: 'refresh',
    label: 'Refresh',
    scope: 'reader',
    section: 'app',
    keys: ['r'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: (_snapshot, reader) => ({
      kind: 'application',
      intent: { kind: 'refreshDetail', thread: readerRowOf(reader).thread },
    }),
  },
  {
    id: 'readerUndoDone',
    configId: 'undoDone',
    label: 'Undo done for this thread',
    scope: 'reader',
    section: 'threads',
    keys: ['u'],
    disabledReason: readerUndoReason,
    intent: (_snapshot, reader) => ({
      kind: 'application',
      intent: { kind: 'undoThreadDone', threadId: readerRowOf(reader).thread.id },
    }),
  },
  {
    id: 'readerNextThread',
    configId: 'moveOtherPaneDown',
    label: 'Move the other pane down',
    scope: 'reader',
    section: 'moving',
    keys: ['meta+j', 'ctrl+n'],
    disabledReason: readerAdjacentReason(1),
    intent: (snapshot, reader) => ({
      kind: 'ui',
      action: 'openDetail',
      row: readerAdjacentRowOf(snapshot, reader, 1),
    }),
  },
  {
    id: 'readerPreviousThread',
    configId: 'moveOtherPaneUp',
    label: 'Move the other pane up',
    scope: 'reader',
    section: 'moving',
    keys: ['meta+k', 'ctrl+p'],
    disabledReason: readerAdjacentReason(-1),
    intent: (snapshot, reader) => ({
      kind: 'ui',
      action: 'openDetail',
      row: readerAdjacentRowOf(snapshot, reader, -1),
    }),
  },
  {
    id: 'scrollPreviewDown',
    configId: 'moveOtherPaneDown',
    label: 'Move the other pane down',
    scope: 'list',
    section: 'moving',
    keys: ['meta+j', 'ctrl+n'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollPreview', lines: 1 }),
  },
  {
    id: 'scrollPreviewUp',
    configId: 'moveOtherPaneUp',
    label: 'Move the other pane up',
    scope: 'list',
    section: 'moving',
    keys: ['meta+k', 'ctrl+p'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'scrollPreview', lines: -1 }),
  },
  {
    id: 'nextTab',
    label: 'Next tab',
    scope: 'reader',
    section: 'threads',
    keys: ['l', 'right'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: () => ({ kind: 'application', intent: { kind: 'switchDetailTab', direction: 1 } }),
  },
  {
    id: 'previousTab',
    label: 'Previous tab',
    scope: 'reader',
    section: 'threads',
    keys: ['h', 'left'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: () => ({ kind: 'application', intent: { kind: 'switchDetailTab', direction: -1 } }),
  },
  {
    id: 'scrollDown',
    label: 'Scroll text down',
    scope: 'reader',
    section: 'moving',
    keys: ['j', 'down'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: () => ({ kind: 'ui', action: 'scrollOverlay', move: { kind: 'lines', lines: 1 } }),
  },
  {
    id: 'scrollUp',
    label: 'Scroll text up',
    scope: 'reader',
    section: 'moving',
    keys: ['k', 'up'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: () => ({ kind: 'ui', action: 'scrollOverlay', move: { kind: 'lines', lines: -1 } }),
  },
  {
    id: 'readerHalfPageDown',
    configId: 'halfPageDown',
    label: 'Half page down',
    scope: 'reader',
    section: 'moving',
    keys: ['ctrl+d'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: () => ({
      kind: 'ui',
      action: 'scrollOverlay',
      move: { kind: 'page', direction: 'down', size: 'half' },
    }),
  },
  {
    id: 'readerHalfPageUp',
    configId: 'halfPageUp',
    label: 'Half page up',
    scope: 'reader',
    section: 'moving',
    keys: ['ctrl+u'],
    disabledReason: (_snapshot, reader) => noReaderReason(reader),
    intent: () => ({
      kind: 'ui',
      action: 'scrollOverlay',
      move: { kind: 'page', direction: 'up', size: 'half' },
    }),
  },
  {
    id: 'openHelpSearch',
    label: 'Search help',
    scope: 'help',
    section: 'overlays',
    keys: ['/'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'openHelpSearch' }),
  },
  {
    id: 'keepHelpSearch',
    label: 'Keep help search',
    scope: 'helpSearch',
    section: 'overlays',
    keys: ['return'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'keepHelpSearch' }),
  },
  {
    id: 'cancelHelpSearch',
    mustKeepKey: true,
    label: 'Clear and close help search',
    scope: 'helpSearch',
    section: 'overlays',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'cancelHelpSearch' }),
  },
  {
    id: 'clearHelpSearch',
    label: 'Clear help search',
    scope: 'helpSearch',
    section: 'overlays',
    keys: ['ctrl+u'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'clearHelpSearch' }),
  },
  {
    id: 'closeEmptyHelpSearch',
    label: 'Close empty help search',
    scope: 'helpSearch',
    section: 'overlays',
    keys: ['backspace'],
    preventDefault: false,
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeEmptyHelpSearch' }),
  },
  {
    id: 'quitFromHelpSearch',
    configurable: false,
    hiddenFromHelp: true,
    label: 'Quit',
    scope: 'helpSearch',
    section: 'app',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
  {
    id: 'closeHelp',
    mustKeepKey: true,
    label: 'Close help',
    scope: 'help',
    section: 'overlays',
    keys: ['q', 'escape'],
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
    mustKeepKey: true,
    label: 'Close messages',
    scope: 'messages',
    section: 'overlays',
    keys: ['q', 'escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeMessages' }),
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
    mustKeepKey: true,
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
    mustKeepKey: true,
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
    configurable: false,
    hiddenFromHelp: true,
    label: 'Quit',
    scope: 'filter',
    section: 'app',
    keys: ['ctrl+c'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'terminal', action: 'quit' }),
  },
];

const readableKeyNames = new Map(
  Object.entries({
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
  }),
);

export const readableStrokeOf = (stroke: ParsedStroke): string => {
  if (stroke.ctrl === true) {
    return `Ctrl+${stroke.name.toUpperCase()}`;
  }

  if (stroke.meta === true) {
    return `Alt+${stroke.name}`;
  }

  if (stroke.shift !== true) {
    return readableKeyNames.get(stroke.name) ?? stroke.name;
  }

  const shiftedName = readableKeyNames.get(`shift+${stroke.name}`);

  if (shiftedName !== undefined) {
    return shiftedName;
  }

  return /^[a-z]$/.test(stroke.name) ? stroke.name.toUpperCase() : `shift+${stroke.name}`;
};

const modifiedStroke = /^(ctrl|shift|meta)\+(.+)$/;

const strokeOf = (key: string): string => {
  const modified = modifiedStroke.exec(key);
  const modifier = modified?.[1];
  const name = modified?.[2];

  if (name === undefined) {
    return readableStrokeOf({ name: key });
  }

  return readableStrokeOf({
    name,
    ctrl: modifier === 'ctrl',
    shift: modifier === 'shift',
    meta: modifier === 'meta',
  });
};

// A known name or modifier form is one stroke, and any other character is one stroke.
const strokePattern =
  /shift\+tab|return|escape|space|tab|backspace|up|down|left|right|(?:shift|ctrl|meta)\+[a-z]|./gu;

const strokesOf = (key: string): string[] =>
  Array.from(key.matchAll(strokePattern), (match) => match[0]);

export const readableKeyOf = (key: string): string => {
  if (readableKeyNames.has(key)) {
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
