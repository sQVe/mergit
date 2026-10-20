import type { Snapshot } from '../session/session.ts';
import { wrapCells } from './textLayout.ts';

type Message = Snapshot['messages'][number];

interface MessageRow {
  key: string;
  time: string;
  tone: Message['tone'] | null;
  text: string;
  dim: boolean;
}

export interface MessageWindow {
  rows: readonly MessageRow[];
  viewportRows: number;
  maximumTop: number;
  overflows: boolean;
}

const borderRows = 2;
const footerRows = 1;
const toneColumns = 5;
const timeColumns = 8;
const columnGap = 1;
const prefixColumns = timeColumns + columnGap + toneColumns + columnGap;
const boxChromeColumns = 4;

const pad = (value: number): string => String(value).padStart(2, '0');

const timeOf = (moment: Date): string =>
  `${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`;

const lineBreak = /\r\n|\r|\n/;

const rowsOfMessage = (message: Message, columns: number): MessageRow[] => {
  const titleChunks = wrapCells(message.title, columns);

  const titleRows = titleChunks.map((text, index) => ({
    key: `${message.id}-title-${index}`,
    time: index === 0 ? timeOf(message.shownAt) : '',
    tone: index === 0 ? message.tone : null,
    text,
    dim: false,
  }));

  const textLines = message.lines.flatMap((line) => line.split(lineBreak));

  const lineRows = textLines.flatMap((line, lineIndex) =>
    wrapCells(line, columns).map((text, index) => ({
      key: `${message.id}-line-${lineIndex}-${index}`,
      time: '',
      tone: null,
      text,
      dim: true,
    })),
  );

  return [...titleRows, ...lineRows];
};

export const messageWindowOf = (
  messages: readonly Message[],
  width: number,
  height: number,
): MessageWindow => {
  const columns = Math.max(1, width - boxChromeColumns - prefixColumns);
  const rows = messages.flatMap((message) => rowsOfMessage(message, columns));
  const availableRows = Math.max(1, height - borderRows);
  const overflows = rows.length > availableRows;
  const viewportRows = overflows ? Math.max(1, availableRows - footerRows) : availableRows;

  return { rows, viewportRows, maximumTop: Math.max(0, rows.length - viewportRows), overflows };
};
