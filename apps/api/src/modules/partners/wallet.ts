import type { FastifyInstance } from 'fastify';
import { many, maybeOne } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { BUCKET_SQL, maskName, maskTail } from './cabinet.js';
import { missingFields } from './drafts.js';
import { myPartner } from './routes.js';

/**
 * Partner cabinet 2.0 read models (V2 §08–§10):
 *  - "E'tibor kerak": what the partner must do now vs what the shop is doing,
 *  - Hamyon: every commission line with a plain reason why it is (not yet) withdrawable,
 *  - Sotuv pasporti: how one order was attributed and how its commission was computed.
 * Read-only. Business values (rates, holds) come from the stored rule snapshots, never from constants here.
 */

/** Why a commission line is where it is. Order matters: a dispute overrides the money state. */
export const ACCRUAL_REASON_SQL = `CASE
  WHEN a.state='reversed' THEN 'reversed'
  WHEN a.state='superseded' THEN 'superseded'
  WHEN EXISTS (SELECT 1 FROM partner_disputes d WHERE d.order_id=a.order_id AND d.status='open') THEN 'dispute'
  WHEN a.state='available' THEN 'available'
  WHEN a.state='estimated' THEN 'not_delivered'
  WHEN a.state='pending' AND o.payment_status <> 'paid' AND COALESCE((SELECT c.status FROM cod_collections c WHERE c.order_id=a.order_id), '') <> 'reconciled' THEN 'awaiting_cash'
  ELSE 'hold' END`;

const MISSING_UZ: Record<string, string> = { product: 'mahsulot', customer_name: 'mijoz ismi', customer_phone: 'telefon', delivery_zone: 'hudud', address: 'manzil' };

export const REASON_LABEL: Record<string, string> = {
  not_delivered: 'Hali yetkazilmagan',
  awaiting_cash: 'Yetkazildi, pul tushumi solishtirilmoqda',
  hold: 'Qaytarish muddati kutilmoqda',
  dispute: 'Nizo ko‘rib chiqilmoqda',
  available: 'Tasdiqlandi',
  reversed: 'Bekor qilindi',
  superseded: 'Boshqa hamkorga o‘tkazildi',
};

const tashkent = (d: string | Date) => new Date(d).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function registerPartnerWallet(app: FastifyInstance, deps: Deps): void {
  const T = ['partner'];

  route(app, deps, { method: 'GET', url: '/partner/attention', tags: T, summary: '"E\'tibor kerak": actions for the partner vs things the shop is handling' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    type Item = { kind: string; title: string; detail?: string; href?: string; at?: string; ref_id?: string };
    const action: Item[] = [];
    const waiting: Item[] = [];

    const drafts = await many<{ id: string; status: string; lines: { sku_id: string; qty: number }[]; customer_name: string | null; customer_phone: string | null; delivery_zone_id: string | null; address: Record<string, string>; address_later: boolean; fill_expires_at: string | null; updated_at: string }>(db,
      `SELECT id, status, lines, customer_name, customer_phone, delivery_zone_id, address, address_later, fill_expires_at, updated_at FROM sales_drafts WHERE partner_id=$1 AND status IN ('draft','awaiting_customer') ORDER BY updated_at DESC LIMIT 50`, [p.id]);
    for (const d of drafts) {
      if (d.status === 'awaiting_customer') {
        const expired = d.fill_expires_at && new Date(d.fill_expires_at) < new Date();
        (expired ? action : waiting).push(expired
          ? { kind: 'fill_link_expired', title: 'Mijoz havolani to‘ldirmadi — muddati tugadi', detail: 'Yangi havola yuboring yoki o‘zingiz to‘ldiring', href: `/partner/new?draft=${d.id}`, at: d.updated_at, ref_id: d.id }
          : { kind: 'fill_link_shared', title: 'Mijoz ma’lumotlarini to‘ldirishini kutyapmiz', detail: 'Havola yuborilgan', href: `/partner/new?draft=${d.id}`, at: d.updated_at, ref_id: d.id });
      } else {
        const miss = missingFields(d);
        action.push({ kind: 'draft_incomplete', title: miss.length ? 'Qoralama to‘liq emas' : 'Qoralama tayyor — yuboring', detail: miss.length ? `Yetishmayapti: ${miss.map((m) => MISSING_UZ[m] ?? m).join(', ')}` : undefined, href: `/partner/new?draft=${d.id}`, at: d.updated_at, ref_id: d.id });
      }
    }

    const orders = await many<{ id: string; masked_number: string; bucket: string; confirmation_status: string; channel: string; callback_at: string | null; quick: boolean; created_at: string; conf_expires: string | null }>(db, `
      SELECT o.id, 'OM-***' || right(o.number, 3) AS masked_number, ${BUCKET_SQL} AS bucket, o.confirmation_status, o.channel, o.callback_at, COALESCE(o.address_snapshot->>'quick','false')='true' AS quick, o.created_at,
             (SELECT max(c.expires_at) FROM order_confirmations c WHERE c.order_id=o.id AND c.method='customer_otp' AND c.status='pending') AS conf_expires
        FROM orders o WHERE o.attributed_partner_id=$1 AND o.created_at > now() - interval '14 days' ORDER BY o.created_at DESC LIMIT 300`, [p.id]);
    for (const o of orders) {
      const href = `/partner/orders/${o.id}`;
      if (o.channel === 'partner_assisted' && o.confirmation_status === 'pending' && o.bucket === 'new') {
        const old = Date.now() - new Date(o.created_at).getTime() > 2 * 3600_000;
        (old ? action : waiting).push({ kind: 'awaiting_customer_sms', title: old ? `${o.masked_number}: mijoz SMS kodni hali kiritmadi — eslatib qo‘ying` : `${o.masked_number}: mijoz SMS orqali tasdiqlashini kutyapmiz`, detail: o.conf_expires ? `Kod ${tashkent(o.conf_expires)} gacha amal qiladi` : undefined, href, at: o.created_at, ref_id: o.id });
      } else if (o.confirmation_status === 'expired' && o.bucket === 'cancelled') {
        action.push({ kind: 'confirmation_expired', title: `${o.masked_number}: mijoz tasdiqlamadi, muddat tugadi`, detail: 'Mijoz bilan gaplashib, yangi buyurtma kiriting', href, at: o.created_at, ref_id: o.id });
      } else if (o.bucket === 'new') {
        waiting.push({ kind: o.callback_at ? 'callback' : o.quick ? 'quick_address' : 'operator_review', title: o.callback_at ? `${o.masked_number}: operator mijozga belgilangan vaqtda qo‘ng‘iroq qiladi` : o.quick ? `${o.masked_number}: operator mijozdan manzilni aniqlayapti` : `${o.masked_number}: operator tasdiqlashini kutyapmiz`, detail: o.callback_at ? `Qo‘ng‘iroq vaqti: ${tashkent(o.callback_at)}` : undefined, href, at: o.created_at, ref_id: o.id });
      }
    }

    // Streams whose product is gone or nearly gone: the partner's post would sell something we cannot ship (V2 §11).
    const streams = await many<{ id: string; name: string | null; product: Record<string, string>; atp: number; waiting: number }>(db, `
      SELECT l.id, l.name, pr.name AS product, COALESCE((SELECT SUM(s.atp) FROM stock_atp s JOIN skus k ON k.id=s.sku_id WHERE k.product_id=pr.id),0)::int AS atp,
             (SELECT COUNT(*) FROM stock_waitlist w WHERE w.product_id=pr.id AND w.status='waiting')::int AS waiting
        FROM referral_links l JOIN products pr ON pr.id=l.product_id WHERE l.partner_id=$1 AND l.status='active'`, [p.id]);
    for (const s of streams) {
      const pname = s.product?.uz ?? Object.values(s.product ?? {})[0] ?? '';
      if (s.atp <= 0) action.push({ kind: 'stream_out_of_stock', title: `Oqim «${s.name ?? pname}»: mahsulot tugadi`, detail: `Postni vaqtincha to‘xtating yoki boshqa mahsulot tanlang. Havola endi «Hozir mavjud emas» sahifasini, kutish ro‘yxati va o‘xshash mahsulotlarni ko‘rsatadi${s.waiting ? ` · ${s.waiting} kishi kutish ro‘yxatida` : ''}`, href: '/partner/streams', ref_id: s.id });
      else if (s.atp <= 3) action.push({ kind: 'stream_low_stock', title: `Oqim «${s.name ?? pname}»: ${s.atp} dona qoldi`, href: '/partner/streams', ref_id: s.id });
    }

    const holds = await many<{ draft_id: string; expires_at: string }>(db, `SELECT sales_draft_id AS draft_id, expires_at FROM reservations WHERE partner_id=$1 AND status='active_unpaid' AND expires_at > now() ORDER BY expires_at`, [p.id]);
    for (const h of holds) action.push({ kind: 'hold_active', title: `Bron qilingan mahsulot: ${Math.max(1, Math.round((new Date(h.expires_at).getTime() - Date.now()) / 60000))} daqiqa qoldi`, detail: 'Buyurtmani yuboring, aks holda bron bekor bo‘lib, mahsulot boshqalarga ochiladi', href: `/partner/new?draft=${h.draft_id}`, at: h.expires_at, ref_id: h.draft_id });
    const offers = await many<{ id: string; status: string; seen_at: string | null; remind_at: string | null; created_at: string }>(db, `SELECT id, status, seen_at, remind_at, created_at FROM partner_offers WHERE partner_id=$1 AND status IN ('open','thinking') AND expires_at > now() ORDER BY created_at DESC LIMIT 20`, [p.id]);
    for (const f of offers) waiting.push({ kind: 'offer_open', title: f.status === 'thinking' ? 'Mijoz taklif to‘plamini o‘ylab ko‘ryapti' : f.seen_at ? 'Mijoz taklifni ochdi, hali tanlamadi' : 'Taklif to‘plami yuborildi, mijoz hali ochmadi', detail: f.remind_at ? 'Mijoz eslatma so‘radi — o‘zimiz bir marta eslatamiz' : undefined, href: '/partner/offers', at: f.created_at, ref_id: f.id });
    const disputes = await many<{ id: string; subject: string; created_at: string }>(db, `SELECT id, subject, created_at FROM partner_disputes WHERE partner_id=$1 AND status='open' ORDER BY created_at DESC`, [p.id]);
    for (const d of disputes) waiting.push({ kind: 'dispute_open', title: `Murojaat ko‘rib chiqilmoqda: ${d.subject}`, at: d.created_at, href: '/partner/wallet', ref_id: d.id });

    return { action, waiting, counts: { action: action.length, waiting: waiting.length } };
  });

  route(app, deps, { method: 'GET', url: '/partner/wallet', tags: T, summary: 'Hamyon: balances + every commission line with a plain reason' }, async ({ actor, db }) => {
    const p = await myPartner(db, actor, false);
    const bal = await maybeOne<Record<string, string>>(db, `SELECT estimated_minor::text, pending_minor::text, available_minor::text, reserved_minor::text, paid_minor::text, debt_minor::text FROM partner_balances WHERE partner_id=$1`, [p.id]);
    const rows = await many<{ id: string; order_id: string; masked_number: string; product: unknown; qty: number; target_minor: string; state: string; reason: string; available_after: string | null; created_at: string; reversed_reason: string | null }>(db, `
      SELECT a.id, a.order_id, 'OM-***' || right(o.number, 3) AS masked_number, ol.product_snapshot->'name' AS product, ol.qty, a.target_minor::text, a.state, ${ACCRUAL_REASON_SQL} AS reason, a.available_after, a.created_at,
             (SELECT l.reason FROM partner_ledger l WHERE l.partner_id=a.partner_id AND l.source_type='accrual' AND l.source_id=a.id::text ORDER BY l.id DESC LIMIT 1) AS reversed_reason
        FROM commission_accruals a JOIN orders o ON o.id=a.order_id JOIN order_lines ol ON ol.id=a.order_line_id
       WHERE a.partner_id=$1 AND a.state <> 'superseded' ORDER BY a.created_at DESC LIMIT 300`, [p.id]);
    const lines = rows.map((r) => ({ ...r, reason_label: REASON_LABEL[r.reason] ?? r.reason, reversed_reason: r.state === 'reversed' ? r.reversed_reason : null }));
    const groups: Record<string, { count: number; amount_minor: string }> = {};
    for (const l of lines) {
      const g = (groups[l.reason] ??= { count: 0, amount_minor: '0' });
      g.count += 1;
      g.amount_minor = (BigInt(g.amount_minor) + BigInt(l.target_minor)).toString();
    }
    const debt = BigInt(bal?.debt_minor ?? '0');
    const debtSources = debt < 0n ? await many(db, `SELECT source_type, reason, amount_minor::text, created_at FROM partner_ledger WHERE partner_id=$1 AND to_bucket='debt' ORDER BY id DESC LIMIT 10`, [p.id]) : [];
    const payouts = await many(db, `SELECT id, amount_minor::text, status, created_at FROM payout_requests WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 20`, [p.id]).catch(() => []);
    return {
      balances: bal ?? { estimated_minor: '0', pending_minor: '0', available_minor: '0', reserved_minor: '0', paid_minor: '0', debt_minor: '0' },
      groups: Object.entries(groups).map(([reason, g]) => ({ reason, label: REASON_LABEL[reason] ?? reason, ...g })),
      lines,
      debt: debt < 0n ? { amount_minor: (-debt).toString(), explanation: 'Qarz keyingi tasdiqlangan komissiyalardan avtomatik yopiladi', sources: debtSources } : null,
      payouts,
    };
  });

  route(app, deps, { method: 'GET', url: '/partner/orders/:id/passport', tags: T, summary: 'Sotuv pasporti: source, attribution reason, rule snapshot, base, commission, timeline', params: zIdParam }, async ({ actor, db, params }) => {
    const p = await myPartner(db, actor, false);
    const o = await maybeOne<Record<string, unknown> & { attribution: Record<string, unknown> | null; cname: unknown; cphone: unknown }>(db, `
      SELECT o.id, 'OM-***' || right(o.number, 3) AS masked_number, o.channel, ${BUCKET_SQL} AS bucket, o.commercial_status, o.confirmation_status, o.fulfillment_status, o.payment_status,
             o.created_at, o.delivered_at, o.contact_time_note, o.attribution, o.subtotal_minor::text, o.delivery_minor::text, o.payable_minor::text,
             o.contact_snapshot->>'name' AS cname, coalesce(o.customer_phone, o.contact_snapshot->>'phone') AS cphone,
             o.address_snapshot->>'district' AS district, o.address_snapshot->>'region_code' AS region,
             l.name AS stream_name, l.code AS stream_code
        FROM orders o LEFT JOIN referral_links l ON l.id::text = o.attribution->>'link_id'
       WHERE o.id=$1 AND o.attributed_partner_id=$2`, [params.id, p.id]);
    if (!o) throw notFound('ORDER'); // other partners' orders look non-existent
    const { cname, cphone, attribution, ...rest } = o;
    const source = o.channel === 'partner_assisted' ? 'Siz kiritgan buyurtma' : o.stream_name ? `Oqim «${o.stream_name}»` : 'Sizning havolangiz';
    const reasonText: Record<string, string> = { partner_assisted: 'Buyurtmani o‘zingiz kiritdingiz', last_eligible_click: 'Mijoz oxirgi marta sizning havolangiz orqali kirgan', manual_correction: 'Administrator tuzatishi' };
    const accruals = await many<{ state: string }>(db, `
      SELECT a.id, a.state, ${ACCRUAL_REASON_SQL} AS reason, a.target_minor::text, a.rule_snapshot, a.available_after, a.available_at, ol.product_snapshot->'name' AS product, ol.qty, ol.returned_qty, ol.unit_price_minor::text, ol.line_gross_minor::text,
             (SELECT '/media/' || ma.storage_key FROM skus sk JOIN media_assets ma ON ma.product_id=sk.product_id AND ma.status='approved' WHERE sk.id=ol.sku_id ORDER BY ma.sort LIMIT 1) AS image
        FROM commission_accruals a JOIN orders o ON o.id=a.order_id JOIN order_lines ol ON ol.id=a.order_line_id WHERE a.order_id=$1 AND a.partner_id=$2 ORDER BY a.created_at`, [params.id, p.id]);
    const timeline = await many(db, `SELECT dimension, from_status, to_status, reason, created_at FROM order_status_events WHERE order_id=$1 ORDER BY id`, [params.id]);
    // Clear milestones for the partner: received → operator call(s) (who, when, result) → accepted → shipped → delivered → paid.
    const calls = await many<{ outcome: string; created_at: string; operator: string | null }>(db, `SELECT c.outcome, c.created_at, split_part(u.display_name, ' ', 1) AS operator FROM call_logs c LEFT JOIN users u ON u.id=c.operator_id WHERE c.order_id=$1 ORDER BY c.id`, [params.id]);
    const ev = timeline as { dimension: string; to_status: string; created_at: string }[];
    const first = (pred: (e: { dimension: string; to_status: string }) => boolean) => ev.find(pred)?.created_at ?? null;
    const op = await maybeOne<{ name: string | null }>(db, `SELECT split_part(u.display_name, ' ', 1) AS name FROM orders o JOIN users u ON u.id=o.assigned_operator_id WHERE o.id=$1`, [params.id]);
    const milestones = {
      received_at: o.created_at,
      operator: op?.name ?? calls.find((c) => c.operator)?.operator ?? null,
      calls,
      accepted_at: first((e) => (e.dimension === 'confirmation' && e.to_status === 'verified') || (e.dimension === 'commercial' && e.to_status === 'confirmed')),
      shipped_at: first((e) => e.dimension === 'fulfillment' && e.to_status === 'shipped'),
      delivered_at: o.delivered_at ?? first((e) => e.dimension === 'fulfillment' && e.to_status === 'delivered'),
      paid_at: first((e) => e.dimension === 'payment' && e.to_status === 'paid'),
      cancelled_at: first((e) => (e.dimension === 'commercial' && e.to_status === 'cancelled') || (e.dimension === 'confirmation' && ['rejected', 'expired'].includes(e.to_status))),
      returned_at: first((e) => e.dimension === 'fulfillment' && ['returned', 'failed'].includes(e.to_status)),
    };
    const entries = await many(db, `SELECT from_bucket, to_bucket, amount_minor::text, reason, created_at FROM partner_ledger WHERE partner_id=$1 AND source_type='accrual' AND source_id IN (SELECT id::text FROM commission_accruals WHERE order_id=$2) ORDER BY id`, [p.id, params.id]);
    const smsPending = !!(await maybeOne(db, `SELECT 1 FROM order_confirmations WHERE order_id=$1 AND method='customer_otp' AND status='pending' AND expires_at > now()`, [params.id]));
    const total = accruals.reduce((s, a: Record<string, unknown>) => s + (a.state === 'reversed' ? 0n : BigInt(a.target_minor as string)), 0n);
    return {
      ...rest, customer: maskName(cname), customer_phone: maskTail(cphone), source,
      attribution: { reason: attribution?.reason ?? null, reason_label: reasonText[String(attribution?.reason)] ?? String(attribution?.reason ?? '—') },
      commission: { total_minor: total.toString(), lines: accruals.map((a: Record<string, unknown>) => ({ ...a, reason_label: REASON_LABEL[a.reason as string] ?? a.reason })) },
      timeline, entries, milestones,
      explain: explainOrder({ sms_pending: smsPending, bucket: String(o.bucket), channel: String(o.channel), confirmation_status: String(o.confirmation_status), payment_status: String(o.payment_status), reasons: accruals.map((a: Record<string, unknown>) => String(a.reason)), available_after: (accruals.find((a: Record<string, unknown>) => a.state === 'pending') as { available_after?: string } | undefined)?.available_after ?? null }),
    };
  });
}

/**
 * "Nima bo'ldi va keyingi amal nima?" (V2 §18-D) — a plain explanation derived only from backend state
 * (no model guesses): what happened, whose turn it is, and the next action.
 */
export function explainOrder(o: { bucket: string; channel: string; confirmation_status: string; payment_status: string; reasons: string[]; available_after: string | null; sms_pending?: boolean }): { what: string; whose_turn: 'partner' | 'customer' | 'shop' | 'none'; next: string } {
  if (o.reasons.includes('dispute')) return { what: 'Siz yozgan murojaat ko‘rib chiqilmoqda.', whose_turn: 'shop', next: 'Javob Hamyon va Telegram’da keladi. Qo‘shimcha dalil bo‘lsa, murojaatga yozing.' };
  if (o.bucket === 'new' && o.channel === 'partner_assisted' && o.confirmation_status === 'pending' && o.sms_pending) return { what: 'Buyurtma yaratildi, mijozga SMS kod yuborildi.', whose_turn: 'customer', next: 'Mijozga qo‘ng‘iroq qilib, SMS’dagi havolani ochib kodni kiritishini eslating.' };
  if (o.bucket === 'new' && o.channel === 'partner_assisted' && o.confirmation_status === 'pending') return { what: 'Buyurtma operatorga tushdi.', whose_turn: 'shop', next: 'Operator mijozga qo‘ng‘iroq qilib tasdiqlaydi. Mijozni qo‘ng‘iroqqa tayyor bo‘lishini ogohlantiring — SMS kod so‘ralmaydi.' };
  if (o.bucket === 'new') return { what: 'Buyurtma operatorga tushdi.', whose_turn: 'shop', next: 'Operator mijozga qo‘ng‘iroq qilib tasdiqlaydi. Sizdan hozir hech narsa talab qilinmaydi.' };
  if (o.bucket === 'accepted') return { what: 'Buyurtma tasdiqlandi, omborda yig‘ilmoqda.', whose_turn: 'shop', next: 'Jo‘natilgach holat «Yo‘lda» bo‘ladi.' };
  if (o.bucket === 'shipping') return { what: 'Buyurtma kuryerda, yo‘lda.', whose_turn: 'customer', next: 'Mijozni telefonni ko‘tarishga va mahsulotni qabul qilishga tayyor bo‘lishini eslating.' };
  if (o.bucket === 'delivered') {
    if (o.reasons.includes('available')) return { what: 'Yetkazildi, komissiya tasdiqlandi.', whose_turn: 'partner', next: 'Hamyondan pul yechish so‘rovini yuborishingiz mumkin.' };
    if (o.reasons.includes('awaiting_cash')) return { what: 'Yetkazildi, kuryer pulni do‘konga topshirishi va moliya tekshiruvi kutilmoqda.', whose_turn: 'shop', next: 'Pul tushumi solishtirilgach, qaytarish muddati boshlanadi.' };
    if (o.reasons.includes('hold')) return { what: 'Yetkazildi va pul tushdi. Qaytarish muddati kutilmoqda.', whose_turn: 'none', next: o.available_after ? `${new Date(o.available_after).toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent' })} dan keyin komissiya «Yechish mumkin» bo‘ladi.` : 'Muddat tugagach komissiya «Yechish mumkin» bo‘ladi.' };
    return { what: 'Yetkazildi.', whose_turn: 'none', next: 'Bu mahsulot uchun komissiya qoidasi belgilanmagan bo‘lishi mumkin — savol bo‘lsa murojaat qiling.' };
  }
  if (o.bucket === 'returned') return { what: 'Mahsulot yetkazilmadi yoki qaytarildi.', whose_turn: 'partner', next: 'Bu buyurtma uchun komissiya yo‘q. Mijoz hali xohlasa, «Mijozlar daftari»dan qayta buyurtma tuzing.' };
  if (o.confirmation_status === 'expired') return { what: 'Mijoz SMS kodni belgilangan vaqtda kiritmadi — buyurtma bekor bo‘ldi.', whose_turn: 'partner', next: 'Mijoz bilan gaplashib, yangi buyurtma kiriting yoki unga to‘ldirish havolasini yuboring.' };
  if (o.confirmation_status === 'rejected') return { what: 'Mijoz buyurtmani rad etdi.', whose_turn: 'none', next: 'Sababini so‘rang — boshqa variant yoki taklif to‘plamini yuborish mumkin.' };
  return { what: 'Buyurtma bekor qilindi.', whose_turn: 'none', next: 'Bu buyurtma uchun komissiya yo‘q.' };
}
