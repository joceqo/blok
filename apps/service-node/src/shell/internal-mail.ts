// Only the local Go process holds mail-provider credentials. Paths and redirects
// cannot move the internal bearer to a different origin.
export function createInternalMailTransport(secret: string) {
  return (path: string, body: object): Promise<Response> => {
    const endpoint = new URL('http://127.0.0.1:8080');
    endpoint.pathname = path;
    if (!endpoint.pathname.startsWith('/internal/')) throw new Error('Internal mail route required');
    return fetch(endpoint.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
}
