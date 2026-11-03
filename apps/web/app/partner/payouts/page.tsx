'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** The old "To‘lov" page showed raw ledger codes; everything it did now lives in the plain-language Hamyon page. */
export default function PartnerPayoutsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/partner/wallet' + (typeof location !== 'undefined' ? location.search : '')); }, [router]);
  return <p className="loading" role="status">Hamyonga o‘tilmoqda…</p>;
}
