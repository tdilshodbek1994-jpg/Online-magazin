import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Allowlisted landing block schema (no HTML, no scripts, no iframes). Text is plain text (rendered as text nodes).
 * Product facts (name, price, images, stock, variants) are BINDINGS resolved live from the catalog — a block can only
 * choose to show them, never type a price. Video only from an allowed adapter (own media path or YouTube id).
 */
const txt = (max: number) => z.string().max(max).refine((s) => !/[<>]/.test(s), 'plain_text_only');
const zBlock = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1).max(40), type: z.literal('hero'), props: z.object({ headline: txt(160).optional(), subline: txt(300).optional(), show_price: z.boolean().default(true) }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('gallery'), props: z.object({ max: z.number().int().min(1).max(12).default(6) }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('video'), props: z.object({ provider: z.enum(['media', 'youtube']), ref: z.string().regex(/^([A-Za-z0-9_-]{6,20}|\/media\/[A-Za-z0-9._-]{4,120})$/) }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('benefits'), props: z.object({ items: z.array(txt(160)).max(8) }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('specs'), props: z.object({ from_catalog: z.literal(true).default(true) }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('faq'), props: z.object({ items: z.array(z.object({ q: txt(200), a: txt(800) })).max(12) }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('delivery_returns'), props: z.object({ note: txt(500).optional() }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('order_form'), props: z.object({ cta: txt(40).default('Buyurtma berish'), sticky: z.boolean().default(true) }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('contact'), props: z.object({ text: txt(300).optional() }) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal('footer'), props: z.object({ text: txt(300).optional() }) }),
]);
export const zDefinition = z.object({
  schema_version: z.literal(1),
  template_type: z.enum(['simple', 'pro', 'boom', 'multi']),
  locale: z.enum(['uz-Latn', 'uz-Cyrl']).default('uz-Latn'),
  seo: z.object({ title: txt(70).optional(), description: txt(160).optional() }).default({}),
  blocks: z.array(zBlock).min(1).max(30).refine((b) => new Set(b.map((x) => x.id)).size === b.length, 'duplicate_block_id'),
}).strict();
export type LandingDefinition = z.infer<typeof zDefinition>;

export const digestOf = (d: unknown) => createHash('sha256').update(JSON.stringify(d)).digest('hex');

/** Starting blocks per template (all facts come from the catalog bindings). */
export function defaultDefinition(template: 'simple' | 'pro' | 'boom' | 'multi'): LandingDefinition {
  const base = { schema_version: 1 as const, template_type: template, locale: 'uz-Latn' as const, seo: {} };
  if (template === 'simple') return { ...base, blocks: [{ id: 'hero', type: 'hero', props: { show_price: true } }, { id: 'form', type: 'order_form', props: { cta: 'Buyurtma berish', sticky: true } }, { id: 'dr', type: 'delivery_returns', props: {} }] };
  if (template === 'multi') return { ...base, blocks: [{ id: 'hero', type: 'hero', props: { headline: 'Tanlangan mahsulotlar', show_price: true } }, { id: 'form', type: 'order_form', props: { cta: 'Savatga qo‘shish', sticky: false } }, { id: 'dr', type: 'delivery_returns', props: {} }] };
  return { ...base, blocks: [
    { id: 'hero', type: 'hero', props: { show_price: true } }, { id: 'gallery', type: 'gallery', props: { max: 6 } }, { id: 'specs', type: 'specs', props: { from_catalog: true } },
    { id: 'form', type: 'order_form', props: { cta: 'Buyurtma berish', sticky: true } }, { id: 'faq', type: 'faq', props: { items: [] } }, { id: 'dr', type: 'delivery_returns', props: {} }, { id: 'footer', type: 'footer', props: {} },
  ] };
}
