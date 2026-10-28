import { expect, test } from 'bun:test';

import type { DetailLine, DetailRecord } from './detailLayout.ts';
import { anchorOfLine, layoutRecords, topOfAnchor } from './detailLayout.ts';

const recordOf = (id: string, text: string, digest = `digest-${id}`): DetailRecord => ({
  id,
  digest,
  heading: `@${id}`,
  text,
});

const offsetOf = (line: DetailLine): number =>
  line.position.kind === 'text' ? line.position.offset : Number.NaN;

const prose = 'one two three four five six seven eight nine ten eleven twelve';

test('lines break at spaces and keep the offset of their first character', () => {
  const lines = layoutRecords([recordOf('a', prose)], 14);
  const body = lines.slice(1);

  expect(body.map((line) => line.text)).toEqual([
    'one two three',
    'four five six',
    'seven eight',
    'nine ten',
    'eleven twelve',
  ]);

  for (const line of body) {
    expect(prose.slice(offsetOf(line)).startsWith(line.text)).toBe(true);
  }
});

test('a word wider than the line breaks between graphemes', () => {
  const text = '👍🏽👍🏽👍🏽👍🏽';
  const body = layoutRecords([recordOf('a', text)], 4).slice(1);

  expect(body.map((line) => line.text)).toEqual(['👍🏽👍🏽', '👍🏽👍🏽']);
  expect(body.map(offsetOf)).toEqual([0, '👍🏽👍🏽'.length]);
});

test('after a resize the top line is the one that holds the anchor offset', () => {
  const wide = layoutRecords([recordOf('a', prose)], 30);
  const anchor = anchorOfLine(wide[2] ?? wide[0]!, ['a']);
  const narrow = layoutRecords([recordOf('a', prose)], 10);
  const top = narrow[topOfAnchor(narrow, anchor)];

  const anchorOffset = anchor.position.kind === 'text' ? anchor.position.offset : -1;
  const holding = narrow.map(offsetOf).filter((offset) => offset <= anchorOffset);

  expect(anchorOffset).toBeGreaterThan(0);
  expect(top === undefined ? undefined : offsetOf(top)).toBe(Math.max(...holding));
});

test('a changed digest starts at the first line of that record', () => {
  const before = layoutRecords([recordOf('a', 'first'), recordOf('b', prose)], 14);
  const anchor = anchorOfLine(before.at(-1)!, ['a', 'b']);
  const after = layoutRecords([recordOf('a', 'first'), recordOf('b', prose, 'edited')], 14);

  expect(after[topOfAnchor(after, anchor)]?.text).toBe('@b');
});

test('a removed record falls back to the nearest surviving record before it, or the top', () => {
  const order = ['a', 'b', 'c', 'd'];

  const before = layoutRecords(
    order.map((id) => recordOf(id, `text of ${id}`)),
    20,
  );

  const anchor = anchorOfLine(
    before.find((line) => line.recordId === 'c')!,
    order,
  );

  const withoutC = layoutRecords(
    ['a', 'b', 'd'].map((id) => recordOf(id, `text of ${id}`)),
    20,
  );

  const onlyD = layoutRecords([recordOf('d', 'text of d')], 20);

  expect(withoutC[topOfAnchor(withoutC, anchor)]?.text).toBe('@b');
  expect(topOfAnchor(onlyD, anchor)).toBe(0);
});

test('a heading, its text lines, and the blank line before it each restore to their own line', () => {
  const order = ['a', 'b'];
  const lines = layoutRecords([recordOf('a', 'first'), recordOf('b', prose)], 14);

  for (const [index, line] of lines.entries()) {
    expect(topOfAnchor(lines, anchorOfLine(line, order))).toBe(index);
  }
});

test('a separator anchor restores to its record heading when the record becomes first', () => {
  const order = ['a', 'b', 'c'];

  const before = layoutRecords(
    order.map((id) => recordOf(id, `text of ${id}`)),
    20,
  );

  const separator = before.find(
    (line) => line.recordId === 'b' && line.position.kind === 'separator',
  );

  const after = layoutRecords(
    ['b', 'c'].map((id) => recordOf(id, `text of ${id}`)),
    20,
  );

  expect(separator).toBeDefined();
  expect(after[topOfAnchor(after, anchorOfLine(separator!, order))]?.text).toBe('@b');
});
