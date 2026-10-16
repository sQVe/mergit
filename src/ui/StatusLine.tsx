import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import { hasNoRows } from './Notice.tsx';
import type { Palette } from './palette.ts';
import { formatAge } from './threadRow.ts';

const noticeMarkers = {
  ghMissing: 'gh missing, press r',
  notSignedIn: 'not signed in, press r',
};

const readError = (snapshot: Snapshot): string | null => {
  // With threads loaded, the list stays on screen and the full notice shows as a toast.
  if (snapshot.notice !== null && !hasNoRows(snapshot)) {
    return noticeMarkers[snapshot.notice];
  }

  return snapshot.errorMessage;
};

export const StatusLine = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const { snapshot, palette } = props;
  const error = readError(snapshot);

  return (
    <box height={1} flexShrink={0} flexDirection="row" gap={2}>
      <text fg={palette.dim} flexShrink={0}>
        ? help
      </text>
      {snapshot.savedAt === null ? null : (
        <text fg={palette.dim} flexShrink={0}>
          saved {formatAge(snapshot.savedAt.toISOString(), new Date())} ago
        </text>
      )}
      {snapshot.refreshStatus === 'running' ? (
        <text fg={palette.dim} flexShrink={0}>
          refreshing...
        </text>
      ) : null}
      {snapshot.feedBusy ? (
        <text fg={palette.dim} flexShrink={0}>
          feed busy, showing the last list
        </text>
      ) : null}
      {snapshot.stateWarning === null ? null : (
        <text fg={palette.error} flexShrink={0}>
          {snapshot.stateWarning}
        </text>
      )}
      {error === null ? null : <text fg={palette.error}>{error}</text>}
    </box>
  );
};
