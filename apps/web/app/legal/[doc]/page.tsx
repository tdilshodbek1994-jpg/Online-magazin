export default async function Legal({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  return (
    <div className="card">
      <h1>{doc === 'offer' ? 'Ommaviy oferta' : doc === 'partner' ? 'Hamkorlik shartnomasi' : doc === 'returns' ? 'Qaytarish shartlari' : 'Maxfiylik siyosati'}</h1>
      <div className="notice">QORALAMA — huquqiy mutaxassis tomonidan tekshirilmagan (PHASE1_TASK §26). Haqiqiy savdodan oldin tasdiqlanishi shart.</div>
      <p>Sotuvchi rekvizitlari: DEMO. Real rekvizitlar egasi tomonidan kiritiladi.</p>
    </div>
  );
}
