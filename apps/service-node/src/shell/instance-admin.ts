import { randomUUID } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { mailTemplate } from './mail-template.ts';
import { inTransaction } from './bootstrap.ts';
import { readBody, requireAccount, validWorkspace } from './workspace-directory.ts';
import { consumeRate, createLoginMail, trustedClientIP } from './request-code.ts';
import { mailBackend, passwordAuthAvailable, sendMail, validateAddress } from './mail.ts';
import { generateLoginCode, hashSecret } from '../auth/codes.ts';
import { hashPassword, validPassword } from './password.ts';
import { sessionDigest } from './session.ts';

import { mediaOrigin, uploadDirectory } from './asset-storage.ts';
import { readInstanceSettings, updateInstanceSettings } from './instance-settings.ts';

const userFields = `u.id,u.email,u.name,u.created_at AS "createdAt",
  (SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id) AS "workspaceCount",
  EXISTS(SELECT FROM instance_admins ia WHERE ia.user_id=u.id) AS "instanceAdmin"`;
function bad(message: string): never { throw new HTTPException(400,{message}); }
function getName(value: unknown, empty = false) {
  if(typeof value!=='string'||(!empty && !value.trim())||[...value.trim()].length>120) bad('Invalid name');
  return value.trim();
}
function getEmail(value: unknown) {
  const email = typeof value==='string' && validateAddress(value);
  if(!email) bad('Invalid email');
  return email;
}
function policy(value: unknown, values: string[]) {
  if(value!==undefined && (typeof value!=='string'||!values.includes(value))) bad('Invalid policy');
}
async function lockedAdmin(db: PoolClient,c: Context) {
  await db.query('SELECT id FROM instance_settings WHERE id FOR UPDATE');
  const {rows:[actor]}=await db.query(`SELECT s.user_id FROM sessions s JOIN instance_admins a USING(user_id)
    WHERE s.id=$1 AND s.expires_at>now() FOR SHARE OF s,a`,[sessionDigest(c)]);
  if(!actor) throw new HTTPException(403,{message:'Instance administrator required'});
  return actor.user_id as string;
}

export function instanceAdmin(pool: PgPool, secret: string, recheck: ()=>Promise<void>) {
  const router=new Hono();
  router.use('/api/admin/*', async(c,next)=>{ await requireAccount(pool,c,true); await next(); });
  router.use('/api/admin/*',bodyLimit({maxSize:32<<10}));
  router.use('/api/setup/*',bodyLimit({maxSize:8192}));
  const clientIP=trustedClientIP(process.env.TRUSTED_PROXY_CIDRS??'');
  const ip=(c:Context)=>clientIP(getConnInfo(c).remote.address??'unknown',c.req.header('X-Forwarded-For')??'');
  router.get('/api/instance',async c=>c.json({...(await pool.query(`SELECT s.name,s.signup_policy AS "signupPolicy",
    s.workspace_creation AS "workspaceCreation",s.setup_completed_at IS NULL AS "setupRequired",
    CASE WHEN w.id IS NOT NULL THEN jsonb_build_object('name',w.name,'slug',w.slug) END AS "defaultWorkspace"
    FROM instance_settings s LEFT JOIN workspaces w ON w.id=s.default_workspace_id WHERE s.id`)).rows[0],
    passwordAuthAvailable:passwordAuthAvailable(),emailCodeAvailable:!!mailBackend()}));
  router.get('/api/admin/settings',async c=>c.json(await readInstanceSettings(pool)));
  router.patch('/api/admin/settings',async c=>{
    const patch=await readBody(c);
    return c.json(await inTransaction(pool,async db=>updateInstanceSettings(db,patch,await lockedAdmin(db,c))));
  });
  router.post('/api/setup/claim',async c=>{
    const b=await readBody(c), email=getEmail(b.email),name=getName(b.name);
    if (b.password !== undefined) {
      if (!passwordAuthAvailable()) throw new HTTPException(403,{message:'Password sign-in is disabled'});
      if (!validPassword(b.password)) bad('Le mot de passe doit contenir au moins 12 caractères et au plus 1 024 octets.');
    }
    const instance=b.instanceName?getName(b.instanceName):null;
    const signup=b.signupPolicy??'invite',creation=b.workspaceCreation??'admins_only';
    policy(signup,['invite','domain','open']);policy(creation,['anyone','admins_only','disabled']);
    const local=email.split('@')[0]!;
    let slug=local.replace(/[^a-z0-9]+/g,'-').slice(0,63).replace(/^-+|-+$/g,'')||'espace';
    if(slug.length<2) slug+='-espace';
    const ws=b.workspace??{slug,name:'Espace de '+local};
    if(!validWorkspace(ws.slug,ws.name)) bad('Invalid workspace');
    const peer=ip(c);
    if(!await consumeRate(pool,'setup-claim:'+peer,20)) throw new HTTPException(429,{message:'Too many attempts'});
    await inTransaction(pool,async db=>{
      const {rows:[cfg]}=await db.query('SELECT setup_completed_at FROM instance_settings WHERE id FOR UPDATE');
      if(cfg.setup_completed_at) throw new HTTPException(409,{message:'Setup already completed'});
      if(!await consumeRate(db,'login-ip:'+peer,30)||!await consumeRate(db,'login-email:'+email,8)) throw new HTTPException(429,{message:'Too many attempts'});
      const passwordHash = b.password === undefined ? null : await hashPassword(b.password);
      const {rows:[user]}=await db.query(`INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)
        ON CONFLICT(email) DO UPDATE SET name=excluded.name WHERE excluded.password_hash IS NULL RETURNING id`,
        [randomUUID(),email,name,passwordHash]);
      if(!user) throw new HTTPException(409,{message:'Account already exists'});
      const id=randomUUID();
      await db.query('INSERT INTO instance_admins(user_id) VALUES($1)',[user.id]);
      await db.query('INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)',[id,ws.slug,ws.name.trim()]);
      await db.query("INSERT INTO memberships VALUES($1,$2,'admin')",[id,user.id]);
      await db.query(`UPDATE instance_settings SET name=coalesce($1,name),signup_policy=$2,workspace_creation=$3,default_workspace_id=$4,
        setup_completed_at=now(),updated_at=now(),updated_by=$5 WHERE id`,[instance,signup,creation,id,user.id]);
      if (passwordHash) return;
      const code=generateLoginCode();
      const issued=await db.query(`INSERT INTO login_codes(email,digest,expires_at) VALUES($1,$2,now()+interval '10 minutes')
        ON CONFLICT(email) DO UPDATE SET digest=excluded.digest,expires_at=excluded.expires_at,attempts=0,sent_at=now()
        WHERE login_codes.sent_at<now()-interval '45 seconds'`,[email,hashSecret(email+':'+code+':'+secret)]);
      if(!issued.rowCount) throw new HTTPException(429,{message:'Too many attempts'});
      await createLoginMail().deliver(email,code);
    });
    return c.json({ok:true});
  });
  router.on('POST',['/api/admin/email-test','/api/setup/email-test'],async c=>{
    const email=getEmail((await readBody(c)).email), setup=c.req.path.startsWith('/api/setup');
    const key=setup?'setup-email-test:'+ip(c):'admin-email-test:'+(await requireAccount(pool,c,true)).id;
    if(!await consumeRate(pool,key,10)) throw new HTTPException(429,{message:'Too many attempts'});
    if(setup && !(await pool.query('SELECT 1 FROM instance_settings WHERE id AND setup_completed_at IS NULL')).rowCount) throw new HTTPException(403,{message:'Setup already completed'});
    const backend=mailBackend();
    try {
      const { text, html } = await mailTemplate('delivery-test', { publicURL: process.env.PUBLIC_URL ?? '' });
      await sendMail(email, 'Test de livraison Blok', text, html);
    }
    catch { return c.json({error:'Email delivery unavailable',backend},503); }
    return c.json({ok:true,backend});
  });
  router.get('/api/admin/health',async c=>{
    const s3 = !!process.env.BLOK_S3_BUCKET;
    const uploads = uploadDirectory();
    const files = s3
      ? await fetch(mediaOrigin+'/health', {method:'HEAD', signal:AbortSignal.timeout(3000)}).then(r=>r.ok).catch(()=>false)
      : await stat(uploads).then(async info=>{await access(uploads,constants.W_OK); return info.isDirectory();}).catch(()=>false);
    const backend=mailBackend();
    return c.json({database:{ok:true,detail:'Joignable'},files:{ok:files,detail:s3 ? (files?'Stockage S3 accessible':'Stockage S3 indisponible') : (files?'Volume accessible en écriture':'Volume indisponible')},mail:{ok:!!backend,backend,detail:backend?'Configuré':'Aucun backend configuré'}});
  });
  router.on('GET',['/api/admin/users','/api/admin/workspaces'],async c=>{
    const integer=(key:string,def:number,max:number)=>{const v=c.req.query(key); return v && /^\d+$/.test(v)?Math.min(Number(v),max):def;};
    const limit=integer('limit',50,100)||50,offset=integer('offset',0,2147483647);
    const users=c.req.path.endsWith('/users'),table=users?'users':'workspaces';
    const rows=await pool.query((users?'SELECT '+userFields+' FROM users u ORDER BY u.created_at,u.email':
      'SELECT w.id,w.slug,w.name,w.created_at AS "createdAt",(SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id) AS "memberCount" FROM workspaces w ORDER BY w.created_at,w.slug')+' LIMIT $1 OFFSET $2',[limit,offset]);
    const {rows:[count]}=await pool.query('SELECT count(*)::int AS total FROM '+table);
    return c.json({[table]:rows.rows,total:count.total,limit,offset});
  });
  router.post('/api/admin/users',async c=>{
    const b=await readBody(c),email=getEmail(b.email),name=getName(b.name??'',true);
    const user=await inTransaction(pool,async db=>{
      await lockedAdmin(db,c);
      return (await db.query('INSERT INTO users(id,email,name) VALUES($1,$2,$3) RETURNING id,email,name,created_at AS "createdAt"',[randomUUID(),email,name])).rows[0];
    });
    return c.json({...user,workspaceCount:0,instanceAdmin:false},201);
  });
  router.on(['PATCH','DELETE'],'/api/admin/users/:id',async c=>{
    const remove=c.req.method==='DELETE',b=remove?{}:await readBody(c),id=c.req.param('id');
    const name=b.name===undefined?undefined:getName(b.name,true);
    if(b.instanceAdmin!==undefined&&typeof b.instanceAdmin!=='boolean') bad('Invalid instanceAdmin');
    const result=await inTransaction(pool,async db=>{
      const actor=await lockedAdmin(db,c);
      const {rows:[user]}=await db.query('SELECT '+userFields+' FROM users u WHERE u.id=$1 FOR UPDATE',[id]);
      if(!user) throw new HTTPException(404,{message:'User not found'});
      if(user.instanceAdmin && (remove||b.instanceAdmin===false) && !(await db.query('SELECT 1 FROM instance_admins WHERE user_id<>$1 LIMIT 1',[id])).rowCount) throw new HTTPException(409,{message:'Keep at least one instance administrator'});
      if(remove){
        if(id===actor) throw new HTTPException(409,{message:'You cannot delete your own account'});
        await db.query('UPDATE page_shares SET granted_by=$2 WHERE granted_by=$1',[id,actor]);
        await db.query('UPDATE workspace_emojis SET created_by=$2 WHERE created_by=$1',[id,actor]);
        await db.query('UPDATE instance_admins SET granted_by=NULL WHERE granted_by=$1',[id]);
        await db.query('UPDATE instance_settings SET updated_by=NULL WHERE updated_by=$1',[id]);
        for(const table of ['sessions','mcp_tokens','memberships','join_requests','page_shares','instance_admins']) await db.query('DELETE FROM '+table+' WHERE user_id=$1',[id]);
        await db.query("DELETE FROM ai_credentials WHERE scope='personal' AND owner_id=$1",[id]);
        await db.query('DELETE FROM login_codes WHERE email=$1',[user.email]);
        await db.query('DELETE FROM users WHERE id=$1',[id]);
        return {ok:true};
      }
      if(name!==undefined) await db.query('UPDATE users SET name=$2 WHERE id=$1',[id,name]);
      if(b.instanceAdmin===true) await db.query('INSERT INTO instance_admins(user_id,granted_by) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,actor]);
      if(b.instanceAdmin===false) await db.query('DELETE FROM instance_admins WHERE user_id=$1',[id]);
      return {...user,name:name??user.name,instanceAdmin:b.instanceAdmin??user.instanceAdmin};
    });
    if(remove) await recheck();
    return c.json(result);
  });
  return router;
}
