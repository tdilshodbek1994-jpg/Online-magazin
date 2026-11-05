'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, som } from '@/lib/api';
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

const SOM_COLS = new Set(['Komissiya', 'Sof komissiya']);
const fmt = (f: { value: string | number | null; unit: string }) => {
  if (f.value === null || f.value === undefined) return 'maʼlumot yo‘q';
  if (f.unit === 'som') return som(String(f.value));
  if (f.unit === 'orders') return `${f.value} ta`;
  if (f.unit === 'units') return `${f.value} dona`;
  if (f.unit === 'coins') return `${f.value} coin`;
  if (f.unit === 'count') return `${f.value} ta`;
  return String(f.value);
};
const STATUS: Record<string, [string, string]> = { ok: ['Natija', 'ok'], zero: ['Natija: 0', 'zero'], partial: ['Qisman', 'partial'], forbidden: ['Ruxsat yo‘q', 'no'], unsupported: ['Hali ulanmagan', 'no'], unknown: ['Maʼlumot yo‘q', 'zero'] };

function AnswerCard({ c }: { c: Card }) {
  const [sent, setSent] = useState<string | null>(null);
  const r = c.result;
  const primary = r?.facts.find((f) => f.primary);
  const rest = r?.facts.filter((f) => f !== primary) ?? [];
  const fb = async (verdict: 'correct' | 'wrong') => { if (!c.report_id) return; try { await api('/ai/biz/feedback', { method: 'POST', body: { report_id: c.report_id, verdict } }); setSent(verdict); } catch { /* ignore */ } };
  const [label, tone] = STATUS[c.status] ?? ['Javob', 'ok'];
  return (
    <article className={`ai-card ai-${tone}`}>
      <div className="ai-card-top"><span className={`ai-st ai-st-${tone}`}>{label}</span><span className="ai-scope">🔒 {c.scope_label}</span></div>
      <p className="ai-sum">{c.summary}</p>
      {r && (
        <>
          <div className="ai-chips">
            {r.period && <span className="ai-chip">📅 {r.period.label}</span>}
            {r.filters && Object.entries(r.filters).map(([k, v]) => <span key={k} className="ai-chip">🔎 {v}</span>)}
            <span className="ai-chip">📐 {r.title}</span>
          </div>
          {primary && <div className="ai-big"><span>{primary.label}</span><b>{fmt(primary)}</b></div>}
          {rest.length > 0 && <dl className="ai-facts">{rest.map((f) => <div key={f.id}><dt>{f.label}</dt><dd>{fmt(f)}</dd></div>)}</dl>}
          {r.table && r.table.rows.length > 0 && (
            <div className="ai-table" role="table" aria-label={r.title}>
              {r.table.rows.map((row, i) => (
                <div key={i} className="ai-tr" role="row">{row.cells.map((cell, j) => (
                  <div key={j} role="cell" className="ai-td"><small>{r.table!.columns[j]}</small><span>{SOM_COLS.has(r.table!.columns[j]!) ? som(String(cell)) : cell}</span></div>
                ))}</div>
              ))}
            </div>
          )}
          {r.evidence.length > 0 && (
            <div className="ai-ev"><b>Manba</b>{r.evidence.map((e, i) => <Link key={i} href={e.href}>{e.label}{e.value ? ` · ${som(e.value)}` : ''} ›</Link>)}</div>
          )}
          {r.partial_reasons.length > 0 && <ul className="ai-note">{r.partial_reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          <details className="ai-method"><summary>Hisoblash usuli</summary><p>{r.method}</p><p className="muted small">Ko‘rsatkich: {r.metric} · v{r.metric_version}{r.period ? ` · ${r.period.timezone} · [${r.period.from}, ${r.period.to_exclusive})` : ''}</p></details>
          <div className="ai-foot">
            {r.open && <Link className="btn sm" href={r.open.href}>{r.open.label}</Link>}
            <span className="muted small">Holat: {new Date(c.as_of).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</span>
          </div>
          {c.report_id && <div className="ai-fb">{sent ? <span className="muted small">Rahmat, qayd qilindi.</span> : <><button className="link-btn" onClick={() => fb('correct')}>👍 To‘g‘ri</button><button className="link-btn" onClick={() => fb('wrong')}>⚠️ Xato haqida xabar</button></>}</div>}
        </>
      )}
    </article>
  );
}

export default function PartnerAi() {
  const [cap, setCap] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sid, setSid] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { api('/ai/biz/capabilities').then(setCap).catch(setErr); }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy]);

  const ask = async (q: string) => {
    const v = q.trim(); if (v.length < 2 || busy) return;
    setMsgs((m) => [...m, { role: 'user', text: v }]); setText(''); setBusy(true);
    try {
      const c: Card = await api('/ai/biz/ask', { method: 'POST', body: { text: v, ...(sid ? { session_id: sid } : {}) } });
      setSid(c.session_id); setMsgs((m) => [...m, { role: 'assistant', card: c }]);
    } catch (e: any) { setMsgs((m) => [...m, { role: 'error', text: errText(e) }]); }
    finally { setBusy(false); }
  };

  if (err) return <div className="notice" role="alert">{err.code === 'AI_DISABLED' ? 'AI yordamchi hozir o‘chirilgan. Oddiy hisobotlar ishlayapti.' : errText(err)}</div>;
  if (!cap) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return (
    <div className="ai-page">
      <div className="ai-hero">
        <span className="ai-bot" aria-hidden>🤖</span>
        <div><h1>AI yordamchi</h1><p>Hamkor kabineti · faqat sizning maʼlumotlaringiz bo‘yicha aniq hisob</p></div>
      </div>
      {msgs.length === 0 && (
        <section className="ai-quick" aria-label="Tezkor savollar">
          <p className="muted small">Oddiy o‘zbekcha yozing (lotin yoki kirill). Masalan: «25-oktabrda qancha pul topdim?»</p>
          <div className="ai-q-grid">{cap.quick_questions.map((q: string) => <button key={q} className="ai-q" onClick={() => ask(q)}>{q}</button>)}</div>
        </section>
      )}
      <div className="ai-thread" aria-live="polite">
        {msgs.map((m, i) => m.role === 'user' ? <div key={i} className="ai-u">{m.text}</div>
          : m.role === 'error' ? <div key={i} className="notice" role="alert">{m.text}</div>
          : <div key={i}>
              <AnswerCard c={m.card} />
              {m.card.suggestions && <div className="ai-sugg">{m.card.suggestions.map((q) => <button key={q} className="ai-q sm" onClick={() => ask(q)}>{q}</button>)}</div>}
            </div>)}
        {busy && <div className="ai-wait" role="status"><span className="spinner" aria-hidden />Hisobot olinmoqda…</div>}
        <div ref={end} />
      </div>
      {msgs.length > 0 && <div className="ai-more">{cap.quick_questions.slice(0, 6).map((q: string) => <button key={q} className="ai-q sm" onClick={() => ask(q)}>{q}</button>)}</div>}
      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <label className="sr-only" htmlFor="aiq">Savolingiz</label>
        <input id="aiq" value={text} onChange={(e) => setText(e.target.value)} placeholder="Savolingizni yozing…" maxLength={500} autoComplete="off" />
        <button className="btn" disabled={busy || text.trim().length < 2} aria-label="Yuborish">➤</button>
      </form>
      <p className="muted small ai-disc">{cap.llm?.note ?? ''} AI pul o‘tkazmaydi, buyurtma yoki imtiyozni o‘zgartirmaydi.</p>
    </div>
  );
}
