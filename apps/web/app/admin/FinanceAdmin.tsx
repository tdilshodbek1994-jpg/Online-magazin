'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText, stText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const RS: Record<string, [string, string]> = { submitted: ['Kassada tekshirilishi kerak', 'b-new'], discrepancy: ['Farq bor', 'b-returned'], reconciled: ['Solishtirildi ✓', 'b-delivered'] };
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

/** Admin «Moliya»: courier cash hand-ins (COD remittances) and finance exceptions — plain language, cards, inline actions. */
export function FinanceAdmin() {
  const [rem, setRem] = useState<any[] | null>(null);
  const [ex, setEx] = useState<any[] | null>(null);
  const [f, setF] = useState<'submitted' | 'discrepancy' | 'reconciled' | 'all'>('submitted');
  const [open, setOpen] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [limit, setLimit] = useState(15);
  const load = useCallback(() => {
    api('/finance/remittances').then((r) => setRem(r.items)).catch((e) => toast(errText(e), 'err'));
    api('/finance/exceptions').then((r) => setEx(r.items)).catch(() => setEx([]));
  }, []);
  useEffect(load, [load]);
  if (!rem) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const by = (s: string) => rem.filter((r) => r.status === s);
  const sum = (xs: any[], k: string) => xs.reduce((a, r) => a + BigInt(r[k] ?? 0), 0n).toString();
  const list = (f === 'all' ? rem : by(f)).slice(0, limit);
  const confirm = async (r: any) => {
    const v = val.replace(/\D/g, '');
    if (!v) return;
    try { const x = await api(`/finance/remittances/${r.id}/confirm`, { method: 'POST', body: { received_minor: String(BigInt(v) * 100n) } }); toast(x.status === 'discrepancy' ? 'Saqlandi — summada farq bor, istisnolar ro‘yxatiga tushdi' : '✓ Solishtirildi, buyurtmalar «to‘langan» bo‘ldi'); setOpen(null); load(); }
    catch (e) { toast(errText(e), 'err'); }
  };
  const openEx = (ex ?? []).filter((x) => x.status === 'open');
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <h2>💵 Kuryerlardan naqd pul</h2>
      <p className="muted small">Kuryer yetkazgan buyurtmalar pulini kassaga topshiradi. Siz kassaga haqiqatan tushgan summani kiritasiz — shundan keyingina buyurtma «to‘langan» bo‘ladi va hamkor komissiyasi ochiladi.</p>
      <div className="fin-sum">
        <button type="button" className={f === 'submitted' ? 'on' : ''} onClick={() => setF('submitted')}><b>{by('submitted').length}</b><span>Tekshirish kerak</span><small>{som(sum(by('submitted'), 'expected_minor'))}</small></button>
        <button type="button" className={f === 'discrepancy' ? 'on warn' : 'warn'} onClick={() => setF('discrepancy')}><b>{by('discrepancy').length}</b><span>Farq bor</span><small>{som(sum(by('discrepancy'), 'expected_minor'))}</small></button>
        <button type="button" className={f === 'reconciled' ? 'on' : ''} onClick={() => setF('reconciled')}><b>{by('reconciled').length}</b><span>Solishtirilgan</span><small>{som(sum(by('reconciled'), 'received_minor'))}</small></button>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="link-btn small" onClick={() => setF('all')}>Hammasini ko‘rsatish ({rem.length})</button></div>
      {list.length === 0 && <div className="empty small">Bu ro‘yxat bo‘sh.</div>}
      <div className="fin-list">
        {list.map((r) => {
          const [label, cls] = RS[r.status] ?? [stText(r.status), ''];
          const diff = r.received_minor !== null ? BigInt(r.received_minor) - BigInt(r.expected_minor) : null;
          const declaredDiff = BigInt(r.declared_minor) !== BigInt(r.expected_minor);
          return (
            <article key={r.id} className="card fin-card">
              <div className="spread"><b>{r.courier_name}</b><span className={`pill ${cls}`}>{label}</span></div>
              <div className="small muted">{dt(r.created_at)} · {r.orders} ta buyurtma{r.order_numbers?.length ? ` (${r.order_numbers.slice(0, 3).join(', ')}${r.order_numbers.length > 3 ? '…' : ''})` : ''}</div>
              <dl className="w-money">
                <div><dt>Buyurtmalar bo‘yicha kerak</dt><dd>{som(r.expected_minor)}</dd></div>
                {declaredDiff && <div><dt>Kuryer aytgan summa</dt><dd className="danger-t">{som(r.declared_minor)}</dd></div>}
                {r.received_minor !== null && <div><dt>Kassaga tushdi</dt><dd>{som(r.received_minor)}</dd></div>}
                {diff !== null && diff !== 0n && <div><dt>Farq</dt><dd className="danger-t">{diff > 0n ? '+' : '−'}{som((diff > 0n ? diff : -diff).toString())}</dd></div>}
              </dl>
              {r.confirmed_at && <div className="small muted">Tekshirdi: {r.confirmed_by_name ?? '—'} · {dt(r.confirmed_at)}{r.note ? ` · ${r.note}` : ''}</div>}
              {r.status === 'submitted' && (open === r.id ? (
                <div className="tr-form">
                  <label htmlFor={`fin-${r.id}`}>Kassaga haqiqatan tushgan summa (so‘m)</label>
                  <input id={`fin-${r.id}`} inputMode="numeric" autoFocus value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d\s]/g, ''))} />
                  <div className="row" style={{ gap: 8 }}><button className="btn sm" disabled={!val.replace(/\D/g, '')} onClick={() => confirm(r)}>Tasdiqlash</button><button className="btn secondary sm" onClick={() => setOpen(null)}>Bekor</button></div>
                </div>
              ) : <button className="btn sm" onClick={() => { setOpen(r.id); setVal(String(BigInt(r.expected_minor) / 100n)); }}>Kassaga tushganini kiritish</button>)}
            </article>
          );
        })}
      </div>
      {(f === 'all' ? rem.length : by(f).length) > limit && <button className="btn secondary sm" onClick={() => setLimit(limit + 20)}>Yana ko‘rsatish</button>}

      <h2 style={{ marginTop: 18 }}>⚠️ Moliyaviy muammolar {openEx.length ? `(${openEx.length} ochiq)` : ''}</h2>
      <p className="muted small">Pul bo‘yicha avtomatik hal bo‘lmagan holatlar: naqd pulda farq, ortiqcha to‘lov va h.k. Har birini tekshirib, nima qilinganini yozib yopasiz.</p>
      {ex && ex.length === 0 && <div className="empty small">Muammo yo‘q ✓</div>}
      <div className="fin-list">
        {(ex ?? []).slice(0, 30).map((x) => (
          <article key={x.id} className="card fin-card">
            <div className="spread"><b>{stText(x.kind)}</b><span className={`pill ${x.status === 'open' ? 'b-returned' : 'b-delivered'}`}>{x.status === 'open' ? 'Ochiq' : 'Yopilgan'}</span></div>
            <div className="small muted">{dt(x.created_at)}{x.amount_minor !== null ? ` · ${som(String(x.amount_minor).replace('-', ''))}${String(x.amount_minor).startsWith('-') ? ' kam' : ''}` : ''}</div>
            {x.resolution && <div className="small">Yechim: {x.resolution}</div>}
            {x.status === 'open' && <ResolveBox id={x.id} onDone={load} />}
          </article>
        ))}
      </div>
    </section>
  );
}

function ResolveBox({ id, onDone }: { id: string; onDone: () => void }) {
  const [t, setT] = useState('');
  const [on, setOn] = useState(false);
  if (!on) return <button className="btn secondary sm" onClick={() => setOn(true)}>Hal qilindi deb yopish</button>;
  return (
    <div className="tr-form">
      <textarea aria-label="Yechim" rows={2} placeholder="Nima qilindi (kamida 10 belgi): masalan, kuryer qolgan 50 000 so‘mni topshirdi" value={t} onChange={(e) => setT(e.target.value)} />
      <div className="row" style={{ gap: 8 }}><button className="btn sm" disabled={t.trim().length < 10} onClick={async () => { try { await api(`/finance/exceptions/${id}/resolve`, { method: 'POST', body: { resolution: t } }); toast('✓ Yopildi'); onDone(); } catch (e) { toast(errText(e), 'err'); } }}>Yopish</button><button className="btn secondary sm" onClick={() => setOn(false)}>Bekor</button></div>
    </div>
  );
}
