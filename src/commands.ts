import type { ApplicationIntent, Snapshot } from './session/session.ts';
import { visibleRows } from './session/session.ts';

export type Intent =
  | { kind: 'application'; intent: ApplicationIntent }
  | { kind: 'ui'; action: 'toggleHelp' | 'closeHelp' | 'openDetail' | 'closeDetail' }
  | { kind: 'terminal'; action: 'quit' };

export type TerminalIntent = Extract<Intent, { kind: 'terminal' }>;

export interface Command {
  id: string;
  label: string;
  scope: 'global' | 'list' | 'preview' | 'modal';
  keys: readonly string[];
  disabledReason: (snapshot: Snapshot) => string | undefined;
  intent: (snapshot: Snapshot) => Intent;
}

const selectedRowOf = (snapshot: Snapshot) =>
  visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

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
    label: 'Mark thread done',
    scope: 'list',
    keys: ['d'],
    disabledReason: (snapshot) =>
      selectedRowOf(snapshot)?.kind === 'thread' ? undefined : 'Select a thread to mark it done',
    intent: () => ({ kind: 'application', intent: { kind: 'markDone' } }),
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
    scope: 'modal',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeHelp' }),
  },
];
