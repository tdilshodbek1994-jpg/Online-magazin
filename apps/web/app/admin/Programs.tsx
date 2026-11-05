'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';

const toMinor = (v: string) => String(BigInt(v.replace(/\D/g, '') || '0') * 100n);
const digits = (v: string) => v.replace(/\D/g, '');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const plusDays = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(Date.now() + n * 86400000));
const ERR: Record<string, string> = {
  STEP_UP_REQUIRED: 'Pul bilan bog‘liq amal uchun himoya kodi kerak — avval «MFA» bo‘limida Google Authenticator’ni ulang.',
  CONTEST_WINDOW_INVALID: 'Tugash sanasi boshlanishdan keyin bo‘lsin.', CHARITY_FUND_INSUFFICIENT: 'Qutida bunchalik mablag‘ yo‘q.',
  VALIDATION_FAILED: 'Maydonlarni to‘g‘ri to‘ldiring.', ORDER_NOT_FOUND: 'Bu hamkorga tegishli bunday buyurtma topilmadi.',
};
const medal = (r: number) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);

export function AdminPrograms() {
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sec, setSec] = useState('contests');
  const load = useCallback(() => api('/admin/programs').then(setD).catch((e) => setMsg(errText(e))), []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<any>, ok: string) => { setMsg(null); try { await fn(); setMsg(`✓ ${ok}`); await load(); return true; } catch (e: any) { setMsg(ERR[e.code] ?? errText(e)); return false; } };
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return (
    <section style={{ marginTop: 12 }}>
      <div className="chips" role="tablist">{[['contests', '🏆 Konkurslar'], ['bonus', '🎁 Bonuslar'], ['penalty', '⚠️ Jarimalar'], ['charity', '💝 Hayriya qutisi']].map(([k, l]) => <button key={k} role="tab" aria-selected={sec === k} className={`chip ${sec === k ? 'on' : ''}`} onClick={() => setSec(k!)}>{l}</button>)}</div>
      {msg && <div className="notice" role="status">{msg}</div>}
      {sec === 'contests' && <Contests d={d} act={act} />}
      {sec === 'bonus' && <Bonuses d={d} act={act} />}
      {sec === 'penalty' && <Penalties d={d} act={act} />}
      {sec === 'charity' && <Charity d={d} act={act} />}
    </section>
  );
}

type Act = (fn: () => Promise<any>, ok: string) => Promise<boolean>;

function Contests({ d, act }: { d: any; act: Act }) {
  const [f, setF] = useState({ title: '', description: '', start: today(), end: plusDays(30), metric: 'delivered_orders', min: '1' });
  const [prizes, setPrizes] = useState([{ place: 1, text: '', amount: '' }]);
  return (
    <>
      <details className="card" open={d.contests.length === 0}>
        <summary><b>+ Yangi konkurs</b></summary>
        <label htmlFor="c-t">Nomi</label><input id="c-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Masalan: Kuzgi savdo poygasi" />
        <label htmlFor="c-d">Shartlari (hamkorlar ko‘radi)</label><textarea id="c-d" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="ed-two">
          <div><label htmlFor="c-s">Boshlanishi</label><input id="c-s" type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></div>
          <div><label htmlFor="c-e">Tugashi</label><input id="c-e" type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></div>
        </div>
        <div className="ed-two">
          <div><label htmlFor="c-m">G‘olib nimaga qarab</label><select id="c-m" value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}><option value="delivered_orders">Yetkazilgan buyurtmalar soni</option><option value="delivered_sales">Yetkazilgan savdo summasi</option></select></div>
          <div><label htmlFor="c-min">Kamida (yetkazilgan)</label><input id="c-min" inputMode="numeric" value={f.min} onChange={(e) => setF({ ...f, min: digits(e.target.value) })} /></div>
        </div>
        <b style={{ display: 'block', marginTop: 10 }}>Sovrinlar</b>
        {prizes.map((p, i) => (
          <div key={i} className="ed-grid">
            <div><label htmlFor={`pz-t-${i}`}>{medal(p.place)} {p.place}-o‘rin — sovg‘a</label><input id={`pz-t-${i}`} value={p.text} onChange={(e) => setPrizes(prizes.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} placeholder="Telefon, sertifikat…" /></div>
            <div><label htmlFor={`pz-a-${i}`}>Pul (so‘m, ixtiyoriy)</label><input id={`pz-a-${i}`} inputMode="numeric" value={p.amount} onChange={(e) => setPrizes(prizes.map((x, k) => (k === i ? { ...x, amount: digits(e.target.value) } : x)))} /></div>
          </div>
        ))}
        <button type="button" className="btn secondary sm" onClick={() => setPrizes([...prizes, { place: prizes.length + 1, text: '', amount: '' }])}>+ Sovrin</button>
        <button className="btn" style={{ marginTop: 10, width: '100%' }} disabled={f.title.trim().length < 3} onClick={() => act(() => api('/admin/contests', { method: 'POST', body: {
          title: f.title.trim(), description: f.description.trim() || undefined, starts_at: new Date(`${f.start}T00:00:00+05:00`).toISOString(), ends_at: new Date(`${f.end}T23:59:59+05:00`).toISOString(),
          metric: f.metric, min_delivered: Number(f.min || '0'), prizes: prizes.filter((p) => p.text.trim() || p.amount).map((p) => ({ place: p.place, ...(p.text.trim() ? { text: p.text.trim() } : {}), ...(p.amount ? { amount_minor: toMinor(p.amount) } : {}) })),
        } }), 'Konkurs e’lon qilindi')}>Konkursni e’lon qilish</button>
      </details>
      <div className="slist" style={{ marginTop: 10 }}>
        {d.contests.map((c: any) => (
          <article key={c.id} className="scard">
            <div className="spread"><h3>{c.title}</h3><span className={`pill ${c.status === 'active' ? 'b-delivered' : c.status === 'finished' ? 'b-accepted' : 'b-cancelled'}`}>{c.status === 'active' ? 'Faol' : c.status === 'finished' ? 'Yakunlangan' : 'Bekor'}</span></div>
            <div className="muted small">{new Date(c.starts_at).toLocaleDateString('uz-UZ')} — {new Date(c.ends_at).toLocaleDateString('uz-UZ')} · {c.metric === 'delivered_sales' ? 'savdo summasi' : 'buyurtmalar soni'}</div>
            {c.prizes?.length > 0 && <div className="pills">{c.prizes.map((p: any) => <span key={p.place} className="pill">{medal(p.place)} {p.text ?? ''} {p.amount_minor ? som(p.amount_minor) : ''}</span>)}</div>}
            {c.board.length === 0 ? <p className="muted small">Hali ishtirokchi yo‘q</p> : <ol className="top-list">{c.board.slice(0, 5).map((r: any) => <li key={r.pid}><span className="top-rank">{medal(r.rank)}</span><span className="top-name">{r.display_name}</span><span className="top-val"><b>{c.metric === 'delivered_sales' ? som(r.score) : r.delivered}</b></span></li>)}</ol>}
            <div className="row" style={{ gap: 8 }}>
              {c.status === 'active' && <button className="btn sm" onClick={() => { if (confirm('Konkurs yakunlansinmi? G‘oliblar qotiriladi.')) void act(() => api(`/admin/contests/${c.id}/finish`, { method: 'POST' }), 'Konkurs yakunlandi'); }}>Yakunlash</button>}
              {c.status === 'active' && <button className="btn secondary sm" onClick={() => { if (confirm('Konkurs bekor qilinsinmi?')) void act(() => api(`/admin/contests/${c.id}/cancel`, { method: 'POST' }), 'Bekor qilindi'); }}>Bekor qilish</button>}
              {c.status === 'finished' && c.prizes.some((p: any) => p.amount_minor) && !c.prizes_paid_at && <button className="btn sm" onClick={() => act(() => api(`/admin/contests/${c.id}/pay-prizes`, { method: 'POST' }), 'Pul sovrinlari g‘oliblar hisobiga o‘tkazildi')}>💰 Sovrinlarni hisobga o‘tkazish</button>}
              {c.prizes_paid_at && <span className="pill b-delivered">Sovrinlar to‘langan</span>}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function Bonuses({ d, act }: { d: any; act: Act }) {
  const [f, setF] = useState({ name: '', period: 'month', threshold: '', amount: '' });
  const [m, setM] = useState({ partner: '', amount: '', reason: '' });
  const [prev, setPrev] = useState<Record<string, any>>({});
  return (
    <>
      <details className="card" open={d.bonus_rules.length === 0}>
        <summary><b>+ Yangi bonus rejasi</b></summary>
        <label htmlFor="b-n">Nomi</label><input id="b-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Masalan: Oyiga 50 ta" />
        <div className="ed-grid">
          <div><label htmlFor="b-p">Davr</label><select id="b-p" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}><option value="month">Har oy</option><option value="week">Har hafta</option></select></div>
          <div><label htmlFor="b-t">Kamida yetkazilgan</label><input id="b-t" inputMode="numeric" value={f.threshold} onChange={(e) => setF({ ...f, threshold: digits(e.target.value) })} /></div>
          <div><label htmlFor="b-a">Bonus (so‘m)</label><input id="b-a" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: digits(e.target.value) })} /></div>
        </div>
        <button className="btn" style={{ marginTop: 10, width: '100%' }} disabled={f.name.trim().length < 3 || !f.threshold || !f.amount} onClick={() => act(() => api('/admin/bonus-rules', { method: 'POST', body: { name: f.name.trim(), period: f.period, threshold_delivered: Number(f.threshold), amount_minor: toMinor(f.amount) } }), 'Bonus rejasi qo‘shildi')}>Saqlash</button>
      </details>
      <div className="slist" style={{ marginTop: 10 }}>
        {d.bonus_rules.map((r: any) => (
          <article key={r.id} className="scard">
            <div className="spread"><h3>{r.name}</h3><span className={`pill ${r.active ? 'b-delivered' : 'b-cancelled'}`}>{r.active ? 'Faol' : 'O‘chirilgan'}</span></div>
            <div className="small">{r.period === 'month' ? 'Har oy' : 'Har hafta'} ≥ {r.threshold_delivered} ta yetkazilgan → <b>{som(r.amount_minor)}</b></div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary sm" onClick={() => api(`/admin/bonus-rules/${r.id}/preview`).then((p) => setPrev({ ...prev, [r.id]: p }))}>Kim bajardi?</button>
              <button className="btn secondary sm" onClick={() => act(() => api(`/admin/bonus-rules/${r.id}/active`, { method: 'POST', body: { active: !r.active } }), r.active ? 'O‘chirildi' : 'Yoqildi')}>{r.active ? 'O‘chirish' : 'Yoqish'}</button>
            </div>
            {prev[r.id] && (
              <div className="ops-lines small">
                <b>Davr: {prev[r.id].period_key} {prev[r.id].closed ? '(yakunlangan)' : '(davom etmoqda)'}</b>
                {prev[r.id].items.length === 0 ? <span className="muted">Hali hech kim shartni bajarmagan.</span> : prev[r.id].items.map((x: any) => <div key={x.partner_id} className="spread"><span>{x.name} ({x.code}) — {x.delivered} ta</span><span>{x.awarded ? '✅ berilgan' : '⏳'}</span></div>)}
                {prev[r.id].items.some((x: any) => !x.awarded) && <button className="btn sm" onClick={async () => { if (!prev[r.id].closed && !confirm('Davr hali tugamagan. Hozir berilsinmi?')) return; if (await act(() => api(`/admin/bonus-rules/${r.id}/award`, { method: 'POST', body: { period_key: prev[r.id].period_key } }), 'Bonuslar hisobga o‘tkazildi')) setPrev({ ...prev, [r.id]: undefined }); }}>💰 Bonuslarni berish</button>}
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <b>Qo‘lda bonus berish</b>
        <label htmlFor="mb-p">Hamkor</label><select id="mb-p" value={m.partner} onChange={(e) => setM({ ...m, partner: e.target.value })}><option value="">— tanlang —</option>{d.partners.map((p: any) => <option key={p.id} value={p.id}>{p.display_name} ({p.code})</option>)}</select>
        <div className="ed-two">
          <div><label htmlFor="mb-a">Summa (so‘m)</label><input id="mb-a" inputMode="numeric" value={m.amount} onChange={(e) => setM({ ...m, amount: digits(e.target.value) })} /></div>
          <div><label htmlFor="mb-r">Sabab</label><input id="mb-r" value={m.reason} onChange={(e) => setM({ ...m, reason: e.target.value })} /></div>
        </div>
        <button className="btn" style={{ marginTop: 10, width: '100%' }} disabled={!m.partner || !m.amount || m.reason.trim().length < 3} onClick={async () => { if (await act(() => api('/admin/bonuses', { method: 'POST', body: { partner_id: m.partner, amount_minor: toMinor(m.amount), reason: m.reason.trim() } }), 'Bonus berildi')) setM({ partner: '', amount: '', reason: '' }); }}>Bonus berish</button>
      </div>
      <h3 style={{ marginTop: 16 }}>So‘nggi bonuslar</h3>
      <div className="slist">{d.bonuses.map((b: any) => <div key={b.id} className="scard spread small"><div><b>{b.display_name}</b> <span className="muted">{b.code}</span><div className="muted">{b.reason} · {new Date(b.created_at).toLocaleDateString('uz-UZ')}</div></div><b className="ok-t">+{som(b.amount_minor)}</b></div>)}</div>
    </>
  );
}

function Penalties({ d, act }: { d: any; act: Act }) {
  const [r, setR] = useState({ name: '', description: '', amount: '' });
  const [p, setP] = useState({ partner: '', reason: '', amount: '', order: '', note: '' });
  const reasons = d.penalty_reasons.filter((x: any) => x.active);
  return (
    <>
      <div className="card">
        <b>Jarima berish</b>
        <label htmlFor="pn-p">Hamkor</label><select id="pn-p" value={p.partner} onChange={(e) => setP({ ...p, partner: e.target.value })}><option value="">— tanlang —</option>{d.partners.map((x: any) => <option key={x.id} value={x.id}>{x.display_name} ({x.code})</option>)}</select>
        <label htmlFor="pn-r">Sabab</label><select id="pn-r" value={p.reason} onChange={(e) => { const rr = reasons.find((x: any) => x.id === e.target.value); setP({ ...p, reason: e.target.value, amount: rr?.default_amount_minor ? String(BigInt(rr.default_amount_minor) / 100n) : p.amount }); }}><option value="">— tanlang —</option>{reasons.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <div className="ed-two">
          <div><label htmlFor="pn-a">Summa (so‘m)</label><input id="pn-a" inputMode="numeric" value={p.amount} onChange={(e) => setP({ ...p, amount: digits(e.target.value) })} /></div>
          <div><label htmlFor="pn-o">Buyurtma raqami (ixtiyoriy)</label><input id="pn-o" value={p.order} onChange={(e) => setP({ ...p, order: e.target.value.trim() })} placeholder="OM-100123" /></div>
        </div>
        <label htmlFor="pn-n">Izoh (hamkor ko‘radi)</label><input id="pn-n" value={p.note} onChange={(e) => setP({ ...p, note: e.target.value })} />
        <p className="muted small">Jarima avval «Yechish mumkin» balansdan olinadi; yetmasa qolgani ochiq qarz bo‘lib yoziladi va keyingi daromaddan qoplanadi.</p>
        <button className="btn danger" style={{ width: '100%' }} disabled={!p.partner || !p.reason || !p.amount} onClick={async () => { if (!confirm('Jarima qo‘llansinmi? Hamkorga xabar boradi.')) return; if (await act(() => api('/admin/penalties', { method: 'POST', body: { partner_id: p.partner, reason_id: p.reason, amount_minor: toMinor(p.amount), ...(p.order ? { order_number: p.order } : {}), ...(p.note ? { note: p.note } : {}) } }), 'Jarima qo‘llandi')) setP({ partner: '', reason: '', amount: '', order: '', note: '' }); }}>Jarima qo‘llash</button>
      </div>
      <details className="card" style={{ marginTop: 10 }} open={reasons.length === 0}>
        <summary><b>Jarima qoidalari ({reasons.length}) — hamkorlar ko‘radi</b></summary>
        <div className="slist">{d.penalty_reasons.map((x: any) => <div key={x.id} className="spread small"><span className={x.active ? '' : 'muted'}>{x.name}{x.default_amount_minor ? ` — ${som(x.default_amount_minor)}` : ''}</span><button className="link-btn" onClick={() => act(() => api(`/admin/penalty-reasons/${x.id}/active`, { method: 'POST', body: { active: !x.active } }), 'Saqlandi')}>{x.active ? 'O‘chirish' : 'Yoqish'}</button></div>)}</div>
        <label htmlFor="pr-n">Yangi sabab</label><input id="pr-n" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Masalan: Soxta buyurtma" />
        <div className="ed-two">
          <div><label htmlFor="pr-a">Odatiy summa (so‘m)</label><input id="pr-a" inputMode="numeric" value={r.amount} onChange={(e) => setR({ ...r, amount: digits(e.target.value) })} /></div>
          <div><label htmlFor="pr-d">Tushuntirish</label><input id="pr-d" value={r.description} onChange={(e) => setR({ ...r, description: e.target.value })} /></div>
        </div>
        <button className="btn secondary" style={{ marginTop: 8 }} disabled={r.name.trim().length < 3} onClick={async () => { if (await act(() => api('/admin/penalty-reasons', { method: 'POST', body: { name: r.name.trim(), ...(r.description ? { description: r.description } : {}), ...(r.amount ? { default_amount_minor: toMinor(r.amount) } : {}) } }), 'Qoida qo‘shildi')) setR({ name: '', description: '', amount: '' }); }}>Qoida qo‘shish</button>
      </details>
      <h3 style={{ marginTop: 16 }}>So‘nggi jarimalar</h3>
      <div className="slist">{d.penalties.map((x: any) => (
        <div key={x.id} className="scard small">
          <div className="spread"><b>{x.display_name} <span className="muted">{x.code}</span></b><b className={x.status === 'cancelled' ? 'muted' : 'no-t'}>−{som(x.amount_minor)}</b></div>
          <div className="spread"><span className="muted">{x.reason_text} · {new Date(x.created_at).toLocaleDateString('uz-UZ')}{x.status === 'cancelled' ? ' · bekor qilingan' : ''}</span>
            {x.status === 'applied' && <button className="link-btn" onClick={() => { const why = prompt('Bekor qilish sababi'); if (why && why.trim().length >= 3) void act(() => api(`/admin/penalties/${x.id}/cancel`, { method: 'POST', body: { reason: why.trim() } }), 'Jarima bekor qilindi, pul qaytarildi'); }}>Bekor qilish</button>}</div>
        </div>
      ))}</div>
    </>
  );
}

function Charity({ d, act }: { d: any; act: Act }) {
  const [h, setH] = useState({ amount: '', recipient: '', note: '' });
  const free = BigInt(d.charity.total) - BigInt(d.charity.handed);
  return (
    <>
      <div className="kpi-row">
        <div className="card kpi"><span className="muted">Jami yig‘ildi</span><b>{som(d.charity.total)}</b></div>
        <div className="card kpi"><span className="muted">Topshirildi</span><b>{som(d.charity.handed)}</b></div>
        <div className="card kpi"><span className="muted">Qutida qoldi</span><b className="ok-t">{som(free.toString())}</b></div>
        <div className="card kpi"><span className="muted">Xayriya qilganlar</span><b>{d.charity.donors}</b></div>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <b>Mablag‘ni topshirish (hamkorlar ko‘radi)</b>
        <div className="ed-two">
          <div><label htmlFor="ho-a">Summa (so‘m)</label><input id="ho-a" inputMode="numeric" value={h.amount} onChange={(e) => setH({ ...h, amount: digits(e.target.value) })} /></div>
          <div><label htmlFor="ho-r">Kimga</label><input id="ho-r" value={h.recipient} onChange={(e) => setH({ ...h, recipient: e.target.value })} placeholder="Masalan: Mehribonlik uyi №5" /></div>
        </div>
        <label htmlFor="ho-n">Izoh / hujjat</label><input id="ho-n" value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} placeholder="Kvitansiya raqami" />
        <button className="btn" style={{ marginTop: 10, width: '100%' }} disabled={!h.amount || h.recipient.trim().length < 3} onClick={async () => { if (await act(() => api('/admin/charity/handovers', { method: 'POST', body: { amount_minor: toMinor(h.amount), recipient: h.recipient.trim(), ...(h.note ? { note: h.note } : {}) } }), 'Topshirish qayd etildi')) setH({ amount: '', recipient: '', note: '' }); }}>Qayd etish</button>
      </div>
      <div className="slist" style={{ marginTop: 10 }}>{d.handovers.map((x: any) => <div key={x.id} className="scard spread small"><div><b>{x.recipient}</b><div className="muted">{new Date(x.created_at).toLocaleDateString('uz-UZ')}{x.note ? ` · ${x.note}` : ''}</div></div><b>{som(x.amount_minor)}</b></div>)}</div>
    </>
  );
}
