import type { PgPool } from '../db/pool.ts';
import {tokenCounts} from './usage-counts.ts';
type Feature = 'chat' | 'edit' | 'query' | 'index';

export async function recordAiUsage(pool: PgPool, workspace:string, actor:string, feature:Feature,
  usage:unknown, model:unknown, tier:unknown = 'default') {
  const counts=tokenCounts(usage);
  try {
    await pool.query(`INSERT INTO ai_usage_model_daily AS current
      (workspace_id,day,actor,feature,model,standard,calls,tokens,measured,detailed,input,cached,output)
      VALUES ($1,(now() AT TIME ZONE 'UTC')::date,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(workspace_id,day,actor,feature,model,standard) DO UPDATE SET calls=current.calls+1,
      tokens=current.tokens+excluded.tokens, measured=current.measured+excluded.measured,
      detailed=current.detailed+excluded.detailed,input=current.input+excluded.input,
      cached=current.cached+excluded.cached,output=current.output+excluded.output`,
      [workspace,actor,feature,typeof model==='string'?model:'',tier==='default'||tier==='standard',
       counts.tokens,counts.measured,counts.detailed,counts.input,counts.cached,counts.output]);
  } catch { console.warn(JSON.stringify({event:'ai.usage.write_failed',feature})); }
}

