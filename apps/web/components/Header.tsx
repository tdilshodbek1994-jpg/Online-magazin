'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, getToken, setToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function Header() {
  const { t, lang, setLang } = useI18n();
  const [perms, setPerms] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [logged, setLogged] = useState(false);
  useEffect(() => {
    if (!getToken()) return;
    api('/me').then((m) => { setLogged(true); setPerms(m.permissions); setRoles(m.roles.map((r: any) => r.role)); }).catch((e) => { if (e?.status === 401) setToken(null); }); // network errors/aborts never log the user out
  }, []);
  return (
    <header className="top">
      <div className="wrap">
        <Link href="/" className="brand">{t('shop')}</Link>
        <nav className="links" aria-label="Asosiy">
          <Link href="/cart">{t('cart')}</Link>
          {logged && <Link href="/account">{t('myOrders')}</Link>}
          {(roles.includes('owner') || roles.includes('finance')) && <Link href="/account/security">MFA</Link>}
          {roles.includes('courier') && <Link href="/courier">Kuryer</Link>}
          {roles.includes('partner') && <Link href="/partner">{t('partner')}</Link>}
          {perms.includes('orders.read_all') && <Link href="/ops">{t('ops')}</Link>}
          {(perms.includes('catalog.write') || perms.includes('reports.read') || perms.includes('payouts.prepare')) && <Link href="/admin">{t('admin')}</Link>}
          {logged ? <button className="btn secondary" onClick={async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setToken(null); location.href = '/'; }}>{t('logout')}</button> : <Link href="/login">{t('login')}</Link>}
          <label className="sr-only" htmlFor="lang">Til</label>
          <select id="lang" value={lang} onChange={(e) => setLang(e.target.value as any)} style={{ width: 'auto' }}>
            <option value="uz-Latn">O‘zbek (lotin)</option>
            <option value="uz-Cyrl">Ўзбек (кирилл)</option>
          </select>
        </nav>
      </div>
    </header>
  );
}

export function Async({ loading, error, onRetry, children }: { loading: boolean; error: any; onRetry?: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  if (loading) return <p role="status">{t('loading')}</p>;
  if (error) return <div role="alert" className="notice">{t('error')}: <code>{error.code ?? 'UNKNOWN'}</code> {onRetry && <button className="btn secondary" onClick={onRetry}>{t('retry')}</button>}</div>;
  return <>{children}</>;
}
