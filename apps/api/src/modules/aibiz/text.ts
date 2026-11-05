/** Text helpers for the business assistant: Cyrillic→Latin Uzbek, matching form, PII masking for stored chat text. */
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h',
};

export function toLatin(s: string): string {
  return [...s].map((ch) => {
    const low = ch.toLowerCase();
    const t = CYR[low];
    return t === undefined ? ch : t;
  }).join('');
}

/** Lower-case Latin with all apostrophe variants removed: «Oʻtgan haftа» → «otgan hafta». Used only for matching. */
export function matchForm(s: string): string {
  return toLatin(s).toLowerCase().replace(/[ʻʼ‘’`´'"]/g, '').replace(/[«»“”?!,;:()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Mask phones, cards and e-mails before a chat line is stored (the question itself is not needed with PII). */
export function redact(s: string): string {
  return s
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[karta]')
    .replace(/\+?\d[\d\s\-()]{8,}\d/g, '[telefon]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .slice(0, 500);
}
