import type { ReactNode } from 'react';

import type { Command, ReaderContext } from '../commands.ts';
import { isReaderDetached, keyHintOf } from '../commands.ts';
import type {
  DetailAnchor,
  DetailEntry,
  DetailTab,
  IssueEntry,
  Snapshot,
} from '../session/session.ts';
import type { NotificationThread } from '../work/work.ts';
import type { DetailLine, DetailRecord } from './detailLayout.ts';
import { anchorOfLine, layoutRecords, topOfAnchor } from './detailLayout.ts';
import type { Palette } from './palette.ts';
import { fitText } from './textLayout.ts';
import { formatAge, numberLabelFor } from './threadRow.ts';

export interface ReaderLayout {
  header: string[];
  lines: DetailLine[];
  top: number;
  rows: number;
}

export interface DetailScroll {
  window: { viewportRows: number; maximumTop: number };
  top: number;
  anchorAt: (top: number) => { tab: DetailTab; anchor: DetailAnchor } | null;
}

interface ReaderInput {
  snapshot: Snapshot;
  thread: NotificationThread;
  columns: number;
  rows: number;
  openKey: string | undefined;
}

interface ReaderBody {
  header: string[];
  lines: DetailLine[];
  tab: DetailTab | null;
  anchor: DetailAnchor | undefined;
  order: string[];
}

type NoticeKind = 'mismatch' | 'unsupported' | 'loading' | 'empty';

const borderAndPadding = 2;
const hintRows = 1;
const unsupportedNote = 'Mergit cannot show this content yet.';
const noDescription = 'No description provided.';
const noComments = 'No comments.';

const tabLabels: Record<DetailTab, string> = { overview: 'Overview', discussion: 'Discussion' };

// A digest fixed per kind keeps the position when notice text changes, such as its age, and a kind
// never restores another kind's position.
const noticeLines = (kind: NoticeKind, texts: readonly string[], columns: number): DetailLine[] => {
  if (texts.length === 0) {
    return [];
  }

  const id = `notice:${kind}`;

  return layoutRecords([{ id, digest: id, heading: null, text: texts.join('\n') }], columns);
};

const noticeBodyOf = (
  entry: DetailEntry | undefined,
  header: string[],
  notice: { kind: NoticeKind; texts: string[] },
  columns: number,
): ReaderBody => ({
  header,
  lines: noticeLines(notice.kind, notice.texts, columns),
  tab: entry?.tab ?? null,
  anchor: entry?.anchors[entry.tab],
  order: [],
});

const nowOf = (snapshot: Snapshot): Date => snapshot.savedAt ?? snapshot.refreshedAt ?? new Date(0);

const activeEntryOf = (snapshot: Snapshot, thread: NotificationThread): DetailEntry | undefined => {
  const { activeKey, entries } = snapshot.detail;
  const entry = activeKey === null ? undefined : entries.get(activeKey);

  return entry?.threadId === thread.id ? entry : undefined;
};

const identityOf = (thread: NotificationThread, entry: DetailEntry | undefined): string => {
  const record = entry?.kind === 'issue' ? entry.sources.overview.record : null;
  const kind = thread.subjectType === 'PullRequest' ? 'Pull request' : thread.subjectType;
  const parts = [thread.repository, `${kind} ${numberLabelFor(thread)}`.trim()];

  if (record !== null) {
    parts.push(record.state, `@${record.author ?? 'ghost'}`);
  }

  return parts.join(' / ');
};

const reasonLineOf = (thread: NotificationThread, entry: DetailEntry | undefined, now: Date) => {
  const fetchedAt = entry?.fetchedAt ?? null;

  return fetchedAt === null
    ? thread.reason
    : `${thread.reason}; fetched ${formatAge(fetchedAt.toISOString(), now)} ago`;
};

const tabRowOf = (entry: IssueEntry): string =>
  entry.tabs
    .map((tab) => {
      const count =
        tab === 'discussion'
          ? ` ${entry.sources.discussion.totalCount ?? entry.sources.discussion.records.length}`
          : '';

      const label = `${tabLabels[tab]}${count}`;

      return tab === entry.tab ? `[${tabLabels[tab]}*]${count}` : label;
    })
    .join(' ');

const loadedCountOf = (entry: IssueEntry, tab: DetailTab): number =>
  tab === 'discussion'
    ? entry.sources.discussion.records.length
    : Number(entry.sources.overview.record !== null);

const coverageLineOf = (entry: IssueEntry, tab: DetailTab): string | null => {
  const { coverage, message } = entry.sources[tab];
  const loaded = loadedCountOf(entry, tab);
  const reason = message === null ? '' : `. ${message}`;

  if (coverage === 'loaded') {
    return null;
  }

  if (coverage === 'partial') {
    return `Partial: ${loaded} loaded, more may exist${reason}`;
  }

  if (coverage === 'failed') {
    const shown = loaded > 0 ? '. Showing loaded content' : '';

    return `Failed: ${message ?? 'the read did not finish'}${shown}`;
  }

  return coverage === 'unavailable' ? 'Unavailable' : 'Loading';
};

const recordsOf = (entry: IssueEntry, tab: DetailTab, now: Date): DetailRecord[] => {
  if (tab === 'overview') {
    const { record } = entry.sources.overview;
    const text = record?.body.trim() === '' ? noDescription : (record?.body ?? '');

    return record === null ? [] : [{ id: record.id, digest: record.digest, heading: null, text }];
  }

  return entry.sources.discussion.records.map((comment) => ({
    id: comment.id,
    digest: comment.digest,
    heading: `@${comment.author ?? 'ghost'} / ${formatAge(comment.createdAt, now)} ago`,
    text: comment.body,
  }));
};

const emptyTextOf = (entry: IssueEntry, tab: DetailTab): string[] => {
  const settled = entry.sources[tab].coverage === 'loaded';

  return tab === 'discussion' && settled ? [noComments] : [];
};

const issueBody = (entry: IssueEntry, input: ReaderInput, header: string[]): ReaderBody => {
  const { columns } = input;
  const now = nowOf(input.snapshot);
  const records = recordsOf(entry, entry.tab, now);
  const coverage = coverageLineOf(entry, entry.tab);
  const tabHeader = [...header, tabRowOf(entry)];

  if (coverage !== null) {
    tabHeader.push(coverage);
  }

  const lines =
    records.length === 0
      ? noticeLines('empty', emptyTextOf(entry, entry.tab), columns)
      : layoutRecords(records, columns);

  return {
    header: tabHeader,
    lines,
    tab: entry.tab,
    anchor: entry.anchors[entry.tab],
    order: records.map((record) => record.id),
  };
};

const unsupportedTexts = (input: ReaderInput): string[] => {
  const { thread } = input;
  const now = nowOf(input.snapshot);

  const open =
    input.openKey === undefined ? [] : [`Press ${input.openKey} to open it in the browser.`];

  return [
    `Updated ${formatAge(thread.updatedAt, now)} ago`,
    `Unread ${thread.unread ? 'yes' : 'no'}`,
    '',
    unsupportedNote,
    ...open,
  ];
};

const bodyOf = (input: ReaderInput): ReaderBody => {
  const { snapshot, thread, columns } = input;
  const entry = activeEntryOf(snapshot, thread);
  const now = nowOf(snapshot);

  const title =
    entry?.kind === 'issue' ? (entry.sources.overview.record?.title ?? thread.title) : thread.title;

  const header = [identityOf(thread, entry), title, reasonLineOf(thread, entry, now)];
  const { mismatch } = snapshot.detail;

  if (mismatch !== null) {
    const notice = `This content was read as @${mismatch.login}, not the account that loaded the inbox. Mergit shows nothing from it.`;

    return noticeBodyOf(entry, header, { kind: 'mismatch', texts: [notice] }, columns);
  }

  if (entry?.kind === 'issue') {
    return issueBody(entry, input, header);
  }

  const notice: { kind: NoticeKind; texts: string[] } =
    entry?.kind === 'unsupported'
      ? { kind: 'unsupported', texts: unsupportedTexts(input) }
      : { kind: 'loading', texts: ['Loading'] };

  return noticeBodyOf(entry, header, notice, columns);
};

export const readerInputOf = (
  snapshot: Snapshot,
  reader: ReaderContext,
  pane: { width: number; height: number },
  catalog: readonly Command[],
): ReaderInput | null => {
  if (reader.kind !== 'reader') {
    return null;
  }

  const detached = isReaderDetached(snapshot, reader);

  return {
    snapshot,
    thread: reader.row.thread,
    columns: Math.max(1, pane.width - borderAndPadding),
    rows: Math.max(1, pane.height - hintRows - Number(detached)),
    openKey: keyHintOf(catalog, 'readerOpenInBrowser'),
  };
};

const viewOf = (input: ReaderInput) => {
  const body = bodyOf(input);
  const header = body.header.map((line) => fitText(line, input.columns));
  const viewportRows = Math.max(1, input.rows - header.length);
  const top = topOfAnchor(body.lines, body.anchor);
  const maximumTop = Math.max(0, body.lines.length - viewportRows, top);

  return { body, header, viewportRows, maximumTop, top };
};

export const readerLayoutOf = (input: ReaderInput): ReaderLayout => {
  const { body, header, viewportRows, top } = viewOf(input);

  return { header, lines: body.lines, top, rows: viewportRows };
};

export const detailScrollOf = (input: ReaderInput): DetailScroll => {
  const { body, viewportRows, maximumTop, top } = viewOf(input);

  const anchorAt = (nextTop: number) => {
    const { tab, lines, order } = body;
    const line = lines[nextTop];

    if (tab === null || line === undefined) {
      return null;
    }

    return { tab, anchor: anchorOfLine(line, order) };
  };

  return { window: { viewportRows, maximumTop }, top, anchorAt };
};

export const DetailReader = (props: { layout: ReaderLayout; palette: Palette }): ReactNode => {
  const { layout, palette } = props;
  const [identity, ...rest] = layout.header;
  const visible = layout.lines.slice(layout.top, layout.top + layout.rows);

  return (
    <>
      <text fg={palette.text}>{identity}</text>
      {rest.map((line, index) => (
        <text key={index} fg={index === 0 ? palette.text : palette.dim}>
          {line}
        </text>
      ))}
      {visible.map((line, index) => (
        <text key={index} fg={palette.text}>
          {line.text === '' ? ' ' : line.text}
        </text>
      ))}
    </>
  );
};
