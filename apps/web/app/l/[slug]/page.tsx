'use client';
import { use, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LandingView } from '@/components/LandingView';

/** Public landing page: published revision + live catalog facts from the server. */
export default function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { api(`/landings/${slug}`).then(setD).catch(() => setErr(true)); }, [slug]);
  if (err) return <div className="empty">Bu sahifa topilmadi yoki hozir faol emas.</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return <LandingView data={{ ...d, preview: false }} />;
}
