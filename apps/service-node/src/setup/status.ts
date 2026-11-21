/**
 * Pure setup gating — safe to unit test without HTTP or PostgreSQL.
 */

export function needsSetup(userCount: number): boolean {
  return userCount === 0;
}

export function canRunFirstAdminSetup(
  userCount: number,
  envSetupToken: string | undefined,
  bodyToken: string | undefined,
): boolean {
  if (userCount === 0) {
    return true;
  }
  if (envSetupToken === undefined || envSetupToken.length === 0) {
    return false;
  }
  return bodyToken === envSetupToken;
}