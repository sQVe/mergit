import type { NotificationThread } from '../work/work.ts';
import { readSubjectNumber } from '../work/work.ts';

const typeLabels: Record<string, string> = {
  PullRequest: 'PR',
  Issue: 'ISS',
  Release: 'REL',
  Discussion: 'DISC',
  Commit: 'CMT',
  CheckSuite: 'CI',
};

const fallbackLabelLength = 3;
const secondsPerMinute = 60;
const minutesPerHour = 60;
const hoursPerDay = 24;
const millisecondsPerSecond = 1000;

export const typeLabelFor = (thread: NotificationThread): string =>
  typeLabels[thread.subjectType] ?? thread.subjectType.slice(0, fallbackLabelLength).toUpperCase();

export const typeSummaryLabelFor = (subjectType: string): string =>
  typeLabels[subjectType] ?? subjectType;

export const numberLabelFor = (thread: NotificationThread): string => {
  const number = readSubjectNumber(thread.subjectUrl);

  return number === null ? '' : `#${number}`;
};

export const formatAge = (updatedAt: string, now: Date): string => {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - new Date(updatedAt).getTime()) / millisecondsPerSecond),
  );

  const minutes = Math.floor(elapsedSeconds / secondsPerMinute);
  const hours = Math.floor(minutes / minutesPerHour);
  const days = Math.floor(hours / hoursPerDay);

  if (days > 0) {
    return `${days}d`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  return `${minutes}m`;
};

export const guideWidth = 2;

export const guideFor = (depth: number): string => '│ '.repeat(depth);

export const branchFor = (last: boolean): string => (last ? '└─' : '├─');
