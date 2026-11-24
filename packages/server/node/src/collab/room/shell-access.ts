import type { RoomIdentity, RoomOptions } from './preview.ts';

interface Decision { read: boolean; write: boolean; session?: unknown; ticketWrite?: unknown }

/** The cloud service owns both the ticket signing key and the canonical session/page ACL. */
export function shellRoomTickets(serviceOrigin: string, internalSecret: string): RoomOptions['authorize'] {
  const endpoint = new URL(serviceOrigin);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Expected an internal cloud service origin');
  if (internalSecret.length < 32) throw new Error('Internal secret must contain at least 32 characters');
  endpoint.pathname = '/internal/room-access';

  async function check(body: { documentId: string; ticket?: string; session?: string }): Promise<Decision | null> {
    const response = await fetch(endpoint, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(2000),
      headers:{ Authorization:'Bearer '+internalSecret, 'Content-Type':'application/json' },
      body:JSON.stringify(body),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('read' in data) || data.read !== true ||
        !('write' in data) || typeof data.write !== 'boolean') return null;
    return data as Decision;
  }

  return async (ticket, documentId) => {
    const grant = await check({documentId,ticket});
    if (!grant || typeof grant.session !== 'string' || !/^[a-f0-9]{64}$/.test(grant.session) ||
        typeof grant.ticketWrite !== 'boolean') return null;
    const id = grant.session;
    const ticketWrite = grant.ticketWrite;
    const revalidate = async (): Promise<RoomIdentity | null> => {
      const access = await check({documentId,session:id});
      return access ? {id,write:ticketWrite && access.write} : null;
    };
    return {id,write:ticketWrite && grant.write,revalidate};
  };
}
