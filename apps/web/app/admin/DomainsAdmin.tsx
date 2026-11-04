'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const DNS: Record<string, string> = { pending: '⏳ DNS tasdiqlanmagan', verified: '✅ DNS tasdiqlandi' };
const TLS: Record<string, string> = { unknown: 'SSL: noma’lum', pending: 'SSL: kutilmoqda', ready: 'SSL: tayyor', failed: 'SSL: xato' };
const META: Record<string, string> = { unknown: 'Meta: noma’lum', token_saved: 'Meta: kod saqlangan (tasdiq kutilmoqda)', verified: 'Meta: tasdiqlangan', unverified: 'Meta: tasdiqlanmagan' };

/** «🌐 Domenlar»: egalik faqat TXT yozuv bilan; DNS, SSL va Meta alohida holatlar. DNS’ni biz o‘zgartirmaymiz. */
export function DomainsAdmin({ landings }: { landings: any[] }) {
  const [items, setItems] = useState<any[]>([]);
  const [nw, setNw] = useState({ host: '', landing_id: '' });
  const [meta, setMeta] = useState<Record<string, string>>({});
  const load = useCallback(() => { api('/admin/domains').then((r) => setItems(r.items)).catch(() => {}); }, []);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => { try { const r = await fn(); if (ok) toast(ok); load(); return r; } catch (e: any) { toast(e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Faqat egasi.' : e.code === 'DOMAIN_TAKEN' ? 'Bu domen allaqachon band.' : e.code === 'META_TOKEN_INVALID' ? 'Faqat Meta tasdiqlash kodi (yoki rasmiy meta teg) qabul qilinadi.' : e.code === 'REDIRECT_LOOP' ? 'Aylanma yo‘naltirish bo‘lib qoladi.' : errText(e), 'err'); } };
  return (
    <details className="card pp-more" style={{ marginTop: 12 }}>
      <summary>🌐 Domenlar</summary>
      <p className="small muted">Domenni ulash uchun DNS’ga biz bergan TXT yozuvni o‘zingiz qo‘yasiz. Faqat CNAME yetarli emas. SSL va Meta tasdig‘i alohida ko‘rsatiladi.</p>
      <div className="tr-form">
        <input aria-label="Domen" placeholder="masalan shop.example.uz" value={nw.host} onChange={(e) => setNw({ ...nw, host: e.target.value.trim().toLowerCase() })} />
        <select aria-label="Landing" value={nw.landing_id} onChange={(e) => setNw({ ...nw, landing_id: e.target.value })}><option value="">— landing —</option>{landings.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</select>
        <button className="btn secondary sm" disabled={!nw.host || !nw.landing_id} onClick={() => run(() => api('/admin/domains', { method: 'POST', body: nw }), 'Qo‘shildi — endi TXT yozuvni qo‘ying')}>Qo‘shish (egasi)</button>
      </div>
      {items.map((d) => (
        <div key={d.id} className="ln-block" style={{ marginTop: 8 }}>
          <div className="spread small"><b>{d.host}</b><span>{d.landing}</span></div>
          <p className="small">{DNS[d.status] ?? d.status} · {TLS[d.tls_status]} · {META[d.meta_status]}</p>
          {d.status === 'pending' && <p className="small" style={{ overflowWrap: 'anywhere' }}>TXT nomi: <code>_uzshop-verify.{d.host}</code><br />Qiymati: <code>uzshop-verify={d.txt_token}</code>{d.last_check_result ? <><br />Oxirgi tekshiruv: {d.last_check_result}</> : null}</p>}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn secondary sm" onClick={() => run(async () => { const r = await api(`/admin/domains/${d.id}/verify`, { method: 'POST' }); toast(r.status === 'verified' ? '✓ DNS tasdiqlandi' : 'TXT yozuv topilmadi — DNS yangilanishi vaqt olishi mumkin'); })}>DNS’ni tekshirish</button>
            <select aria-label="SSL holati" value={d.tls_status} onChange={(e) => run(() => api(`/admin/domains/${d.id}`, { method: 'PUT', body: { tls_status: e.target.value } }), '✓ Saqlandi')}><option value="unknown" disabled>SSL…</option><option value="pending">SSL kutilmoqda</option><option value="ready">SSL tayyor</option><option value="failed">SSL xato</option></select>
            <button className="btn secondary sm danger-t" onClick={async () => {
              const r = await run(() => api(`/admin/domains/${d.id}/disconnect`, { method: 'POST', body: {} }));
              if (r && !r.disconnected && confirm(`${r.dependencies.length} ta reklama shu landingga yo‘naltirilgan. To‘xtatish so‘rovi yuborib, uzilsinmi?`)) await run(() => api(`/admin/domains/${d.id}/disconnect`, { method: 'POST', body: { confirm: true } }), 'Uzildi — reklamalarga to‘xtatish so‘rovi yuborildi');
              else if (r?.disconnected) toast('Uzildi');
            }}>Uzish</button>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6 }}><input aria-label="Meta tasdiqlash kodi" placeholder="Meta domen tasdiqlash kodi" value={meta[d.id] ?? ''} onChange={(e) => setMeta({ ...meta, [d.id]: e.target.value })} />
            <button className="btn secondary sm" disabled={!meta[d.id]} onClick={() => run(() => api(`/admin/domains/${d.id}`, { method: 'PUT', body: { meta_verification: meta[d.id] } }), '✓ Kod saqlandi')}>Saqlash</button></div>
        </div>
      ))}
    </details>
  );
}
