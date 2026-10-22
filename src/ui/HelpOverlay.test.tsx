import { afterEach, expect, test } from 'bun:test';

import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';

import { catalog } from '../commands.ts';
import type { Command } from '../commands.ts';
import { HelpOverlay } from './HelpOverlay.tsx';
import { helpWindowOf } from './helpWindow.ts';
import { pickPalette } from './palette.ts';
import { track, mount as untrackedMount } from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const boxWidth = 64;

const sectionTitles = [
  'App',
  'Moving',
  'Folding',
  'Threads',
  'Search',
  'Filters',
  'Command line',
  'Overlays',
];

const totalLines = helpWindowOf(catalog, 1000, 80).lines.length;
const fitsHeight = totalLines + 3;

// The text between the left and right padding of each row inside the help box.
const boxRowsOf = (frame: string, width = boxWidth): string[] => {
  const lines = frame.split('\n');
  const first = lines.findIndex((line) => line.includes('╭'));
  const last = lines.findIndex((line) => line.includes('╰'));

  return lines.slice(first + 1, last).map((line) => line.slice(4, width));
};

const borderRowOf = (frame: string): number =>
  frame.split('\n').findIndex((line) => line.includes('╰'));

const isHeading = (text: string): boolean =>
  sectionTitles.some((title) => text.startsWith(title) && !text.includes('  '));

const isFooter = (text: string): boolean => /\d+-\d+ of \d+/u.test(text);

const renderOverlay = async (
  custom: readonly Command[],
  size: { width: number; height: number },
  top = 0,
) => {
  const setup = await act(() =>
    testRender(
      <HelpOverlay
        catalog={custom}
        palette={pickPalette('dark')}
        height={size.height}
        helpWindow={helpWindowOf(custom, size.height, size.width)}
        top={top}
      />,
      size,
    ),
  );

  cleanups.push(() => {
    setup.renderer.destroy();
  });

  await act(() => setup.renderOnce());

  return setup;
};

const frameOf = async (
  custom: readonly Command[],
  size: { width: number; height: number },
  top = 0,
): Promise<string> => {
  const setup = await renderOverlay(custom, size, top);

  return setup.captureCharFrame();
};

// One frame per page of help, from the first line to the last.
const framesThroughHelp = async (
  custom: readonly Command[],
  size: { width: number; height: number },
): Promise<string[]> => {
  const { viewportRows, maximumTop } = helpWindowOf(custom, size.height, size.width);
  const frames: string[] = [];

  for (let top = 0; top < maximumTop + viewportRows; top += viewportRows) {
    frames.push(await frameOf(custom, size, Math.min(top, maximumTop)));
  }

  return frames;
};

const rowTextsOf = (frames: string[]): string[] =>
  frames.flatMap((frame) => boxRowsOf(frame).map((row) => row.trim()));

test('help at 80x24 sits above the status line with keys at the left and labels at the right', async () => {
  const { setup, press } = await mount({ width: 80, height: 24 });

  await press('?');

  const frame = setup.captureCharFrame();
  const lines = frame.split('\n');
  const rows = boxRowsOf(frame);
  const quitRow = rows.find((row) => row.endsWith('Quit'));

  expect(frame).toContain('App');
  expect(borderRowOf(frame)).toBe(22);
  expect(quitRow?.startsWith('q/Ctrl+C')).toBe(true);
  expect(quitRow?.length).toBe(boxWidth - 4);

  const quitLine = lines.find((line) => line.includes('q/Ctrl+C')) ?? '';

  expect(quitLine.slice(2, 4)).toBe('│ ');
  expect(quitLine.slice(boxWidth, boxWidth + 2)).toBe(' │');
});

for (const size of [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
]) {
  test(`help at ${size.width}x${size.height} shows the sections in order with aligned rows`, async () => {
    const frames = await framesThroughHelp(catalog, size);
    const headings: string[] = [];

    for (const frame of frames) {
      expect(borderRowOf(frame)).toBe(size.height - 2);

      for (const row of boxRowsOf(frame)) {
        const text = row.trim();
        const title = sectionTitles.find((candidate) => text.startsWith(candidate));

        if (isHeading(text) && title !== undefined && !headings.includes(title)) {
          headings.push(title);
        }

        if (text === '' || isHeading(text) || isFooter(text)) {
          continue;
        }

        expect(row[0]).not.toBe(' ');
        expect(row.length).toBe(boxWidth - 4);
        expect(row.at(-1)).not.toBe(' ');
      }

      for (const line of frame.split('\n')) {
        if (line.slice(2, 4) === '│ ') {
          expect(line[boxWidth + 1]).toBe('│');
          expect(line[boxWidth]).toBe(' ');
        }
      }
    }

    expect(headings).toEqual(sectionTitles);
  });
}

test('help rows carry no scope suffix', async () => {
  const frames = await framesThroughHelp(catalog, { width: 80, height: 24 });

  const suffixed = rowTextsOf(frames).filter((row) =>
    /\((search line|filter composer|command line)\)$/u.test(row),
  );

  expect(rowTextsOf(frames).length).toBeGreaterThan(totalLines);
  expect(suffixed).toEqual([]);
});

test('help shows the keys and named commands of a custom catalog', async () => {
  const quit = catalog.find((command) => command.id === 'quit') as Command;

  const custom: readonly Command[] = [
    ...catalog.map((command) =>
      command.id === 'selectNext' ? Object.assign({}, command, { keys: ['n', 'down'] }) : command,
    ),
    { ...quit, id: 'quitByName', label: 'Leave Mergit', names: ['bye'], keys: [] },
    { ...quit, id: 'quitByKeyAndName', label: 'Go away', names: ['away'], keys: ['x', 'ctrl+x'] },
  ];

  const frame = await frameOf(custom, { width: 80, height: 100 });
  const rows = boxRowsOf(frame).map((row) => row.trim());

  expect(rows.find((row) => row.endsWith('Select next row'))).toMatch(/^n\/↓\s+Select next row$/u);
  expect(rows.find((row) => row.endsWith('Leave Mergit'))).toMatch(/^:bye\s+Leave Mergit$/u);
  expect(rows.find((row) => row.endsWith('Go away'))).toMatch(/^x\/Ctrl\+X\/:away\s+Go away$/u);
});

test('help lists the shared input line commands and quit once each', async () => {
  const frame = await frameOf(catalog, { width: 80, height: 100 });
  const rows = boxRowsOf(frame).map((row) => row.trim());
  const countOf = (label: string) => rows.filter((row) => row.endsWith(label)).length;

  expect(countOf('Clear an input line')).toBe(1);
  expect(countOf('Close an empty input line')).toBe(1);
  expect(countOf('Quit')).toBe(1);
});

test('section headings name the opener keys from the catalog', async () => {
  const frame = await frameOf(catalog, { width: 80, height: 100 });
  const rows = boxRowsOf(frame).map((row) => row.trim());

  expect(rows).toContain('Search (opens with /)');
  expect(rows).toContain('Filters (opens with f)');
  expect(rows).toContain('Command line (opens with :)');
});

test('a section heading leaves out the opener when the opener has no key', async () => {
  const custom = catalog.map((command) =>
    command.id === 'openSearch' ? Object.assign({}, command, { keys: [] }) : command,
  );

  const frame = await frameOf(custom, { width: 80, height: 100 });

  expect(boxRowsOf(frame).map((row) => row.trim())).toContain('Search');
});

test('a label that does not fit is cut with an ellipsis at the right border', async () => {
  const frames = await framesThroughHelp(catalog, { width: 30, height: 24 });
  const rows = frames.flatMap((frame) => boxRowsOf(frame, 26));
  const cut = rows.find((row) => row.startsWith('Esc Close the comp'));

  expect(cut).toBe('Esc Close the compose…');
});

test('? opens the overlay and ? closes it', async () => {
  const { setup, press } = await mount({ height: 100 });

  await press('?');

  const open = setup.captureCharFrame();

  expect(open).toContain('Toggle help');
  expect(open).not.toContain('Confirm opening');

  await press('?');

  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('Escape closes the overlay', async () => {
  const { setup, press } = await mount();

  await press('?');
  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('escape does nothing while the overlay is closed', async () => {
  const { setup, press } = await mount({ height: 100 });

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Close help');
});

const scrollHeight = 40;
const scrollMaximumTop = helpWindowOf(catalog, scrollHeight, 80).maximumTop;
const scrollViewport = helpWindowOf(catalog, scrollHeight, 80).viewportRows;

test('scrolling stops at the first line and at the last', async () => {
  const { setup, press } = await mount({ width: 80, height: scrollHeight });

  await press('?');
  await press('k');
  await press('up');

  expect(setup.captureCharFrame()).toContain(`1-${scrollViewport} of ${totalLines}`);
  expect(setup.captureCharFrame()).not.toContain('Close help');

  for (let presses = 0; presses < scrollMaximumTop; presses += 1) {
    await press('j');
  }

  const bottom = setup.captureCharFrame();

  expect(bottom).toContain(`${totalLines - scrollViewport + 1}-${totalLines} of ${totalLines}`);
  expect(bottom).toContain('Close help');

  await press('down');

  expect(setup.captureCharFrame()).toBe(bottom);

  await press('k');

  expect(setup.captureCharFrame()).not.toBe(bottom);
});

test('the first scroll key after a resize moves one line from what is shown', async () => {
  const { setup, press, resize } = await mount({ width: 80, height: scrollHeight });

  await press('?');

  for (let presses = 0; presses < scrollMaximumTop; presses += 1) {
    await press('j');
  }

  await resize(80, scrollHeight + 4);

  const grown = scrollViewport + 4;

  expect(setup.captureCharFrame()).toContain(
    `${totalLines - grown + 1}-${totalLines} of ${totalLines}`,
  );

  await press('k');

  expect(setup.captureCharFrame()).toContain(
    `${totalLines - grown}-${totalLines - 1} of ${totalLines}`,
  );
});

test('the help box keeps its width at every scroll position', async () => {
  const frames = await framesThroughHelp(catalog, { width: 80, height: 24 });

  for (const frame of frames) {
    const border = frame.split('\n').find((line) => line.includes('╭')) ?? '';

    expect(border.lastIndexOf('╮')).toBe(boxWidth + 1);
  }
});

test('help that fits shows no position hint', async () => {
  const frame = await frameOf(catalog, { width: 80, height: fitsHeight });

  expect(frame).not.toMatch(/\d+-\d+ of \d+/);
  expect(frame).not.toContain('scroll');
  expect(frame).toContain('Close help');
  expect(borderRowOf(frame)).toBe(fitsHeight - 2);
});

test('help one row shorter overflows and shows the footer with the scroll and close keys', async () => {
  const frame = await frameOf(catalog, { width: 80, height: fitsHeight - 1 });

  expect(frame).toContain(`1-${totalLines - 2} of ${totalLines}  j/k scroll  Esc close`);
});

test('help lists the :messages command', async () => {
  const frame = await frameOf(catalog, { width: 80, height: 100 });

  expect(frame).toContain(':messages');
  expect(frame).toContain('Show recent messages');
});

test('help shows readable key names instead of raw ones', async () => {
  const frame = await frameOf(catalog, { width: 80, height: 100 });

  expect(frame).toContain('Enter');
  expect(frame).toContain('G');
  expect(frame).not.toContain('return');
  expect(frame).not.toContain('shift+g');
});

const commandOf = (id: string, keys: string[]): Command => ({
  id,
  label: `Label of ${id}`,
  scope: 'global',
  section: 'app',
  keys,
  disabledReason: () => undefined,
  intent: () => ({ kind: 'terminal', action: 'quit' }),
});

test('a command without keys renders its label at the right border', async () => {
  const setup = await renderOverlay([commandOf('nameOnly', [])], { width: 80, height: 24 });
  const frame = setup.captureCharFrame();
  const row = frame.split('\n').find((line) => line.includes('Label of nameOnly')) ?? '';

  expect(row.slice(boxWidth - 'Label of nameOnly'.length, boxWidth + 2)).toBe(
    'Label of nameOnly │',
  );
});

test('the footer names the scroll and close keys that the catalog gives', async () => {
  const custom = [
    commandOf('scrollHelpDown', ['n', 'down']),
    commandOf('scrollHelpUp', ['p', 'up']),
    commandOf('closeHelp', ['x']),
    commandOf('other', ['o']),
    commandOf('another', ['a']),
  ];

  const setup = await renderOverlay(custom, { width: 80, height: 7 });
  const frame = setup.captureCharFrame();

  expect(frame).toContain('1-3 of 6  n/p scroll  x close');
  expect(frame).toContain('╰');
});

test('help at 40x24 keeps the footer on one row and the Moving rows apart', async () => {
  const { setup, press } = await mount({ width: 40, height: 24 });

  await press('?');

  const lines = setup.captureCharFrame().split('\n');
  const firstRows = lines.filter((line) => line.includes('Select first row'));
  const lastRows = lines.filter((line) => line.includes('Select last row'));
  const footers = lines.filter((line) => /\d+-\d+ of \d+/u.test(line));

  expect(firstRows).toHaveLength(1);
  expect(lastRows).toHaveLength(1);
  expect(firstRows[0]).not.toBe(lastRows[0]);
  expect(footers).toHaveLength(1);
  expect(footers[0]?.trimEnd().endsWith('│')).toBe(true);
});

test('help separates each section from the next with one empty row', async () => {
  const frame = await frameOf(catalog, { width: 80, height: fitsHeight + 2 });
  const rows = boxRowsOf(frame).map((row) => row.trim());
  const emptyRowCount = rows.filter((row) => row === '').length;

  expect(emptyRowCount).toBe(sectionTitles.length - 1);

  rows.forEach((row, index) => {
    if (row === '') {
      expect(isHeading(rows[index + 1] ?? '')).toBe(true);
    }
  });
});
