import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { AddToCart } from './AddToCart';
import { Related } from './Related';
import { Reviews } from './Reviews';
import { Waitlist } from './Waitlist';
import { RecentRail } from '@/components/SavedRails';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
async function load(slug: string) {
  const r = await fetch(`${API}/api/v1/products/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('api');
  return r.json();
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await load(slug).catch(() => null);
  if (!p || p.redirect) return {};
  const name = p.name['uz-Latn'] ?? p.name['uz-Cyrl'];
  // Canonical drops referral/UTM params so links do not create index duplicates (§22).
  return { title: `${name} — UzShop`, description: (p.description?.['uz-Latn'] ?? '').slice(0, 155), alternates: { canonical: `/p/${p.slug}` } };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await load(slug);
  if (!p) notFound();
  if (p.redirect) redirect(`/p/${p.redirect}`);
  const variants = p.variants ?? [];
  const minPrice = variants.reduce((m: bigint | null, v: any) => (m === null || BigInt(v.price_minor) < m ? BigInt(v.price_minor) : m), null);
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.name['uz-Latn'], sku: variants[0]?.sku_code, brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined, image: (p.media ?? []).map((m: any) => m.url),
    offers: variants.map((v: any) => ({ '@type': 'Offer', sku: v.sku_code, priceCurrency: 'UZS', price: (Number(BigInt(v.price_minor) / 100n)).toString(), availability: v.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' })),
  };
  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <AddToCart product={p} minPrice={minPrice?.toString() ?? null} />
      {(p.variants ?? []).length > 0 && (p.variants ?? []).every((v: any) => v.available <= 0) && <Waitlist productId={p.id} />}
      <Reviews productId={p.id} />
      {p.category_slug && <Related category={p.category_slug} exclude={p.slug} />}
      <RecentRail exclude={p.id} />
    </article>
  );
}
