'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LinkBox } from '../../../shared';
import { CH_LABEL, PERIODS, useMoney } from '../../shared';

/** "Hisob-kitob" for one link: totals, 1/2/3-unit split with formulas, the orders and expenses behind every number, placements. */
export default function LinkAnalytics({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [period, setPeriod] = useState('this_month');
  const [basis, setBasis] = useState<'financial' | 'cohort'>('financial');
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pls, setPls] = useState<any[]>([]);
  const [pf, setPf] = useState({ channel: 'telegram_channel', name: '' });
  const [tab, setTab] = useState<'orders' | 'expenses'>('orders');
  const money = useMoney('UZS');
  useEffect(() => { try { const p = new URLSearchParams(location.search).get('period'); if (p) setPeriod(p); } catch {} }, []);
  const load = useCallback(() => {
    api(`/partner/links/${id}/analytics?period=${period}&basis=${basis}`).then(setD).catch((e) => setErr(e.code));
    api(`/partner/links/${id}/placements`).then((r) => setPls(r.items)).catch(() => {});
  }, [id, period, basis]);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{err === 'NOT_FOUND' || err === 'LINK_NOT_FOUND' ? 'Havola topilmadi' : err}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const t = d.totals;
  return (
    <div className="an">
      <Link href="/partner/analytics" className="see-all">← Reklama va daromad</Link>
      <h1>Hisob-kitob · {d.links.find((l: any) => l.link_id === id)?.name ?? 'Havola'}</h1>
      <div className="sort-chips" role="group" aria-label="Davr">{PERIODS.filter(([k]) => k !== 'custom').map(([k, l]) => <button key={k} className={`schip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
      <div className="sort-chips" role="group" aria-label="Hisobot turi">
        <button className={`schip ${basis === 'financial' ? 'on' : ''}`} aria-pressed={basis === 'financial'} onClick={() => setBasis('financial')}>Moliyaviy</button>
        <button className={`schip ${basis === 'cohort' ? 'on' : ''}`} aria-pressed={basis === 'cohort'} onClick={() => setBasis('cohort')}>Kampaniya</button>
      </div>
      <div className="an-cards">
        <button className="an-card linkish" onClick={() => setTab('orders')}><span>Komissiya daromadi</span><b>{money(t.commission)}</b><small>buyurtmalarni ko‘rish →</small></button>
        <button className="an-card linkish" onClick={() => setTab('expenses')}><span>Reklama xarajati</span><b>{money(t.ad)}</b><small>{t.ad === null ? 'Xarajat kiritilmagan' : 'xarajatlarni ko‘rish →'}</small></button>
        <div className="an-card main"><span>Natija</span><b>{t.result === null ? 'Hisob to‘liq emas' : money(t.result)}</b></div>
        <div className="an-card"><span>Kutilmoqda</span><b>{money(t.expected)}</b></div>
      </div>
      {d.completeness.notes.length > 0 && <div className="notice small">{d.completeness.notes.join(' · ')}</div>}

      <section className="card an-sec">
        <h2>Necha donadan olishdi</h2>
        <div className="an-ratios">
          {(['1', '2', '3', '4+'] as const).map((k) => <div key={k}><span>{k} dona</span><b>{d.counts.qty_distribution[k] ?? 0}</b><small>buyurtma</small></div>)}
        </div>
        {d.formulas.length > 0 && <ul className="small an-formulas">{d.formulas.map((f: any) => <li key={f.qty}>{f.formula}</li>)}</ul>}
        {d.rule && d.rule.kind !== 'quantity_matrix' && <p className="small muted">Qoida: {d.rule.kind === 'percent' ? `narxdan ${d.rule.rate_bps / 100}%` : `har dona ${money(d.rule.base_minor)}`} (versiya {d.rule.version})</p>}
      </section>

      <div className="seg" role="tablist"><button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>Buyurtmalar ({d.orders.length})</button><button role="tab" aria-selected={tab === 'expenses'} className={tab === 'expenses' ? 'on' : ''} onClick={() => setTab('expenses')}>Xarajatlar ({d.expenses.length})</button></div>
      {tab === 'orders' ? (
        <div className="slist">
          {d.orders.length === 0 && <div className="empty">Bu havoladan hali buyurtma yo‘q</div>}
          {d.orders.map((o: any) => (
            <Link key={o.id} href={`/partner/orders/${o.id}`} className="scard draft-card">
              <div className="spread"><b>{o.masked} · {o.units} dona</b><b>{money(o.commission)}</b></div>
              <div className="small muted">{new Date(o.created_at).toLocaleDateString('uz-UZ')} · {o.capture_mode === 'partner_assisted' ? 'Siz kiritgansiz' : 'Mijoz o‘zi'} · {CH_LABEL[o.source_channel] ?? o.source_channel} · {o.states ?? '—'}{o.review ? ' · ko‘rib chiqilmoqda' : ''}</div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="slist">
          {d.expenses.length === 0 && <div className="empty">Bu havolaga xarajat biriktirilmagan. <Link href={`/partner/expenses?link=${id}`}>Xarajat qo‘shish</Link></div>}
          {d.expenses.map((e: any, i: number) => (
            <div key={i} className="scard">
              <div className="spread"><b>{CH_LABEL[e.channel] ?? e.channel}{e.placement_name ? ` · ${e.placement_name}` : ''}</b><b>{e.amount} {e.currency}</b></div>
              <div className="small muted">{e.service_from} — {e.service_to} · ulush: {e.share_bps ? `${e.share_bps / 100}%` : e.alloc_amount} · {e.currency !== 'UZS' ? (e.fx_status === 'ok' ? `kurs ${e.fx_rate} (${e.fx_date})` : 'kurs kutilmoqda') : 'so‘m'}{e.payer === 'shop' ? ' · do‘kon to‘lagan' : ''}</div>
            </div>
          ))}
        </div>
      )}

      <section className="card an-sec">
        <h2>Telegram va Instagram uchun alohida havolalar</h2>
        <p className="small muted">Har bir post yoki target kampaniyaga alohida havola bering — qaysi biridan sotuv kelganini aniq ko‘rasiz. Telegram’da “Ulashish” tugmasi bosilgani sotuv isboti hisoblanmaydi.</p>
        {pls.map((p) => (
          <div key={p.id} className="pl-row">
            <div className="spread"><b>{CH_LABEL[p.channel]} · {p.name}</b>{p.status === 'active' ? <button className="link-btn small" onClick={async () => { await api(`/partner/placements/${p.id}/archive`, { method: 'POST' }).catch(() => {}); load(); }}>Arxivlash</button> : <span className="small muted">arxiv</span>}</div>
            {p.status === 'active' && <LinkBox url={p.url} shareText="" />}
          </div>
        ))}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <label className="sr-only" htmlFor="pch">Kanal</label>
          <select id="pch" value={pf.channel} onChange={(e) => setPf({ ...pf, channel: e.target.value })} style={{ maxWidth: 200 }}>
            <option value="telegram_channel">Telegram kanal</option><option value="telegram_ads">Telegram Ads</option><option value="instagram_target">Instagram target</option><option value="organic">Organik</option>
          </select>
          <label className="sr-only" htmlFor="pnm">Nomi</label>
          <input id="pnm" value={pf.name} maxLength={80} onChange={(e) => setPf({ ...pf, name: e.target.value })} placeholder="Masalan: Kanal posti 12-noyabr" style={{ flex: 1, minWidth: 160 }} />
          <button className="btn sm" disabled={!pf.name.trim()} onClick={async () => { await api(`/partner/links/${id}/placements`, { method: 'POST', body: { channel: pf.channel, name: pf.name.trim() } }).catch(() => {}); setPf({ ...pf, name: '' }); load(); }}>Havola yaratish</button>
        </div>
      </section>
    </div>
  );
}
