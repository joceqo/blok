const pending = new Map<string, string>();

/** Retain only a fingerprint and an operation ID while an import is unacknowledged. */
export async function markdownImportAttempt(workspace: string, name: string, source: string | ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', typeof source === 'string' ? new TextEncoder().encode(JSON.stringify([name,source])) : source);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `blok:desktop:markdown-import:${workspace}:${typeof source === 'string' ? hash : JSON.stringify([name,hash])}`;
  let id = pending.get(key);
  if (!id) {
    try { id = sessionStorage.getItem(key) || undefined; } catch { /* Use this window's in-memory attempt. */ }
    id ??= crypto.randomUUID();
    pending.set(key, id);
    try { sessionStorage.setItem(key, id); } catch { /* Keep the in-memory attempt. */ }
  }
  return {id, complete() {
    pending.delete(key);
    try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  }};
}
