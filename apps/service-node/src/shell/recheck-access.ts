// The shell and the process that owns the live collaboration sockets share
// a network namespace. The internal credential may only travel over loopback.
export function createAccessRecheck(secret: string) {
  return async (workspaceId: string): Promise<void> => {
    await recheck(secret, '/internal/workspaces/' + encodeURIComponent(workspaceId) + '/recheck-access');
  };
}

export function recheckLiveSessions(secret: string) {
  return recheck(secret, '/internal/sessions/recheck-access');
}

async function recheck(secret: string, path: string) {
  const response = await fetch(new URL(path, 'http://127.0.0.1:8080'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 204) {
    throw new Error('Live collaboration access recheck failed with status ' + response.status);
  }
}
