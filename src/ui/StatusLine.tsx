import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import { hasNoRows, readNoticeText } from './Notice.tsx';
import type { Palette } from './palette.ts';
import { formatAge } from './threadRow.ts';

const readError = (snapshot: Snapshot): string | null => {
  const notice = readNoticeText(snapshot);

  // With threads loaded, the list stays on screen and the notice moves to the status line.
  if (notice !== null && !hasNoRows(snapshot)) {
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
      {snapshot.savedAt === null ? null : (
        <text fg={palette.dim}>
          saved {formatAge(snapshot.savedAt.toISOString(), new Date())} ago
        </text>
      )}
      {snapshot.refreshStatus === 'running' ? <text fg={palette.dim}>refreshing...</text> : null}
      {snapshot.feedBusy ? <text fg={palette.dim}>feed busy, showing the last list</text> : null}
      {snapshot.stateWarning === null ? null : (
        <text fg={palette.error}>{snapshot.stateWarning}</text>
      )}
      {error === null ? null : <text fg={palette.error}>{error}</text>}
    </box>
  );
};
