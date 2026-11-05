/** Supported UI locales (M04, D18). Interface, content and legal-document language are stored separately. */
export const LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'uz-Latn';

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Localized text stored per locale; fallback chain never shows a raw key. */
export type LocalizedText = Partial<Record<Locale, string>>;

const FALLBACK: Record<Locale, Locale[]> = {
  'uz-Latn': ['uz-Latn', 'uz-Cyrl', 'ru'],
  'uz-Cyrl': ['uz-Cyrl', 'uz-Latn', 'ru'],
  ru: ['ru', 'uz-Latn', 'uz-Cyrl'],
};

export function pickText(t: LocalizedText | null | undefined, locale: Locale): string {
  if (!t) return '';
  for (const l of FALLBACK[locale]) {
    const v = t[l];
    if (v) return v;
  }
  return '';
}
