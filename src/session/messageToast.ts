import type { Snapshot, Toast } from './sessionState.ts';

export interface MessageToastInputs {
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
  now: () => Date;
  getSnapshot: () => Snapshot;
  update: (candidate: Snapshot) => void;
}

export interface MessageToastOwner {
  show: (content: Omit<Toast, 'durationMilliseconds'>, durationMilliseconds?: number) => void;
  cancel: () => void;
}

const toastMilliseconds = 4000;
const messageLimit = 100;

export const createMessageToast = (inputs: MessageToastInputs): MessageToastOwner => {
  let cancelTimer: (() => void) | null = null;
  let nextMessageId = 0;

  const show = (
    content: Omit<Toast, 'durationMilliseconds'>,
    durationMilliseconds = toastMilliseconds,
  ) => {
    const toast = { ...content, durationMilliseconds };

    cancelTimer?.();
    const snapshot = inputs.getSnapshot();

    nextMessageId += 1;

    const message = {
      id: nextMessageId,
      title: content.title,
      lines: content.lines,
      tone: content.tone,
      shownAt: inputs.now(),
    };

    const messages = [message, ...snapshot.messages].slice(0, messageLimit);

    // Installed before publishing, so a toast shown by a subscriber replaces this timer.
    cancelTimer = inputs.setTimer(toast.durationMilliseconds, () => {
      cancelTimer = null;
      inputs.update({ ...inputs.getSnapshot(), toast: null });
    });

    inputs.update({ ...snapshot, toast, messages });
  };

  const cancel = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  return { show, cancel };
};
