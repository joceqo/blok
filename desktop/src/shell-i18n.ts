import {createInstance} from 'i18next';
import type {I18n} from '../../types/api/i18n';
import french from '../../src/components/i18n/locales/fr.json';
import english from '../../src/components/i18n/locales/english-full';

// The French shell also mounts database views before an editor has been opened.
const messages = createInstance();
void messages.init({
  initAsync: false, lng: 'fr', fallbackLng: 'en', keySeparator: false, nsSeparator: false,
  resources: {fr: {translation: french}, en: {translation: english}},
  interpolation: {prefix: '{', suffix: '}', escapeValue: false},
});
export const shellI18n: I18n = {
  t: (key, vars) => messages.t(key, vars),
  has: key => messages.exists(key),
  getLocale: () => 'fr',
  getEnglishTranslation: key => english[key] ?? '',
};
