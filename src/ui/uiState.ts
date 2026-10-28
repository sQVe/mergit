import type { RefObject } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { Intent, OverlayMove, ReaderContext } from '../commands.ts';
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
  reader: ReaderContext;
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
  previewTop: number;
  reportPreviewWindow: (window: ScrollWindow) => void;
  reader: ReaderContext;
  modal: RefObject<ModalState>;
  runUiAction: (intent: UiIntent) => void;
}

export interface ScrollWindow {
  viewportRows: number;
  maximumTop: number;
}

const topAfter = (top: number, move: OverlayMove, window: ScrollWindow): number => {
  const { viewportRows, maximumTop } = window;
  const current = Math.min(top, maximumTop);
  const halfPage = Math.max(1, Math.floor(viewportRows / 2));

  const targetOf = (): number => {
    if (move.kind === 'lines') {
      return current + move.lines;
    }

    if (move.kind === 'page') {
      const size = move.size === 'half' ? halfPage : viewportRows;

      return current + (move.direction === 'down' ? size : -size);
    }

    return move.edge === 'bottom' ? maximumTop : 0;
  };

  return Math.min(maximumTop, Math.max(0, targetOf()));
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
  helpWindow: (overlay: Overlay) => ScrollWindow,
  messageWindow: ScrollWindow,
): UiState => {
  // Callers pass fresh window objects every render. Reading them here keeps runUiAction stable,
  // because a changed runUiAction re-registers the key layers and clears a pending count.
  const windows = useRef({ helpWindow, messageWindow });

  useLayoutEffect(() => {
    windows.current = { helpWindow, messageWindow };
  });

  const previewWindow = useRef<ScrollWindow>({ viewportRows: 0, maximumTop: 0 });

  const reportPreviewWindow = useCallback((next: ScrollWindow) => {
    previewWindow.current = next;
  }, []);

  const [overlay, setOverlayState] = useState<Overlay>({ kind: 'none' });
  const [helpTop, setHelpTop] = useState(0);
  const [messagesTop, setMessagesTop] = useState(0);
  const [previewTop, setPreviewTop] = useState(0);
  const { selectedRowKey } = session.getSnapshot();

  useLayoutEffect(() => {
    setPreviewTop(0);
  }, [selectedRowKey]);

  const [reader, setReaderState] = useState<ReaderContext>({ kind: 'inbox' });

  // Keys in one burst arrive before React renders, so key handling reads this copy, which each
  // setter updates at once.
  const modal = useRef<ModalState>({
    overlay: { kind: 'none' },
    reader: { kind: 'inbox' },
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

  const setReader = useCallback((next: ReaderContext) => {
    modal.current.reader = next;
    setReaderState(next);
  }, []);

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

      const closeOverlay = () => {
        setOverlay({ kind: 'none' });
      };

      const plainActions: Partial<Record<UiIntent['action'], () => void>> = {
        confirmOpen,
        cancelOpen: closeOverlay,
        closeDetail: () => {
          setReader({ kind: 'inbox' });
        },
        openMessages,
        closeMessages: closeOverlay,
        toggleHelp: () => {
          toggleHelp(true);
        },
        closeHelp: () => {
          toggleHelp(false);
        },
      };

      const helpSearch = helpSearchAfter(modal.current.overlay, intent);

      if (helpSearch !== undefined) {
        setHelpTop(0);
        setOverlay(helpSearch);
      } else if (intent.action === 'askOpen') {
        setOverlay({ kind: 'confirm', pages: intent.pages });
      } else if (intent.action === 'openDetail') {
        setReader({ kind: 'reader', row: intent.row });
        session.send({ kind: 'selectRow', rowKey: intent.row.key });
      } else if (intent.action === 'scrollOverlay') {
        scrollOverlay(intent.move);
      } else if (intent.action === 'scrollPreview') {
        const move = { kind: 'lines', lines: intent.lines } as const;

        setPreviewTop((top) => topAfter(top, move, previewWindow.current));
      } else {
        plainActions[intent.action]?.();
      }
    },
    [session, setOverlay, setReader],
  );

  const helpInput = { watch: watchHelpSearch, current: currentHelpSearch };

  return {
    overlay,
    helpTop,
    helpInput,
    messagesTop,
    previewTop,
    reportPreviewWindow,
    reader,
    modal,
    runUiAction,
  };
};
