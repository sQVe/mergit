import type { DetailAnchor, DetailPosition } from '../session/session.ts';
import { cellWidth, fitText } from './textLayout.ts';

export interface DetailRecord {
  id: string;
  digest: string;
  heading: string | null;
  text: string;
}

export interface DetailLine {
  recordId: string;
  digest: string;
  position: DetailPosition;
  text: string;
}

const segmenter = new Intl.Segmenter();

const lineOf = (record: DetailRecord, position: DetailPosition, text: string): DetailLine => ({
  recordId: record.id,
  digest: record.digest,
  position,
  text,
});

// Breaks after the last space that fits, or between graphemes when one word is wider than the line.
const wrapParagraph = (paragraph: string, start: number, columns: number): [number, string][] => {
  const lines: [number, string][] = [];
  let lineStart = 0;
  let lineWidth = 0;
  let breakAt: number | null = null;

  for (const { segment, index } of segmenter.segment(paragraph)) {
    const width = Bun.stringWidth(segment);
    const overflows = lineWidth + width > columns && index > lineStart;

    if (overflows) {
      const end = breakAt ?? index;

      lines.push([start + lineStart, paragraph.slice(lineStart, end).trimEnd()]);
      lineStart = end;
      lineWidth = cellWidth(paragraph.slice(lineStart, index));
      breakAt = null;
    }

    lineWidth += width;

    if (segment === ' ') {
      breakAt = index + segment.length;
    }
  }

  lines.push([start + lineStart, paragraph.slice(lineStart).trimEnd()]);

  return lines;
};

const recordLines = (record: DetailRecord, columns: number): DetailLine[] => {
  const lines: DetailLine[] = [];

  if (record.heading !== null) {
    lines.push(lineOf(record, { kind: 'heading' }, fitText(record.heading, columns)));
  }

  let start = 0;

  for (const paragraph of record.text.split('\n')) {
    for (const [offset, text] of wrapParagraph(paragraph, start, columns)) {
      lines.push(lineOf(record, { kind: 'text', offset }, text));
    }

    start += paragraph.length + 1;
  }

  return lines;
};

export const layoutRecords = (records: readonly DetailRecord[], columns: number): DetailLine[] => {
  const width = Math.max(1, columns);
  const lines: DetailLine[] = [];

  // The blank line before a record belongs to it, so every line has its own anchor.
  for (const [index, record] of records.entries()) {
    if (index > 0) {
      lines.push(lineOf(record, { kind: 'separator' }, ''));
    }

    lines.push(...recordLines(record, width));
  }

  return lines;
};

const startIndexOf = (lines: readonly DetailLine[], recordId: string): number =>
  lines.findIndex((line) => line.recordId === recordId && line.position.kind !== 'separator');

const textOffsetOf = (line: DetailLine): number | null =>
  line.position.kind === 'text' ? line.position.offset : null;

// Offsets grow within a record, so the last text line that starts at or before the offset holds it.
const textIndexOf = (lines: readonly DetailLine[], recordId: string, offset: number): number => {
  let found = -1;

  for (const [index, line] of lines.entries()) {
    const lineOffset = textOffsetOf(line);

    if (line.recordId === recordId && lineOffset !== null && lineOffset <= offset) {
      found = index;
    }
  }

  return found;
};

const kindIndexOf = (
  lines: readonly DetailLine[],
  recordId: string,
  kind: 'separator' | 'heading',
) => lines.findIndex((line) => line.recordId === recordId && line.position.kind === kind);

// A line that no longer exists, such as the separator before a record that is now first, restores
// to the record's start.
const positionIndexOf = (lines: readonly DetailLine[], anchor: DetailAnchor, start: number) => {
  const { position, recordId } = anchor;

  const found =
    position.kind === 'text'
      ? textIndexOf(lines, recordId, position.offset)
      : kindIndexOf(lines, recordId, position.kind);

  return found === -1 ? start : found;
};

// A missing record falls back to the nearest surviving record before it, or the top.
export const topOfAnchor = (
  lines: readonly DetailLine[],
  anchor: DetailAnchor | undefined,
): number => {
  if (anchor === undefined) {
    return 0;
  }

  const start = startIndexOf(lines, anchor.recordId);

  if (start === -1) {
    const survivor = anchor.earlierRecordIds
      .toReversed()
      .find((recordId) => startIndexOf(lines, recordId) !== -1);

    return survivor === undefined ? 0 : startIndexOf(lines, survivor);
  }

  if (lines[start]?.digest !== anchor.digest) {
    return start;
  }

  return positionIndexOf(lines, anchor, start);
};

// `order` is the tab's record IDs, so the anchor can fall back when its record disappears.
export const anchorOfLine = (line: DetailLine, order: readonly string[]): DetailAnchor => ({
  recordId: line.recordId,
  digest: line.digest,
  position: line.position,
  earlierRecordIds: order.slice(0, Math.max(0, order.indexOf(line.recordId))),
});
