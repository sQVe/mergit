import type { Command } from '../commands.ts';

export interface HelpWindow {
  commands: readonly Command[];
  viewportRows: number;
  maximumTop: number;
  overflows: boolean;
}

const borderRows = 2;
const footerRows = 1;

export const helpWindowOf = (catalog: readonly Command[], height: number): HelpWindow => {
  const commands = catalog.filter((command) => command.scope !== 'confirm');
  const overflows = commands.length + borderRows > height;
  const viewportRows = overflows ? Math.max(1, height - borderRows - footerRows) : commands.length;

  return { commands, viewportRows, maximumTop: commands.length - viewportRows, overflows };
};
