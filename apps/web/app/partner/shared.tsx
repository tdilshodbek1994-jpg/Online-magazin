'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';

export const PARTNER_TABS: [string, string, string[]][] = [
  ['/partner', 'Bosh sahifa', []], ['/partner/orders', 'Buyurtmalar', ['/partner/requests']], ['/partner/new', '+ Buyurtma', ['/partner/order']],
  ['/partner/market', 'Mahsulotlar', ['/partner/streams']], ['/partner/wallet', 'Hamyon', ['/partner/payouts']], ['/partner/stats', 'Statistika', []],
];

export const PERIODS: [string, string][] = [['today', 'Bugun'], ['yesterday', 'Kecha'], ['week', 'Hafta'], ['month', 'Shu oy'], ['half_year', 'Yarim yil'], ['all', 'Hammasi']];

export const BUCKET_LABEL: Record<string, string> = { new: 'Yangi', accepted: 'Qabul qilindi', shipping: 'Yetkazilmoqda', delivered: 'Yetkazildi', returned: 'Qaytdi', cancelled: 'Bekor qilingan' };
export const BUCKET_ORDER = ['new', 'accepted', 'shipping', 'delivered', 'returned', 'cancelled'];

/** Loads the partner profile; pages render the apply/pending screens through <PartnerGate>. */
export function usePartnerMe() {
  const [me, setMe] = useState<any>(undefined);
  const [error, setError] = useState<any>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setMe(await api('/partner/me')); } catch (e: any) { if (e.code === 'PARTNER_NOT_FOUND') setMe(null); else setError(e); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { me, error, reload: load };
}

export function PartnerTabs() {
  const path = usePathname() ?? '';
  return (
    <nav className="ptabs" aria-label="Hamkor bo'limlari">
      {PARTNER_TABS.map(([href, label, also]) => {
        const on = href === '/partner' ? path === '/partner' : [href, ...also].some((h) => path === h || path.startsWith(h + '/'));
        return <Link key={href} href={href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>{label}</Link>;
      })}
    </nav>
  );
}

export function Chips({ items, value, onChange, label }: { items: [string, string][]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {items.map(([v, l]) => <button key={v} type="button" className={`chip ${value === v ? 'on' : ''}`} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function BucketPills({ c, href }: { c: Record<string, number>; href?: (status: string) => string }) {
  const total = c.total ?? 0;
  const pct = (n: number) => (total ? ` · ${Math.round((n / total) * 100)}%` : '');
  const Pill = ({ k, cls, children }: { k: string; cls: string; children: React.ReactNode }) =>
    href ? <Link className={`pill ${cls} pill-link`} href={href(k)}>{children} ›</Link> : <span className={`pill ${cls}`}>{children}</span>;
  return (
    <div className="pills">
      <Pill k="all" cls="">Jami: {total}</Pill>
      {BUCKET_ORDER.map((b) => <Pill key={b} k={b} cls={`b-${b}`}>{BUCKET_LABEL[b]}: {c[b] ?? 0}{b === 'delivered' || b === 'returned' ? pct(c[b] ?? 0) : ''}</Pill>)}
    </div>
  );
}

export function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch {}
  return Promise.resolve(false);
}

export const tgShare = (url: string, text: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

export function LinkBox({ url, shareText }: { url: string; shareText: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="linkbox">
      <code className="link-url">{url.replace(/^https?:\/\//, '')}</code>
      <button type="button" className="btn secondary sm" onClick={async () => { if (await copyText(url)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>{copied ? 'Nusxalandi ✓' : 'Nusxalash'}</button>
      <a className="btn sm tg" href={tgShare(url, shareText)} target="_blank" rel="noopener noreferrer">Telegram</a>
    </div>
  );
}

export function Money({ v }: { v: string | null | undefined }) { return <>{som(v ?? '0')}</>; }

export function duration(secs: number | null | undefined): string {
  if (!secs) return '—';
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  return [d ? `${d} kun` : '', h ? `${h} soat` : '', !d && m ? `${m} daq` : ''].filter(Boolean).join(' ') || '1 daq';
}

/** Shown instead of partner pages when nobody is logged in: a clear next step, not a raw error code. */
export function PartnerGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');
  useEffect(() => {
    let tok: string | null = null;
    try { tok = localStorage.getItem('om_token'); } catch {}
    if (!tok) { setState('out'); return; }
    // An expired/revoked session must lead to the login card, not a raw UNAUTHENTICATED error.
    api('/me').then(() => setState('in')).catch((e) => { if (e?.status === 401) { try { localStorage.removeItem('om_token'); } catch {} setState('out'); } else setState('in'); });
  }, []);
  if (state === 'checking') return null;
  if (state === 'out') return (
    <div className="card login-cta">
      <div className="lc-icon" aria-hidden>🤝</div>
      <h1>Hamkor kabineti</h1>
      <p>Hamkor bo‘lish yoki kabinetga kirish uchun avval telefon raqamingiz bilan tizimga kiring.</p>
      <Link className="btn big" href="/login?next=/partner">Kirish</Link>
      <p className="muted small">Mahsulotlarni Telegram, Instagram yoki do‘stlaringiz orqali sotib, har bir yetkazilgan buyurtmadan pul ishlaysiz.</p>
    </div>
  );
  return <>{children}</>;
}

/** Connect the partner's Telegram to receive order / delivery / payment messages. */
export function TelegramConnect() {
  const [s, setS] = useState<any>(null);
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api('/me/telegram').then(setS).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!s) return null;
  if (s.linked) return (
    <div className="tg-card ok">
      <span aria-hidden>✅</span>
      <div><b>Telegram ulangan</b><div className="muted small">Yangi buyurtma, yetkazish va to‘lovlar haqida xabar keladi.</div></div>
      <button className="btn secondary sm" onClick={async () => { if (confirm('Telegram xabarlari o‘chirilsinmi?')) { await api('/me/telegram', { method: 'DELETE' }).catch(() => {}); void load(); } }}>Uzish</button>
    </div>
  );
  return (
    <div className="tg-card">
      <span aria-hidden>✈️</span>
      <div><b>Telegram xabarlarini yoqing</b><div className="muted small">Har bir yangi buyurtma va pul tushganini darhol bilib turasiz.</div></div>
      {!s.bot_configured ? <span className="muted small">Bot hali sozlanmagan (admin)</span>
        : link ? <a className="btn sm tg" href={link} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(load, 8000)}>Botni ochish</a>
        : <button className="btn sm tg" onClick={async () => { setErr(null); try { const r = await api('/me/telegram/link-token', { method: 'POST' }); setLink(r.deep_link); if (r.deep_link) window.open(r.deep_link, '_blank', 'noopener'); } catch (e: any) { setErr(e.code); } }}>Telegram'ni ulash</button>}
      {link && <div className="muted small" style={{ gridColumn: '1 / -1' }}>Botda «Start» tugmasini bosing, keyin bu sahifani yangilang. Havola 10 daqiqa amal qiladi.</div>}
      {err && <span className="field-error">{err}</span>}
    </div>
  );
}
