import { matchForm } from './text.js';

/**
 * Deterministic question → registry tool. The model (when enabled later) may only propose the same tool names and
 * argument shapes; identity/scope is never part of the arguments. Questions about other partners, customer contacts or
 * secrets are refused BEFORE any query runs.
 */
export type Tool =
  | 'partner_earnings_summary' | 'partner_orders_count' | 'partner_rejections' | 'partner_wallet_snapshot' | 'partner_best_day'
  | 'partner_top_products' | 'partner_flows_performance' | 'partner_uzcoin_summary' | 'partner_level' | 'partner_quality_cases'
  | 'partner_charity_summary' | 'partner_contest_status' | 'public_bestsellers';

export type Intent =
  | { kind: 'tool'; tool: Tool; metric?: string; status?: string; channel?: string; followup?: boolean }
  | { kind: 'forbidden'; reason: 'other_partner' | 'customer_pii' | 'secrets' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unknown' };

const CHANNEL: [RegExp, string][] = [[/telegram|\btg\b/, 'telegram'], [/instagram|insta|\big\b/, 'instagram'], [/facebook|\bfb\b/, 'facebook'], [/youtube/, 'youtube'], [/tiktok/, 'tiktok']];
export const channelOf = (t: string) => CHANNEL.find(([re]) => re.test(t))?.[1];

export function classify(text: string): Intent {
  const t = matchForm(text);
  // --- refusals first (no data is read for these) ---
  if (/parol|token|api ?key|secret|sekret|kalit(lar)?i?\b|otp|sms kod/.test(t)) return { kind: 'forbidden', reason: 'secrets' };
  if (/(boshqa|ikkinchi|begona|falon\w*|hamma|barcha|qolgan)\s+hamkor|hamkorlar\w*\s+(daromad|pul|buyurtma|balans|komissiya|ismi|telefon)|partner_?id|\bp-\d{3,}/.test(t)) return { kind: 'forbidden', reason: 'other_partner' };
  if (/mijoz\w*\s+(telefon|raqam|nomer|manzil|adres|pasport)|telefon raqam\w* (ber|ko.?rsat|chiqar)/.test(t)) return { kind: 'forbidden', reason: 'customer_pii' };

  const ch = channelOf(t);
  if (/^(endi )?faqat\b|^(endi )?(telegram|instagram)(dan|ni)?( bo.?yicha)?$/.test(t) && ch) return { kind: 'tool', tool: 'partner_earnings_summary', channel: ch, followup: true };
  if (/solishtir|taqqosla|sravn/.test(t)) return { kind: 'unsupported', reason: 'compare' };
  if (/foyda|sof daromad|reklamadan keyin/.test(t)) return { kind: 'unsupported', reason: 'after_ad_result' };
  if (/prognoz|bashorat|keyingi oy\w* qancha/.test(t)) return { kind: 'unsupported', reason: 'forecast' };

  if (/eng (kop|yaxshi|daromadli|zor|baland)\w* kun|qaysi kun\w* eng/.test(t)) return { kind: 'tool', tool: 'partner_best_day' };
  if (/(dokon|magazin|sayt|umumiy|hamma|platforma)\w*.*(kop sotil|top|bestseller|ommabop|xit)|bestseller|eng ommabop/.test(t)) return { kind: 'tool', tool: 'public_bestsellers' };
  if (/(qaysi|eng kop|top)\w*.*(mahsulot|tovar)|mahsulot\w*.*(kop sotil|eng kop)/.test(t)) return { kind: 'tool', tool: 'partner_top_products' };
  if (/uzcoin|\bcoin|tanga/.test(t)) return { kind: 'tool', tool: 'partner_uzcoin_summary' };
  if (/daraja|level|kupon/.test(t)) return { kind: 'tool', tool: 'partner_level' };
  if (/konkurs|musobaqa|sovrin/.test(t)) return { kind: 'tool', tool: 'partner_contest_status' };
  if (/sifat|ogohlantirish|tekshiruv|apellyatsiya/.test(t)) return { kind: 'tool', tool: 'partner_quality_cases' };
  if (/xayriya|ehson|sadaqa/.test(t)) return { kind: 'tool', tool: 'partner_charity_summary' };
  if (/oqim|stream|havola\w*/.test(t)) return { kind: 'tool', tool: 'partner_flows_performance', channel: ch };
  if (/otkaz|rad (et|qil|bo)|bekor (bo|qil)|rad etil|otmen/.test(t)) return { kind: 'tool', tool: 'partner_rejections', channel: ch };
  if (/balans|hamyon|yechish mumkin|qancha pul (bor|qoldi)|hisobim/.test(t)) return { kind: 'tool', tool: 'partner_wallet_snapshot' };
  if (/tolangan|tolab berildi|yechib oldim|kartamga|payout|vyplat/.test(t)) return { kind: 'tool', tool: 'partner_earnings_summary', metric: 'payout_paid', channel: ch };
  if (/pul|topdim|topgan|daromad|ishladim|komissiya|bonus\w* qancha|zarabot|dengi/.test(t)) return { kind: 'tool', tool: 'partner_earnings_summary', metric: 'commission_recognized_net', channel: ch };
  if (/buyurtma|zakaz|order|sotuv|sotdim/.test(t)) {
    const status = /yetkaz|dostav/.test(t) ? 'delivered' : /qaytar|vozvrat/.test(t) ? 'returned' : /kutil|yangi/.test(t) ? 'new' : undefined;
    return { kind: 'tool', tool: 'partner_orders_count', status, channel: ch };
  }
  return { kind: 'unknown' };
}

/** Quick question cards (work without any LLM). */
export const PARTNER_QUICK = [
  'Bugun qancha pul topdim?',
  'Kecha nechta buyurtma oldim?',
  'Shu hafta nechta otkaz bo‘ldi?',
  'Balansim qancha?',
  'Shu oy qaysi mahsulotim ko‘p sotildi?',
  'Shu yil eng daromadli kunim qaysi?',
  'Oqimlarim natijasi (oxirgi 30 kun)',
  'Do‘konda eng ko‘p sotilayotgan mahsulotlar',
  'UzCoin balansim',
  'Darajam va kuponim',
];
