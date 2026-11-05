'use client';
import { use, useState } from 'react';
import { api } from '@/lib/api';

export default function MockPay({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<string | null>(null);
  return (
    <div className="card notice">
      <h1>MOCK to‘lov sahifasi <span className="badge test">TEST / MOCK — haqiqiy pul emas</span></h1>
      <div className="row">
        <button className="btn" onClick={async () => setR((await api(`/payments/mock/${id}/complete`, { method: 'POST', body: { outcome: 'succeeded' } }).catch((e) => e)).result ?? 'error')}>Muvaffaqiyatli</button>
        <button className="btn danger" onClick={async () => setR((await api(`/payments/mock/${id}/complete`, { method: 'POST', body: { outcome: 'failed' } }).catch((e) => e)).result ?? 'error')}>Xato</button>
      </div>
      {r && <p role="status">{r}</p>}
    </div>
  );
}
