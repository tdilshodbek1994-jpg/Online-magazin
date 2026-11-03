import { normalizeSearch, normalizeUzPhone, tokenize } from '@om/shared';

/**
 * Rule-based "paste the customer's message → draft fields" (V2 §06). No AI needed; nothing is invented:
 * every value carries the snippet it came from and a confidence; ambiguous values are flagged "check".
 * The partner always reviews before anything is submitted.
 */
export type Confidence = 'high' | 'check';
export interface Field<T> { value: T; confidence: Confidence; snippet: string; note?: string }
export interface CatalogItem { product_id: string; slug: string; name: Record<string, string>; search_doc: string; skus: { sku_id: string; variant: Record<string, string>; available: number }[] }
export interface ParseResult {
  product?: Field<{ product_id: string; slug: string; name: Record<string, string> }>;
  sku?: Field<{ sku_id: string; variant: Record<string, string> }>;
  qty?: Field<number>;
  phone?: Field<string>;
  contact_time?: Field<string>;
  address_later?: Field<boolean>;
  alternatives?: { product_id: string; name: Record<string, string> }[];
  warnings: string[];
}

const STOP = new Set(['shu', 'bu', 'dan', 'ta', 'dona', 'kerak', 'menga', 'iltimos', 'salom', 'assalomu', 'alaykum', 'olaman', 'bering', 'qiling', 'keyin', 'soat', 'manzil', 'manzilni', 'yuboraman', 'telefon', 'raqam', 'qo\'ng\'iroq', 'va', 'ham', 'bilan', 'uchun', 'rangli', 'ranglisidan', 'rangidan', 'ni', 'ga', 'da']);

const COLOR_STEMS: [string, string][] = [['qora', 'qora'], ['oq', 'oq'], ["ko'k", "ko'k"], ['kok', "ko'k"], ['qizil', 'qizil'], ['yashil', 'yashil'], ['sariq', 'sariq'], ['kulrang', 'kulrang'], ['pushti', 'pushti'], ['jigarrang', 'jigarrang'], ['binafsha', 'binafsha']];

function snippetAround(text: string, idx: number, len: number): string {
  const s = Math.max(0, idx - 12), e = Math.min(text.length, idx + len + 12);
  return (s > 0 ? '…' : '') + text.slice(s, e).trim() + (e < text.length ? '…' : '');
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Colour stems must start a word ("oq" must not match inside "qo'ng'iroq"); suffixes like "qorasidan" are fine. */
const wordStart = (text: string, stem: string) => new RegExp(`(^|[^a-z0-9'ʻʼ‘’])${esc(stem)}`).test(text);

export function parseMessage(raw: string, catalog: CatalogItem[]): ParseResult {
  const text = raw.slice(0, 2000);
  const norm = normalizeSearch(text);
  const out: ParseResult = { warnings: [] };

  // Phone: only accept numbers that normalise to a valid UZ E.164; never guess missing digits.
  const phoneRe = /(\+?\s*998[\s\-()]*)?\(?\d{2}\)?[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
  for (const m of text.matchAll(phoneRe)) {
    const p = normalizeUzPhone(m[0]);
    if (p) { out.phone = { value: p, confidence: 'high', snippet: m[0].trim() }; break; }
  }

  // Quantity: "2 ta", "2та", "2 dona", "x2". A bare number is not treated as quantity.
  const qtyM = /(\d{1,2})\s*(ta|dona|dana|шт|x)\b/i.exec(norm) ?? /\bx\s*(\d{1,2})\b/i.exec(norm);
  if (qtyM) {
    const q = Number(qtyM[1]);
    if (q >= 1 && q <= 50) out.qty = { value: q, confidence: 'high', snippet: snippetAround(norm, qtyM.index, qtyM[0].length) };
  }

  // Address explicitly postponed by the customer.
  const addrLater = /manzil\w*\s+(keyin|keyinroq|ertaga)|manzilni\s+\S+\s+(keyin|yuboraman)/.exec(norm);
  if (addrLater) out.address_later = { value: true, confidence: 'high', snippet: snippetAround(norm, addrLater.index, addrLater[0].length), note: 'Manzil keyin aniqlanadi — buyurtma jo‘natishga tayyor hisoblanmaydi' };

  // Contact time: keep the customer's words; "soat 6" is ambiguous (06:00 vs 18:00) unless a part of day is stated.
  const timeM = /(soat\s*\d{1,2}([:.]\d{2})?(\s*(dan|da|ga)\s*(keyin|oldin)?)?|(ertalab|kechqurun|kechki|tushdan\s+keyin|abetdan\s+keyin)[^.,;]*)/.exec(norm);
  if (timeM) {
    const t = timeM[0].trim();
    const hour = /(\d{1,2})/.exec(t)?.[1];
    const partOfDay = /(ertalab|kechqurun|kechki|tushdan|abetdan)/.test(norm);
    const sure = partOfDay || (hour !== undefined && Number(hour) >= 13);
    out.contact_time = { value: t, confidence: sure ? 'high' : 'check', snippet: snippetAround(norm, timeM.index, t.length), note: sure ? undefined : `«${t}» — ertalabmi yoki kechqurunmi? Mijoz bilan aniqlang.` };
  }

  // Product: token overlap with catalog search docs; a single clear winner is "high", otherwise "check" with alternatives.
  const words = tokenize(text).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  const scored = catalog.map((c) => {
    const doc = c.search_doc;
    let score = 0;
    for (const w of words) if (doc.includes(w)) score += w.length >= 5 ? 2 : 1;
    return { c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (scored.length) {
    const best = scored[0]!;
    const clear = best.score >= 2 && (scored.length === 1 || best.score >= (scored[1]?.score ?? 0) + 2);
    const hitWord = words.find((w) => best.c.search_doc.includes(w)) ?? '';
    const at = norm.indexOf(hitWord);
    out.product = { value: { product_id: best.c.product_id, slug: best.c.slug, name: best.c.name }, confidence: clear ? 'high' : 'check', snippet: at >= 0 ? snippetAround(norm, at, hitWord.length) : hitWord,
      note: clear ? undefined : 'Mahsulot aniq emas — ro‘yxatdan tekshiring' };
    if (!clear) out.alternatives = scored.slice(0, 4).map((x) => ({ product_id: x.c.product_id, name: x.c.name }));
    // Variant: colour/size words that literally appear in one variant of the chosen product.
    const vScores = best.c.skus.map((s) => {
      const vals = Object.values(s.variant).map((v) => normalizeSearch(v));
      let hit = '';
      for (const v of vals) {
        if (v.length <= 3 ? new RegExp(`(^|[^a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(norm) : norm.includes(v)) hit = v;
        for (const [stem, canon] of COLOR_STEMS) if (wordStart(norm, stem) && v.includes(canon)) hit = v;
      }
      return { s, hit };
    }).filter((x) => x.hit);
    if (vScores.length === 1) {
      const v = vScores[0]!;
      out.sku = { value: { sku_id: v.s.sku_id, variant: v.s.variant }, confidence: 'high', snippet: snippetAround(norm, Math.max(0, norm.indexOf(v.hit.slice(0, 4))), v.hit.length) };
      if (v.s.available <= 0) out.warnings.push('Tanlangan variant hozir omborda yo‘q');
    } else if (best.c.skus.length === 1) {
      out.sku = { value: { sku_id: best.c.skus[0]!.sku_id, variant: best.c.skus[0]!.variant }, confidence: 'high', snippet: '(yagona variant)' };
    } else {
      out.warnings.push('Variant (rang/o‘lcham) aniqlanmadi — tanlang');
    }
  } else {
    out.warnings.push('Mahsulot topilmadi — katalogdan tanlang');
  }
  if (!out.phone) out.warnings.push('Telefon raqami topilmadi');
  return out;
}
