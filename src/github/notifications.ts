import { z } from 'zod';

import type { NotificationThread } from '../work/work.ts';
import { toThreadId } from '../work/work.ts';

export interface NotificationPage {
  endpoint: string;
  etag: string | null;
  threads: NotificationThread[];
  next: string | null;
  body: string;
}

export interface NotificationFeed {
  pages: NotificationPage[];
}

const notificationThreadSchema = z
  .object({
    id: z.string().min(1),
    unread: z.boolean(),
    reason: z.string(),
    updated_at: z.string(),
    last_read_at: z.string().nullable(),
    subject: z.object({
      title: z.string(),
      type: z.string(),
      url: z.string().nullable(),
    }),
    repository: z.object({ full_name: z.string() }),
  })
  .transform((thread): NotificationThread => ({
    id: toThreadId(thread.id),
    reason: thread.reason,
    unread: thread.unread,
    updatedAt: thread.updated_at,
    lastReadAt: thread.last_read_at,
    title: thread.subject.title,
    subjectType: thread.subject.type,
    subjectUrl: thread.subject.url,
    repository: thread.repository.full_name,
  }));

export const findNextPage = (linkHeader: string | undefined): string | null => {
  if (linkHeader === undefined) {
    return null;
  }

  for (const part of linkHeader.split(',')) {
    const match = /<([^>]*)>\s*;\s*rel="next"/.exec(part);

    if (match?.[1] !== undefined) {
      return match[1];
    }
  }

  return null;
};

export const notificationPageSchema = z.array(notificationThreadSchema);

const maximumPollIntervalSeconds = 86_400;

const pollIntervalSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(maximumPollIntervalSeconds));

export const readPollInterval = (headers: ReadonlyMap<string, string>): number | null => {
  const parsed = pollIntervalSchema.safeParse(headers.get('x-poll-interval'));

  return parsed.success ? parsed.data : null;
};
