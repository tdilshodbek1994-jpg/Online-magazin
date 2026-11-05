'use client';
import { use, useEffect } from 'react';
import { api } from '@/lib/api';

/** Referral landing: records the touch server-side (partner resolved from code on the server), then redirects. */
export default function Ref({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  useEffect(() => {
    api('/referrals/touch', { method: 'POST', body: { code } }).then((r) => location.replace(r.redirect ?? '/')).catch(() => location.replace('/'));
  }, [code]);
  return <p role="status">…</p>;
}
