import { failureMessage, laterPauseOf } from './feedTransitions.ts';
import type { Snapshot } from './sessionState.ts';

export interface Admission {
  pauseRemaining: () => number;
  isPaused: () => boolean;
  pause: (resetAt: Date) => void;
}

export interface AdmissionHost {
  now: () => Date;
  getSnapshot: () => Snapshot;
  update: (next: Snapshot) => void;
}

export const createAdmission = (host: AdmissionHost): Admission => {
  const pauseRemaining = () => {
    const { pausedUntil } = host.getSnapshot();

    if (pausedUntil === null) {
      return 0;
    }

    return Math.max(pausedUntil.getTime() - host.now().getTime(), 0);
  };

  const pause = (resetAt: Date) => {
    const snapshot = host.getSnapshot();
    const pausedUntil = laterPauseOf(snapshot.pausedUntil, resetAt);

    host.update({
      ...snapshot,
      errorMessage: failureMessage({ kind: 'rateLimited', resetAt: pausedUntil }),
      notice: null,
      pausedUntil,
    });
  };

  return { pauseRemaining, isPaused: () => pauseRemaining() > 0, pause };
};
