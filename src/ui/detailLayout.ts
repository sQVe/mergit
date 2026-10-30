import type { DetailAnchor, DetailPosition } from '../session/session.ts';
import type { DetailCoverage } from '../work/work.ts';
import { cellWidth, fitText, visibleText } from './textLayout.ts';

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

export const noDescription = 'No description provided.';

const reasonOf = (message: string | null): string => (message === null ? '' : `. ${message}`);

export const coverageTextOf = (
  coverage: DetailCoverage,
  message: string | null,
  loaded: number,
): string | null => {
  if (coverage === 'loaded') {
    return null;
  }

  if (coverage === 'partial') {
    return `Partial: ${loaded} loaded, more may exist${reasonOf(message)}`;
  }

  if (coverage === 'failed') {
    const shown = loaded > 0 ? '. Showing loaded content' : '';

    return `Failed: ${message ?? 'the read did not finish'}${shown}`;
  }

  return coverage === 'unavailable' ? 'Unavailable' : 'Loading';
};

const segmenter = new Intl.Segmenter();

const lineOf = (record: DetailRecord, position: DetailPosition, text: string): DetailLine => ({
  recordId: record.id,
  digest: record.digest,
  position,
  text,
});

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
    lines.push(lineOf(record, { kind: 'heading' }, fitText(visibleText(record.heading), columns)));
  }

  let start = 0;

  for (const paragraph of visibleText(record.text).split('\n')) {
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

const positionIndexOf = (lines: readonly DetailLine[], anchor: DetailAnchor, start: number) => {
  const { position, recordId } = anchor;

  const found =
    position.kind === 'text'
      ? textIndexOf(lines, recordId, position.offset)
      : kindIndexOf(lines, recordId, position.kind);

  return found === -1 ? start : found;
};

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

export const anchorOfLine = (line: DetailLine, order: readonly string[]): DetailAnchor => ({
  recordId: line.recordId,
  digest: line.digest,
  position: line.position,
  earlierRecordIds: order.slice(0, Math.max(0, order.indexOf(line.recordId))),
});
