'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { LandingView } from '@/components/LandingView';
import { TrackingAdmin } from './TrackingAdmin';
import { LandingStats } from './LandingStats';
import { ExperimentsCard } from './ExperimentsCard';

const ST: Record<string, string> = { draft: 'Qoralama', review: 'Ko‘rib chiqilmoqda', approved: 'Tasdiqlangan', published: 'Nashrda', archived: 'Arxiv', revoked: 'Bekor qilingan' };
const ADDABLE: [string, string, any][] = [['benefits', 'Afzalliklar', { items: [] }], ['faq', 'Savollar (FAQ)', { items: [] }], ['gallery', 'Galereya', { max: 6 }], ['specs', 'Tavsif (katalogdan)', { from_catalog: true }], ['video', 'Video (YouTube ID)', { provider: 'youtube', ref: '' }], ['contact', 'Aloqa matni', { text: '' }], ['delivery_returns', 'Yetkazish/qaytarish', {}]];

/** Admin «Landinglar»: create from template, block editor (allowlisted blocks only), 360/390/430 preview, workflow. */
export function LandingsAdmin() {
  const [list, setList] = useState<any[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [nw, setNw] = useState({ slug: '', title: '', template: 'pro', product: '' });
  const [prods, setProds] = useState<any[]>([]);
  const load = useCallback(() => { api('/admin/landings').then((r) => setList(r.items)).catch((e) => toast(errText(e), 'err')); }, []);
  useEffect(() => { load(); api('/admin/products').then((r) => setProds((r.items ?? []).filter((p: any) => p.status === 'published').slice(0, 300))).catch(() => {}); }, [load]);
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <h2>Landinglar</h2>
      <p className="muted small">Sahifa bloklardan yig‘iladi (HTML/skript yo‘q). Narx, rasm va qoldiq har doim katalogdan olinadi. Tahrir yangi versiya bo‘ladi; nashr faqat egasi tasdiqlagan versiyadan.</p>
      <details className="card pp-more"><summary>＋ Yangi landing</summary>
        <label htmlFor="ln-t">Nomi</label><input id="ln-t" value={nw.title} onChange={(e) => setNw({ ...nw, title: e.target.value })} />
        <label htmlFor="ln-s">Manzil: /l/…</label><input id="ln-s" value={nw.slug} onChange={(e) => setNw({ ...nw, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60) })} placeholder="masalan blender-pro" />
        <label htmlFor="ln-tp">Shablon</label><select id="ln-tp" value={nw.template} onChange={(e) => setNw({ ...nw, template: e.target.value })}><option value="simple">Oddiy forma</option><option value="pro">PRO</option><option value="boom">Boom (yengil animatsiya)</option></select>
        <label htmlFor="ln-p">Mahsulot</label><select id="ln-p" value={nw.product} onChange={(e) => setNw({ ...nw, product: e.target.value })}><option value="">— tanlang —</option>{prods.map((p) => <option key={p.id} value={p.id}>{p.name?.['uz-Latn'] ?? p.slug}</option>)}</select>
        <button className="btn mt8" disabled={!nw.title || nw.slug.length < 3 || !nw.product} onClick={async () => { try { const r = await api('/admin/landings', { method: 'POST', body: { slug: nw.slug, title: nw.title, template: nw.template, product_ids: [nw.product] } }); toast('✓ Qoralama yaratildi'); setSel(r.id); load(); } catch (e: any) { toast(e.code === 'SLUG_TAKEN' ? 'Bu manzil band.' : errText(e), 'err'); } }}>Yaratish</button>
      </details>
      <div className="slist">{list?.map((l) => <button key={l.id} type="button" className={`scard cc-card ${sel === l.id ? 'sel' : ''}`} onClick={() => setSel(sel === l.id ? null : l.id)}><div className="spread"><b>{l.title}</b><span className="pill">{ST[l.status]}</span></div><div className="small muted">/l/{l.slug} · {l.template} · qoralama v{l.draft_revision}{l.published_revision ? ` · nashrda v${l.published_revision}` : ''} · {l.flows} oqim</div></button>)}</div>
      {sel && <Editor id={sel} onChanged={load} />}
      <TrackingAdmin />
    </section>
  );
}

function Editor({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [def, setDef] = useState<any>(null);
  const [w, setW] = useState(390);
  const load = useCallback(() => { api(`/admin/landings/${id}`).then((x) => { setD(x); setDef(x.preview.definition); }).catch((e) => toast(errText(e), 'err')); }, [id]);
  useEffect(load, [load]);
  if (!d || !def) return <div className="loading" role="status"><span className="spinner" aria-hidden />…</div>;
  const setBlock = (i: number, props: any) => { const b = [...def.blocks]; b[i] = { ...b[i], props: { ...b[i].props, ...props } }; setDef({ ...def, blocks: b }); };
  const move = (i: number, dir: number) => { const b = [...def.blocks]; const j = i + dir; if (j < 0 || j >= b.length) return; [b[i], b[j]] = [b[j], b[i]]; setDef({ ...def, blocks: b }); };
  const act = async (name: string, body: any = {}) => { try { await api(`/admin/landings/${id}/${name}`, { method: 'POST', body }); toast('✓ Bajarildi'); load(); onChanged(); } catch (e: any) { toast(e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Faqat egasi.' : errText(e), 'err'); } };
  return (
    <div className="card cc-panel">
      <div className="spread"><b>{d.title}</b><span className="small muted">{ST[d.status]} · v{d.draft_revision}</span></div>
      {def.blocks.map((b: any, i: number) => (
        <div key={b.id} className="ln-block">
          <div className="spread small"><b>{b.type}</b><span className="row" style={{ gap: 4 }}><button className="link-btn small" onClick={() => move(i, -1)} aria-label="Yuqoriga">↑</button><button className="link-btn small" onClick={() => move(i, 1)} aria-label="Pastga">↓</button>{b.type !== 'order_form' && <button className="link-btn small danger-t" onClick={() => setDef({ ...def, blocks: def.blocks.filter((_: any, k: number) => k !== i) })}>O‘chirish</button>}</span></div>
          {b.type === 'hero' && <><input aria-label="Sarlavha" placeholder="Sarlavha (bo‘sh — mahsulot nomi)" value={b.props.headline ?? ''} onChange={(e) => setBlock(i, { headline: e.target.value || undefined })} /><input aria-label="Qisqa matn" placeholder="Qisqa matn" value={b.props.subline ?? ''} onChange={(e) => setBlock(i, { subline: e.target.value || undefined })} /></>}
          {b.type === 'benefits' && <textarea aria-label="Afzalliklar" rows={3} placeholder="Har qatorda bitta tasdiqlangan afzallik" value={b.props.items.join('\n')} onChange={(e) => setBlock(i, { items: e.target.value.split('\n').filter((x: string) => x.trim()).slice(0, 8) })} />}
          {b.type === 'faq' && <textarea aria-label="FAQ" rows={4} placeholder={'Savol? | Javob\nHar qatorda bittadan'} value={b.props.items.map((x: any) => `${x.q} | ${x.a}`).join('\n')} onChange={(e) => setBlock(i, { items: e.target.value.split('\n').map((l: string) => l.split('|')).filter((x: string[]) => x[0]?.trim() && x[1]?.trim()).map((x: string[]) => ({ q: x[0]!.trim(), a: x.slice(1).join('|').trim() })).slice(0, 12) })} />}
          {b.type === 'order_form' && <input aria-label="Tugma matni" value={b.props.cta} onChange={(e) => setBlock(i, { cta: e.target.value.slice(0, 40) })} />}
          {b.type === 'video' && <input aria-label="YouTube ID" placeholder="YouTube video ID" value={b.props.ref} onChange={(e) => setBlock(i, { ref: e.target.value.trim() })} />}
          {(b.type === 'contact' || b.type === 'footer') && <input aria-label="Matn" value={b.props.text ?? ''} onChange={(e) => setBlock(i, { text: e.target.value || undefined })} />}
          {b.type === 'delivery_returns' && <input aria-label="Izoh" placeholder="Izoh (ixtiyoriy)" value={b.props.note ?? ''} onChange={(e) => setBlock(i, { note: e.target.value || undefined })} />}
        </div>
      ))}
      <div className="chips">{ADDABLE.map(([t, l, props]) => <button key={t} className="chip" onClick={() => setDef({ ...def, blocks: [...def.blocks, { id: `${t}-${Date.now().toString(36)}`, type: t, props }] })}>＋ {l}</button>)}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={async () => { try { await api(`/admin/landings/${id}/draft`, { method: 'PUT', body: { expected_version: d.version, definition: def } }); toast('✓ Yangi versiya saqlandi'); load(); onChanged(); } catch (e: any) { toast(e.code === 'LANDING_VERSION_CONFLICT' ? 'Boshqa joyda o‘zgartirilgan — sahifani yangilang.' : e.code === 'LANDING_SCHEMA_INVALID' ? `Ruxsat etilmagan qiymat: ${Object.values(e.field_errors ?? {}).join(', ')}` : errText(e), 'err'); } }}>Saqlash (yangi versiya)</button>
        {['draft', 'published'].includes(d.status) && <button className="btn secondary sm" onClick={() => act('submit')}>Ko‘rib chiqishga</button>}
        <button className="btn secondary sm" onClick={() => act('approve', { digest: d.preview.digest })}>Tasdiqlash v{d.draft_revision} (egasi)</button>
        {d.approved_revision && <button className="btn secondary sm" onClick={() => act('publish')}>Nashr qilish v{d.approved_revision} (egasi)</button>}
        {d.status === 'published' && <a className="btn secondary sm" href={`/l/${d.slug}`} target="_blank" rel="noopener noreferrer">Ochish ↗</a>}
        {d.status !== 'archived' && <button className="btn secondary sm danger-t" onClick={() => act('archive')}>Arxivlash</button>}
      </div>
      <LandingStats id={id} />
      <ExperimentsCard id={id} draftRevision={d.draft_revision} publishedRevision={d.published_revision} />
      <div className="chips" aria-label="Ekran o‘lchami">{[360, 390, 430].map((x) => <button key={x} className={`chip ${w === x ? 'on' : ''}`} onClick={() => setW(x)}>{x}px</button>)}</div>
      <div className="ln-preview" style={{ width: "100%", maxWidth: w }}><LandingView data={{ ...d, template: d.template, definition: def, products: d.products, preview: true, revision: d.draft_revision, availability: 'in_stock' }} /></div>
    </div>
  );
}
