import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import type { Palette } from './palette.ts';

export const Toast = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const { snapshot, palette } = props;
  const { toast } = snapshot;

  if (toast === null) {
    return null;
  }

  return (
    <box height={1} flexShrink={0}>
      <text fg={toast.tone === 'error' ? palette.error : palette.text}>{toast.text}</text>
    </box>
  );
};
