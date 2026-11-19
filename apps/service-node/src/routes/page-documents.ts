import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Database } from '@/db/index.js';
import { pageDocuments, pages } from '@/db/schema.js';
import { requireWorkspaceRole } from '@/http/workspace-access.js';
import type { DbVariables } from '@/middleware/db.js';
import { requireUser } from '@/middleware/require-user.js';
import { assertPageAction } from '@/permissions.js';
import type { SessionVariables } from '@/middleware/session.js';
import { memberRole } from '@/workspaces/membership.js';

type Env = { Variables: DbVariables & SessionVariables };

function formatDocument(row: {
  pageId: string;
  docId: string;
  lineage: string | null;
  sequence: bigint | null;
}) {
  return {
    pageId: row.pageId,
    docId: row.docId,
    lineage: row.lineage,
    sequence: row.sequence === null ? null : row.sequence.toString(),
  };
}

function parseSequence(value: string | number | undefined): bigint | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

async function loadPage(db: Database, pageId: string) {
  return (await db.select().from(pages).where(eq(pages.id, pageId)).limit(1))[0];
}

export const pageDocumentRoutes = new Hono<Env>();

pageDocumentRoutes.get('/api/pages/:pageId/document', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const page = await loadPage(db, pageId);
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, page.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }
  try {
    assertPageAction(role, 'read');
  } catch {
    return context.json({ error: 'permission_denied' }, 403);
  }

  const binding = (
    await db.select().from(pageDocuments).where(eq(pageDocuments.pageId, pageId)).limit(1)
  )[0];

  if (binding === undefined) {
    return context.json({ document: null });
  }

  return context.json({ document: formatDocument(binding) });
});

pageDocumentRoutes.post('/api/pages/:pageId/document', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const page = await loadPage(db, pageId);
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, page.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }
  try {
    assertPageAction(role, 'edit');
  } catch {
    return context.json({ error: 'permission_denied' }, 403);
  }

  const existing = (
    await db.select({ pageId: pageDocuments.pageId }).from(pageDocuments).where(eq(pageDocuments.pageId, pageId)).limit(1)
  )[0];
  if (existing !== undefined) {
    return context.json({ error: 'already_bound' }, 409);
  }

  const body: { docId?: string; lineage?: string | null; sequence?: string | number | null } =
    await context.req
      .json<{ docId?: string; lineage?: string | null; sequence?: string | number | null }>()
      .catch(() => ({}));

  const docId = typeof body.docId === 'string' ? body.docId.trim() : '';
  if (docId.length === 0) {
    return context.json({ error: 'invalid_doc_id' }, 400);
  }

  const lineage = typeof body.lineage === 'string' ? body.lineage : null;
  const sequence =
    body.sequence === null || body.sequence === undefined
      ? null
      : (parseSequence(body.sequence) ?? null);

  if (body.sequence !== undefined && body.sequence !== null && sequence === null) {
    return context.json({ error: 'invalid_sequence' }, 400);
  }

  const inserted = await db
    .insert(pageDocuments)
    .values({ pageId, docId, lineage, sequence })
    .returning();

  const row = inserted[0];
  if (row === undefined) {
    return context.json({ error: 'insert_failed' }, 500);
  }

  return context.json({ document: formatDocument(row) }, 201);
});

pageDocumentRoutes.patch('/api/pages/:pageId/document', requireUser(), async (context) => {
  const pageId = context.req.param('pageId');
  const db = context.get('db');
  const userId = context.get('userId');
  if (userId === undefined) {
    return context.json({ error: 'unauthenticated' }, 401);
  }

  const page = await loadPage(db, pageId);
  if (page === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const role = await memberRole(db, userId, page.workspaceId);
  if (role === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }
  try {
    assertPageAction(role, 'edit');
  } catch {
    return context.json({ error: 'permission_denied' }, 403);
  }

  const current = (
    await db.select().from(pageDocuments).where(eq(pageDocuments.pageId, pageId)).limit(1)
  )[0];
  if (current === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  const body: { docId?: string; lineage?: string | null; sequence?: string | number | null } =
    await context.req
      .json<{ docId?: string; lineage?: string | null; sequence?: string | number | null }>()
      .catch(() => ({}));

  const patch: { docId?: string; lineage?: string | null; sequence?: bigint | null } = {};

  if (typeof body.docId === 'string') {
    const docId = body.docId.trim();
    if (docId.length === 0) {
      return context.json({ error: 'invalid_doc_id' }, 400);
    }
    patch.docId = docId;
  }

  if (body.lineage === null) {
    patch.lineage = null;
  } else if (typeof body.lineage === 'string') {
    patch.lineage = body.lineage;
  }

  if (body.sequence === null) {
    patch.sequence = null;
  } else if (body.sequence !== undefined) {
    const sequence = parseSequence(body.sequence);
    if (sequence === undefined) {
      return context.json({ error: 'invalid_sequence' }, 400);
    }
    patch.sequence = sequence;
  }

  if (Object.keys(patch).length === 0) {
    return context.json({ document: formatDocument(current) });
  }

  const updated = await db
    .update(pageDocuments)
    .set(patch)
    .where(eq(pageDocuments.pageId, pageId))
    .returning();

  const row = updated[0];
  if (row === undefined) {
    return context.json({ error: 'not_found' }, 404);
  }

  return context.json({ document: formatDocument(row) });
});