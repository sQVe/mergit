import type { ReactNode } from 'react';

import type { Filter } from '../session/session.ts';
import { formatFilter } from '../session/session.ts';
import { ellipsized } from './CandidateList.tsx';
import type { Palette } from './palette.ts';

interface Chip {
  text: string;
  separator: string;
}

const orSeparator = ' or ';
const andSeparator = ' and ';
const conjunctiveFields = new Set(['age', 'title']);
const gapSeparator = '  ';

const groupedByField = (filters: Filter[]): Filter[] => {
  const fields = [...new Set(filters.map((filter) => filter.field))];

  return fields.flatMap((field) => {
    const ofField = filters.filter((filter) => filter.field === field);
    const positive = ofField.filter((filter) => !filter.negated);
    const negated = ofField.filter((filter) => filter.negated);

    return positive.concat(negated);
  });
};

const chipsOf = (filters: Filter[]): Chip[] =>
  groupedByField(filters).map((filter, index, grouped) => {
    const previous = grouped[index - 1];

    if (previous === undefined) {
      return { text: formatFilter(filter), separator: '' };
    }

    const joined = previous.field === filter.field && !previous.negated && !filter.negated;
    const joiner = conjunctiveFields.has(filter.field) ? andSeparator : orSeparator;
    const separator = joined ? joiner : gapSeparator;

    return { text: formatFilter(filter), separator };
  });

const moreLabel = (hidden: number): string => `${gapSeparator}+${hidden} more`;

const widthOf = (chips: Chip[]): number =>
  chips.reduce((total, chip) => total + chip.separator.length + chip.text.length, 0);

const shownChips = (chips: Chip[], width: number): Chip[] => {
  for (let shown = chips.length; shown > 0; shown -= 1) {
    const hidden = chips.length - shown;
    const reserved = hidden === 0 ? 0 : moreLabel(hidden).length;

    if (widthOf(chips.slice(0, shown)) + reserved <= width) {
      return chips.slice(0, shown);
    }
  }

  return chips.slice(0, 1);
};

export const FilterBar = (props: {
  filters: Filter[];
  palette: Palette;
  width: number;
}): ReactNode => {
  const { filters, palette, width } = props;
  const chips = chipsOf(filters);
  const shown = shownChips(chips, width);
  const hidden = chips.length - shown.length;
  const room = width - (hidden === 0 ? 0 : moreLabel(hidden).length);

  return (
    <box height={1} flexShrink={0} flexDirection="row">
      {shown.map((chip, index) => (
        <box key={chip.text} flexDirection="row">
          {chip.separator === '' ? null : <text fg={palette.dim}>{chip.separator}</text>}
          <text fg={palette.key}>{index === 0 ? ellipsized(chip.text, room) : chip.text}</text>
        </box>
      ))}
      {hidden === 0 ? null : <text fg={palette.dim}>{moreLabel(hidden)}</text>}
    </box>
  );
};
