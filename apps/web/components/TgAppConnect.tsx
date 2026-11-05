'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { tgAppName, type TgAppName } from '@/lib/telegram';

const WHAT: Record<TgAppName, string> = { partner: 'Kabinet', operator: 'Operator xonasi' };

/** «Telegram ilovada ochish»: one-time link that opens the bot's mini app already tied to this account. */
export function TgAppConnect({ app = 'partner' }: { app?: TgAppName }) {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/me/telegram/apps').then((r) => setS(r.items.find((i: any) => i.app === app))).catch(() => {});
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s?.configured || tgAppName()) return null;
  return (
    <div className="card tg-app-card">
      <div className="tac-head"><span className="tac-icon" aria-hidden>📱</span><div><b>Telegram ilova</b><p className="muted small">{WHAT[app]} @{s.bot_username} botida ochiladi — parol va kodsiz.</p></div></div>
      {err && <p className="notice" role="alert">{errText(err)}</p>}
      {s.linked ? (
        <div className="tac-row">
          <span className="pill b-delivered">Ulangan{s.tg_username ? ` · @${s.tg_username}` : ''}</span>
          <a className="btn sm" href={`https://t.me/${s.bot_username}`} target="_blank" rel="noopener noreferrer">Botni ochish</a>
          <button type="button" className="btn secondary sm" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/me/telegram/apps/${app}`, { method: 'DELETE' }); await load(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>Uzish</button>
        </div>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { const r = await api('/me/telegram/apps/link-token', { method: 'POST', body: { app } }); if (r.url) location.href = r.url; } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>Telegram ilovada ochish</button>
      )}
    </div>
  );
}
