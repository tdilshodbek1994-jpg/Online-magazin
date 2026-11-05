'use client';
import { useEffect } from 'react';

/** The old single-form page is superseded by the Order Studio (/partner/new); old links and bookmarks keep working. */
export default function PartnerOrderRedirect() {
  useEffect(() => { location.replace(`/partner/new${location.search}`); }, []);
  return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
}
