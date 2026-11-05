import Link from 'next/link';

export default function PartnerAbout() {
  return (
    <article className="card prose">
      <h1>Dastur haqida</h1>
      <h2>Qanday ishlaydi</h2>
      <ol>
        <li><b>Market</b>dan mahsulot tanlang — har birida «Siz olasiz» summasi ko‘rsatilgan.</li>
        <li><b>Oqim yaratish</b> — sizga shaxsiy havola beriladi. Uni Telegram kanal, guruh, Instagram yoki do‘stlaringizga yuboring.</li>
        <li>Mijoz havola orqali kirib buyurtma beradi (faqat ism va telefon ham yetarli). Buyurtma avtomatik sizga yoziladi.</li>
        <li>Operator mijozga qo‘ng‘iroq qilib tasdiqlaydi, kuryer yetkazadi, mijoz mahsulotni olib to‘laydi.</li>
        <li>Bonus avval <b>«Taxminiy»</b>, yetkazilib to‘langach <b>«Kutilmoqda»</b>, kutish muddati o‘tgach <b>«Yechish mumkin»</b> bo‘ladi va kartangizga yechib olasiz.</li>
      </ol>
      <h2>So‘rov holatlari</h2>
      <ul>
        <li><b>Yangi</b> — operator hali tasdiqlamagan. <b>Qayta qo‘ng‘iroq</b> — mijoz javob bermagan yoki keyinroq qo‘ng‘iroq so‘ragan.</li>
        <li><b>Dublikat</b> — shu mijoz 24 soat ichida xuddi shu mahsulotga yana buyurtma bergan; operator tekshiradi.</li>
        <li><b>Qabul qilindi</b> — tasdiqlangan, jo‘natishga tayyorlanmoqda. <b>Yetkazilmoqda</b> — kuryerda.</li>
        <li><b>Yetkazildi</b> — mijoz oldi va to‘ladi. <b>Qaytdi / Bekor qilingan</b> — bu buyurtmadan bonus yo‘q.</li>
      </ul>
      <h2>Qoidalar</h2>
      <ul>
        <li>Soxta buyurtma, o‘zingizga buyurtma berish, spam va aldamchi reklama taqiqlanadi — bonus bekor qilinadi, hisob to‘xtatilishi mumkin.</li>
        <li>Mijozdan hech qachon karta raqami, SMS kod yoki parol so‘ramang.</li>
        <li>Narxni mahsulot sahifasidagidan boshqacha aytmang; chegirma va va’dalarni o‘zingizdan qo‘shmang.</li>
        <li>Bonus miqdorlari, kutish muddati va to‘lov qoidalarini do‘kon egasi belgilaydi; to‘liq matn — <Link href="/legal/partner">hamkorlik shartnomasi</Link>.</li>
      </ul>
      <p><Link className="btn" href="/partner/market">Marketga o‘tish</Link></p>
    </article>
  );
}
