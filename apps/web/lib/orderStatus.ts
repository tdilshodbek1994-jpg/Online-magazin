/**
 * Customer-facing order status in plain Uzbek. The order has three technical dimensions (commercial,
 * fulfillment, payment); the customer only needs one sentence and a step on a simple tracker.
 */
export const STEPS = ['Qabul qilindi', 'Tasdiqlandi', 'Yig‘ilmoqda', 'Yo‘lda', 'Yetkazildi'];

export type Stage = { label: string; hint: string; step: number; cls: 'ok' | 'wait' | 'road' | 'off' };

export function orderStage(o: { commercial_status?: string; fulfillment_status?: string; payment_status?: string; payment_method?: string }): Stage {
  const c = o.commercial_status ?? '';
  const f = o.fulfillment_status ?? '';
  if (c === 'cancelled') return { label: 'Bekor qilindi', hint: 'Buyurtma bekor qilingan.', step: -1, cls: 'off' };
  if (f === 'returned') return { label: 'Qaytarildi', hint: 'Mahsulot omborga qaytarilgan.', step: -1, cls: 'off' };
  if (f === 'failed') return { label: 'Yetkazib bo‘lmadi', hint: 'Kuryer sizga yetkaza olmadi. Operator siz bilan bog‘lanadi.', step: 3, cls: 'off' };
  if (f === 'delivered' || c === 'completed') return { label: 'Yetkazildi', hint: 'Xaridingiz uchun rahmat!', step: 4, cls: 'ok' };
  if (f === 'shipped') return { label: 'Yo‘lda', hint: 'Kuryer yo‘lda — yetib kelganda qo‘ng‘iroq qiladi.', step: 3, cls: 'road' };
  if (f === 'picking' || f === 'packed') return { label: 'Yig‘ilmoqda', hint: 'Buyurtmangiz omborda yig‘ilmoqda.', step: 2, cls: 'road' };
  if (c === 'confirmed') {
    if (o.payment_method === 'online' && o.payment_status !== 'paid') return { label: 'To‘lov kutilmoqda', hint: 'Buyurtma tasdiqlandi — onlayn to‘lovni amalga oshiring.', step: 1, cls: 'wait' };
    return { label: 'Tasdiqlandi', hint: 'Operator buyurtmani tasdiqladi, tez orada jo‘natiladi.', step: 1, cls: 'wait' };
  }
  return { label: 'Qabul qilindi', hint: 'Operator tez orada qo‘ng‘iroq qilib, buyurtmani tasdiqlaydi.', step: 0, cls: 'wait' };
}

export const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'To‘lanmagan', pending: 'To‘lov tekshirilmoqda', paid: 'To‘langan', partially_refunded: 'Qisman qaytarilgan',
  refunded: 'Pul qaytarilgan', failed: 'To‘lov o‘tmadi', reconciliation_required: 'To‘lov tekshirilmoqda',
};

const EVENT_LABEL: Record<string, Record<string, string>> = {
  commercial: { awaiting_confirmation: 'Buyurtma qabul qilindi', confirmed: 'Operator tasdiqladi', cancelled: 'Bekor qilindi', completed: 'Yakunlandi', draft: 'Qoralama' },
  fulfillment: { unallocated: 'Omborga yuborildi', reserved: 'Mahsulot band qilindi', picking: 'Yig‘ilmoqda', packed: 'Qadoqlandi', shipped: 'Kuryerga topshirildi', delivered: 'Yetkazildi', failed: 'Yetkazib bo‘lmadi', returned: 'Qaytarildi' },
  payment: { unpaid: 'To‘lov kutilmoqda', pending: 'To‘lov tekshirilmoqda', paid: 'To‘lov qabul qilindi', refunded: 'Pul qaytarildi', partially_refunded: 'Pulning bir qismi qaytarildi', failed: 'To‘lov o‘tmadi', reconciliation_required: 'To‘lov tekshirilmoqda' },
};

export function eventLabel(dimension: string, to: string): string {
  return EVENT_LABEL[dimension]?.[to] ?? EVENT_LABEL.fulfillment[to] ?? EVENT_LABEL.commercial[to] ?? to;
}

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
/** "3-noyabr" / "3-noyabr, 2026" — browsers lack Uzbek month names (they print "M11"), so we format by hand in Tashkent time. */
export function uzDate(v: string | number | Date, withYear = false): string {
  const d = new Date(new Date(v).getTime() + 5 * 3600 * 1000); // Asia/Tashkent, UTC+5, no DST
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}${withYear ? `, ${d.getUTCFullYear()}` : ''}`;
}
