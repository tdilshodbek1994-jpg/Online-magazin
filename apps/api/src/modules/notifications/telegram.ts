import type { Queryable } from '../../platform/db.js';
import { queueNotification } from './service.js';

/** Partner-facing events (Telegram + in-cabinet list). Amounts are tiyin strings; text never contains customer PII. */
export type PartnerEvent = 'partner.customer_filled' | 'partner.order_new' | 'partner.order_delivered' | 'partner.order_cancelled' | 'partner.commission_available' | 'partner.payout_paid' | 'partner.bonus' | 'partner.contest_prize' | 'partner.penalty' | 'partner.level_up' | 'partner.coupon_issued' | 'telegram.linked';

const som = (minor: unknown) => {
  try { return `${(BigInt(String(minor ?? '0')) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`; } catch { return '—'; }
};

export function renderText(template: string, p: Record<string, unknown>): string {
  switch (template) {
    case 'partner.order_new': return `🛒 Yangi buyurtma ${p.number ?? ''}\n${p.products ?? ''}\nOqim: ${p.stream ?? '—'}\nKutilayotgan bonus: ${som(p.amount_minor)}\n\nOperator mijoz bilan bog‘lanib tasdiqlaydi.`;
    case 'partner.order_delivered': return `✅ Buyurtma ${p.number ?? ''} yetkazildi va to‘landi${p.products ? `\nMahsulot: ${p.products}` : ''}\nBonus: ${som(p.amount_minor)} — kutish muddatidan keyin hisobingizga o‘tadi.`;
    case 'partner.order_cancelled': return `❌ Buyurtma ${p.number ?? ''} bekor qilindi yoki qaytarildi${p.products ? `\nMahsulot: ${p.products}` : ''}\nBu buyurtma bo‘yicha bonus hisoblanmaydi.`;
    case 'partner.commission_available': return `💰 Hisobingizga ${som(p.amount_minor)} o‘tdi${p.products ? `\nMahsulot: ${p.products}` : ''}${p.number ? `\nBuyurtma: ${p.number}` : ''}\nEndi pul yechish so‘rovini yuborishingiz mumkin.`;
    case 'partner.payout_paid': return `💳 To‘lov amalga oshirildi: ${som(p.amount_minor)}\nKarta: ${p.destination ?? '—'}`;
    case 'partner.bonus': return `🎁 Bonus: +${som(p.amount_minor)}\n${p.reason ?? ''}\nHisobingizga (yechish mumkin) qo‘shildi.`;
    case 'partner.contest_prize': return `🏆 Tabriklaymiz! ${p.reason ?? 'Konkurs sovrini'}\n+${som(p.amount_minor)} hisobingizga qo‘shildi.`;
    case 'partner.operator_message': return `💬 Operator xabari — buyurtma ${p.number ?? ''}\n${p.text ?? ''}`;
    case 'partner.weekly': return `📊 O‘tgan hafta natijangiz\nBuyurtmalar: ${p.orders ?? 0}\nYetkazildi: ${p.delivered ?? 0}\nYechish mumkin bo‘ldi: ${som(p.amount_minor)}\nEng yaxshi oqim: ${p.stream ?? '—'}\n\nBatafsil: kabinet → Statistika`;
    case 'partner.penalty': return `⚠️ Jarima: −${som(p.amount_minor)}\nSabab: ${p.reason ?? '—'}\nSavol bo‘lsa, qo‘llab-quvvatlashga yozing.`;
    case 'partner.customer_filled': return `📝 Mijoz ma’lumotlarini o‘zi to‘ldirdi (${p.source ?? 'havola'})\nBuyurtma ${p.number ?? ''} yaratildi — operator mijoz bilan bog‘lanib tasdiqlaydi.`;
    case 'price_watch.dropped': return `UzShop: «${p.product ?? 'mahsulot'}» narxi tushdi: ${p.was ?? ''} → ${p.now ?? ''}. ${p.path ?? ''}`;
    case 'waitlist.back_in_stock': return `UzShop: «${p.product ?? 'mahsulot'}» yana sotuvda. Buyurtma: ${p.path ?? ''}`;
    case 'offer.reminder': return 'UzShop: sizga yuborilgan mahsulot taklifi hali amal qilmoqda. Havolani qayta ochib, tanlashingiz mumkin.';
    case 'partner.level_up': return `${p.badge ?? '🎖️'} Tabriklaymiz! Yangi daraja: ${p.name ?? ''}\nHisobga olingan sotuvlar: ${p.units ?? 0} dona\nSovg‘alarga chegirma: ${p.discount ?? 0}%${p.next ? `\nKeyingi daraja: ${p.next} (${p.remaining} ta qoldi)` : ''}\n\nKabinet → Darajam`;
    case 'partner.coupon_issued': return `🎟️ Sizga bir martalik 50% komissiya kuponi berildi!\n${p.units ?? ''} ta sotuvga yetdingiz. Kabinet → Darajam bo‘limida faollashtiring — keyingi mos buyurtmaga qo‘llanadi.`;
    case 'automation.alert': return `⚙️ ${p.text ?? ''}`;
    case 'telegram.linked': return '✅ UzShop hamkor bildirishnomalari ulandi. Yangi buyurtma, yetkazish va to‘lovlar haqida shu yerga xabar keladi.';
    default: return String(p.text ?? template);
  }
}

export async function notifyPartner(q: Queryable, partnerId: string, template: PartnerEvent, params: Record<string, unknown>, dedupeKey: string): Promise<void> {
  const r = await q.query(`SELECT user_id FROM partners WHERE id=$1`, [partnerId]);
  const userId = r.rows[0]?.user_id as string | undefined;
  if (!userId) return;
  await queueNotification(q, { userId, channel: 'telegram', purpose: 'transactional', template, locale: 'uz-Latn', params, dedupeKey });
}

/** Masked order number for partners (they never see the full number or customer data). */
export const maskedNumber = (n: string) => `OM-***${n.slice(-3)}`;

/** Sends one message through the Bot API. Throws on transport/API errors so the job is retried with backoff. */
export async function sendTelegram(token: string, chatId: string | number, text: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number }; description?: string; error_code?: number };
  if (!j.ok) {
    const err = new Error(`telegram ${j.error_code ?? res.status}: ${j.description ?? 'error'}`) as Error & { permanent?: boolean };
    err.permanent = j.error_code === 400 || j.error_code === 403; // chat not found / bot blocked: do not retry forever
    throw err;
  }
  return String(j.result?.message_id ?? '');
}
