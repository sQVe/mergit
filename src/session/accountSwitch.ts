import type { NotificationFeed, NotificationFeedRequest, Viewer } from '../github/github.ts';
import type { ViewerId, ViewerLogin } from '../work/work.ts';
import type { SavedSnapshot } from './session.ts';

export interface AccountSwitchOwner {
  accept: (
    viewer: Viewer,
    request: NotificationFeedRequest,
    feed: NotificationFeed | null,
    clear: () => void,
  ) => NotificationFeedRequest;
  currentLogin: () => ViewerLogin | null;
  currentViewerId: () => ViewerId | null;
  lastViewer: () => Viewer | null;
  viewerKnown: () => boolean;
}

export const createAccountSwitch = (saved: SavedSnapshot | null): AccountSwitchOwner => {
  let viewerLogin: ViewerLogin | null = null;
  let login: ViewerLogin | null = saved?.viewer.login ?? null;
  let lastViewer: Viewer | null = saved?.viewer ?? null;

  const accept = (
    viewer: Viewer,
    request: NotificationFeedRequest,
    feed: NotificationFeed | null,
    clear: () => void,
  ): NotificationFeedRequest => {
    const firstRead = viewerLogin === null;

    const accountChanged = lastViewer !== null && lastViewer.id !== viewer.id;

    // Clear before the login changes, so the thread the cursor leaves is seen by its own account.
    if (accountChanged) {
      clear();
    }

    viewerLogin = viewer.login;
    login = viewer.login;
    lastViewer = viewer;

    if (accountChanged) {
      return { ...request, previous: null };
    }

    if (firstRead && saved !== null) {
      return { ...request, previous: feed };
    }

    return request;
  };

  return {
    accept,
    currentLogin: () => login,
    currentViewerId: () => lastViewer?.id ?? null,
    lastViewer: () => lastViewer,
    viewerKnown: () => viewerLogin !== null,
  };
};
