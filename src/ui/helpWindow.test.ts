import { expect, test } from 'bun:test';

import { catalog } from '../commands.ts';
import { boxChromeColumns, footerOf, helpWindowOf } from './helpWindow.ts';

const withKeys = (keys: Record<string, readonly string[]>) =>
  catalog.map((command) => Object.assign({}, command, { keys: keys[command.id] ?? command.keys }));

test('the help footer shows the first key of each command', () => {
  const moved = withKeys({ selectNext: ['n', 'x'], selectPrevious: ['p'], closeHelp: ['q'] });

  expect(footerOf(moved, '1-5 of 9', 60)).toBe('1-5 of 9  n/p scroll  q close');
});

test('the help footer leaves out an action whose commands have no keys', () => {
  const bare = withKeys({ selectNext: [], selectPrevious: [], closeHelp: [] });

  expect(footerOf(bare, '1-5 of 9', 60)).toBe('1-5 of 9');
});

test('the help footer names the one scroll key that exists', () => {
  const upOnly = withKeys({ selectNext: [], selectPrevious: ['k'], closeHelp: ['q'] });

  expect(footerOf(upOnly, '1-5 of 9', 60)).toBe('1-5 of 9  k scroll  q close');
});

test('the help box is 64 columns wide on a wide terminal and 4 less than a narrow one', () => {
  expect(helpWindowOf(catalog, 40, 200).boxWidth).toBe(64);
  expect(helpWindowOf(catalog, 40, 50).boxWidth).toBe(46);
  expect(helpWindowOf(catalog, 40, 10).boxWidth).toBe(20);
});

test('the help box leaves the status line free and grows by line count', () => {
  const tall = helpWindowOf(catalog, 200, 80);
  const short = helpWindowOf(catalog, 24, 80);

  expect(tall.overflows).toBe(false);
  expect(tall.boxHeight).toBe(tall.lines.length + 2);
  expect(short.overflows).toBe(true);
  expect(short.boxHeight).toBe(23);
  expect(short.maximumTop).toBe(tall.lines.length - short.viewportRows);
});

test('the help footer drops the close hint, then the scroll hint, to fit a narrow width', () => {
  expect(footerOf(catalog, '1-5 of 99', 29)).toBe('1-5 of 99  j/k scroll');
  expect(footerOf(catalog, '1-5 of 99', 20)).toBe('1-5 of 99');
});

test('the help footer cuts the position with an ellipsis when it alone is too wide', () => {
  expect(footerOf(catalog, '1-5 of 99', 6)).toBe('1-5 o…');
});

test('the help footer is never wider than the inner width of the box', () => {
  for (let width = 20; width <= 80; width += 1) {
    const window = helpWindowOf(catalog, 10, width);
    const inner = window.boxWidth - boxChromeColumns;

    expect(footerOf(catalog, '100-120 of 120', inner).length).toBeLessThanOrEqual(inner);
  }
});

test('the help footer keeps every part when the text exactly fills the inner width', () => {
  const text = '1-5 of 99  j/k scroll';

  expect(footerOf(catalog, '1-5 of 99', text.length)).toBe(text);
  expect(footerOf(catalog, '1-5 of 99', text.length - 1)).toBe('1-5 of 99');
});
