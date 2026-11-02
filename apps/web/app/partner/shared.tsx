'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';

export const PARTNER_TABS: [string, string][] = [['/partner', 'Dashboard'], ['/partner/market', 'Market'], ['/partner/streams', 'Oqim'], ['/partner/stats', 'Statistika'], ['/partner/payouts', "To'lov"]];

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
      {PARTNER_TABS.map(([href, label]) => {
        const on = href === '/partner' ? path === '/partner' : path.startsWith(href);
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

export function BucketPills({ c }: { c: Record<string, number> }) {
  const total = c.total ?? 0;
  const pct = (n: number) => (total ? ` · ${Math.round((n / total) * 100)}%` : '');
  return (
    <div className="pills">
      <span className="pill">Jami: {total}</span>
      {BUCKET_ORDER.map((b) => <span key={b} className={`pill b-${b}`}>{BUCKET_LABEL[b]}: {c[b] ?? 0}{b === 'delivered' || b === 'returned' ? pct(c[b] ?? 0) : ''}</span>)}
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
  useEffect(() => { try { setState(localStorage.getItem('om_token') ? 'in' : 'out'); } catch { setState('out'); } }, []);
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
