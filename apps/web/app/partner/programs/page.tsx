'use client';
import Link from 'next/link';

export default function PartnerPrograms() {
  return (
    <>
      <h1>Bonus va jarimalar</h1>
      <div className="hub-links">
        <Link href="/partner/contests" className="hub-link">🏆 <span>Konkurslar</span><small>Konkurs markazi ›</small></Link>
        <Link href="/partner/charity" className="hub-link">💝 <span>Xayriya</span><small>Xayriya markazi ›</small></Link>
        <Link href="/partner/level" className="hub-link">🎖️ <span>Darajam</span><small>daraja va kupon ›</small></Link>
        <Link href="/partner/uzcoin" className="hub-link">🪙 <span>UzCoin</span><small>tanga va sovg‘alar ›</small></Link>
      </div>

      <p className="muted small" style={{ marginTop: 14 }}>Bonus va jarimalar tarixi — <Link href="/partner/wallet">Hamyon</Link> bo‘limida.</p>
    </>
  );
}

