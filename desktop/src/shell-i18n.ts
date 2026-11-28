import {createInstance} from 'i18next';
import type {I18n} from '../../types/api/i18n';
import type {SupportedLocale} from '../../types/configs/i18n-config';
import {ALL_LOCALE_CODES, getDirection, loadLocale, normalizeLocale} from '../../src/components/i18n/locales/catalog';
import french from '../../src/components/i18n/locales/fr.json';
import english from '../../src/components/i18n/locales/english-full';
import completeLocales from './complete-locales.json';

const messages = createInstance();
const preference = 'blok:desktop:language';
const catalogs = import.meta.glob<Record<string, string>>('./locales/*.json', {import: 'default'});
const offeredLocales = ALL_LOCALE_CODES.filter(code => code === 'fr' || './locales/' + code + '.json' in catalogs);
let active: SupportedLocale = 'fr';
void messages.init({
  initAsync: false, lng: active, fallbackLng: 'en', keySeparator: false, nsSeparator: false,
  resources: {fr: {translation: french}, en: {translation: english}},
  interpolation: {prefix: '{', suffix: '}', escapeValue: false},
});

export function savedLanguage(): SupportedLocale {
  try {
    const code = normalizeLocale(localStorage.getItem(preference) ?? 'fr');
    return code && offeredLocales.includes(code) ? code : 'fr';
  }
  catch { return 'fr'; }
}

const languageNameTags: Partial<Record<SupportedLocale, string>> = {
  ku: 'ckb',
  zh: 'zh-Hans',
  'zh-TW': 'zh-Hant-TW',
};

export const languageOptions = (locale: SupportedLocale) => {
  const displayLocale = languageNameTags[locale] ?? locale;
  const names = new Intl.DisplayNames([displayLocale], {type: 'language'});
  const partialLabel = messages.t('(partiel)', {lng: locale, ns: 'shell', defaultValue: '(partiel)'});
  return offeredLocales.map(value => {
    const tag = languageNameTags[value] ?? value;
    const native = new Intl.DisplayNames([tag], {type: 'language'});
    const name = native.of(tag) ?? tag;
    const label = completeLocales.includes(value) ? name : name + ' ' + partialLabel;
    return {value, label, description: names.of(tag)};
  }).sort((a, b) => a.label.localeCompare(b.label, displayLocale));
};

export async function initializeShellLanguage(locale = savedLanguage()): Promise<void> {
  const [core, shell, fallback] = await Promise.all([
    loadLocale(locale),
    catalogs['./locales/' + locale + '.json']?.(),
    locale !== 'en' && !messages.hasResourceBundle('en', 'shell') ? catalogs['./locales/en.json']() : undefined,
  ]);
  if (fallback) messages.addResourceBundle('en', 'shell', fallback);
  messages.addResourceBundle(locale, 'translation', core.dictionary);
  if (shell) messages.addResourceBundle(locale, 'shell', shell);
  await messages.changeLanguage(locale);
  active = locale;
  document.documentElement.lang = locale;
  document.documentElement.dir = getDirection(locale);
}

export function rememberShellLanguage(locale: SupportedLocale): void {
  localStorage.setItem(preference, locale);
}
export const shellLocale = (): SupportedLocale => active;

// Only authored UI messages go through this namespace. Values are interpolated after translation.
export const shellText = (source: string, values?: Record<string, unknown>): string =>
  messages.t(source, {...values, ns: 'shell', defaultValue: source});

export const shellI18n: I18n = {
  t: (key, vars) => messages.t(key, vars),
  has: key => messages.exists(key),
  getLocale: shellLocale,
  getEnglishTranslation: key => english[key] ?? '',
};
