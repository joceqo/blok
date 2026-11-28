import type {UsageRow} from './ai-usage-store';

// Standard USD per million tokens (input, cached input, output), 2026-11-28.
// https://developers.openai.com/api/docs/pricing and the individual model pricing cards.
const standardRates:Record<string,readonly [number,number,number]> = {
  'text-embedding-3-small':[0.02,0.02,0],
  'gpt-4o-mini':[0.15,0.075,0.60], 'gpt-4.1-mini':[0.40,0.10,1.60],
  'gpt-5-mini':[0.25,0.025,2], 'gpt-5-nano':[0.05,0.005,0.40],
  'gpt-5.4-mini':[0.75,0.075,4.50], 'gpt-5.4-nano':[0.20,0.02,1.25],
  'gpt-6.2-astra':[8,0.40,40], 'gpt-6.2-sol':[2,0.10,10],
  'gpt-6-astra':[10,1,50], 'gpt-6.1-sol':[2,0.10,10],
  'gpt-6.1-terra':[1,0.05,5], 'gpt-6-luna':[0.10,0.01,0.50],
};

export function estimatedUsd(row:UsageRow):number|undefined {
  if (row.provider!=='openai' || !row.standard || !row.detailed) return;
  const model=row.model?.replace(/-\d{4}-\d{2}-\d{2}$/,'') ?? '';
  if (!Object.hasOwn(standardRates,model)) return;
  const [input,cached,output]=standardRates[model];
  return (((row.input??0)-(row.cached??0))*input+(row.cached??0)*cached+(row.output??0)*output)/1_000_000;
}

export function usageBreakdown(rows:UsageRow[]) {
  const groups=new Map<string,{provider:UsageRow['provider'];model:string;feature:UsageRow['feature'];calls:number;tokens:number;measured:number;detailed:number;input:number;cached:number;output:number;usd:number;priced:number}>();
  for (const row of rows) {
    const model=row.model??'';
    const key=JSON.stringify([row.provider,model,row.feature]);
    const group=groups.get(key)??{provider:row.provider,feature:row.feature,model,calls:0,tokens:0,measured:0,detailed:0,input:0,cached:0,output:0,usd:0,priced:0};
    for (const name of ['calls','tokens','measured','detailed','input','cached','output'] as const) group[name]+=row[name]??0;
    const cost=estimatedUsd(row);
    if (cost!==undefined) {group.usd+=cost;group.priced+=row.detailed??0;}
    groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>b.calls-a.calls||a.model.localeCompare(b.model));
}

