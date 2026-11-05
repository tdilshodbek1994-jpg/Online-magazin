import { maybeOne, type Queryable } from '../../platform/db.js';
import { currentRate } from '../uzcoin/service.js';
import { matchForm } from './text.js';

/**
 * «UzCoin nima?», «qaytarishda komissiya nima bo‘ladi?» — answers describe how the IMPLEMENTED system works (code rules),
 * with live values read from the services (coin rate, hold policy). A value that is still a demo/draft policy is said
 * so explicitly. No personal data is read for these answers.
 */
export type Topic = 'uzcoin' | 'hold' | 'returns' | 'payout' | 'level' | 'quality' | 'charity' | 'contest' | 'attribution' | 'commission';

const ASK = /\b(nima|nimaga|nega|qanday|qachon|qancha vaqt|necha kun|qoida\w*|degani|tushuntir\w*|bilasanmi|mumkinmi|bo.?ladimi|ishlaydi|chto|kak|kogda)\b/;
const OWN = /\b(balans\w*|mening|menga|qancha pul|nechta|nechanchi|topdim|oldim|tugaydi|boshlanadi|o.?rnim|o.?rindaman)\b/;

export function policyTopic(text: string): Topic | null {
  const t = matchForm(text);
  if (!ASK.test(t) || OWN.test(t)) return null;
  if (/qaytar|vozvrat|otkaz/.test(t) && /komissiya|bonus|pul|coin/.test(t)) return 'returns';
  if (/uzcoin|\bcoin|tanga/.test(t)) return 'uzcoin';
  if (/yechish\w*|yechib|ochadi|o.?tadi|kutish muddati|hold/.test(t) && /pul|komissiya|bonus|balans|hisob/.test(t)) return 'hold';
  if (/kartaga|tolov\w*|payout|vyplat/.test(t)) return 'payout';
  if (/daraja|level|kupon|vip/.test(t)) return 'level';
  if (/sifat|ogohlantirish|jarima|tekshiruv/.test(t)) return 'quality';
  if (/xayriya|ehson/.test(t)) return 'charity';
  if (/konkurs|sovrin/.test(t)) return 'contest';
  if (/kimniki|sizniki|meniki|kimga yoziladi|havola|oqim/.test(t) && /buyurtma/.test(t)) return 'attribution';
  if (/komissiya|bonus/.test(t)) return 'commission';
  return null;
}

const som = (minor: string | number) => `${(BigInt(String(minor)) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;

export async function policyAnswer(q: Queryable, topic: Topic): Promise<string> {
  switch (topic) {
    case 'uzcoin': {
      const r = await currentRate(q);
      return `UzCoin — sotuv uchun mukofot tanga. Yetkazilgan, to‘lovi tasdiqlangan va komissiyasi «yechish mumkin»ga o‘tgan har 1 dona = 1 coin. Hozirgi qiymati: 1 coin = ${som(r.som_per_coin_minor)}. Coinni UzCoin bo‘limida sovg‘aga yoki pulga almashtirish so‘rovi orqali ishlatasiz — almashtirilgunicha bu naqd pul emas. Dona qaytarilsa, uning coini ayiriladi.`;
    }
    case 'hold': {
      const p = await maybeOne<{ value: { days?: number }; status: string }>(q, `SELECT value, status FROM business_policies WHERE key='commission.hold_days' AND effective_at <= now() ORDER BY (status='approved') DESC, version DESC LIMIT 1`);
      const days = p?.value?.days;
      const note = !p ? 'Kutish muddati hali belgilanmagan — avtomatik o‘tish sanasi qo‘yilmaydi.' : `Kutish muddati: ${days} kun${p.status === 'approved' ? '' : ' (namuna qiymat, do‘kon egasi hali tasdiqlamagan)'}.`;
      return `Komissiya 3 bosqichdan o‘tadi: 1) buyurtma tushganda — «yetkazilishi kutilmoqda»; 2) yetkazilib, to‘lovi tasdiqlangach — «kutish muddatida»; 3) kutish muddati tugab, ochiq qaytarish yoki nizo bo‘lmasa — «yechish mumkin». ${note} Hamyonda har bosqich alohida ko‘rinadi.`;
    }
    case 'returns':
      return 'Mijoz mahsulotni qaytarsa yoki buyurtma bekor bo‘lsa, shu dona uchun komissiya hisoblanmaydi: kutilayotgan bo‘lsa — olib tashlanadi; «yechish mumkin»ga o‘tgan bo‘lsa — balansdan ayiriladi; allaqachon to‘langan bo‘lsa — qarz sifatida ochiq ko‘rinadi (yashirilmaydi). Shu dona uchun UzCoin ham ayiriladi. Hammasi Hamyon tarixida sababi bilan yoziladi.';
    case 'payout':
      return 'Pul yechish: Hamyonda «yechish mumkin» summadan so‘rov yuborasiz → summa «band» bo‘ladi → moliya bo‘limi tasdiqlab, kartangizga o‘tkazadi → «to‘landi» bo‘ladi va xabar keladi. Karta ma’lumoti o‘zgarsa, qayta tasdiqlash kerak. AI pul o‘tkazmaydi.';
    case 'level':
      return 'Daraja faqat tasdiqlangan sotuvlar (yetkazilgan, to‘lovi tasdiqlangan dona) soni bo‘yicha hisoblanadi; qaytarilgan dona ayiriladi. 10 000 donada bir martalik 50% komissiya kuponi, 100 000 donada VIP 50% huquqi beriladi — faqat do‘kon tanlagan mahsulotlarda va foyda yetarli bo‘lsa. Kuponni «Darajam» bo‘limida o‘zingiz faollashtirasiz. Darajangizni «Darajam va kuponim» deb so‘rang.';
    case 'quality':
      return 'Sifat ko‘rsatkichlari (tasdiqlanish, yetkazilish, mijoz rad etishi) oxirgi 30 kun bo‘yicha hisoblanadi. Past ko‘rsatkich avtomatik ayb yoki jarima emas — faqat tekshiruv signali. Tekshiruv ochilsa, javob va dalil yuborasiz, qaror chiqsa apellyatsiya qilish mumkin. Pul jarimasi faqat shartnoma va qoidaga asosan, inson qarori bilan.';
    case 'charity':
      return 'Xayriya ixtiyoriy: o‘zingiz rozilik bersangiz, yechish mumkin bo‘lgan komissiyangizdan belgilangan foiz xayriya fondiga ajratiladi. Ajratilgan, fondga topshirilgan summalar alohida ko‘rinadi. Istalgan payt o‘chirib qo‘yishingiz mumkin. AI xayriyani o‘zi yoqmaydi.';
    case 'contest':
      return 'Konkurs natijasi e’lon qilingan qoidalar, boshlanish/tugash vaqti (Toshkent vaqti) bo‘yicha faqat yetkazilgan va to‘lovi tasdiqlangan buyurtmalardan hisoblanadi. Davom etayotgan paytdagi o‘rin o‘zgarishi mumkin; sovrin faqat yakuniy natijadan keyin beriladi. O‘rningizni «Konkursda nechanchi o‘rindaman?» deb so‘rang.';
    case 'attribution':
      return 'Buyurtma sizniki bo‘ladi, agar: mijoz sizning havolangiz (oqimingiz) orqali kirib buyurtma bersa yoki siz uni mijoz roziligi bilan o‘zingiz kiritsangiz. Bu buyurtma yaratilgan paytda qotiriladi — keyinroq boshqa havola uni o‘zgartirmaydi. Har buyurtma kartasida «Nega sizniki» qatori bor.';
    case 'commission':
      return 'Komissiya har mahsulotning qoidasidan (foiz yoki belgilangan summa) buyurtma tushgan paytda qotiriladi — keyin qoida o‘zgarsa ham o‘sha buyurtmaga ta’sir qilmaydi. Pul yetkazilib, to‘lovi tasdiqlangach va kutish muddatidan keyin «yechish mumkin» bo‘ladi. Har buyurtmaning hisob-kitobi buyurtma sahifasida.';
  }
}
