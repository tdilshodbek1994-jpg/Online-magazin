/**
 * Search normalization (M07): Uzbek Cyrillic -> Latin transliteration, apostrophe variants unified,
 * lowercase. Numbers and model tokens are preserved verbatim (128 != 256).
 */
const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q',
  ғ: "g'", ҳ: 'h',
};

const APOSTROPHES = /[‘’ʻʼ`´]/g;

export function normalizeSearch(input: string): string {
  const lower = input.toLowerCase().normalize('NFC').replace(APOSTROPHES, "'");
  let out = '';
  for (const ch of lower) out += CYR_TO_LAT[ch] ?? ch;
  return out.replace(/\s+/g, ' ').trim();
}

export function tokenize(input: string): string[] {
  return normalizeSearch(input)
    .split(/[^a-z0-9'а-яё]+/i)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** Slug for URLs (ASCII latin). */
export function slugify(input: string): string {
  return normalizeSearch(input)
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
