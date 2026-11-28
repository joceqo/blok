import type {PoolClient} from 'pg';

interface Comment {
  id: string;
  parentId?: string;
  parent?: string;
  data: {authorId?: string; text?: string; mentions?: {type?: string; id?: string; label?: string; start?: number}[]};
}
function comments(document: unknown) {
  const result = new Map<string, Comment>();
  if (!document || typeof document !== 'object' || !('blocks' in document) || !Array.isArray(document.blocks)) return result;
  for (const block of document.blocks) {
    if (block?.type === 'database-comment' && typeof block.id === 'string' && block.id.length <= 128 && block.data) result.set(block.id, block);
  }
  return result;
}
function recipients(comment: Comment, blocks: Map<string, Comment>) {
  const users = new Map<string, 'comment_mention' | 'comment_reply'>();
  const parentId = comment.parentId ?? comment.parent;
  const parent = parentId && blocks.get(parentId);
  if (parent && typeof parent.data.authorId === 'string') users.set(parent.data.authorId, 'comment_reply');
  const text = comment.data.text;
  if (typeof text === 'string' && Array.isArray(comment.data.mentions)) {
    for (const item of comment.data.mentions) {
      if (item?.type === 'person' && typeof item.id === 'string' && typeof item.label === 'string' && item.label &&
          typeof item.start === 'number' && Number.isInteger(item.start) && item.start >= 0 && text.startsWith(item.label,item.start)) {
        users.set(item.id, 'comment_mention');
      }
    }
  }
  if (comment.data.authorId) users.delete(comment.data.authorId);
  return users;
}

export interface RecordedNotice { recipient_id: string; type: string; page_id: string }

export async function recordCommentNotifications(db: PoolClient, workspace: string, page: string, before: unknown, after: unknown): Promise<RecordedNotice[]> {
  const previous = comments(before), current = comments(after);
  const notices: {recipient: string; type: string; comment: string}[] = [];
  for (const [id, comment] of current) {
    const old = previous.get(id);
    const existing = old ? recipients(old,previous) : undefined;
    for (const [recipient,type] of recipients(comment,current)) {
      if (!existing?.has(recipient)) notices.push({recipient,type,comment:id});
    }
  }
  if (!notices.length) return [];
  // An editor controls document text and its recorded author. Notify with no
  // attributed actor. Restrict recipients to current readers under inherited ACLs.
  const created = await db.query<RecordedNotice>(`WITH RECURSIVE ancestors AS (
    SELECT p.id,p.visibility,p.metadata->>'parentId' AS parent,0 AS depth FROM pages p
    WHERE p.id=$2 AND p.workspace_id=$1 AND NOT p.deleted AND NOT p.trashed
    UNION ALL SELECT p.id,p.visibility,p.metadata->>'parentId',a.depth+1 FROM pages p JOIN ancestors a ON p.id=a.parent
    WHERE a.depth<63 AND p.workspace_id=$1 AND NOT p.deleted
  ) INSERT INTO workspace_notifications(workspace_id,recipient_id,type,page_id,comment_id)
    SELECT $1,m.user_id,n.type,$2,n.comment FROM jsonb_to_recordset($3::jsonb) AS n(recipient text,type text,comment text)
    JOIN memberships m ON m.user_id=n.recipient AND m.workspace_id=$1
    WHERE EXISTS (SELECT FROM ancestors) AND (
      (SELECT visibility FROM ancestors WHERE visibility<>'inherit' ORDER BY depth LIMIT 1)='workspace'
      OR EXISTS (SELECT FROM page_shares s JOIN ancestors a ON a.id=s.page_id WHERE s.user_id=m.user_id))
    ON CONFLICT DO NOTHING
    RETURNING recipient_id,type,page_id`,[workspace,page,JSON.stringify(notices)]);
  return created.rows;
}
