import type { ReactNode } from 'react';

import type { Command } from '../commands.ts';
import { keyHintOf } from '../commands.ts';
import type { Snapshot } from '../session/session.ts';
import { hasNoRows } from './Notice.tsx';
import type { Palette } from './palette.ts';
import { formatAge } from './threadRow.ts';

const noticeMarkers = {
  ghMissing: 'gh missing',
  notSignedIn: 'not signed in',
};

const readMarker = (snapshot: Snapshot, refreshKey: string | undefined): string | null => {
  // With threads loaded, the list stays on screen and the full notice shows as a toast.
  if (snapshot.notice !== null && !hasNoRows(snapshot)) {
    const fix = refreshKey === undefined ? 'refresh' : `press ${refreshKey}`;

    return `${noticeMarkers[snapshot.notice]}, ${fix}`;
  }

  return null;
};

export const StatusLine = (props: {
  snapshot: Snapshot;
  palette: Palette;
  catalog: readonly Command[];
  pending: string;
}): ReactNode => {
  const { snapshot, palette, catalog, pending } = props;
  const marker = readMarker(snapshot, keyHintOf(catalog, 'refresh'));
  const helpKeys = keyHintOf(catalog, 'help');

  return (
    <box height={1} flexShrink={0} flexDirection="row" gap={2}>
      <text fg={palette.dim} flexShrink={0}>
        {helpKeys === undefined ? 'help' : `${helpKeys} help`}
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
      {snapshot.stateWarning === null ? null : (
        <text fg={palette.error} flexShrink={0}>
          {snapshot.stateWarning}
        </text>
      )}
      {marker === null ? null : (
        <text fg={palette.error} flexShrink={0}>
          {marker}
        </text>
      )}
      {snapshot.feedBusy ? <text fg={palette.dim}>feed busy, showing the last list</text> : null}
      {snapshot.errorMessage === null ? null : (
        <text fg={palette.error}>{snapshot.errorMessage}</text>
      )}
      {pending === '' ? null : (
        <>
          <box flexGrow={1} />
          <text fg={palette.dim} flexShrink={0}>
            {pending}
          </text>
        </>
      )}
    </box>
  );
};
