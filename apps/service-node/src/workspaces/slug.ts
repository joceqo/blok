/** URL slug from a display name — ASCII fallback, not full Go IDNA parity yet. */
export function slugFromName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length >= 2) {
    return base.slice(0, 128);
  }
  return `ws-${Date.now().toString(36)}`;
}