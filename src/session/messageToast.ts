import type { Snapshot, Toast } from './sessionState.ts';

export interface MessageToastInputs {
  setTimer: (delayMilliseconds: number, callback: () => void) => () => void;
  getSnapshot: () => Snapshot;
  update: (candidate: Snapshot) => void;
}

export interface MessageToastOwner {
  show: (content: Omit<Toast, 'durationMilliseconds'>, durationMilliseconds?: number) => void;
  cancel: () => void;
}

const toastMilliseconds = 4000;

export const createMessageToast = (inputs: MessageToastInputs): MessageToastOwner => {
  let cancelTimer: (() => void) | null = null;

  const show = (
    content: Omit<Toast, 'durationMilliseconds'>,
    durationMilliseconds = toastMilliseconds,
  ) => {
    const toast = { ...content, durationMilliseconds };

    cancelTimer?.();
    inputs.update({ ...inputs.getSnapshot(), toast });

    cancelTimer = inputs.setTimer(toast.durationMilliseconds, () => {
      cancelTimer = null;
      inputs.update({ ...inputs.getSnapshot(), toast: null });
    });
  };

  const cancel = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  return { show, cancel };
};
