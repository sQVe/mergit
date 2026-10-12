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

export const truncate = (text: string, width: number): string => {
  if (text.length <= width) {
    return text;
  }

  return `${text.slice(0, Math.max(0, width - 1))}…`;
};

export const scrollTop = (
  currentTop: number,
  selectedIndex: number,
  height: number,
  count: number,
): number => {
  const maximumTop = Math.max(0, count - height);
  const clamped = Math.min(currentTop, maximumTop);

  if (selectedIndex < clamped) {
    return Math.max(0, selectedIndex);
  }

  if (selectedIndex >= clamped + height) {
    return Math.min(maximumTop, selectedIndex - height + 1);
  }

  return clamped;
};

export const guideWidth = 2;

export const guideFor = (depth: number): string => '│ '.repeat(depth);

export const branchFor = (last: boolean): string => (last ? '└─' : '├─');
