import type {Locale} from 'date-fns';
import {enUS} from 'date-fns/locale/en-US';
import {fr} from 'date-fns/locale/fr';
import type {SupportedLocale} from '../../types/configs/i18n-config';

const bundled: Partial<Record<SupportedLocale, () => Promise<Locale>>> = {
  'ar': () => import('date-fns/locale/ar').then(module => module.ar),
  'az': () => import('date-fns/locale/az').then(module => module.az),
  'bg': () => import('date-fns/locale/bg').then(module => module.bg),
  'bn': () => import('date-fns/locale/bn').then(module => module.bn),
  'bs': () => import('date-fns/locale/bs').then(module => module.bs),
  'cs': () => import('date-fns/locale/cs').then(module => module.cs),
  'da': () => import('date-fns/locale/da').then(module => module.da),
  'de': () => import('date-fns/locale/de').then(module => module.de),
  'el': () => import('date-fns/locale/el').then(module => module.el),
  'es': () => import('date-fns/locale/es').then(module => module.es),
  'et': () => import('date-fns/locale/et').then(module => module.et),
  'fa': () => import('date-fns/locale/fa-IR').then(module => module.faIR),
  'fi': () => import('date-fns/locale/fi').then(module => module.fi),
  'gu': () => import('date-fns/locale/gu').then(module => module.gu),
  'he': () => import('date-fns/locale/he').then(module => module.he),
  'hi': () => import('date-fns/locale/hi').then(module => module.hi),
  'hr': () => import('date-fns/locale/hr').then(module => module.hr),
  'hu': () => import('date-fns/locale/hu').then(module => module.hu),
  'hy': () => import('date-fns/locale/hy').then(module => module.hy),
  'id': () => import('date-fns/locale/id').then(module => module.id),
  'it': () => import('date-fns/locale/it').then(module => module.it),
  'ja': () => import('date-fns/locale/ja').then(module => module.ja),
  'ka': () => import('date-fns/locale/ka').then(module => module.ka),
  'km': () => import('date-fns/locale/km').then(module => module.km),
  'kn': () => import('date-fns/locale/kn').then(module => module.kn),
  'ko': () => import('date-fns/locale/ko').then(module => module.ko),
  'ku': () => import('date-fns/locale/ckb').then(module => module.ckb),
  'lt': () => import('date-fns/locale/lt').then(module => module.lt),
  'lv': () => import('date-fns/locale/lv').then(module => module.lv),
  'mk': () => import('date-fns/locale/mk').then(module => module.mk),
  'mn': () => import('date-fns/locale/mn').then(module => module.mn),
  'ms': () => import('date-fns/locale/ms').then(module => module.ms),
  'nl': () => import('date-fns/locale/nl').then(module => module.nl),
  'no': () => import('date-fns/locale/nb').then(module => module.nb),
  'pl': () => import('date-fns/locale/pl').then(module => module.pl),
  'pt': () => import('date-fns/locale/pt').then(module => module.pt),
  'ro': () => import('date-fns/locale/ro').then(module => module.ro),
  'ru': () => import('date-fns/locale/ru').then(module => module.ru),
  'sk': () => import('date-fns/locale/sk').then(module => module.sk),
  'sl': () => import('date-fns/locale/sl').then(module => module.sl),
  'sq': () => import('date-fns/locale/sq').then(module => module.sq),
  'sr': () => import('date-fns/locale/sr').then(module => module.sr),
  'sv': () => import('date-fns/locale/sv').then(module => module.sv),
  'ta': () => import('date-fns/locale/ta').then(module => module.ta),
  'te': () => import('date-fns/locale/te').then(module => module.te),
  'th': () => import('date-fns/locale/th').then(module => module.th),
  'tr': () => import('date-fns/locale/tr').then(module => module.tr),
  'ug': () => import('date-fns/locale/ug').then(module => module.ug),
  'uk': () => import('date-fns/locale/uk').then(module => module.uk),
  'vi': () => import('date-fns/locale/vi').then(module => module.vi),
  'zh': () => import('date-fns/locale/zh-CN').then(module => module.zhCN),
  'zh-TW': () => import('date-fns/locale/zh-TW').then(module => module.zhTW),
};

// Some shell languages have no date-fns pack. The OS can still name days and months.
export function initialCalendarLocale(code: SupportedLocale): Locale {
  if (code === 'fr') return fr;
  if (code === 'en') return enUS;
  const tag = code === 'ku' ? 'ckb' : code;
  const labels = new Map<string, Intl.DateTimeFormat>();
  function name(unit: 'month' | 'weekday', width: string | undefined, date: Date) {
    const length = width === 'narrow' ? 'narrow' : width === 'wide' ? 'long' : 'short';
    const key = unit + length;
    let formatter = labels.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(tag, {[unit]: length, calendar: 'gregory', timeZone: 'UTC'});
      labels.set(key, formatter);
    }
    return formatter.format(date);
  }
  return {...enUS, code: tag, localize: {...enUS.localize,
    month: (month, options) => name('month', options?.width, new Date(Date.UTC(2023, month, 1))),
    day: (day, options) => name('weekday', options?.width, new Date(Date.UTC(2023, 0, day + 1))),
  }};
}

export const loadCalendarLocale = (code: SupportedLocale) => bundled[code]?.();
