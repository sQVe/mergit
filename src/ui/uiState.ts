import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Intent, OverlayMove } from '../commands.ts';
import type { Session } from '../session/session.ts';
import type { BrowserPage } from '../work/work.ts';

export type UiIntent = Extract<Intent, { kind: 'ui' }>;

export type Overlay =
  | { kind: 'none' }
  | { kind: 'help'; text: string; editing: boolean }
  | { kind: 'messages' }
  | { kind: 'confirm'; pages: readonly BrowserPage[] };

export interface ModalState {
  overlay: Overlay;
  detailOpen: boolean;
}

export interface HelpSearchInput {
  watch: (listener: () => void) => () => void;
  current: () => string;
}

export interface UiState {
  overlay: Overlay;
  helpTop: number;
  helpInput: HelpSearchInput;
  messagesTop: number;
  detailOpen: boolean;
  modal: RefObject<ModalState>;
  runUiAction: (intent: UiIntent) => void;
}

interface ScrollWindow {
  viewportRows: number;
  maximumTop: number;
}

const topAfter = (top: number, move: OverlayMove, window: ScrollWindow): number => {
  const { viewportRows, maximumTop } = window;
  const current = Math.min(top, maximumTop);
  const halfPage = Math.max(1, Math.floor(viewportRows / 2));

  const target = {
    lines: () => (move.kind === 'lines' ? current + move.lines : current),
    page: () => {
      if (move.kind !== 'page') {
        return current;
      }

      const size = move.size === 'half' ? halfPage : viewportRows;

      return current + (move.direction === 'down' ? size : -size);
    },
    edge: () => (move.kind === 'edge' && move.edge === 'bottom' ? maximumTop : 0),
  }[move.kind]();

  return Math.min(maximumTop, Math.max(0, target));
};

const helpSearchAfter = (overlay: Overlay, intent: UiIntent): Overlay | undefined => {
  if (overlay.kind !== 'help') {
    return undefined;
  }

  if (intent.action === 'openHelpSearch') {
    return { ...overlay, editing: true };
  }

  if (intent.action === 'keepHelpSearch') {
    return { ...overlay, editing: false };
  }

  if (intent.action === 'closeEmptyHelpSearch') {
    return overlay.text === '' ? { ...overlay, editing: false } : overlay;
  }

  if (intent.action === 'cancelHelpSearch') {
    return { ...overlay, text: '', editing: false };
  }

  if (intent.action === 'clearHelpSearch') {
    return { ...overlay, text: '' };
  }

  if (intent.action === 'editHelpSearch') {
    return overlay.editing ? { ...overlay, text: intent.text } : overlay;
  }

  return undefined;
};

export const useUiState = (
  session: Session,
  sideLayout: boolean,
  helpWindow: (overlay: Overlay) => ScrollWindow,
  messageWindow: ScrollWindow,
): UiState => {
  // Callers pass fresh window objects every render. Reading them here keeps runUiAction stable,
  // because a changed runUiAction re-registers the key layers and clears a pending count.
  const windows = useRef({ helpWindow, messageWindow });

  useLayoutEffect(() => {
    windows.current = { helpWindow, messageWindow };
  });

  const [overlay, setOverlayState] = useState<Overlay>({ kind: 'none' });
  const [helpTop, setHelpTop] = useState(0);
  const [messagesTop, setMessagesTop] = useState(0);
  const [detailOpen, setDetailOpenState] = useState(false);

  // Keys in one burst arrive before React renders, so key handling reads this copy, which each
  // setter updates at once.
  const modal = useRef<ModalState>({
    overlay: { kind: 'none' },
    detailOpen: false,
  });

  const helpListeners = useRef(new Set<() => void>());

  const watchHelpSearch = useCallback((listener: () => void) => {
    helpListeners.current.add(listener);

    return () => {
      helpListeners.current.delete(listener);
    };
  }, []);

  const currentHelpSearch = useCallback(() => {
    const current = modal.current.overlay;

    return current.kind === 'help' ? current.text : '';
  }, []);

  const setOverlay = useCallback((next: Overlay) => {
    modal.current.overlay = next;
    setOverlayState(next);

    for (const listener of helpListeners.current) {
      listener();
    }
  }, []);

  const setDetailOpen = useCallback((open: boolean) => {
    modal.current.detailOpen = open;
    setDetailOpenState(open);
  }, []);

  useEffect(() => {
    if (sideLayout) {
      setDetailOpen(false);
    }
  }, [sideLayout, setDetailOpen]);

  const runUiAction = useCallback(
    (intent: UiIntent) => {
      const confirmOpen = () => {
        const { overlay: current } = modal.current;

        setOverlay({ kind: 'none' });

        if (current.kind === 'confirm') {
          session.send({ kind: 'openInBrowser', pages: current.pages });
        }
      };

      const openMessages = () => {
        if (modal.current.overlay.kind === 'confirm') {
          return;
        }

        setMessagesTop(0);
        setOverlay({ kind: 'messages' });
      };

      const toggleHelp = (toggling: boolean) => {
        const { kind } = modal.current.overlay;

        if (kind === 'confirm') {
          return;
        }

        setHelpTop(0);

        setOverlay(
          toggling && kind !== 'help'
            ? { kind: 'help', text: '', editing: false }
            : { kind: 'none' },
        );
      };

      const scrollOverlay = (move: OverlayMove) => {
        const { kind } = modal.current.overlay;

        if (kind === 'help') {
          setHelpTop((top) =>
            topAfter(top, move, windows.current.helpWindow(modal.current.overlay)),
          );
        } else if (kind === 'messages') {
          setMessagesTop((top) => topAfter(top, move, windows.current.messageWindow));
        }
      };

      const { action } = intent;

      const helpSearch = helpSearchAfter(modal.current.overlay, intent);

      if (helpSearch !== undefined) {
        setHelpTop(0);
        setOverlay(helpSearch);
      } else if (intent.action === 'askOpen') {
        setOverlay({ kind: 'confirm', pages: intent.pages });
      } else if (action === 'confirmOpen') {
        confirmOpen();
      } else if (action === 'cancelOpen') {
        setOverlay({ kind: 'none' });
      } else if (action === 'openDetail') {
        setDetailOpen(!sideLayout);
      } else if (action === 'closeDetail') {
        setDetailOpen(false);
      } else if (action === 'openMessages') {
        openMessages();
      } else if (action === 'closeMessages') {
        setOverlay({ kind: 'none' });
      } else if (intent.action === 'scrollOverlay') {
        scrollOverlay(intent.move);
      } else {
        toggleHelp(action === 'toggleHelp');
      }
    },
    [session, sideLayout, setOverlay, setDetailOpen],
  );

  const helpInput = { watch: watchHelpSearch, current: currentHelpSearch };

  return { overlay, helpTop, helpInput, messagesTop, detailOpen, modal, runUiAction };
};
