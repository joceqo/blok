// All rooms share a listener. Recheck every connected identity on membership,
// sharing or session changes; an inactive socket also loses its permissions.
export function createAccessRecheck(secret: string) {
  return async (_workspaceId: string): Promise<void> => recheckLiveSessions(secret);
}

export async function recheckLiveSessions(secret: string) {
  const response = await fetch(new URL('http://127.0.0.1:18102/internal/room/recheck-access'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 204) throw new Error('Live collaboration access recheck failed with status '+response.status);
}
