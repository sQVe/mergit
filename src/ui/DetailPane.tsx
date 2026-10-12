import type { ReactNode } from 'react';

import type {
  NodeRow,
  NotificationThread,
  SubjectFacts,
  ThreadRow,
  TreeRow,
} from '../work/work.ts';
import type { Palette } from './palette.ts';
import { formatAge, numberLabelFor, typeLabelFor, typeSummaryLabelFor } from './threadRow.ts';

interface PaneProps {
  palette: Palette;
}

const labelWidth = 8;

const countBy = (
  threads: NotificationThread[],
  keyFor: (thread: NotificationThread) => string,
): [string, number][] => {
  const counts = new Map<string, number>();

  for (const thread of threads) {
    const key = keyFor(thread);

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()];
};

const Fact = (props: PaneProps & { label: string; value: string }): ReactNode => (
  <box flexDirection="row">
    <text fg={props.palette.dim} width={labelWidth}>
      {props.label}
    </text>
    <text fg={props.palette.text} flexShrink={1}>
      {props.value}
    </text>
  </box>
);

const SecondaryFact = (props: PaneProps & { label: string; value: string }): ReactNode => (
  <box flexDirection="row">
    <text fg={props.palette.dim} width={labelWidth}>
      {props.label}
    </text>
    <text fg={props.palette.dim} flexShrink={1}>
      {props.value}
    </text>
  </box>
);

const SubjectFactLines = (props: PaneProps & { facts: SubjectFacts | undefined }): ReactNode => {
  const { facts, palette } = props;

  if (facts === undefined) {
    return null;
  }

  return (
    <>
      <SecondaryFact palette={palette} label="State" value={facts.state} />
      {facts.author === null ? null : (
        <SecondaryFact palette={palette} label="Author" value={facts.author} />
      )}
    </>
  );
};

const ThreadDetail = (
  props: PaneProps & { row: ThreadRow; now: Date; facts: SubjectFacts | undefined },
): ReactNode => {
  const { thread } = props.row;
  const { palette } = props;

  return (
    <>
      <text fg={palette.text}>{thread.title}</text>
      <text> </text>
      <Fact palette={palette} label="Repo" value={thread.repository} />
      <Fact palette={palette} label="Type" value={typeLabelFor(thread)} />
      <Fact palette={palette} label="Number" value={numberLabelFor(thread)} />
      <Fact palette={palette} label="Reason" value={thread.reason} />
      <Fact
        palette={palette}
        label="Updated"
        value={`${formatAge(thread.updatedAt, props.now)} ago`}
      />
      <Fact palette={palette} label="Unread" value={thread.unread ? 'yes' : 'no'} />
      <SubjectFactLines palette={palette} facts={props.facts} />
    </>
  );
};

const NodeDetail = (props: PaneProps & { row: NodeRow }): ReactNode => {
  const { row, palette } = props;
  const byType = countBy(row.threads, (thread) => thread.subjectType);
  const byReason = countBy(row.threads, (thread) => thread.reason);

  return (
    <>
      <text fg={palette.text}>{row.title}</text>
      <Fact palette={palette} label="Threads" value={String(row.threads.length)} />
      <text> </text>
      <text fg={palette.dim}>By type</text>
      {byType.map(([subjectType, count]) => (
        <Fact
          key={subjectType}
          palette={palette}
          label={String(count)}
          value={typeSummaryLabelFor(subjectType)}
        />
      ))}
      <text> </text>
      <text fg={palette.dim}>By reason</text>
      {byReason.map(([label, count]) => (
        <Fact key={label} palette={palette} label={String(count)} value={label} />
      ))}
    </>
  );
};

const RowDetail = (
  props: PaneProps & { row: TreeRow; now: Date; facts: SubjectFacts | undefined },
): ReactNode => {
  if (props.row.kind === 'node') {
    return <NodeDetail palette={props.palette} row={props.row} />;
  }

  return (
    <ThreadDetail palette={props.palette} row={props.row} now={props.now} facts={props.facts} />
  );
};

export const DetailPane = (
  props: PaneProps & {
    row: TreeRow | undefined;
    facts: SubjectFacts | undefined;
    now: Date;
    width: number;
  },
): ReactNode => {
  const { row } = props;

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      paddingLeft={1}
      border={['left']}
      borderColor={props.palette.dim}
    >
      {row === undefined ? null : (
        <RowDetail palette={props.palette} row={row} now={props.now} facts={props.facts} />
      )}
    </box>
  );
};
