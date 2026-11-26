import { createCalendarWorkspaces, workspaceColors, type CalendarWorkspaces } from './calendar-workspaces';
import { CloudClient } from './cloud/client';
import { nativeBridge, deviceWorkspaces } from './native-runtime';
import { nativeSessionAdapter } from './native-session';
import { listWorkspaces, workspaceKey, type WorkspaceRef } from './workspace-registry';

const accountKey = (ref: WorkspaceRef) =>
  ref.kind === 'local' ? 'disk' : JSON.stringify([ref.server, ref.accountId]);

/** Discover memberships using each account's own session. UI keys include the
 * origin and account, while preference writes still use the server's actual IDs. */
export function createCalendarDirectory(current: WorkspaceRef): CalendarWorkspaces {
  type Account = { model: CalendarWorkspaces; token?: string | null };
  const accounts = new Map<string, Account>();
  const unavailable = new Map<string, WorkspaceRef[]>();
  const entries = () => {
    const all = Array.from(accounts.values()).flatMap(({model}) =>
      model.entries().map(entry => ({...entry, id: workspaceKey(entry.ref)})));
    const selected = new Set(all.filter(entry => entry.connected).map(entry => entry.id));
    const colors = workspaceColors(all.map(entry => entry.id), id => selected.has(id));
    return all.map(entry => ({...entry, color:colors.get(entry.id)!}));
  };

  function locate(id: string) {
    const entry = entries().find(entry => entry.id === id);
    if (!entry) throw new Error('Cet espace est indisponible.');
    return { model: accounts.get(accountKey(entry.ref))!.model, id: entry.ref.id };
  }

  return {
    activeId: workspaceKey(current), entries, unavailable: () => Array.from(unavailable.values()).flat(),
    async refresh(onAccountReady) {
      const groups = new Map<string, WorkspaceRef[]>();
      const native = !!nativeBridge();
      for (const ref of [current, ...listWorkspaces()]) {
        if (!native && current.kind === 'remote' && (ref.kind === 'local' || ref.embedded)) continue;
        const key = accountKey(ref);
        const group = groups.get(key) ?? [];
        if (!group.some(item => workspaceKey(item) === workspaceKey(ref))) group.push(ref);
        groups.set(key, group);
      }
      for (const key of accounts.keys()) if (!groups.has(key)) accounts.delete(key);
      for (const key of unavailable.keys()) if (!groups.has(key)) unavailable.delete(key);
      await Promise.all(Array.from(groups, async ([key, refs]) => {
        const ref = refs[0]!;
        try {
          let token: string | null | undefined;
          let rememberVerified: (() => Promise<void>) | undefined;
          if (native && ref.kind === 'remote') {
            if (ref.device && key !== accountKey(current)) {
              token = accounts.get(key)?.token;
              if (!token) {
                const device = await deviceWorkspaces();
                if (device.origin !== ref.server || device.result.user.id !== ref.accountId) throw new Error();
                token = device.result.token;
              }
            } else {
              const adapter = nativeSessionAdapter(ref.server);
              token = await adapter.getAccountToken?.(ref.accountId);
              if (!token) {
                token = await adapter.getToken();
                if (token && adapter.setAccountToken)
                  rememberVerified = () => adapter.setAccountToken!(ref.accountId, token!);
              }
            }
            if (!token) throw new Error();
          }
          let account = accounts.get(key);
          if (!account || account.token !== token) {
            const client = ref.kind === 'remote' && token ? new CloudClient({
              origin: ref.server, sessionAdapter: { getToken: async () => token!, setToken: async () => { throw new Error('Session en lecture seule.'); } },
            }) : undefined;
            account = {model:createCalendarWorkspaces(ref, key === accountKey(current), client), token};
          }
          await account.model.refresh();
          await rememberVerified?.();
          accounts.set(key, account);
          unavailable.delete(key);
        } catch {
          accounts.delete(key);
          unavailable.set(key, refs);
        }
        onAccountReady?.();
      }));
    },
    async connect(id) { const target = locate(id); await target.model.connect(target.id); },
    async disconnect(id) { const target = locate(id); await target.model.disconnect(target.id); },
    async setVisible(id, visible) { const target = locate(id); await target.model.setVisible(target.id, visible); },
    async pages(id) { const target = locate(id); return target.model.pages(target.id); },
  };
}
