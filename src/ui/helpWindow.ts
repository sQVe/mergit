import type { Command } from '../commands.ts';
import { keyNamesOf, readableKeyOf } from '../commands.ts';

export interface HelpWindow {
  commands: readonly Command[];
  viewportRows: number;
  maximumTop: number;
  overflows: boolean;
  boxWidth: number;
}

const borderRows = 2;
const footerRows = 1;
const boxChromeColumns = 4;
const rowGap = 2;

const suffixes: Partial<Record<Command['scope'], string>> = {
  input: '(search line)',
  filter: '(filter composer)',
  command: '(command line)',
};

export const suffixOf = (command: Command): string | undefined => suffixes[command.scope];

export const keysTextOf = (command: Command): string => {
  const texts = command.keys.map((key) => readableKeyOf(key));

  if (command.name !== undefined) {
    texts.push(`:${command.name}`);
  }

  return texts.join(' ');
};

const rowTextsOf = (command: Command): string[] => {
  const texts: string[] = [];

  const keysText = keysTextOf(command);

  if (keysText !== '') {
    texts.push(keysText);
  }

  texts.push(command.label);

  const suffix = suffixOf(command);

  if (suffix !== undefined) {
    texts.push(suffix);
  }

  return texts;
};

const rowWidthOf = (command: Command): number => {
  const texts = rowTextsOf(command);
  const textWidth = texts.reduce((sum, text) => sum + text.length, 0);

  return textWidth + rowGap * (texts.length - 1);
};

export const footerOf = (catalog: readonly Command[], position: string): string => {
  const scrollKeys = [
    keyNamesOf(catalog, 'scrollHelpDown')[0] ?? '',
    keyNamesOf(catalog, 'scrollHelpUp')[0] ?? '',
  ];

  const closeKey = keyNamesOf(catalog, 'closeHelp')[0] ?? '';

  return `${position}  ${scrollKeys.join('/')} scroll  ${closeKey} close`;
};

export const helpWindowOf = (catalog: readonly Command[], height: number): HelpWindow => {
  const commands = catalog.filter((command) => command.scope !== 'confirm');
  const overflows = commands.length + borderRows > height;
  const viewportRows = overflows ? Math.max(1, height - borderRows - footerRows) : commands.length;

  const widestRow = Math.max(0, ...commands.map(rowWidthOf));
  const widestPosition = `${commands.length}-${commands.length} of ${commands.length}`;
  const footerWidth = overflows ? footerOf(catalog, widestPosition).length : 0;

  return {
    commands,
    viewportRows,
    maximumTop: commands.length - viewportRows,
    overflows,
    boxWidth: Math.max(widestRow, footerWidth) + boxChromeColumns,
  };
};
