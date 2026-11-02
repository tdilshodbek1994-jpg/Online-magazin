'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { notifyCart } from '@/components/Header';
import { api, som } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const T = {
  'uz-Latn': { open: '⚡ Tez buyurtma — 1 daqiqada', title: 'Tez buyurtma', sub: 'Ism va telefon kifoya. Operator qo‘ng‘iroq qilib, manzilni aniqlaydi. To‘lov — mahsulotni qabul qilganda.', name: 'Ismingiz', phone: 'Telefon raqamingiz', region: 'Viloyat / hudud', terms: 'Oferta shartlariga roziman', send: 'Buyurtma berish', cancel: 'Bekor', ok: 'Buyurtmangiz qabul qilindi!', okSub: 'Operator tez orada qo‘ng‘iroq qilib, manzil va yetkazish vaqtini kelishadi.', total: 'Jami (yetkazish bilan)', number: 'Buyurtma raqami' },
  'uz-Cyrl': { open: '⚡ Тез буюртма — 1 дақиқада', title: 'Тез буюртма', sub: 'Исм ва телефон кифоя. Оператор қўнғироқ қилиб, манзилни аниқлайди. Тўлов — маҳсулотни қабул қилганда.', name: 'Исмингиз', phone: 'Телефон рақамингиз', region: 'Вилоят / ҳудуд', terms: 'Оферта шартларига розиман', send: 'Буюртма бериш', cancel: 'Бекор', ok: 'Буюртмангиз қабул қилинди!', okSub: 'Оператор тез орада қўнғироқ қилиб, манзил ва етказиш вақтини келишади.', total: 'Жами (етказиш билан)', number: 'Буюртма рақами' },
} as const;

const ERR: Record<string, string> = { PHONE_INVALID: 'Telefon raqami noto‘g‘ri. Masalan: +998 90 123 45 67', QUICK_ORDER_RATE_LIMIT: 'Bu raqamdan juda ko‘p buyurtma berildi. Birozdan keyin urinib ko‘ring yoki operatorga yozing.', OUT_OF_STOCK: 'Afsuski, bu variant tugadi.', NETWORK: 'Internet aloqasini tekshirib, qayta bosing — buyurtma ikki marta yozilmaydi.' };

export function QuickOrder({ skuId, qty, disabled, autoOpen = false, onClose }: { skuId: string; qty: number; disabled: boolean; autoOpen?: boolean; onClose?: () => void }) {
  const { lang } = useI18n();
  const t = T[lang] ?? T['uz-Latn'];
  const [open, setOpen] = useState(autoOpen);
  const [zones, setZones] = useState<any[]>([]);
  const [f, setF] = useState({ name: '', phone: '+998 ', zone: '', terms: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const idem = useRef<string>('');
  useEffect(() => {
    if (!open || zones.length) return;
    api('/delivery-zones').then((z) => { setZones(z.items); const tas = z.items.find((x: any) => x.region_code === 'TAS') ?? z.items[0]; if (tas) setF((p) => ({ ...p, zone: tas.id })); }).catch(() => {});
  }, [open, zones.length]);
  // A new key per distinct order; retries of the same submission reuse it (no duplicate orders on flaky mobile networks).
  useEffect(() => { idem.current = crypto.randomUUID(); }, [skuId, qty, f.phone, f.zone]);

  if (done) return (
    <div className="quick-done" role="status">
      <div className="qd-icon" aria-hidden>✅</div>
      <b>{t.ok}</b>
      <p>{t.okSub}</p>
      <div className="spread"><span>{t.number}</span><b>{done.number}</b></div>
      <div className="spread"><span>{t.total}</span><b>{som(done.payable?.amount_minor)}</b></div>
      <Link href="/catalog" className="btn secondary">← Xaridni davom ettirish</Link>
    </div>
  );
  if (!open) return <button type="button" className="btn big quick-btn" disabled={disabled} onClick={() => setOpen(true)}>{t.open}</button>;
  return (
    <form className="quick-form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try {
        const r = await api('/checkout/quick-order', { method: 'POST', idem: idem.current, body: { sku_id: skuId, qty, name: f.name.trim(), phone: f.phone, delivery_zone_id: f.zone || undefined, accept_terms: true } });
        setDone(r); notifyCart();
      } catch (x: any) { setErr(ERR[x.code] ?? (x.field_errors ? 'Maydonlarni tekshiring' : x.code ?? 'ERROR')); } finally { setBusy(false); }
    }}>
      <b>{t.title}</b>
      <p className="muted small">{t.sub}</p>
      <label htmlFor="qo-name">{t.name}</label>
      <input id="qo-name" required minLength={2} maxLength={120} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <label htmlFor="qo-phone">{t.phone}</label>
      <input id="qo-phone" required type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      {zones.length > 1 && (<>
        <label htmlFor="qo-zone">{t.region}</label>
        <select id="qo-zone" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>{zones.map((z) => <option key={z.id} value={z.id}>{z.name}{z.tariff_minor ? ` — ${som(z.tariff_minor)}` : ''}</option>)}</select>
      </>)}
      <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={f.terms} onChange={(e) => setF({ ...f, terms: e.target.checked })} /> <span>{t.terms} (<Link href="/legal/offer">oferta</Link>)</span></label>
      {err && <div className="field-error" role="alert">{err}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn big" disabled={busy || !f.terms || f.name.trim().length < 2} style={{ flex: 1 }}>{busy ? '…' : t.send}</button>
        <button type="button" className="btn secondary" onClick={() => { setOpen(false); onClose?.(); }}>{t.cancel}</button>
      </div>
    </form>
  );
}
