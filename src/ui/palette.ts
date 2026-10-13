export interface Palette {
  text: string;
  dim: string;
  key: string;
  overlayBackground: string;
  selectedBackground: string;
  typeLabel: string;
  newMarker: string;
  error: string;
  errorBackground: string;
  infoBackground: string;
}

const darkPalette: Palette = {
  text: '#d7dae0',
  dim: '#4f5866',
  key: '#e5c07b',
  overlayBackground: '#1c2029',
  selectedBackground: '#2c313c',
  typeLabel: '#61afef',
  newMarker: '#98c379',
  error: '#e06c75',
  errorBackground: '#2e2226',
  infoBackground: '#1f2a36',
};

const lightPalette: Palette = {
  text: '#383a42',
  dim: '#a0a1a7',
  key: '#946200',
  overlayBackground: '#f3f4f6',
  selectedBackground: '#dfe3ea',
  typeLabel: '#2f6fb3',
  newMarker: '#3f7f2f',
  error: '#ca1243',
  errorBackground: '#fdf0f2',
  infoBackground: '#eef4fb',
};

export const pickPalette = (mode: 'light' | 'dark' | null): Palette => {
  return mode === 'light' ? lightPalette : darkPalette;
};
