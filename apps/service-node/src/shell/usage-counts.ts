/** Normalize Responses and Embeddings usage. Cached input is already included in input. */
export function tokenCounts(value:unknown) {
  const count=(n:unknown) => typeof n==='number' && Number.isSafeInteger(n) && n>=0 ? n : undefined;
  const raw = (value && typeof value==='object' ? value : {}) as Record<string,unknown>;
  const embedding = raw.prompt_tokens !== undefined && raw.output_tokens === undefined;
  const input = count(embedding ? raw.prompt_tokens : raw.input_tokens);
  const output = embedding ? 0 : count(raw.output_tokens);
  const details = raw.input_tokens_details as {cached_tokens?:unknown} | undefined;
  const cached = count(details?.cached_tokens ?? 0);
  const detailed = input!==undefined && output!==undefined && cached!==undefined && cached<=input;
  const total = count(raw.total_tokens) ?? (detailed ? input+output : undefined);
  return {tokens:total??0,measured:Number(total!==undefined),detailed:Number(detailed),
    input:detailed?input:0,output:detailed?output:0,cached:detailed?cached:0};
}
