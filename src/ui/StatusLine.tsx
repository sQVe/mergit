import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import { readNoticeText } from './Notice.tsx';
import type { Palette } from './palette.ts';

const readError = (snapshot: Snapshot): string | null => {
  const notice = readNoticeText(snapshot);

  // With threads loaded, the list stays on screen and the notice moves to the status line.
  if (notice !== null && snapshot.threads.length > 0) {
    return notice;
  }

  return snapshot.errorMessage;
};

export const StatusLine = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const { snapshot, palette } = props;
  const error = readError(snapshot);

  return (
    <box height={1} flexShrink={0} flexDirection="row" gap={2}>
      <text fg={palette.dim}>? help</text>
      {snapshot.refreshStatus === 'running' ? <text fg={palette.dim}>refreshing...</text> : null}
      {snapshot.feedBusy ? <text fg={palette.dim}>feed busy, showing the last list</text> : null}
      {error === null ? null : <text fg={palette.error}>{error}</text>}
    </box>
  );
};
