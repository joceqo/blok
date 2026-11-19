const SLUG_MAX_LEN = 128;
const SLUG_MIN_LEN = 2;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type WorkspaceSlugValidation =
  | { ok: true; slug: string }
  | { ok: false; reason: 'invalid_slug' | 'slug_too_short' | 'slug_too_long' };

/** User-provided slug — lowercase alphanumeric segments separated by hyphens. */
export function validateWorkspaceSlug(raw: string): WorkspaceSlugValidation {
  const slug = raw.trim();
  if (slug.length === 0 || slug !== slug.toLowerCase()) {
    return { ok: false, reason: 'invalid_slug' };
  }
  if (slug.length < SLUG_MIN_LEN) {
    return { ok: false, reason: 'slug_too_short' };
  }
  if (slug.length > SLUG_MAX_LEN) {
    return { ok: false, reason: 'slug_too_long' };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return { ok: false, reason: 'invalid_slug' };
  }
  return { ok: true, slug };
}

/** URL slug from a display name — ASCII fallback, not full Go IDNA parity yet. */
export function slugFromName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length >= 2) {
    return base.slice(0, SLUG_MAX_LEN);
  }
  return `ws-${Date.now().toString(36)}`;
}