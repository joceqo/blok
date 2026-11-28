// The chat and MCP transports use this read-only projection of a saved Blok database.
export interface DatabaseColumn { id:string; name:string; type:string; options:{id:string;label:string}[] }
export interface DatabaseInfo { page:string; pageTitle:string; id:string; title:string; columns:DatabaseColumn[] }
export interface DatabaseFilter { column:string; value:string }
export interface DatabaseQuery { page:string; database:string; filters:DatabaseFilter[]; offset?:number }
export interface DatabaseResult { title:string; total:number; rows:{id:string;title:string}[]; nextOffset?:number }
export class DatabaseInputError extends Error {}
const record = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const array = (v:unknown):unknown[] => Array.isArray(v) ? v : [];
const text = (v:unknown):string => typeof v==='string' ? v : array(v).map(s=>record(s) && typeof s.text==='string' ? s.text : '').join('');
export const folded = (s:string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const supported = new Set(['title','text','select','multiSelect','status','number','checkbox','email','url','phone']);
export function describeDatabases(page:string, pageTitle:string, blocks:unknown): DatabaseInfo[] {
  return array(blocks).filter(record).flatMap(b=>{
    if (b.type!=='database' || typeof b.id!=='string' || !record(b.data)) return [];
    const columns = array(b.data.schema).filter(record).flatMap(c=>{
      if (typeof c.id!=='string' || typeof c.type!=='string' || typeof c.name!=='string' || !supported.has(c.type)) return [];
      const options = array(record(c.config) && c.config.options).filter(record).flatMap(o=>
        typeof o.id==='string' && typeof o.label==='string' ? [{id:o.id,label:o.label}] : []);
      return [{id:c.id,name:c.name,type:c.type,options}];
    });
    return [{page,pageTitle,id:b.id,title:text(b.data.title) || pageTitle || 'Base sans titre',columns}];
  });
}

export function parseDatabaseQuery(v: unknown): DatabaseQuery {
  if (!record(v) || typeof v.page!=='string' || !v.page || typeof v.database!=='string' || !v.database ||
      !Array.isArray(v.filters) || v.filters.length>8 || !v.filters.every(f=>record(f) &&
      typeof f.column==='string' && typeof f.value==='string' && f.value.length<=1024) ||
      (v.offset!==undefined && !(typeof v.offset==='number' && Number.isSafeInteger(v.offset) && v.offset>=0)))
    throw new DatabaseInputError('Requête de base invalide.');
  return {page:v.page,database:v.database,filters:v.filters as DatabaseFilter[],offset:v.offset as number|undefined};
}

export function queryDatabase(info:DatabaseInfo, blocks:unknown, args:DatabaseQuery):DatabaseResult {
  const filters=args.filters.map(f=>{
    const col=info.columns.find(c=>c.id===f.column);
    if (!col) throw new DatabaseInputError('Colonne inconnue.');
    if (!['select','multiSelect','status'].includes(col.type)) return {col,value:folded(f.value)};
    const options=col.options.filter(o=>o.id===f.value || folded(o.label)===folded(f.value));
    if (options.length!==1) throw new DatabaseInputError('Option inconnue ou ambiguë.');
    return {col,value:options[0]!.id};
  });
  const titleId=info.columns.find(c=>c.type==='title')?.id;
  const offset=args.offset ?? 0;
  let total=0;
  const rows:DatabaseResult['rows']=[];
  for (const b of array(blocks)) {
    if (!record(b) || b.type!=='database-row' || b.parent!==info.id || typeof b.id!=='string' ||
        !record(b.data) || b.data.template===true) continue;
    const props=record(b.data.properties) ? b.data.properties : {};
    const title=text(b.data.title) || (titleId ? text(props[titleId]) : '');
    const match=filters.every(({col,value})=>{
      const raw=props[col.id];
      if (col.type==='multiSelect') return array(raw).includes(value);
      if (col.type==='status' || col.type==='select') return raw===value;
      const shown=col.type==='title' ? title : typeof raw==='number' || typeof raw==='boolean' ? String(raw) : text(raw);
      return folded(shown)===value;
    });
    if (!match) continue;
    if (total>=offset && rows.length<50) rows.push({id:b.id,title:title || 'Sans titre'});
    total++;
  }
  return {title:info.title,total,rows,...(offset+rows.length<total ? {nextOffset:offset+rows.length} : {})};
}
