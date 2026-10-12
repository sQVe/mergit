import type { ApplicationIntent, Snapshot } from './session/session.ts';
import { visibleRows } from './session/session.ts';

type Intent =
  | { kind: 'application'; intent: ApplicationIntent }
  | { kind: 'ui'; action: 'toggleHelp' | 'closeHelp' }
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

const onThreadRow = (snapshot: Snapshot): string | undefined => {
  const rows = visibleRows(snapshot);
  const row = rows.find((candidate) => candidate.key === snapshot.selectedRowKey);

  return row?.kind === 'thread' ? 'A thread has nothing to fold' : undefined;
};

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
    id: 'toggleNodeFold',
    label: 'Fold or unfold group',
    scope: 'list',
    keys: ['return'],
    disabledReason: onThreadRow,
    intent: () => ({ kind: 'application', intent: { kind: 'toggleFold' } }),
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
    id: 'closeHelp',
    label: 'Close help',
    scope: 'modal',
    keys: ['escape'],
    disabledReason: () => undefined,
    intent: () => ({ kind: 'ui', action: 'closeHelp' }),
  },
];
