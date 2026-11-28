import {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import type {AiClient} from './ai-client';
import {nativeBridge} from './ai-client';
import {readDeviceUsage, shiftDay, utcDay, type UsageRow} from './ai-usage-store';
import {shellLocale, shellText as t} from './shell-i18n';
import type {WorkspaceRef} from './workspace-registry';

import {Choice} from './components/shell/choice';
import {estimatedUsd,usageBreakdown} from './ai-usage-pricing';

type IndexStatus = {enabled:boolean;pages:number;processed:number;passages:number};
type Group = 'feature' | 'provider';
type Metric = 'calls' | 'tokens' | 'cost';
const colors = {chat:'#569ded',edit:'#ee9c59',query:'#58ac92',index:'#a08bd6',openai:'#569ded',codex:'#ee9c59',claude:'#58ac92'};
const series = {feature:['chat','edit','query','index'],provider:['openai','codex','claude']} as const;
const labels = () => ({chat:t('Conversations'),edit:t('Édition'),query:t('Recherche sémantique'),index:t('Indexation'),openai:'OpenAI',codex:'Codex',claude:'Claude Code'});

export function chartData(rows: UsageRow[], end: string, days: number, group: Group, metric: Metric) {
  const points = Array.from({length:days},(_,i) => ({
    day:shiftDay(end,i+1-days),chat:0,edit:0,query:0,index:0,openai:0,codex:0,claude:0,
  }));
  const byDay = new Map(points.map(point => [point.day,point]));
  for (const row of rows) {
    const point = byDay.get(row.day);
    if (point) point[row[group]] += metric==='cost' ? estimatedUsd(row)??0 : row[metric];
  }
  return points;
}

function UsagePanel({workspace,client}:{workspace:WorkspaceRef;client:Pick<AiClient,'usage'>}) {
  const [end,setEnd] = useState(utcDay);
  const [days,setDays] = useState(7);
  const [group,setGroup] = useState<Group>('feature');
  const [metric,setMetric] = useState<Metric>('calls');
  const metricOptions=useMemo(()=>[{value:'calls' as const,label:t('Appels')},{value:'tokens' as const,label:t('Tokens déclarés')},{value:'cost' as const,label:t('Coût API estimé')}],[]);
  const groupOptions=useMemo(()=>[{value:'feature' as const,label:t('Par fonctionnalité')},{value:'provider' as const,label:t('Par fournisseur')}],[]);
  const [refresh,setRefresh] = useState(0);
  const [result,setResult] = useState<{period:string;rows:UsageRow[];issues:string[];available:boolean;index?:IndexStatus}>();
  const period = end+'/'+days;
  useEffect(() => {
    const update = () => {
      if (!document.hidden) setRefresh(value => value+1);
    };
    // Indexing runs on the server and other windows can finish a chat independently.
    const timer = window.setInterval(update,30_000);
    window.addEventListener('focus',update);
    document.addEventListener('visibilitychange',update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus',update);
      document.removeEventListener('visibilitychange',update);
    };
  },[]);
  useEffect(() => {
    const gate = new AbortController();
    let index:IndexStatus|undefined;
    const sources: {name:string;load:Promise<UsageRow[]>}[] = [];
    if (client.usage) sources.push({name:t('Serveur'),load:client.usage(end,days,gate.signal)
      .then(reply => {index=reply.index;return reply.rows.map(row => ({...row,provider:'openai' as const}));})});
    if (nativeBridge() || workspace.kind === 'local') sources.push({name:t('Cet appareil'),load:readDeviceUsage(workspace,end,days)});
    void Promise.allSettled(sources.map(source=>source.load)).then(results => {
      if (gate.signal.aborted) return;
      const rows:UsageRow[] = [];
      const issues:string[] = [];
      results.forEach((value,i) => {
        if (value.status === 'fulfilled') rows.push(...value.value);
        else issues.push(sources[i].name);
      });
      setResult({period,rows,issues,index,available:results.some(value=>value.status==='fulfilled')});
    });
    return () => gate.abort();
  },[workspace,client,end,days,period,refresh]);
  const ready = result?.period === period;
  const rows = ready ? result.rows : [];
  const calls = rows.reduce((n,row)=>n+row.calls,0);
  const measured = rows.reduce((n,row)=>n+row.measured,0);
  const tokens = rows.reduce((n,row)=>n+row.tokens,0);
  const groups=usageBreakdown(rows);
  const apiCalls=groups.filter(g=>g.provider==='openai').reduce((n,g)=>n+g.calls,0);
  const priced=groups.reduce((n,g)=>n+g.priced,0);
  const cost=groups.reduce((n,g)=>n+g.usd,0);
  const total = metric === 'calls' ? calls : metric==='cost' ? cost : tokens;
  const data = chartData(rows,end,days,group,metric);
  const names = labels();
  const keys = series[group];
  const locale = shellLocale();
  const numbers = new Intl.NumberFormat(locale);
  const dollars=(n:number)=>new Intl.NumberFormat(locale,{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:n>0 && n<0.01?8:4}).format(n);
  const formatMetric=(n:number)=>metric==='cost'?dollars(n):numbers.format(n);
  const dateFormat = new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',timeZone:'UTC'});
  const fullDate = new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  const date = (day:string) => new Date(day+'T00:00:00Z');
  const today = utcDay();
  const empty = calls===0 || (metric==='tokens' && measured===0) || (metric==='cost' && !priced);
  const unavailable = ready && !result.available;
  return <div className="ai-usage">
    <h2>{t('Historique d’utilisation')}</h2>
    <p className="ai-usage-intro">{workspace.kind==='remote' && workspace.role==='admin'
      ? t('Vos appels IA dans cet espace et l’indexation en arrière-plan.')
      : t('Vos appels IA dans cet espace.')}</p>
    <div className="ai-usage-controls">
      <div className="ai-usage-segment">{[7,30].map(n=><button key={n} type="button" aria-pressed={n===days} onClick={()=>setDays(n)}>{t('{n} j',{n})}</button>)}</div>
      <Choice<Metric> label={t('Mesure')} value={metric} options={metricOptions} onChange={setMetric}/>
      <Choice<Group> label={t('Répartition')} value={group} options={groupOptions} onChange={setGroup}/>
    </div>
    <div className="ai-usage-period">
      <strong>{fullDate.formatRange(date(data[0].day),date(end))}</strong>
      <button type="button" aria-label={t('Période précédente')} onClick={()=>setEnd(shiftDay(end,-days))}><ChevronLeft size={16}/></button>
      <button type="button" aria-label={t('Période suivante')} disabled={end>=today} onClick={()=>setEnd([today,shiftDay(end,days)].sort()[0])}><ChevronRight size={16}/></button>
    </div>
    {ready && result.issues.length>0 && <p role="status">{t('Statistiques indisponibles pour {source}.',{source:result.issues.join(', ')})} <button onClick={()=>setRefresh(v=>v+1)}>{t('Réessayer')}</button></p>}
    {!ready ? <p role="status">{t('Chargement…')}</p> : !unavailable && <>
      <div className="ai-usage-summary">
        <div className="ai-usage-total"><span>{t('Appels terminés')}</span><strong>{numbers.format(calls)}</strong></div>
        <div className="ai-usage-total"><span>{t('Tokens déclarés')}</span><strong>{measured?numbers.format(tokens):'—'}</strong></div>
        <div className="ai-usage-total"><span>{t('Coût API estimé')}</span><strong>{priced?dollars(cost):'—'}</strong></div>
      </div>
      {empty ? <div className="ai-usage-empty" role="status">
        {calls===0?t('Aucune activité enregistrée sur cette période.'):metric==='cost'?t('Aucun coût API disponible sur cette période.'):t('Aucun token déclaré sur cette période.')}
      </div> : <>
      <div className="ai-usage-chart">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={data} margin={{top:12,right:8,bottom:4,left:8}} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="var(--desktop-border)"/>
            <YAxis hide allowDecimals={false} domain={[0,total?'auto':1]} />
            <XAxis dataKey="day" tickFormatter={day=>dateFormat.format(date(day))} ticks={[data[0].day,data[Math.floor(days/2)].day,end]}
              tickLine={false} axisLine={false} tick={{fill:'var(--desktop-muted)',fontSize:11}} dy={7}/>
            <Tooltip cursor={false} content={({active,label,payload})=>{
              const entries = payload.filter(entry=>typeof entry.value==='number' && entry.value>0);
              if (!active || typeof label!=='string' || !entries.length) return null;
              return <div className="ai-usage-tooltip">
                <strong>{fullDate.format(date(label))}</strong>
                {entries.map(entry=><div key={String(entry.dataKey)}>
                  <span>{entry.name}</span><b>{formatMetric(Number(entry.value))}</b>
                </div>)}
              </div>;
            }}/>
            {keys.map(key=><Bar key={key} dataKey={key} name={names[key]} stackId="usage" fill={colors[key]} maxBarSize={32} isAnimationActive={false}/>)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="ai-usage-legend">{keys.map(key=>{
        const sum = data.reduce((n,point)=>n+point[key],0);
        return <li key={key} style={{borderInlineStartColor:colors[key]}}><span>{names[key]}</span><strong>{formatMetric(sum)}</strong>
          {total>0 && <small>{Intl.NumberFormat(locale,{style:'percent',maximumFractionDigits:1}).format(sum/total)}</small>}</li>;
      })}</ul>
      </>}
      {!empty && <p className="ai-usage-note">{measured===0
        ? t('Le fournisseur n’a communiqué aucun total de tokens pour cette période.')
        : calls===1 ? t('Jours en UTC. Tokens communiqués pour cet appel.')
        : t('Jours en UTC. Tokens communiqués pour {n} appels sur {total}.',{n:numbers.format(measured),total:numbers.format(calls)})}</p>}
      {groups.length>0 && <>
        <h3>{t('Détail par modèle et fonctionnalité')}</h3>
        <div className="ai-usage-table"><table>
          <thead><tr>{[t('Modèle'),t('Appels'),t('Entrée'),t('Dont cache'),t('Sortie'),t('Tokens déclarés'),t('Coût API estimé')].map(c=><th scope="col" key={c}>{c}</th>)}</tr></thead>
          <tbody>{groups.map(g=><tr key={g.provider+':'+g.model+':'+g.feature}>
            <th scope="row">{g.model || names[g.provider]}<small>{names[g.feature]}</small></th>
            <td>{numbers.format(g.calls)}</td>
            {[g.input,g.cached,g.output].map((v,i)=><td key={i}>{g.detailed?numbers.format(v):'—'}</td>)}
            <td>{g.measured?numbers.format(g.tokens):'—'}</td><td>{g.priced?dollars(g.usd):'—'}</td>
          </tr>)}</tbody>
        </table></div>
        {apiCalls>0 && <p className="ai-usage-note">{t('Estimation au tarif standard OpenAI pour {n} appels API sur {total}, hors remises et suppléments.',{n:priced,total:apiCalls})}</p>}
      </>}
      {result.index && <div className="ai-usage-index">
        <div><strong>{t('Indexation de l’espace')}</strong><span>{result.index.enabled?t('Activée'):t('Désactivée')}</span></div>
        <p>{t('{done} / {pages} pages traitées · {chunks} passages',{done:result.index.processed,pages:result.index.pages,chunks:result.index.passages})}</p>
      </div>}
    </>}
  </div>;
}

export function mountUsage(container:HTMLElement, workspace:WorkspaceRef, client:Pick<AiClient,'usage'>) {
  const root = createRoot(container);
  root.render(<UsagePanel workspace={workspace} client={client}/>);
  return () => root.unmount();
}

