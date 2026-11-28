export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (obj: Record<string, unknown>, ...allowed: string[]) => Object.keys(obj).every(k => allowed.includes(k));
export function modelId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id);
}
export function textModel(id: unknown): id is string {
  return modelId(id) && /^(?:ft:)?(?:gpt-|o[1-9])/.test(id) &&
    !/embedding|tts|audio|whisper|image|dall-e|realtime|transcrib|transcrip|moderation|sora/i.test(id);
}
const functions = new Set(['blok_read','blok_describe','blok_execute']);

export function editorItem(item: unknown, reply: boolean): boolean {
  if (!object(item)) return false;
  switch (item.type) {
    case undefined:
    case 'message':
      return keys(item,'type','id','status','phase','role','content') &&
        (item.role === 'assistant' || (!reply && item.role === 'user')) &&
        (typeof item.content === 'string' || (Array.isArray(item.content) && item.content.length > 0 && item.content.every(p =>
          object(p) && (p.type === 'refusal'
            ? keys(p,'type','refusal') && typeof p.refusal === 'string'
            : (p.type === 'input_text' || p.type === 'output_text') && keys(p,'type','text','annotations','logprobs') && typeof p.text === 'string'))));
    case 'function_call':
      return keys(item,'type','call_id','name','arguments','id','status') && typeof item.name === 'string' &&
        functions.has(item.name) && typeof item.call_id === 'string' && !!item.call_id && typeof item.arguments === 'string';
    case 'function_call_output':
      return !reply && keys(item,'type','call_id','output','id','status') && typeof item.call_id === 'string' &&
        !!item.call_id && typeof item.output === 'string';
    case 'reasoning':
      return keys(item,'type','id','encrypted_content','summary','content','status') &&
        (item.encrypted_content != null || item.summary != null || item.content != null) &&
        (item.encrypted_content == null || typeof item.encrypted_content === 'string') &&
        ['summary','content'].every(k => item[k] == null || (Array.isArray(item[k]) && item[k].every(p =>
          object(p) && keys(p,'type','text') && typeof p.text === 'string' && p.type === (k === 'summary' ? 'summary_text' : 'reasoning_text'))));
    default: return false;
  }
}

export function editorRequest(input: Record<string, unknown>) {
  if (!keys(input,'model','instructions','input','tools','store','stream','reasoning','include','max_output_tokens') ||
      !textModel(input.model) || typeof input.instructions !== 'string' ||
      !['store','stream'].every(k => !(k in input) || input[k] === false) ||
      !Array.isArray(input.input) || !input.input.length || input.input.length > 256 || !input.input.every(v => editorItem(v,false)) ||
      !Array.isArray(input.tools) || input.tools.length > 3) return false;
  if ('reasoning' in input && !(object(input.reasoning) && keys(input.reasoning,'effort') &&
      ['none','minimal','low','medium','high','xhigh','max'].includes(String(input.reasoning.effort)))) return false;
  if ('include' in input && !(Array.isArray(input.include) && input.include.length === 1 && input.include[0] === 'reasoning.encrypted_content')) return false;
  const names = new Set<string>();
  return input.tools.every(t => {
    if (!object(t) || !keys(t,'type','name','description','parameters','strict') || t.type !== 'function' ||
        typeof t.name !== 'string' || !functions.has(t.name) || names.has(t.name) || typeof t.description !== 'string' ||
        !object(t.parameters) || t.parameters.type !== 'object' || ('strict' in t && typeof t.strict !== 'boolean')) return false;
    names.add(t.name);
    return true;
  });
}
