import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ALL_LOCALE_CODES} from '../../src/components/i18n/locales/catalog';
import {afterEach, expect, it} from 'vitest';
import {initializeShellLanguage, languageOptions, rememberShellLanguage, savedLanguage, shellText} from './shell-i18n';

const directory = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const readCatalog = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(directory, file), 'utf8'));
const placeholders = (value: string) => (value.match(/\{[a-zA-Z_]\w*\}/g) ?? []).sort().join(' ');

afterEach(async () => {
  localStorage.clear();
  await initializeShellLanguage('fr');
});

it('restores a partial language and interpolates missing messages in English', async () => {
  rememberShellLanguage('nl');
  await initializeShellLanguage();
  expect(document.documentElement.lang).toBe('nl');
  expect(shellText('Langue')).toBe('Taal');
  expect(shellText('Paramètres de {v0}', {v0: 'Studio'})).toBe('Settings for Studio');
});

it('marks languages with missing desktop or editor messages as partial', async () => {
  await initializeShellLanguage('fr');
  const options = languageOptions('fr');
  expect(options.map(option => option.value).sort()).toEqual([...ALL_LOCALE_CODES].sort());
  const source = readCatalog('en.json');
  const editorDirectory = join(directory, '../../../src/components/i18n/locales');
  const readEditor = (file: string): Record<string, string> =>
    JSON.parse(readFileSync(join(editorDirectory, file), 'utf8'));
  const editorKeys = Object.keys(readEditor('en.json'));

  for (const {value: code, label} of options) {
    const catalog = readCatalog(code + '.json');
    const editor = readEditor(code + '.json');
    const complete = Object.keys(source).every(key => catalog[key]?.trim())
      && editorKeys.every(key => editor[key]?.trim());
    expect(label.endsWith(' (partiel)'), code + ' — refresh with scripts/i18n/desktop_coverage.py').toBe(!complete);
    const invalid = Object.entries(catalog).filter(([key, value]) =>
      !(key in source) || !value.trim() || placeholders(key) !== placeholders(value)
      || (value.includes('▁') && !key.includes('▁')));
    expect(invalid, code).toEqual([]);
  }
});

it('restores the saved language, interpolates page names and switches back to French', async () => {
  rememberShellLanguage('es');
  expect(savedLanguage()).toBe('es');
  await initializeShellLanguage();
  expect(document.documentElement.lang).toBe('es');
  expect(shellText('Accueil')).toBe('Inicio');
  expect(shellText('Paramètres de {v0}', {v0: 'Studio'})).toBe('Configuración de Studio');
  await initializeShellLanguage('en');
  expect(shellText('Accueil')).toBe('Home');
  expect(shellText('Month')).toBe('Month');
  await initializeShellLanguage('fr');
  expect(shellText('Accueil')).toBe('Accueil');
});

it('restores reading direction and distinguishes both Chinese scripts in the language picker', async () => {
  await initializeShellLanguage('ar');
  expect(document.documentElement.dir).toBe('rtl');
  await initializeShellLanguage('zh-TW');
  expect(document.documentElement.dir).toBe('ltr');
  const names = new Intl.DisplayNames(['fr'], {type: 'language'});
  const options = languageOptions('fr');
  expect(options.find(option => option.value === 'zh')?.description).toBe(names.of('zh-Hans'));
  expect(options.find(option => option.value === 'zh-TW')?.description).toBe(names.of('zh-Hant-TW'));
});
