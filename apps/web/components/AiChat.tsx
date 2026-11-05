'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, getToken, som } from '@/lib/api';
import { errText } from '@/lib/errors';

/**
 * AI yordamchi (Hamkor kabineti). The server decides the workspace and scope; every number on screen comes from the
 * stored report facts (never from model text). Quick questions work without any external AI.
 */
type Fact = { id: string; label: string; value: string | number | null; unit: string; kind?: string; primary?: boolean };
type Card = { report_id: string | null; session_id: string | null; status: string; summary: string; as_of: string; scope_label: string; suggestions?: string[]; result: null | {
  tool: string; title: string; metric: string; metric_version: number; period?: { from: string; to_exclusive: string; label: string; timezone: string; partial_today: boolean };
  filters?: Record<string, string>; facts: Fact[]; table?: { columns: string[]; rows: { cells: (string | number)[] }[] }; evidence: { type: string; label: string; href: string; value?: string }[];
  method: string; partial_reasons: string[]; open?: { label: string; href: string } } };
type Msg = { role: 'user'; text: string } | { role: 'assistant'; card: Card } | { role: 'error'; text: string };

const fmt = (f: { value: string | number | null; unit: string }) => {
  if (f.value === null || f.value === undefined) return '—';
  if (f.unit === 'som') return som(String(f.value));
  if (f.unit === 'orders' || f.unit === 'count') return `${f.value} ta`;
  if (f.unit === 'units') return `${f.value} dona`;
  if (f.unit === 'coins') return `${f.value} coin`;
  if (f.unit === 'percent') return `${f.value}%`;
  if (f.unit === 'date') return String(f.value).split(', ').map(dmy).join(', ');
  return String(f.value);
};
const MON = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
const dmy = (d: string) => /^\d{4}-\d{2}-\d{2}/.test(d) ? `${Number(d.slice(8, 10))}-${MON[Number(d.slice(5, 7)) - 1]}` : d;
const titleCase = (s: string) => (s === s.toUpperCase() && /[A-ZА-ЯЎҚҒҲ]/.test(s) ? s.charAt(0) + s.slice(1).toLowerCase() : s);
/** One table cell → short text by its column (keeps rows on one line). */
function cell(col: string, v: string | number): string {
  if (col === 'Komissiya' || col === 'Sof komissiya' || col.startsWith('Komissiya')) return som(String(v));
  if (col === 'Dona' || col === 'Sotish mumkin') return `${v} dona`;
  if (col.startsWith('Buyurtma') && typeof v === 'number') return `${v} buyurtma`;
  if (col === 'Tugaydi' || col === 'Kun') return dmy(String(v));
  if (col === 'Qatnashyapsizmi') return v === 'Ha' ? 'qatnashyapsiz' : 'qatnashmayapsiz';
  if (col === 'Bosish') return `${v} bosish`;
  if (col === 'Yetkazildi') return `${v} yetkazildi`;
  if (col === 'Qo‘ng‘iroq') return `${v} qo‘ng‘iroq`;
  if (col === 'Tasdiqladi') return `${v} tasdiq`;
  if (col === 'Bekor qildi') return `${v} bekor`;
  if (col === 'Jami') return `${v} jami`;
  if (col === 'Urinish') return `${v} urinish`;
  return String(v);
}
const ICON: Record<string, string> = { ok: '💬', zero: '0', partial: '…', forbidden: '🔒', unsupported: '?', unknown: '—' };

function AnswerCard({ c, canExport }: { c: Card; canExport?: boolean }) {
  const [sent, setSent] = useState(false);
  const r = c.result;
  const csv = async () => {
    if (!c.report_id) return;
    const res = await fetch(`/api/v1/ai/biz/reports/${c.report_id}/export.csv`, { headers: { 'x-session-token': getToken() ?? '' } });
    if (!res.ok) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `uzshop-ai-${c.report_id.slice(0, 8)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const fb = async (verdict: 'correct' | 'wrong') => { if (!c.report_id || sent) return; try { await api('/ai/biz/feedback', { method: 'POST', body: { report_id: c.report_id, verdict } }); setSent(true); } catch { /* ignore */ } };
  // No report (refusal / not understood): one short line, nothing else.
  if (!r) return <article className={`ai-card ai-c-${c.status}`}><p className="ai-sum"><span className="ai-ic" aria-hidden>{ICON[c.status] ?? '•'}</span>{c.summary}</p></article>;
  const compare = r.metric.startsWith('compare:');
  const primary = r.facts.find((f) => f.primary);
  const rest = r.facts.filter((f) => f !== primary);
  const nonZero = rest.filter((f) => !['0', 0, null].includes(f.value as never));
  const shown = compare ? rest : (c.status === 'zero' ? nonZero : rest).slice(0, 3);
  const hidden = compare ? [] : rest.slice(3);
  const rows = r.table?.rows ?? [];
  const cols = r.table?.columns ?? [];
  const linkRows = rows.length > 0 && r.evidence.length > 0 && r.evidence.every((e) => e.type === 'order' || e.type === 'product');
  const rank = cols[0] === 'O‘rin';
  const row = (x: { cells: (string | number)[] }, i: number) => {
    const name = titleCase(String(rank ? x.cells[1] : x.cells[0]));
    const meta = (rank ? [] : x.cells.slice(1).map((v, j) => cell(cols[j + 1]!, v))).join(' · ');
    const href = linkRows ? r.evidence[i]?.href : undefined;
    const body = <><span className="ai-rn">{rank ? `${x.cells[0]}.` : `${i + 1}.`}</span><span className="ai-rt">{name}</span>{meta && <span className="ai-rm">{meta}</span>}</>;
    return href ? <Link key={i} href={href} className="ai-row">{body}</Link> : <div key={i} className="ai-row">{body}</div>;
  };
  const ev = linkRows ? [] : r.evidence.filter((e) => e.type === 'order');
  const zero = c.status === 'zero';
  return (
    <article className={`ai-card ai-c-${c.status}`}>
      <div className="ai-meta">{r.period ? `📅 ${compare ? `${r.period.label} · oldingi teng davr bilan` : r.period.label}` : '🕒 Hozirgi holat'}{r.filters?.channel ? ` · ${r.filters.channel}` : ''}</div>
      {primary && !zero && !compare && <div className="ai-big"><small>{primary.label}</small><b>{fmt(primary)}</b></div>}
      {compare && primary && (
        <div className="ai-cmp">
          {[primary, ...rest.filter((f) => f.id !== 'diff_pct')].map((f) => (
            <div key={f.id} className={f.id === 'diff' ? (String(f.value).startsWith('-') ? 'neg' : 'pos') : ''}><small>{f.id === 'diff' ? 'Farq' : f.primary ? 'Shu davr' : 'Oldingi davr'}</small><b>{f.id === 'diff' && !String(f.value).startsWith('-') ? '+' : ''}{fmt(f)}</b>{f.id === 'diff' && rest.find((x) => x.id === 'diff_pct') && <em>{fmt(rest.find((x) => x.id === 'diff_pct')!)}</em>}</div>
          ))}
        </div>
      )}
      {zero && !compare && <p className="ai-zero">{primary && primary.unit !== 'text' ? `${primary.label}: ${fmt(primary)}.` : 'Bu davrda natija yo‘q.'}</p>}
      {!compare && shown.length > 0 && <dl className="ai-facts">{shown.map((f) => <div key={f.id}><dt>{f.label}</dt><dd>{fmt(f)}</dd></div>)}</dl>}
      {rows.length > 0 && !zero && (
        <div className="ai-rows">
          {rows.slice(0, 5).map(row)}
          {rows.length > 5 && <details className="ai-more-rows"><summary>Yana {rows.length - 5} ta</summary>{rows.slice(5).map((x, i) => row(x, i + 5))}</details>}
        </div>
      )}
      {ev.length > 0 && !zero && (
        <div className="ai-ev">{ev.slice(0, 3).map((e, i) => <Link key={i} href={e.href}>{e.label}{e.value ? ` · ${som(e.value)}` : ''} ›</Link>)}
          {ev.length > 3 && <details><summary>Yana {ev.length - 3} ta</summary>{ev.slice(3).map((e, i) => <Link key={i} href={e.href}>{e.label} ›</Link>)}</details>}
        </div>
      )}
      <details className="ai-method">
        <summary>Qanday hisoblandi?</summary>
        {hidden.length > 0 && <dl className="ai-facts sm">{hidden.map((f) => <div key={f.id}><dt>{f.label}</dt><dd>{fmt(f)}</dd></div>)}</dl>}
        <p>{r.method}</p>
        {r.partial_reasons.map((x, i) => <p key={i} className="ai-note">• {x}</p>)}
        <p className="muted small">🔒 {c.scope_label} · {new Date(c.as_of).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</p>
      </details>
      <div className="ai-foot">
        {r.open && <Link className="ai-open" href={r.open.href}>{r.open.label} ›</Link>}
        {c.report_id && canExport && <button className="ai-csv" onClick={csv} aria-label="CSV yuklab olish">⬇ CSV</button>}
        {c.report_id && <span className="ai-fb">{sent ? <small className="muted">Rahmat</small> : <><button aria-label="To‘g‘ri" onClick={() => fb('correct')}>👍</button><button aria-label="Xato haqida xabar" onClick={() => fb('wrong')}>👎</button></>}</span>}
      </div>
    </article>
  );
}

export function AiChat({ defaultWorkspace }: { defaultWorkspace?: string }) {
  const [cap, setCap] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sid, setSid] = useState<string | null>(null);
  const [ws, setWs] = useState<string | undefined>(defaultWorkspace);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setCap(null); setMsgs([]); setSid(null);
    api(`/ai/biz/capabilities${ws ? `?workspace=${ws}` : ''}`).then(setCap).catch((e) => { if (ws && e.code === 'AI_WORKSPACE_FORBIDDEN') setWs(undefined); else setErr(e); });
  }, [ws]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy]);

  const ask = async (q: string) => {
    const v = q.trim(); if (v.length < 2 || busy) return;
    setMsgs((m) => [...m, { role: 'user', text: v }]); setText(''); setBusy(true);
    try {
      const c: Card = await api('/ai/biz/ask', { method: 'POST', body: { text: v, workspace: cap?.workspace, ...(sid ? { session_id: sid } : {}) } });
      setSid(c.session_id); setMsgs((m) => [...m, { role: 'assistant', card: c }]);
    } catch (e: any) { setMsgs((m) => [...m, { role: 'error', text: errText(e) }]); }
    finally { setBusy(false); }
  };

  if (err) return <div className="notice" role="alert">{err.code === 'AI_DISABLED' ? 'AI yordamchi hozir o‘chirilgan. Oddiy hisobotlar ishlayapti.' : err.code === 'AI_FORBIDDEN' ? 'AI yordamchi faqat hamkor va xodimlar uchun.' : errText(err)}</div>;
  if (!cap) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return (
    <div className="ai-page">
      <div className="ai-hero">
        <span className="ai-bot" aria-hidden>🤖</span>
        <div><h1>AI yordamchi</h1><p>{cap.workspace_label} · faqat ruxsat etilgan maʼlumotlar bo‘yicha aniq hisob</p></div>
      </div>
      {cap.available.length > 1 && (
        <div className="ai-ws" role="tablist" aria-label="Ish muhiti">{cap.available.map((w: { key: string; label: string }) => (
          <button key={w.key} role="tab" aria-selected={w.key === cap.workspace} className={w.key === cap.workspace ? 'on' : ''} onClick={() => setWs(w.key)}>{w.label}</button>
        ))}</div>
      )}
      {msgs.length === 0 && cap.quick_questions.length > 0 && (
        <section className="ai-quick" aria-label="Tezkor savollar">
          <p className="muted small">Oddiy o‘zbekcha yozing (lotin yoki kirill). Davrni ham yozing: «kecha», «shu oy», «25-oktabr».</p>
          <div className="ai-q-grid">{cap.quick_questions.map((q: string) => <button key={q} className="ai-q" onClick={() => ask(q)}>{q}</button>)}</div>
        </section>
      )}
      <div className="ai-thread" aria-live="polite">
        {msgs.map((m, i) => m.role === 'user' ? <div key={i} className="ai-u">{m.text}</div>
          : m.role === 'error' ? <div key={i} className="notice" role="alert">{m.text}</div>
          : <div key={i}>
              <AnswerCard c={m.card} canExport={!!cap.export} />
              {m.card.suggestions && <div className="ai-sugg">{m.card.suggestions.map((q) => <button key={q} className="ai-q sm" onClick={() => ask(q)}>{q}</button>)}</div>}
            </div>)}
        {busy && <div className="ai-wait" role="status"><span className="spinner" aria-hidden />Hisobot olinmoqda…</div>}
        <div ref={end} />
      </div>
      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <label className="sr-only" htmlFor="aiq">Savolingiz</label>
        <input id="aiq" value={text} onChange={(e) => setText(e.target.value)} placeholder="Savolingizni yozing…" maxLength={500} autoComplete="off" />
        <button className="btn" disabled={busy || text.trim().length < 2} aria-label="Yuborish">➤</button>
      </form>
      <p className="muted small ai-disc">{cap.llm?.note ?? ''} AI pul o‘tkazmaydi, buyurtma, narx yoki imtiyozni o‘zgartirmaydi.</p>
    </div>
  );
}
