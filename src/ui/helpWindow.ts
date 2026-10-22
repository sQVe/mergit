import type { Command, HelpSection } from '../commands.ts';
import { helpSections, keyHintOf, keyNamesOf, readableKeyOf } from '../commands.ts';

export type HelpLine =
  | { kind: 'heading'; text: string }
  | { kind: 'row'; keys: string; label: string };

export interface HelpWindow {
  lines: readonly HelpLine[];
  viewportRows: number;
  maximumTop: number;
  overflows: boolean;
  boxWidth: number;
  boxHeight: number;
}

const borderRows = 2;
const footerRows = 1;
const statusRows = 1;

export const boxChromeColumns = 4;
const minimumBoxWidth = 20;
const maximumBoxWidth = 64;
const terminalMargin = 4;
const ellipsis = '…';

const sectionTitles: Record<HelpSection, string> = {
  app: 'App',
  moving: 'Moving',
  folding: 'Folding',
  threads: 'Threads',
  search: 'Search',
  filters: 'Filters',
  commandLine: 'Command line',
  overlays: 'Overlays',
};

const sectionOpeners: Partial<Record<HelpSection, string>> = {
  search: 'openSearch',
  filters: 'openFilters',
  commandLine: 'openCommandLine',
};

const keysTextOf = (command: Command): string => {
  const texts = command.keys.map((key) => readableKeyOf(key));

  if (command.name !== undefined) {
    texts.push(`:${command.name}`);
  }

  return texts.join('/');
};

const fitted = (text: string, width: number): string => {
  if (text.length <= width) {
    return text;
  }

  return `${text.slice(0, Math.max(0, width - 1))}${ellipsis}`;
};

const listedCommandsOf = (catalog: readonly Command[]): Command[] => {
  const seenConfigIds = new Set<string>();
  const listed: Command[] = [];

  for (const command of catalog) {
    const hidden = command.hiddenFromHelp === true;
    const repeated = command.configId !== undefined && seenConfigIds.has(command.configId);

    if (hidden || repeated) {
      continue;
    }

    if (command.configId !== undefined) {
      seenConfigIds.add(command.configId);
    }

    listed.push(command);
  }

  return listed;
};

const headingOf = (catalog: readonly Command[], section: HelpSection): string => {
  const title = sectionTitles[section];
  const openerId = sectionOpeners[section];
  const opener = openerId === undefined ? undefined : keyHintOf(catalog, openerId);

  return opener === undefined ? title : `${title} (opens with ${opener})`;
};

const rowOf = (command: Command, innerWidth: number): HelpLine => {
  const keys = keysTextOf(command);
  const labelWidth = keys === '' ? innerWidth : innerWidth - keys.length - 1;

  return { kind: 'row', keys, label: fitted(command.label, labelWidth) };
};

const linesOf = (catalog: readonly Command[], innerWidth: number): HelpLine[] => {
  const listed = listedCommandsOf(catalog);
  const lines: HelpLine[] = [];

  for (const section of helpSections) {
    const commands = listed.filter((command) => command.section === section);

    if (commands.length === 0) {
      continue;
    }

    if (lines.length > 0) {
      lines.push({ kind: 'row', keys: '', label: '' });
    }

    lines.push({ kind: 'heading', text: fitted(headingOf(catalog, section), innerWidth) });

    for (const command of commands) {
      lines.push(rowOf(command, innerWidth));
    }
  }

  return lines;
};

export const footerOf = (
  catalog: readonly Command[],
  position: string,
  innerWidth: number,
): string => {
  const scrollKeys = [
    ...keyNamesOf(catalog, 'scrollHelpDown').slice(0, 1),
    ...keyNamesOf(catalog, 'scrollHelpUp').slice(0, 1),
  ];

  const closeKey = keyNamesOf(catalog, 'closeHelp')[0];
  const parts = [position];

  if (scrollKeys.length > 0) {
    parts.push(`${scrollKeys.join('/')} scroll`);
  }

  if (closeKey !== undefined) {
    parts.push(`${closeKey} close`);
  }

  while (parts.length > 1 && parts.join('  ').length > innerWidth) {
    parts.pop();
  }

  return fitted(parts.join('  '), innerWidth);
};

export const helpWindowOf = (
  catalog: readonly Command[],
  height: number,
  width: number,
): HelpWindow => {
  const boxWidth = Math.max(minimumBoxWidth, Math.min(width - terminalMargin, maximumBoxWidth));
  const lines = linesOf(catalog, boxWidth - boxChromeColumns);
  const availableRows = Math.max(1, height - statusRows);
  const overflows = lines.length + borderRows > availableRows;

  const viewportRows = overflows
    ? Math.max(1, availableRows - borderRows - footerRows)
    : lines.length;

  const boxHeight = viewportRows + borderRows + (overflows ? footerRows : 0);

  return {
    lines,
    viewportRows,
    maximumTop: lines.length - viewportRows,
    overflows,
    boxWidth,
    boxHeight,
  };
};
