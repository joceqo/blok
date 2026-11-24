import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { loadAiKey, openAiKey, sealAiKey } from './ai-crypto.ts';
import { editorItem, editorRequest, modelId, object, textModel } from './ai-editor.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

type Scope = Awaited<ReturnType<typeof readWorkspaceScope>>;
interface Credential { scope: string; owner_id: string; model: string; encrypted_key: Buffer | null }
class AiError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 422 | 429 | 502 | 503 | 504, message: string) { super(message); }
}
const state = (v?: Credential) => ({ configured: !!v?.encrypted_key?.length, model: v?.model ?? '' });

function scopeOwner(scope: unknown, user: Scope) {
  if (scope === 'personal') return user.user_id;
  if (scope !== 'workspace') throw new AiError(400, 'Portée IA inconnue');
  if (user.role !== 'admin') throw new AiError(403, 'Seul un administrateur peut gérer la clé IA partagée');
  return user.workspace_id;
}

async function provider(fetcher: typeof fetch, key: string, path: 'models'|'responses', payload: unknown, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(path === 'models' ? 20_000 : 60_000)]);
  try {
    const response = await fetcher('https://api.openai.com/v1/' + path, {
      method: path === 'models' ? 'GET' : 'POST', signal: deadline, redirect: 'error',
      headers: {Authorization:'Bearer '+key, Accept:'application/json', 'Content-Type':'application/json'},
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 429) throw new AiError(429, 'La limite d’utilisation OpenAI est atteinte');
      if ([400,401,403,404].includes(response.status)) throw new AiError(422, 'OpenAI a refusé la clé, le modèle ou la demande');
      throw new AiError(502, 'La requête OpenAI a échoué');
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new AiError(502,'Réponse OpenAI trop longue'); }
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(result)) throw new AiError(502,'Réponse OpenAI invalide');
    return result;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (deadline.aborted) throw new AiError(504,'La requête OpenAI a expiré ou a été annulée');
    throw new AiError(502,'La requête OpenAI a échoué');
  }
}

export function createHostedAi(pool: PgPool, fetcher: typeof fetch = fetch, keySource = (db: Pick<PgPool,'query'>) =>
  loadAiKey(db, process.env.DATA_DIRECTORY || '/data', process.env.AI_ENCRYPTION_KEY)) {
  const app = new Hono();
  const active = new Map<string, number>();
  let cachedKey: Promise<Buffer> | undefined;
  const key = (db: Pick<PgPool,'query'> = pool) => cachedKey ??= keySource(db).catch(error => { cachedKey = undefined; throw error; });
  app.onError((e,c) => {
    if (e instanceof WorkspaceError || e instanceof AiError) return c.json({error:e.message},e.status);
    console.error('[hosted-ai]',e.name);
    return c.json({error:'La configuration IA est indisponible'},503);
  });
  // readWorkspaceScope expects the transaction to hold membership locks through any mutation.
  async function scoped<T>(c: Context, write: boolean, fn: (db: PoolClient, scope: Scope) => Promise<T>) {
    const session = sessionDigest(c);
    if (!session) throw new AiError(401,'Sign in required');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const result = await fn(db,await readWorkspaceScope(db,session,c.req.param('slug') ?? '',write));
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async function settings(c: Context) {
    return scoped(c,false,async(db,user) => {
      const {rows} = await db.query<Credential>(
        "SELECT scope,owner_id,model,encrypted_key FROM ai_credentials WHERE (scope='personal' AND owner_id=$1) OR (scope='workspace' AND owner_id=$2)",
        [user.user_id,user.workspace_id]);
      const personal = rows.find(r => r.scope === 'personal'), workspace = rows.find(r => r.scope === 'workspace');
      const effective = personal?.encrypted_key ? personal : workspace?.encrypted_key ? workspace : undefined;
      return {personal,workspace,effective,user};
    });
  }
  app.get('/',async c => {
    const s = await settings(c);
    return c.json({ personal:state(s.personal), workspace:state(s.workspace),
      effective:{source:s.effective?.scope ?? 'none',model:s.effective?.model ?? ''}, canManageWorkspace:s.user.role === 'admin' });
  });
  const limit = (maxSize: number) => bodyLimit({maxSize,onError:c => c.json({error:'Requête trop longue'},413)});
  app.put('/credentials',limit(8192),async c => {
    const input: unknown = await c.req.json().catch(() => null);
    if (!object(input) || (input.apiKey == null && input.model == null)) throw new AiError(400,'Indiquez une clé ou un modèle');
    if (input.model != null && input.model !== '' && !modelId(input.model)) throw new AiError(400,'Identifiant de modèle invalide');
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined;
    if (input.apiKey != null && (!apiKey || Buffer.byteLength(apiKey) < 8 || Buffer.byteLength(apiKey) > 4096 || /[\s\x00]/u.test(apiKey))) throw new AiError(400,'Clé API invalide');
    await scoped(c,true,async(db,user) => {
      const owner = scopeOwner(input.scope,user);
      const encrypted = apiKey ? sealAiKey(await key(db),input.scope+':'+owner,apiKey) : null;
      await db.query(`INSERT INTO ai_credentials(scope,owner_id,encrypted_key,model) VALUES($1,$2,$3,coalesce($4,''))
        ON CONFLICT(scope,owner_id) DO UPDATE SET encrypted_key=coalesce(excluded.encrypted_key,ai_credentials.encrypted_key),
        model=CASE WHEN $4::text IS NULL THEN ai_credentials.model ELSE excluded.model END,updated_at=now()`,
        [input.scope,owner,encrypted,input.model ?? null]);
    });
    return c.json({ok:true});
  });
  app.delete('/credentials',async c => {
    const scope = c.req.query('scope');
    await scoped(c,true,async(db,user) => db.query('DELETE FROM ai_credentials WHERE scope=$1 AND owner_id=$2',[scope,scopeOwner(scope,user)]));
    return c.json({ok:true});
  });
  async function call(c: Context, path: 'models'|'responses', prepare: (cred: Credential) => unknown) {
    const s = await settings(c);
    let cred = s.effective;
    const choice = path === 'models' && c.req.query('scope');
    if (choice) { scopeOwner(choice,s.user); cred = choice === 'personal' ? s.personal : s.workspace; }
    if (!cred?.encrypted_key) throw new AiError(409,'Ajoutez d’abord une clé API OpenAI');
    const payload = prepare(cred);
    const uid = s.user.user_id;
    const {rows} = await pool.query(`INSERT INTO email_rate_limits(key,count) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN email_rate_limits.window_start<now()-interval '1 minute' THEN 1 ELSE email_rate_limits.count+1 END,
      window_start=CASE WHEN email_rate_limits.window_start<now()-interval '1 minute' THEN now() ELSE email_rate_limits.window_start END RETURNING count`,['ai:'+uid]);
    if (rows[0].count > 30 || (path === 'responses' && (active.get(uid) ?? 0) >= 2)) throw new AiError(429,'Limite de requêtes IA atteinte');
    if (path === 'responses') active.set(uid,(active.get(uid) ?? 0)+1);
    try {
      let secret: string;
      try { secret = openAiKey(await key(),cred.scope+':'+cred.owner_id,cred.encrypted_key); } catch { throw new AiError(503,'Impossible de déchiffrer les identifiants IA'); }
      return {out:await provider(fetcher,secret,path,payload,c.req.raw.signal),cred};
    } finally {
      if (path === 'responses') { const rest = active.get(uid)!-1; if (rest) active.set(uid,rest); else active.delete(uid); }
    }
  }
  app.get('/models',async c => {
    const {out,cred} = await call(c,'models',() => undefined);
    if (!Array.isArray(out.data)) throw new AiError(502,'Catalogue OpenAI invalide');
    const ids = new Set<string>();
    for (const item of out.data) {
      if (object(item) && textModel(item.id)) ids.add(item.id);
      if (ids.size === 500) break;
    }
    return c.json({models:[...ids].sort().map(id => ({id})),source:cred.scope});
  });
  app.post('/respond',limit(128<<10),async c => {
    const input: unknown = await c.req.json().catch(() => null);
    if (!object(input)) throw new AiError(400,'Messages IA invalides');
    const system = input.system ?? '', messages = input.messages;
    if (typeof system !== 'string' || Buffer.byteLength(system)>16<<10 || !Array.isArray(messages) || !messages.length || messages.length>32) throw new AiError(400,'Historique IA invalide');
    let bytes = Buffer.byteLength(system);
    const history = messages.map(item => {
      if (!object(item) || !['user','assistant'].includes(String(item.role)) || typeof item.content !== 'string' || !item.content) throw new AiError(400,'Message IA invalide');
      bytes += Buffer.byteLength(item.content);
      return {role:item.role,content:item.content};
    });
    if (bytes > 64<<10) throw new AiError(400,'La demande IA dépasse 64 Kio');
    let model: string;
    const {out,cred} = await call(c,'responses',credential => {
      const requested = input.model || credential.model;
      if (!modelId(requested)) throw new AiError(400,'Choisissez un modèle OpenAI');
      model = requested;
      return {model,instructions:system,input:history,store:false,max_output_tokens:4096};
    });
    if (out.status !== 'completed' || !Array.isArray(out.output)) throw new AiError(502,'OpenAI n’a pas terminé la réponse');
    const text = out.output.flatMap(item => object(item) && item.type === 'message' && Array.isArray(item.content) ? item.content : [])
      .filter(p => object(p) && p.type === 'output_text' && typeof p.text === 'string').map(p => p.text).join('');
    if (!text || Buffer.byteLength(text) > 64<<10) throw new AiError(502,'Réponse OpenAI invalide');
    return c.json({text,model:modelId(out.model) ? out.model : model!,source:cred.scope});
  });
  app.post('/editor-respond',limit(512<<10),async c => {
    const input: unknown = await c.req.json().catch(() => null);
    if (!object(input) || !editorRequest(input)) throw new AiError(400,'Requête de l’assistant d’édition invalide');
    const {out} = await call(c,'responses',() => ({...input,store:false,stream:false,max_output_tokens:4096}));
    const offered = new Set((input.tools as {name:string}[]).map(t => t.name));
    if (!['completed','incomplete'].includes(String(out.status)) || !Array.isArray(out.output) ||
        (!out.output.length && out.status === 'completed') || !out.output.every(item => editorItem(item,true) &&
        (item.type !== 'function_call' || offered.has(item.name)))) throw new AiError(502,'Réponse de l’assistant d’édition invalide');
    return c.json({status:out.status,model:out.model,output:out.output,incomplete_details:out.incomplete_details});
  });
  return app;
}
