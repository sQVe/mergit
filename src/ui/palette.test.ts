import { expect, test } from 'bun:test';

import { pickPalette } from './palette.ts';

test('the light palette differs from the dark palette', () => {
  expect(pickPalette('light')).not.toEqual(pickPalette('dark'));
});

test('an unknown theme mode picks the dark palette', () => {
  expect(pickPalette(null)).toEqual(pickPalette('dark'));
});

test('the light palette differs from the palette for an unknown theme mode', () => {
  expect(pickPalette('light')).not.toEqual(pickPalette(null));
});

const brightnessOf = (hex: string): number => {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

  return channels.reduce((sum, channel) => sum + channel, 0);
};

test('the light palette has a lighter background than the palette for an unknown theme mode', () => {
  const lightBackground = pickPalette('light').overlayBackground;
  const unknownBackground = pickPalette(null).overlayBackground;

  expect(brightnessOf(lightBackground)).toBeGreaterThan(brightnessOf(unknownBackground));
});
