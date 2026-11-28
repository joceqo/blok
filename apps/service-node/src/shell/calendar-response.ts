import type { PoolClient } from 'pg';
import type { Notice } from './notification-mail.ts';

/** What an invitee may answer. 'needs-action' takes an answer back. */
const answers = ['needs-action', 'accepted', 'declined', 'tentative'] as const;
export type CalendarResponse = (typeof answers)[number];

/**
 * The answer a request carries, or undefined. The column has a CHECK too, but
 * refusing here answers 400 rather than letting Postgres raise a 500.
 */
export function validCalendarResponse(value: unknown): CalendarResponse | undefined {
  return typeof value === 'string' && (answers as readonly string[]).includes(value)
    ? (value as CalendarResponse)
    : undefined;
}

/**
 * Records one invitee's answer and tells the organiser. Returns the notice to
 * mail once the transaction commits, or null when there is nobody to tell:
 * an organiser answering their own event, or an event without one.
 */
export async function recordCalendarResponse(
  db: PoolClient,
  workspace: string,
  event: string,
  user: string,
  response: CalendarResponse,
): Promise<Notice | null> {
  const { rowCount } = await db.query(
    'UPDATE calendar_participants SET response=$4 WHERE workspace_id=$1 AND event_id=$2 AND user_id=$3',
    [workspace, event, user, response],
  );
  if (!rowCount) return null;
  // Taking an answer back is not news worth a mail.
  if (response === 'needs-action') return null;
  const { rows: [created] } = await db.query<Notice>(
    `INSERT INTO workspace_notifications(workspace_id,event_id,recipient_id,actor_id,type)
     SELECT $1,$2,e.organizer_id,$3,'calendar_response' FROM workspace_calendar_events e
     WHERE e.workspace_id=$1 AND e.id=$2 AND e.organizer_id IS NOT NULL AND e.organizer_id<>$3
     ON CONFLICT DO NOTHING
     RETURNING recipient_id,type`,
    [workspace, event, user],
  );
  return created ?? null;
}
