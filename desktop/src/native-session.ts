<<<<<<< HEAD
import { serverOrigin } from './workspace-registry';
type Bridge = { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
let deviceSession: {origin: string; token: string} | undefined;

/** Set only from a validated Tauri response during device bootstrap. */
export function bindDeviceSession(origin: string, token: string): void {
  deviceSession = {origin, token};
}

/** Never fall back to localStorage for a native bearer credential. */
export function nativeSessionAdapter(server: string) {
  const origin = serverOrigin(server);
  const bridge = (window as Window & { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;
  if (!bridge) throw new Error('Le stockage sécurisé nécessite l’application native');
  if (deviceSession?.origin === origin) {
    const token = deviceSession.token;
    return {
      async getToken() { return token; },
      async setToken() { throw new Error('Le profil de cet appareil est géré par Blok.'); },
    };
  }
  return {
    async getToken(): Promise<string | null> { return await bridge.invoke('load_cloud_session', { server: origin }) as string | null; },
    async getAccountToken(account: string) {
      return await bridge.invoke('load_cloud_session', {server:origin, account}) as string | null;
    },
    async setAccountToken(account: string, token: string | null) {
      await bridge.invoke('save_cloud_session', {server:origin, account, token});
    },
    async setToken(token: string | null): Promise<void> { await bridge.invoke('save_cloud_session', { server: origin, token }); },
  };
}
||||||| f8ef3c6b39
=======
import { serverOrigin } from './workspace-registry';
type Bridge = { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
/** Never fall back to localStorage for a native bearer credential. */
export function nativeSessionAdapter(server: string) {
  const origin = serverOrigin(server);
  const bridge = (window as Window & { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;
  if (!bridge) throw new Error('Le stockage sécurisé nécessite l’application native');
  return {
    async getToken(): Promise<string | null> { return await bridge.invoke('load_cloud_session', { server: origin }) as string | null; },
    async setToken(token: string | null): Promise<void> { await bridge.invoke('save_cloud_session', { server: origin, token }); },
  };
}
>>>>>>> origin/fix/self-host-review
