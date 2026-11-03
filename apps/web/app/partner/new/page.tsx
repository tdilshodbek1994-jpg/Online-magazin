'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { LinkBox } from '../shared';

/**
 * Order Studio (V2 §04–§07): the partner enters a customer's order in one screen.
 * Every change autosaves as a draft (server version check), the right panel shows the live server price and the
 * commission estimate, and the order is only created when nothing is missing. Three ways to start:
 * type it in, paste the customer's message, or send the customer a link to fill in themselves.
 */
type Line = { sku_id: string; qty: number; slug: string };
type Form = { lines: Line[]; customer_name: string; customer_phone: string; delivery_zone_id: string; district: string; street: string; house: string; landmark: string; address_later: boolean; contact_time: string; note: string; placement_id: string };
const EMPTY: Form = { lines: [], customer_name: '', customer_phone: '', delivery_zone_id: '', district: '', street: '', house: '', landmark: '', address_later: false, contact_time: '', note: '', placement_id: '' };
const MISSING_LABEL: Record<string, string> = { product: 'Mahsulot', customer_name: 'Mijoz ismi', customer_phone: 'Telefon raqami', delivery_zone: 'Yetkazish hududi', address: 'Manzil' };
const TIME_CHIPS = ['Hozir', 'Ertalab', 'Tushdan keyin', 'Kechqurun 18:00 dan keyin'];

function toBody(f: Form, extra: Record<string, unknown> = {}) {
  return {
    lines: f.lines.filter((l) => l.sku_id).map((l) => ({ sku_id: l.sku_id, qty: l.qty })),
    customer_name: f.customer_name || null, customer_phone: f.customer_phone || null, delivery_zone_id: f.delivery_zone_id || null,
    address: { district: f.district || undefined, street: f.street || undefined, house: f.house || undefined, landmark: f.landmark || undefined },
    address_later: f.address_later, contact_time: f.contact_time || null, note: f.note || null, placement_id: f.placement_id || null, ...extra,
  };
}
function fromDraft(d: any): Form {
  const slugOf = (sku: string) => d.quote?.lines?.find((l: any) => l.sku_id === sku)?.product?.slug ?? '';
  return {
    lines: (d.lines ?? []).map((l: any) => ({ sku_id: l.sku_id, qty: l.qty, slug: slugOf(l.sku_id) })),
    customer_name: d.customer_name ?? '', customer_phone: d.customer_phone ?? '', delivery_zone_id: d.delivery_zone_id ?? '',
    district: d.address?.district ?? '', street: d.address?.street ?? '', house: d.address?.house ?? '', landmark: d.address?.landmark ?? '',
    address_later: !!d.address_later, contact_time: d.contact_time ?? '', note: d.note ?? '', placement_id: d.placement_id ?? '',
  };
}

export default function OrderStudio() {
  const { lang } = useI18n();
  const [mode, setMode] = useState<'manual' | 'message' | 'link'>('manual');
  const [f, setF] = useState<Form>(EMPTY);
  const [draft, setDraft] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [placements, setPlacements] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [msgText, setMsgText] = useState('');
  const [parsed, setParsed] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<any>(null);
  draftRef.current = draft;

  // Initial load: ?draft=<id> continues a stopped order (V2 §08), ?product=<slug>&sku=<id> starts from the market card.
  useEffect(() => {
    api('/partner/products').then((r) => setProducts(r.items)).catch((e) => setErr(e.code));
    api('/delivery-zones').then((r) => setZones(r.items)).catch(() => {});
    api('/partner/placements').then((r) => setPlacements(r.items)).catch(() => {});
    const q = new URLSearchParams(location.search);
    const id = q.get('draft');
    if (id) api(`/partner/drafts/${id}`).then((d) => { setDraft(d); setF(fromDraft(d)); if (d.fill_status === 'shared') setMode('link'); }).catch((e) => setErr(e.code));
    else if (q.get('product')) setF((x) => ({ ...x, lines: [{ slug: q.get('product')!, sku_id: q.get('sku') ?? '', qty: 1 }] }));
    else setF((x) => ({ ...x, lines: [{ slug: '', sku_id: '', qty: 1 }] }));
  }, []);

  const persist = useCallback(async (form: Form) => {
    setSave('saving');
    try {
      const cur = draftRef.current;
      const d = cur
        ? await api(`/partner/drafts/${cur.id}`, { method: 'PATCH', body: { ...toBody(form), expected_version: cur.version } })
        : await api('/partner/drafts', { method: 'POST', body: toBody(form, { source: parsed ? 'message' : 'manual' }) });
      setDraft(d);
      if (!cur) history.replaceState(null, '', `/partner/new?draft=${d.id}`);
      setSave('saved');
    } catch (e: any) {
      setSave(e.code === 'VERSION_CONFLICT' ? 'conflict' : 'error');
      if (e.code === 'DRAFT_CLOSED') setErr('Bu qoralama yopilgan (buyurtmaga aylangan yoki bekor qilingan).');
    }
  }, [parsed]);

  // Debounced autosave: nothing typed is lost if the partner switches apps to answer the customer.
  const update = (patch: Partial<Form>) => {
    setF((x) => {
      const n = { ...x, ...patch };
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      const meaningful = n.lines.some((l) => l.sku_id) || n.customer_name || n.customer_phone;
      if (meaningful) timer.current = setTimeout(() => { dirty.current = false; void persist(n); }, 700);
      return n;
    });
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const reloadDraft = async () => { if (!draft) return; const d = await api(`/partner/drafts/${draft.id}`); setDraft(d); setF(fromDraft(d)); setSave('saved'); };

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (dirty.current || !draft) { dirty.current = false; await persist(f); }
      const id = draftRef.current?.id;
      if (!id) throw { code: 'DRAFT_NOT_SAVED' };
      setResult(await api(`/partner/drafts/${id}/submit`, { method: 'POST' }));
    } catch (e: any) {
      setErr(e.code === 'DRAFT_INCOMPLETE' ? `Yetishmayapti: ${(e.details?.missing ?? []).map((m: string) => MISSING_LABEL[m] ?? m).join(', ')}` : e.code === 'SELF_ORDER_FORBIDDEN' ? 'O‘zingiz uchun buyurtma kiritib bo‘lmaydi.' : (e.code ?? 'ERROR'));
    } finally { setBusy(false); }
  };

  const makeLink = async () => {
    setErr(null); setBusy(true);
    try {
      if (dirty.current || !draftRef.current) { dirty.current = false; await persist(f); }
      setShare(await api(`/partner/drafts/${draftRef.current.id}/share`, { method: 'POST', body: { hours: 72 } }));
    } catch (e: any) { setErr(e.code === 'DRAFT_INCOMPLETE' ? 'Avval mahsulotni tanlang.' : e.code ?? 'ERROR'); } finally { setBusy(false); }
  };

  const runParse = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api('/partner/drafts/parse', { method: 'POST', body: { text: msgText } });
      setParsed(r);
      const patch: Partial<Form> = {};
      if (r.product) patch.lines = [{ slug: r.product.value.slug, sku_id: r.sku?.value.sku_id ?? '', qty: r.qty?.value ?? 1 }];
      if (r.phone) patch.customer_phone = r.phone.value;
      if (r.contact_time) patch.contact_time = r.contact_time.value;
      if (r.address_later) patch.address_later = true;
      update(patch);
    } catch (e: any) { setErr(e.code ?? 'ERROR'); } finally { setBusy(false); }
  };

  const quote = draft?.quote && !draft.quote.error ? draft.quote : null;
  const missing: string[] = draft?.missing ?? ['product', 'customer_name', 'customer_phone', 'delivery_zone', 'address'];

  if (result) return (
    <div className="card studio-done">
      <div className="sd-icon" aria-hidden>✅</div>
      <h1>Buyurtma yaratildi</h1>
      <p>Mijozga ({result.customer_phone_masked ?? 'telefoniga'}) SMS kod va havola yuborildi. Mijoz tasdiqlagach, operator ko‘rib chiqadi va jo‘natadi.</p>
      <p className="muted small">Komissiya faqat mahsulot yetkazilib, pul tushgandan keyin «Yechish mumkin» bo‘ladi.</p>
      {result.dev_customer_link_token && <p className="badge test">DEMO: mijoz havolasi <a href={`/confirm/${result.dev_customer_link_token}`}>/confirm/…</a> · kod <code>{result.dev_customer_code}</code></p>}
      <div className="row">
        <Link className="btn" href={`/partner/orders/${result.order_id}`}>Sotuv pasporti</Link>
        <button className="btn secondary" onClick={() => { location.href = '/partner/new'; }}>+ Yana buyurtma</button>
      </div>
    </div>
  );

  return (
    <div className="studio">
      <div className="studio-head">
        <h1>Mijoz uchun buyurtma</h1>
        <span className={`save-state s-${save}`} role="status" aria-live="polite">
          {save === 'saving' ? 'Saqlanmoqda…' : save === 'saved' ? 'Qoralama saqlandi ✓' : save === 'error' ? 'Saqlanmadi — internetni tekshiring' : save === 'conflict' ? <>Boshqa oynada o‘zgartirilgan · <button className="link-btn" onClick={reloadDraft}>Yangilash</button></> : ''}
        </span>
      </div>

      <div className="seg" role="tablist" aria-label="Buyurtma kiritish usuli">
        {([['manual', 'Qo‘lda kiritish'], ['message', 'Xabardan'], ['link', 'Mijoz o‘zi to‘ldirsin']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={mode === k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}

      <div className="studio-grid">
        <div className="studio-main">
          {mode === 'message' && (
            <section className="card">
              <h2>Mijoz xabarini joylang</h2>
              <p className="muted small">Telegram yoki Instagram’dagi xabarni nusxalab qo‘ying. Tizim telefon, mahsulot, soni va qulay vaqtni topadi — siz tekshirasiz.</p>
              <label htmlFor="msg" className="sr-only">Mijoz xabari</label>
              <textarea id="msg" rows={4} value={msgText} onChange={(e) => setMsgText(e.target.value)} placeholder="Masalan: Smart soat qorasidan 1 ta kerak, tel 90 123 45 67, kechqurun qo‘ng‘iroq qiling" />
              <button className="btn" disabled={busy || msgText.trim().length < 2} onClick={runParse}>Ajratib olish</button>
              {parsed && (
                <ul className="parse-list">
                  {(['product', 'sku', 'qty', 'phone', 'contact_time', 'address_later'] as const).filter((k) => parsed[k]).map((k) => (
                    <li key={k} className={parsed[k].confidence === 'check' ? 'check' : 'ok'}>
                      <b>{({ product: 'Mahsulot', sku: 'Variant', qty: 'Soni', phone: 'Telefon', contact_time: 'Aloqa vaqti', address_later: 'Manzil' } as Record<string, string>)[k]}:</b>{' '}
                      {k === 'product' ? pick(parsed.product.value.name, lang) : k === 'sku' ? Object.values(parsed.sku.value.variant).join(' / ') || 'yagona' : k === 'address_later' ? 'keyin aniqlanadi' : String(parsed[k].value)}
                      <span className="muted small"> · «{parsed[k].snippet}»</span>
                      {parsed[k].note && <div className="small warn-t">{parsed[k].note}</div>}
                    </li>
                  ))}
                  {parsed.warnings.map((w: string) => <li key={w} className="check">{w}</li>)}
                </ul>
              )}
            </section>
          )}

          <section className="card">
            <h2>Mahsulot</h2>
            {f.lines.map((l, i) => (
              <LineEditor key={i} line={l} products={products} lang={lang}
                onChange={(nl) => update({ lines: f.lines.map((x, j) => (j === i ? nl : x)) })}
                onRemove={f.lines.length > 1 ? () => update({ lines: f.lines.filter((_, j) => j !== i) }) : undefined} />
            ))}
            <button className="link-btn" onClick={() => setF((x) => ({ ...x, lines: [...x.lines, { slug: '', sku_id: '', qty: 1 }] }))}>+ Yana mahsulot qo‘shish</button>
          </section>

          {mode === 'link' ? (
            <section className="card">
              <h2>Mijozga havola yuboring</h2>
              <p className="muted small">Mijoz ismi, telefoni va manzilini o‘zi kiritadi, so‘ng SMS kod bilan tasdiqlaydi. Havolada shaxsiy ma’lumot yo‘q, 72 soat amal qiladi va istalgan payt bekor qilinadi.</p>
              {share || draft?.fill_status === 'shared' ? (
                <>
                  {share ? <LinkBox url={share.url} shareText="Buyurtmangizni tasdiqlash uchun ma’lumotlaringizni kiriting" /> : <p className="notice">Havola yuborilgan. Mijoz to‘ldirishini kutyapmiz.</p>}
                  <button className="btn secondary sm" onClick={async () => { await api(`/partner/drafts/${draftRef.current.id}/revoke-link`, { method: 'POST' }).catch(() => {}); setShare(null); await reloadDraft(); }}>Havolani bekor qilish</button>
                </>
              ) : <button className="btn" disabled={busy || !f.lines.some((l) => l.sku_id)} onClick={makeLink}>Havola yaratish</button>}
            </section>
          ) : (
            <>
              <section className="card">
                <h2>Mijoz</h2>
                <label htmlFor="cn">Ismi</label>
                <input id="cn" value={f.customer_name} onChange={(e) => update({ customer_name: e.target.value })} autoComplete="off" />
                <label htmlFor="cp">Telefon raqami</label>
                <input id="cp" type="tel" inputMode="tel" value={f.customer_phone} onChange={(e) => update({ customer_phone: e.target.value })} placeholder="+998 90 123 45 67" autoComplete="off" />
                <label>Qachon qo‘ng‘iroq qilish qulay?</label>
                <div className="chips">{TIME_CHIPS.map((c) => <button type="button" key={c} className={`chip ${f.contact_time === c ? 'on' : ''}`} aria-pressed={f.contact_time === c} onClick={() => update({ contact_time: f.contact_time === c ? '' : c })}>{c}</button>)}</div>
                {placements.length > 0 && (
                  <>
                    <label htmlFor="src">Mijoz qaysi reklamadan keldi?</label>
                    <select id="src" value={f.placement_id} onChange={(e) => update({ placement_id: e.target.value })}>
                      <option value="">Bilmayman / manba ajratilmagan</option>
                      {placements.map((p) => <option key={p.id} value={p.id}>{p.link_name} · {p.name}</option>)}
                    </select>
                  </>
                )}
                <label htmlFor="ct" className="sr-only">Aloqa vaqti</label>
                <input id="ct" value={f.contact_time} onChange={(e) => update({ contact_time: e.target.value })} placeholder="Yoki o‘zingiz yozing: masalan, 19:00 dan keyin" />
              </section>
              <section className="card">
                <h2>Yetkazish</h2>
                <label htmlFor="zone">Hudud</label>
                <select id="zone" value={f.delivery_zone_id} onChange={(e) => update({ delivery_zone_id: e.target.value })}>
                  <option value="">— tanlang —</option>
                  {zones.map((z) => <option key={z.id} value={z.id}>{pick(z.name, lang) || z.region_code}{z.tariff_minor ? ` · ${som(z.tariff_minor)}` : ''}</option>)}
                </select>
                <label className="check-row"><input type="checkbox" checked={f.address_later} onChange={(e) => update({ address_later: e.target.checked })} /> Manzil keyin aniqlanadi</label>
                {f.address_later ? <p className="muted small">Qoralama saqlanadi, lekin manzil kiritilmaguncha buyurtma yuborilmaydi.</p> : (
                  <div className="addr-grid">
                    <div><label htmlFor="ad">Tuman</label><input id="ad" value={f.district} onChange={(e) => update({ district: e.target.value })} /></div>
                    <div><label htmlFor="as">Ko‘cha / mahalla</label><input id="as" value={f.street} onChange={(e) => update({ street: e.target.value })} /></div>
                    <div><label htmlFor="ah">Uy</label><input id="ah" value={f.house} onChange={(e) => update({ house: e.target.value })} /></div>
                    <div><label htmlFor="al">Mo‘ljal</label><input id="al" value={f.landmark} onChange={(e) => update({ landmark: e.target.value })} /></div>
                  </div>
                )}
                <label htmlFor="nt">Izoh (operator uchun)</label>
                <input id="nt" value={f.note} onChange={(e) => update({ note: e.target.value })} />
              </section>
            </>
          )}
        </div>

        <aside className="studio-side card" aria-label="Hisob">
          <h2>Hisob</h2>
          {quote ? (
            <>
              {quote.lines.map((l: any) => <div key={l.sku_id} className="sum-row"><span>{pick(l.product?.name, lang)} × {l.qty}</span><b>{som(l.line_total.amount_minor)}</b></div>)}
              <div className="sum-row"><span>Yetkazish{quote.zone_assumed ? ' (taxminiy)' : ''}</span><b>{som(quote.delivery.amount_minor)}</b></div>
              <div className="sum-row total"><span>Mijoz to‘laydi</span><b>{som(quote.payable.amount_minor)}</b></div>
              <div className="earn-box"><span>Sizning komissiyangiz (taxminiy)</span><b>{som(quote.commission_estimate_minor)}</b><small>Yetkazilib, pul tushgach hisobingizga o‘tadi</small></div>
            </>
          ) : draft?.quote?.error ? <p className="notice">Narxni hisoblab bo‘lmadi: {draft.quote.error === 'OUT_OF_STOCK' ? 'omborda yetarli emas' : draft.quote.error}</p> : <p className="muted">Mahsulotni tanlang — narx shu yerda chiqadi.</p>}
          {mode !== 'link' && (
            <>
              {missing.length > 0 && <div className="missing"><b>Yetishmayapti:</b> {missing.map((m) => MISSING_LABEL[m] ?? m).join(', ')}</div>}
              {draft && missing.length === 0 && <HoldBox draft={draft} onChange={reloadDraft} />}
              <button className="btn big full" disabled={busy || missing.length > 0} onClick={submit}>Buyurtmani yuborish</button>
              <p className="muted small">Mijozga SMS kod boradi. Mijoz tasdiqlamaguncha buyurtma jo‘natilmaydi. Mijozdan karta yoki bank kodlarini hech qachon so‘ramang.</p>
            </>
          )}
          {draft && <button className="link-btn small" onClick={async () => { if (confirm('Qoralama bekor qilinsinmi?')) { await api(`/partner/drafts/${draft.id}`, { method: 'DELETE' }).catch(() => {}); location.href = '/partner/orders?tab=drafts'; } }}>Qoralamani bekor qilish</button>}
        </aside>
      </div>
    </div>
  );
}

/** Short hold (V2 §09): a real reservation on the server, with a visible countdown; not just a timer picture. */
function HoldBox({ draft, onChange }: { draft: any; onChange: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = draft.hold ? Math.max(0, new Date(draft.hold.expires_at).getTime() - now) : 0;
  useEffect(() => { if (draft.hold && left === 0) onChange(); }, [left === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  const act = async (fn: () => Promise<any>) => {
    setErr(null); setBusy(true);
    try { await fn(); onChange(); } catch (e: any) { setErr(e.code === 'HOLD_LIMIT' ? `Bir vaqtda ${e.details?.max ?? ''} tadan ortiq bron qilib bo‘lmaydi` : e.code === 'OUT_OF_STOCK' ? 'Omborda yetarli emas' : e.code === 'POLICY_NOT_SET' ? 'Bron qoidasi hali admin tomonidan belgilanmagan' : e.code ?? 'ERROR'); } finally { setBusy(false); }
  };
  if (draft.hold && left > 0) return (
    <div className="hold-box on" role="status">
      <b>🔒 Mahsulot siz uchun bron qilindi: {mm}:{String(ss).padStart(2, '0')}</b>
      <small>Shu vaqt ichida buyurtmani yuboring. Vaqt tugasa, mahsulot boshqalarga ochiladi.</small>
      <button className="link-btn small" disabled={busy} onClick={() => act(() => api(`/partner/drafts/${draft.id}/hold`, { method: 'DELETE' }))}>Bronni bekor qilish</button>
    </div>
  );
  return (
    <div className="hold-box">
      <button className="btn secondary full" disabled={busy} onClick={() => act(() => api(`/partner/drafts/${draft.id}/hold`, { method: 'POST' }))}>🔒 Mijoz o‘ylab turguncha bron qilish</button>
      <small className="muted">Mahsulot qisqa vaqtga (DEMO: 15 daqiqa) faqat siz uchun ushlab turiladi.</small>
      {err && <div className="field-error" role="alert">{err}</div>}
    </div>
  );
}

function LineEditor({ line, products, lang, onChange, onRemove }: { line: Line; products: any[]; lang: any; onChange: (l: Line) => void; onRemove?: () => void }) {
  const [variants, setVariants] = useState<any[]>([]);
  useEffect(() => {
    if (!line.slug) { setVariants([]); return; }
    api(`/products/${line.slug}`).then((p) => {
      const v = p.variants ?? [];
      setVariants(v);
      if (!line.sku_id && v.length === 1) onChange({ ...line, sku_id: v[0].sku_id });
    }).catch(() => setVariants([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.slug]);
  const sel = variants.find((v) => v.sku_id === line.sku_id);
  return (
    <div className="line-ed">
      <label className="sr-only" htmlFor={`lp-${line.slug}`}>Mahsulot</label>
      <select id={`lp-${line.slug}`} value={line.slug} onChange={(e) => onChange({ slug: e.target.value, sku_id: '', qty: line.qty })}>
        <option value="">— mahsulot tanlang —</option>
        {products.map((p) => <option key={p.id} value={p.slug}>{pick(p.name, lang)}{p.min_price_minor ? ` · ${som(p.min_price_minor)}` : ''}</option>)}
      </select>
      {variants.length > 1 && (
        <div className="chips" role="group" aria-label="Variant">
          {variants.map((v) => (
            <button type="button" key={v.sku_id} disabled={v.available <= 0} className={`chip ${line.sku_id === v.sku_id ? 'on' : ''}`} aria-pressed={line.sku_id === v.sku_id} onClick={() => onChange({ ...line, sku_id: v.sku_id })}>
              {Object.values(v.variant ?? {}).join(' / ') || v.sku_code}{v.available <= 0 ? ' · tugagan' : ''}
            </button>
          ))}
        </div>
      )}
      <div className="qty-row">
        <span>Soni</span>
        <button type="button" className="qbtn" aria-label="Kamaytirish" onClick={() => onChange({ ...line, qty: Math.max(1, line.qty - 1) })}>−</button>
        <b aria-live="polite">{line.qty}</b>
        <button type="button" className="qbtn" aria-label="Ko‘paytirish" onClick={() => onChange({ ...line, qty: Math.min(99, line.qty + 1) })}>+</button>
        {sel && <span className={sel.available > 3 ? 'muted small' : 'warn-t small'}>Omborda: {sel.available} ta</span>}
        {onRemove && <button type="button" className="link-btn small" onClick={onRemove}>O‘chirish</button>}
      </div>
    </div>
  );
}
