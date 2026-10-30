import type { PullRequestCheck } from '../work/work.ts';
import type { PullRequestEntry, PullRequestTab } from './detailTransitions.ts';

export const checkRecordId = (check: PullRequestCheck): string => {
  if (check.kind === 'statusContext') {
    return `status:${check.context}`;
  }

  return check.databaseId === null ? `name:${check.name}` : `run:${check.databaseId}`;
};

const mergeCachedRows = <Record>(
  incoming: Record[],
  cached: Record[],
  keyOf: (record: Record) => string,
  maximumRecords: number,
): Record[] => {
  const records = new Map(incoming.map((record) => [keyOf(record), record]));

  for (const record of cached) {
    const key = keyOf(record);

    if (!records.has(key)) {
      records.set(key, record);
    }
  }

  return [...records.values()].slice(0, maximumRecords);
};

const sameSourceRevision = (
  incoming: PullRequestEntry,
  cached: PullRequestEntry,
  source: PullRequestTab,
): boolean => {
  const next = incoming.sources[source];
  const previous = cached.sources[source];

  return (
    incoming.subjectId === cached.subjectId &&
    next.headOid === previous.headOid &&
    next.baseOid === previous.baseOid
  );
};

export const preservePullRequestRows = (
  incoming: PullRequestEntry,
  cached: PullRequestEntry,
  source: PullRequestTab,
  maximumRecords: number,
): PullRequestEntry => {
  if (!sameSourceRevision(incoming, cached, source)) {
    return incoming;
  }

  const sources = { ...incoming.sources };

  if (source === 'files') {
    sources.files = {
      ...sources.files,
      records: mergeCachedRows(
        sources.files.records,
        cached.sources.files.records,
        (record) => record.path,
        maximumRecords,
      ),
    };
  } else if (source === 'commits') {
    sources.commits = {
      ...sources.commits,
      records: mergeCachedRows(
        sources.commits.records,
        cached.sources.commits.records,
        (record) => record.oid,
        maximumRecords,
      ),
    };
  } else if (source === 'checks') {
    sources.checks = {
      ...sources.checks,
      records: mergeCachedRows(
        sources.checks.records,
        cached.sources.checks.records,
        checkRecordId,
        maximumRecords,
      ),
    };
  }

  return { ...incoming, sources };
};
