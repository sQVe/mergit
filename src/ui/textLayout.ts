const segmenter = new Intl.Segmenter();

const ellipsis = '…';

export const cellWidth = (text: string): number => {
  let total = 0;

  for (const { segment } of segmenter.segment(text)) {
    total += Bun.stringWidth(segment);
  }

  return total;
};

export const fitText = (text: string, columns: number): string => {
  if (columns < 1) {
    return '';
  }

  if (cellWidth(text) <= columns) {
    return text;
  }

  const room = columns - Bun.stringWidth(ellipsis);
  let kept = '';
  let keptWidth = 0;

  for (const { segment } of segmenter.segment(text)) {
    const width = Bun.stringWidth(segment);

    if (keptWidth + width > room) {
      break;
    }

    kept += segment;
    keptWidth += width;
  }

  return `${kept}${ellipsis}`;
};

export const wrapCells = (text: string, columns: number): string[] => {
  const chunks: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const { segment } of segmenter.segment(text)) {
    const width = Bun.stringWidth(segment);

    if (current !== '' && currentWidth + width > columns) {
      chunks.push(current);
      current = '';
      currentWidth = 0;
    }

    current += segment;
    currentWidth += width;
  }

  chunks.push(current);

  return chunks;
};

export const wrapText = (text: string, width: number, maxLines: number): string[] => {
  const lines: string[] = [];
  let current = '';

  for (const word of text.split(' ').filter((part) => part !== '')) {
    const joined = current === '' ? word : `${current} ${word}`;

    if (cellWidth(joined) <= width || current === '') {
      current = joined;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current !== '') {
    lines.push(current);
  }

  if (lines.length <= maxLines) {
    return lines.map((line) => fitText(line, width));
  }

  const kept = lines.slice(0, maxLines);
  const last = kept.at(-1) ?? '';

  return [...kept.slice(0, -1), fitText(`${last}${ellipsis}`, width)];
};
