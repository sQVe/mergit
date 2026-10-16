import type { ReactNode } from 'react';

import type { Snapshot } from '../session/session.ts';
import { noticeMessages, openThreads, visibleRows } from '../session/session.ts';
import type { Palette } from './palette.ts';

export const hasNoRows = (snapshot: Snapshot): boolean => visibleRows(snapshot).length === 0;

const readNoticeText = (snapshot: Snapshot): string | null =>
  snapshot.notice === null ? null : noticeMessages[snapshot.notice].text;

const readMessage = (snapshot: Snapshot): { text: string; dim: boolean } | null => {
  const notice = readNoticeText(snapshot);

  if (notice !== null && hasNoRows(snapshot)) {
    return { text: notice, dim: false };
  }

  if (!snapshot.hasLoaded) {
    return { text: 'Loading notifications...', dim: true };
  }

  if (hasNoRows(snapshot) && snapshot.errorMessage === null) {
    if (openThreads(snapshot).length > 0) {
      return { text: 'No notifications match the search or filters', dim: false };
    }

    return { text: 'No open notifications', dim: false };
  }

  return null;
};

export const hasNotice = (snapshot: Snapshot): boolean => readMessage(snapshot) !== null;

export const Notice = (props: { snapshot: Snapshot; palette: Palette }): ReactNode => {
  const message = readMessage(props.snapshot);

  if (message === null) {
    return null;
  }

  const color = message.dim ? props.palette.dim : props.palette.text;

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center">
      <text fg={color}>{message.text}</text>
    </box>
  );
};
