import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Three files must agree on the list of native commands, and nothing warns when
 * they drift: `generate_handler!` exposes a command, `build.rs` declares it so a
 * permission exists, and the capability grants that permission. Miss either of
 * the last two and the call is rejected at runtime — which the front end often
 * swallows (`local-sync-bridge.ts` drops broadcast failures on purpose), so the
 * feature just stops working in silence.
 */
const read = (relative: string): string =>
  readFileSync(join(process.cwd(), 'src-tauri', relative), 'utf8');

/** `ai::ai_local_save` is exposed under its bare name. */
const bareName = (entry: string): string => entry.trim().split('::').pop() ?? '';

function exposedCommands(): string[] {
  const handler = /generate_handler!\[([^\]]*)\]/.exec(read('src/lib.rs'));
  if (!handler) throw new Error('generate_handler! not found in lib.rs');

  return handler[1].split(',').map(bareName).filter((name) => name.length > 0);
}

function declaredCommands(): string[] {
  const commands = /\.commands\(&\[([\s\S]*?)\]\)/.exec(read('build.rs'));
  if (!commands) throw new Error('commands(&[...]) not found in build.rs');

  return [...commands[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function grantedPermissions(): string[] {
  return (JSON.parse(read('capabilities/default.json')) as { permissions: string[] }).permissions;
}

/** The permission tauri generates for a command: allow-snake-case-as-kebab. */
const permissionFor = (command: string): string => `allow-${command.replaceAll('_', '-')}`;

describe('native commands', () => {
  it('declares every exposed command in build.rs, so a permission exists for it', () => {
    const missing = exposedCommands().filter((name) => !declaredCommands().includes(name));

    expect(missing).toEqual([]);
  });

  it('grants every exposed command to the main window', () => {
    const granted = grantedPermissions();
    const ungranted = exposedCommands().filter((name) => !granted.includes(permissionFor(name)));

    expect(ungranted).toEqual([]);
  });

  it('reads the real lists, so the checks above cannot pass vacuously', () => {
    expect(exposedCommands()).toContain('collab_broadcast');
    expect(exposedCommands().length).toBeGreaterThan(10);
    expect(declaredCommands()).toContain('collab_broadcast');
    expect(grantedPermissions()).toContain('allow-collab-broadcast');
  });
});
