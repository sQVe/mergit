import type { Command } from '../commands.ts';

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

export const suffixOf = (command: Command): string | undefined => {
  if (command.scope === 'input') {
    return '(search line)';
  }

  return command.scope === 'filter' ? '(filter composer)' : undefined;
};

const rowTextsOf = (command: Command): string[] => {
  const texts: string[] = [];

  if (command.keys.length > 0) {
    texts.push(command.keys.join(' '));
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

export const helpWindowOf = (catalog: readonly Command[], height: number): HelpWindow => {
  const commands = catalog.filter((command) => command.scope !== 'confirm');
  const overflows = commands.length + borderRows > height;
  const viewportRows = overflows ? Math.max(1, height - borderRows - footerRows) : commands.length;

  const widestRow = Math.max(0, ...commands.map(rowWidthOf));

  return {
    commands,
    viewportRows,
    maximumTop: commands.length - viewportRows,
    overflows,
    boxWidth: widestRow + boxChromeColumns,
  };
};
