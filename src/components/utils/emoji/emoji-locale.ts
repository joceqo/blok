// src/components/utils/emoji/emoji-locale.ts

/**
 * Entry shape for a single emoji in a locale file.
 * `n` = translated name, `k` = translated keywords (optional).
 */
export interface EmojiLocaleEntry {
  n: string;
  k?: string[];
}

/**
 * Map from native emoji character to its locale entry.
 */
export type EmojiLocaleData = Record<string, EmojiLocaleEntry>;

/**
 * Module-level cache: locale code -> loaded data.
 */
const cache = new Map<string, EmojiLocaleData>();

/**
 * In-flight loads by locale, so concurrent callers share one import.
 * Dropped once settled: a failed load caches nothing, so a later call retries.
 */
const pending = new Map<string, Promise<EmojiLocaleData | null>>();

/**
 * Locales that have a data file.
 * 65 non-English locales; English needs no data, CLDR lacks dv and yi,
 * and its `ku` annotations are Kurmanji rather than this product's Sorani.
 */
const LOCALES_WITH_DATA = new Set([
  'am', 'ar', 'az', 'bg', 'bn', 'bs', 'cs', 'da', 'de', 'el', 'es', 'et', 'fa', 'fi', 'fil',
  'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'it', 'ja', 'ka', 'km', 'kn', 'ko', 'lo',
  'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'my', 'ne', 'nl', 'no', 'pa', 'pl', 'ps', 'pt',
  'ro', 'ru', 'sd', 'si', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'ug',
  'uk', 'ur', 'vi', 'zh', 'zh-TW',
]);

/**
 * Loads one locale's JSON. The specifier is built from `locale` rather than
 * written out 65 times, so TypeScript never resolves the files themselves:
 * typing them costs ~200k types, 42% of the program's memory and time.
 * Vite still maps every file in the folder, so each locale stays its own lazy
 * chunk and the build-time locale codec still sees them as it did.
 */
const importLocaleFile = (locale: string): Promise<{ default: EmojiLocaleData }> =>
  import(`./locales/${locale}.json`) as Promise<{ default: EmojiLocaleData }>;

/**
 * Lazy-load and cache locale data.
 * Returns null for 'en' (no translation needed) or unsupported locales.
 */
export async function loadEmojiLocale(locale: string): Promise<EmojiLocaleData | null> {
  if (locale === 'en') {
    return null;
  }

  const cached = cache.get(locale);

  if (cached !== undefined) {
    return cached;
  }

  if (!LOCALES_WITH_DATA.has(locale)) {
    return null;
  }

  const inFlight = pending.get(locale);

  if (inFlight !== undefined) {
    return inFlight;
  }

  const load = importLocale(locale, () => importLocaleFile(locale)).finally(() => {
    pending.delete(locale);
  });

  pending.set(locale, load);

  return load;
}

async function importLocale(
  locale: string,
  importer: () => Promise<{ default: EmojiLocaleData }>
): Promise<EmojiLocaleData | null> {
  try {
    const module = await importer();
    const data = module.default;

    cache.set(locale, data);

    return data;
  } catch {
    return null;
  }
}

/**
 * Look up a translated name from the cache.
 * Returns null if the locale isn't loaded or the emoji isn't in the data.
 */
export function getTranslatedName(native: string, locale: string): string | null {
  const data = cache.get(locale);

  if (data === undefined) {
    return null;
  }

  const entry = data[native];

  if (entry === undefined) {
    return null;
  }

  return entry.n;
}

/**
 * Look up translated keywords from the cache.
 * Returns null if the locale isn't loaded, the emoji isn't in the data, or no keywords exist.
 */
export function getTranslatedKeywords(native: string, locale: string): string[] | null {
  const data = cache.get(locale);

  if (data === undefined) {
    return null;
  }

  const entry = data[native];

  if (entry === undefined) {
    return null;
  }

  return entry.k ?? null;
}
