'use client';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick } from '@/lib/i18n';

type Row = { sku_id?: string; offer_version?: number; label: string; sku_code: string; price: string; was: string; cost: string; stock: string; on_hand?: number; reserved?: number };
type Photo = { file: File; url: string };

const toMinor = (som: string) => (som ? String(BigInt(som.replace(/\D/g, '') || '0') * 100n) : '');
const fromMinor = (m?: string | null) => (m ? String(BigInt(m) / 100n) : '');
const digits = (v: string) => v.replace(/\D/g, '');

const ERR: Record<string, string> = {
  VALIDATION_FAILED: 'Majburiy maydonlarni to‘ldiring (nom, kategoriya, narx).',
  CATEGORY_UNKNOWN: 'Kategoriyani tanlang.',
  VERSION_CONFLICT: 'Bu mahsulotni boshqa xodim o‘zgartirgan — oynani yopib, qayta oching.',
  STEP_UP_REQUIRED: 'Komissiyani o‘zgartirish uchun himoya kodi kerak. Avval «MFA» bo‘limida Google Authenticator’ni ulang.',
  MFA_NOT_ENROLLED: 'Komissiyani o‘zgartirish uchun avval «MFA» bo‘limida Google Authenticator’ni ulang.',
  SKU_CODE_TAKEN: 'Bu artikul (SKU) band — boshqasini yozing yoki bo‘sh qoldiring.',
  PRODUCT_HAS_NO_SELLABLE_SKU: 'E’lon qilish uchun kamida bitta narxli variant kerak.',
  MEDIA_TYPE_NOT_ALLOWED: 'Rasm faqat JPG, PNG yoki WEBP bo‘lishi kerak.',
  MEDIA_DIMENSIONS_INVALID: 'Rasm o‘lchami 200–6000 piksel bo‘lishi kerak.',
  MEDIA_SIZE_INVALID: 'Rasm 5 MB dan kichik bo‘lsin.',
  ADJUSTMENT_BELOW_RESERVED: 'Qoldiqni band qilingan miqdordan kam qilib bo‘lmaydi.',
};

function catLabel(c: any, all: any[], lang: any): string {
  const parent = c.parent_id ? all.find((x) => x.id === c.parent_id) : null;
  return parent ? `${pick(parent.name, lang)} › ${pick(c.name, lang)}` : pick(c.name, lang);
}

export function ProductEditor({ product, categories, lang, onClose, onSaved }: { product?: any; categories: any[]; lang: any; onClose: () => void; onSaved: () => void }) {
  const editing = !!product;
  const [f, setF] = useState({
    latn: product ? product.name?.['uz-Latn'] ?? '' : '', cyrl: product ? product.name?.['uz-Cyrl'] ?? '' : '',
    category: product?.category_id ?? '', brand: product?.brand ?? '', warranty: product?.warranty_months != null ? String(product.warranty_months) : '',
    desc: product?.description?.['uz-Latn'] ?? '',
  });
  const [rows, setRows] = useState<Row[]>(() => product?.skus?.length
    ? product.skus.map((s: any) => ({ sku_id: s.sku_id, offer_version: s.offer_version, label: Object.values(s.variant ?? {}).join(' / '), sku_code: s.sku_code, price: fromMinor(s.price_minor), was: fromMinor(s.compare_at_minor), cost: '', stock: '', on_hand: s.on_hand ?? 0, reserved: s.reserved ?? 0 }))
    : [{ label: '', sku_code: '', price: '', was: '', cost: '', stock: '' }]);
  const rule = product?.commission_rule;
  const [com, setCom] = useState<{ kind: 'none' | 'percent' | 'fixed'; value: string }>(rule ? (rule.kind === 'percent' ? { kind: 'percent', value: String(rule.rate_bps / 100) } : { kind: 'fixed', value: fromMinor(rule.fixed_minor) }) : { kind: 'none', value: '' });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), [photos]);

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const note = (m: string) => setLog((l) => [...l, m]);
  const valid = f.latn.trim().length >= 2 && f.category && rows.length > 0 && rows.every((r) => Number(digits(r.price)) > 0);

  const save = async (publish: boolean) => {
    setBusy(true); setErr(null); setLog([]);
    const stamp = Date.now().toString(36).toUpperCase();
    const skuBody = (r: Row, i: number) => ({
      sku_code: r.sku_code.trim() || `P${stamp}-${i + 1}`,
      variant: r.label.trim() ? { variant: r.label.trim() } : {},
      price_minor: toMinor(r.price),
      ...(r.was && Number(digits(r.was)) > Number(digits(r.price)) ? { compare_at_minor: toMinor(r.was) } : {}),
      ...(r.cost ? { cost_minor: toMinor(r.cost) } : {}),
    });
    try {
      let id = product?.id as string | undefined;
      let version = product?.version as number | undefined;
      const stockOps: { sku_id: string; qty: number }[] = [];
      const name = { 'uz-Latn': f.latn.trim(), ...(f.cyrl.trim() ? { 'uz-Cyrl': f.cyrl.trim() } : {}) };
      const description = f.desc.trim() ? { 'uz-Latn': f.desc.trim() } : {};
      if (!editing) {
        const r = await api('/admin/products', { method: 'POST', body: { name, description, category_id: f.category, ...(f.brand.trim() ? { brand: f.brand.trim() } : {}), ...(f.warranty ? { warranty_months: Number(f.warranty) } : {}), skus: rows.map(skuBody) } });
        id = r.id; version = r.version;
        r.skus.forEach((s: any, i: number) => { const q = Number(digits(rows[i]!.stock)); if (q > 0) stockOps.push({ sku_id: s.sku_id, qty: q }); });
        note('✓ Mahsulot yaratildi');
      } else {
        const u = await api(`/admin/products/${id}`, { method: 'PATCH', body: { expected_version: version, name, description: { 'uz-Latn': f.desc.trim() }, category_id: f.category, brand: f.brand.trim() || null, warranty_months: f.warranty ? Number(f.warranty) : null } });
        version = u.version;
        note('✓ Ma’lumotlar saqlandi');
        for (const [i, r] of rows.entries()) {
          if (r.sku_id) {
            const old = product.skus.find((s: any) => s.sku_id === r.sku_id);
            const newWas = r.was && Number(digits(r.was)) > Number(digits(r.price)) ? toMinor(r.was) : null;
            if (old && (toMinor(r.price) !== old.price_minor || newWas !== (old.compare_at_minor ?? null))) {
              await api(`/admin/skus/${r.sku_id}/price`, { method: 'POST', body: { price_minor: toMinor(r.price), compare_at_minor: newWas, expected_version: r.offer_version, reason: 'admin tahrir' } });
              note(`✓ Narx yangilandi: ${r.label || r.sku_code}`);
            }
            const q = Number(digits(r.stock)); if (q > 0) stockOps.push({ sku_id: r.sku_id, qty: q });
          } else {
            const ns = await api(`/admin/products/${id}/skus`, { method: 'POST', body: skuBody(r, i) });
            note(`✓ Variant qo‘shildi: ${r.label || 'yangi'}`);
            const q = Number(digits(r.stock)); if (q > 0) stockOps.push({ sku_id: ns.sku_id, qty: q });
          }
        }
      }
      for (const s of stockOps) await api(`/admin/skus/${s.sku_id}/stock`, { method: 'POST', body: { kind: 'receipt', qty: s.qty, reason: editing ? 'kirim (tahrir)' : 'boshlang‘ich qoldiq', ref: crypto.randomUUID() } });
      if (stockOps.length) note(`✓ Omborga kirim: ${stockOps.reduce((a, s) => a + s.qty, 0)} dona`);
      for (const [k, ph] of photos.entries()) {
        const b64 = await new Promise<string>((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(',')[1] ?? ''); rd.onerror = rej; rd.readAsDataURL(ph.file); });
        await api(`/admin/products/${id}/media`, { method: 'POST', body: { filename: ph.file.name, content_base64: b64, alt: { 'uz-Latn': f.latn.trim() }, rights_source: 'owner upload', sort: k } });
      }
      if (photos.length) note(`✓ ${photos.length} ta rasm yuklandi`);
      const wantRule = com.kind === 'percent' ? { kind: 'percent', rate_bps: Math.round(Number(com.value) * 100) } : com.kind === 'fixed' ? { kind: 'fixed_per_unit', fixed_minor: toMinor(com.value) } : null;
      const same = rule && wantRule && ((wantRule.kind === 'percent' && rule.kind === 'percent' && rule.rate_bps === wantRule.rate_bps) || (wantRule.kind === 'fixed_per_unit' && rule.kind === 'fixed_per_unit' && rule.fixed_minor === (wantRule as any).fixed_minor));
      if (wantRule && !same && Number(com.value) > 0) {
        await api(`/admin/products/${id}/commission-rules`, { method: 'POST', body: wantRule });
        note('✓ Hamkor komissiyasi belgilandi');
      }
      if (publish && product?.status !== 'published') {
        await api(`/admin/products/${id}/status`, { method: 'POST', body: { status: 'published', expected_version: version } });
        note('✓ E’lon qilindi — do‘konda ko‘rinadi');
      }
      onSaved();
      setTimeout(onClose, 900);
    } catch (e: any) {
      setErr(ERR[e.code] ?? `Xatolik: ${e.code ?? 'ERROR'}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="sheet-backdrop editor-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet editor" role="dialog" aria-modal="true" aria-label={editing ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot'} onClick={(e) => e.stopPropagation()}>
        <div className="spread"><h2>{editing ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot'}</h2><button className="icon-btn" aria-label="Yopish" disabled={busy} onClick={onClose}>✕</button></div>

        <fieldset className="ed-sec"><legend>1. Asosiy ma’lumot</legend>
          <label htmlFor="ed-latn">Nomi (lotin) *</label><input id="ed-latn" value={f.latn} onChange={(e) => setF({ ...f, latn: e.target.value })} placeholder="Masalan: Simsiz quloqchin X1" />
          <label htmlFor="ed-cyrl">Номи (кирилл) — ixtiyoriy</label><input id="ed-cyrl" value={f.cyrl} onChange={(e) => setF({ ...f, cyrl: e.target.value })} />
          <label htmlFor="ed-cat">Kategoriya *</label>
          <select id="ed-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">— tanlang —</option>{categories.map((c) => <option key={c.id} value={c.id}>{catLabel(c, categories, lang)}</option>)}</select>
          <div className="ed-two">
            <div><label htmlFor="ed-brand">Brend</label><input id="ed-brand" value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} /></div>
            <div><label htmlFor="ed-war">Kafolat (oy)</label><input id="ed-war" inputMode="numeric" value={f.warranty} onChange={(e) => setF({ ...f, warranty: digits(e.target.value).slice(0, 3) })} /></div>
          </div>
          <label htmlFor="ed-desc">Tavsif</label><textarea id="ed-desc" rows={4} value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} placeholder="Xususiyatlari, o‘lchami, komplekti…" />
        </fieldset>

        <fieldset className="ed-sec"><legend>2. Variantlar, narx va qoldiq</legend>
          <p className="muted small">Bitta variant bo‘lsa, nomini bo‘sh qoldiring. Rang/o‘lcham bo‘lsa — har biri alohida qator. «Eski narx» to‘ldirilsa, chegirma belgisi chiqadi.</p>
          {rows.map((r, i) => (
            <div key={i} className="ed-row">
              <div className="spread"><b>Variant {i + 1}{r.sku_id ? <span className="muted small"> · {r.sku_code} · omborda {r.on_hand} (band {r.reserved})</span> : ''}</b>
                {!r.sku_id && rows.length > 1 && <button type="button" className="link-btn" onClick={() => setRows(rows.filter((_, k) => k !== i))}>O‘chirish</button>}</div>
              <div className="ed-grid">
                <div><label htmlFor={`v-l-${i}`}>Variant nomi</label><input id={`v-l-${i}`} value={r.label} disabled={!!r.sku_id} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="Qora / 128 GB" /></div>
                <div><label htmlFor={`v-p-${i}`}>Narx (so‘m) *</label><input id={`v-p-${i}`} inputMode="numeric" value={r.price} onChange={(e) => setRow(i, { price: digits(e.target.value) })} /></div>
                <div><label htmlFor={`v-w-${i}`}>Eski narx</label><input id={`v-w-${i}`} inputMode="numeric" value={r.was} onChange={(e) => setRow(i, { was: digits(e.target.value) })} /></div>
                <div><label htmlFor={`v-s-${i}`}>{r.sku_id ? 'Kirim (+ dona)' : 'Qoldiq (dona)'}</label><input id={`v-s-${i}`} inputMode="numeric" value={r.stock} onChange={(e) => setRow(i, { stock: digits(e.target.value) })} /></div>
                {!r.sku_id && <div><label htmlFor={`v-c-${i}`}>Tannarx (ichki)</label><input id={`v-c-${i}`} inputMode="numeric" value={r.cost} onChange={(e) => setRow(i, { cost: digits(e.target.value) })} /></div>}
                {!r.sku_id && <div><label htmlFor={`v-k-${i}`}>Artikul (SKU)</label><input id={`v-k-${i}`} value={r.sku_code} onChange={(e) => setRow(i, { sku_code: e.target.value.replace(/[^A-Za-z0-9._-]/g, '') })} placeholder="avtomatik" /></div>}
              </div>
            </div>
          ))}
          <button type="button" className="btn secondary sm" onClick={() => setRows([...rows, { label: '', sku_code: '', price: rows.at(-1)?.price ?? '', was: '', cost: '', stock: '' }])}>+ Variant qo‘shish</button>
        </fieldset>

        <fieldset className="ed-sec"><legend>3. Hamkor komissiyasi</legend>
          <div className="chips" role="radiogroup" aria-label="Komissiya turi">
            {([['none', 'Hozircha yo‘q'], ['percent', 'Foiz (%)'], ['fixed', 'Har donaga so‘m']] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={com.kind === k} className={`chip ${com.kind === k ? 'on' : ''}`} onClick={() => setCom({ ...com, kind: k })}>{l}</button>)}
          </div>
          {com.kind !== 'none' && (<>
            <label htmlFor="ed-com">{com.kind === 'percent' ? 'Foiz (masalan 10)' : 'Har sotilgan dona uchun (so‘m)'}</label>
            <input id="ed-com" inputMode="decimal" value={com.value} onChange={(e) => setCom({ ...com, value: com.kind === 'percent' ? e.target.value.replace(/[^\d.]/g, '') : digits(e.target.value) })} />
            {com.value && rows[0]?.price && <p className="muted small">Hamkor {som(toMinor(rows[0].price))} lik variant uchun ≈ <b>{com.kind === 'percent' ? som(String((BigInt(toMinor(rows[0].price)) * BigInt(Math.round(Number(com.value) * 100))) / 10000n)) : som(toMinor(com.value))}</b> oladi.</p>}
            <p className="muted small">Komissiyani o‘zgartirishda xavfsizlik kodi so‘raladi (MFA).</p>
          </>)}
        </fieldset>

        <fieldset className="ed-sec"><legend>4. Rasmlar</legend>
          <div className="ed-photos">
            {photos.map((p, k) => <div key={k} className="media-thumb"><img src={p.url} alt="" width={72} height={72} /><button type="button" className="btn danger sm" aria-label="Olib tashlash" onClick={() => setPhotos(photos.filter((_, j) => j !== k))}>×</button></div>)}
            <label className="ed-add-photo">+ Rasm<input type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: 'none' }} onChange={(e) => { const fs = Array.from(e.target.files ?? []).slice(0, 10); setPhotos([...photos, ...fs.map((file) => ({ file, url: URL.createObjectURL(file) }))]); e.target.value = ''; }} /></label>
          </div>
          <p className="muted small">{editing ? 'Yangi rasmlar mavjudlariga qo‘shiladi. Mavjud rasmlarni kartochkadagi «Rasmlar» orqali o‘chirasiz.' : 'Birinchi rasm asosiy bo‘ladi. JPG/PNG/WEBP, 5 MB gacha.'}</p>
        </fieldset>

        {log.length > 0 && <div className="notice ok small">{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
        {err && <div className="notice" role="alert">{err}</div>}
        <div className="ed-actions">
          {product?.status !== 'published' && <button className="btn big" disabled={!valid || busy} onClick={() => save(true)}>{busy ? 'Saqlanmoqda…' : 'Saqlash va e’lon qilish'}</button>}
          <button className={`btn big ${product?.status !== 'published' ? 'secondary' : ''}`} disabled={!valid || busy} onClick={() => save(false)}>{product?.status === 'published' ? (busy ? 'Saqlanmoqda…' : 'Saqlash') : 'Qoralama sifatida saqlash'}</button>
        </div>
      </div>
    </div>
  );
}
