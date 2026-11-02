'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Lang = 'uz-Latn' | 'uz-Cyrl';
const dict = {
  'uz-Latn': {
    home: 'Bosh sahifa', catalog: 'Katalog', account: 'Kabinet', categories: 'Kategoriyalar', allCategories: 'Barchasi', newArrivals: 'Yangi mahsulotlar', deals: 'Chegirmalar', bestPrice: 'Hamyonbop narxlar', seeAll: 'Hammasi',
    heroTitle: 'Kerakli narsalar — uyingizgacha', heroSub: "Buyurtma bering, to'lovni mahsulotni qabul qilganda qiling.", shopNow: 'Xaridni boshlash',
    bCod: "To'lov qabul qilganda", bCodSub: 'Naqd yoki karta orqali', bFast: 'Tez yetkazish', bFastSub: "Toshkent bo'ylab", bReturn: 'Qaytarish', bReturnSub: 'Shartlar asosida', bWarranty: 'Kafolat', bWarrantySub: 'Rasmiy kafolat bilan',
    sortNew: 'Yangilari', sortCheap: 'Arzonroq', sortExpensive: 'Qimmatroq', sort: 'Saralash', inStockOnly: 'Faqat mavjudlari', results: 'natija', resultsFor: "bo'yicha natijalar", related: "O'xshash mahsulotlar", variant: 'Variant',
    added: "Savatga qo'shildi", warranty: 'Kafolat', months: 'oy', description: 'Tavsif', aboutShop: "O'zbekiston bo'ylab onlayn do'kon. Buyurtmalar operator tomonidan tasdiqlanadi.", help: 'Yordam', staff: 'Xodimlar paneli', demoNote: 'DEMO versiya — mahsulotlar va narxlar namuna.', from: 'dan',
    shop: 'UzShop', search: 'Qidirish', searchPh: 'Mahsulot, SKU yoki brend', cart: 'Savat', login: 'Kirish', logout: 'Chiqish', partner: 'Hamkor', ops: 'Operator', admin: 'Boshqaruv',
    addToCart: "Savatga qo'shish", inStock: 'Mavjud', outOfStock: 'Tugagan', price: 'Narx', qty: 'Soni', remove: "O'chirish", checkout: 'Rasmiylashtirish', empty: "Hech narsa topilmadi", emptyCart: "Savat bo'sh",
    loading: 'Yuklanmoqda…', retry: 'Qayta urinish', error: 'Xatolik yuz berdi', name: 'Ism', phone: 'Telefon', district: 'Tuman', street: "Ko'cha", house: 'Uy', apartment: 'Xonadon', landmark: "Mo'ljal",
    delivery: 'Yetkazish', payment: "To'lov", cod: 'Naqd (qabul qilganda)', online: 'Onlayn (Payme/Click)', subtotal: 'Mahsulotlar', discount: 'Chegirma', total: 'Jami', getQuote: 'Hisoblash', placeOrder: 'Buyurtmani tasdiqlash',
    terms: 'Oferta shartlariga roziman', marketing: 'Reklama xabarlarini olishga roziman (ixtiyoriy)', referral: 'Hamkor kodi (ixtiyoriy)', orderPlaced: 'Buyurtma qabul qilindi', awaitingCall: 'Operator siz bilan bog‘lanib tasdiqlaydi',
    verified: 'Buyurtma tasdiqlandi', sendCode: 'Kod yuborish', code: 'SMS kod', verify: 'Tasdiqlash', myOrders: 'Buyurtmalarim', status: 'Holat', priceChanged: "Narx o'zgardi — yangi summani tasdiqlang", returns: 'Qaytarish shartlari',
    confirmTitle: 'Buyurtmani tasdiqlang', confirm: 'Tasdiqlayman', reject: 'Rad etaman', deliveryEta: 'Taxminiy muddat', days: 'kun', test: 'TEST / MOCK',
  },
  'uz-Cyrl': {
    home: 'Бош саҳифа', catalog: 'Каталог', account: 'Кабинет', categories: 'Категориялар', allCategories: 'Барчаси', newArrivals: 'Янги маҳсулотлар', deals: 'Чегирмалар', bestPrice: 'Ҳамёнбоп нархлар', seeAll: 'Ҳаммаси',
    heroTitle: 'Керакли нарсалар — уйингизгача', heroSub: 'Буюртма беринг, тўловни маҳсулотни қабул қилганда қилинг.', shopNow: 'Харидни бошлаш',
    bCod: 'Тўлов қабул қилганда', bCodSub: 'Нақд ёки карта орқали', bFast: 'Тез етказиш', bFastSub: 'Тошкент бўйлаб', bReturn: 'Қайтариш', bReturnSub: 'Шартлар асосида', bWarranty: 'Кафолат', bWarrantySub: 'Расмий кафолат билан',
    sortNew: 'Янгилари', sortCheap: 'Арзонроқ', sortExpensive: 'Қимматроқ', sort: 'Саралаш', inStockOnly: 'Фақат мавжудлари', results: 'натижа', resultsFor: 'бўйича натижалар', related: 'Ўхшаш маҳсулотлар', variant: 'Вариант',
    added: 'Саватга қўшилди', warranty: 'Кафолат', months: 'ой', description: 'Тавсиф', aboutShop: 'Ўзбекистон бўйлаб онлайн дўкон. Буюртмалар оператор томонидан тасдиқланади.', help: 'Ёрдам', staff: 'Ходимлар панели', demoNote: 'DEMO версия — маҳсулотлар ва нархлар намуна.', from: 'дан',
    shop: 'UzShop', search: 'Қидириш', searchPh: 'Маҳсулот, SKU ёки бренд', cart: 'Сават', login: 'Кириш', logout: 'Чиқиш', partner: 'Ҳамкор', ops: 'Оператор', admin: 'Бошқарув',
    addToCart: 'Саватга қўшиш', inStock: 'Мавжуд', outOfStock: 'Тугаган', price: 'Нарх', qty: 'Сони', remove: 'Ўчириш', checkout: 'Расмийлаштириш', empty: 'Ҳеч нарса топилмади', emptyCart: 'Сават бўш',
    loading: 'Юкланмоқда…', retry: 'Қайта уриниш', error: 'Хатолик юз берди', name: 'Исм', phone: 'Телефон', district: 'Туман', street: 'Кўча', house: 'Уй', apartment: 'Хонадон', landmark: 'Мўлжал',
    delivery: 'Етказиш', payment: 'Тўлов', cod: 'Нақд (қабул қилганда)', online: 'Онлайн (Payme/Click)', subtotal: 'Маҳсулотлар', discount: 'Чегирма', total: 'Жами', getQuote: 'Ҳисоблаш', placeOrder: 'Буюртмани тасдиқлаш',
    terms: 'Оферта шартларига розиман', marketing: 'Реклама хабарларини олишга розиман (ихтиёрий)', referral: 'Ҳамкор коди (ихтиёрий)', orderPlaced: 'Буюртма қабул қилинди', awaitingCall: 'Оператор сиз билан боғланиб тасдиқлайди',
    verified: 'Буюртма тасдиқланди', sendCode: 'Код юбориш', code: 'SMS код', verify: 'Тасдиқлаш', myOrders: 'Буюртмаларим', status: 'Ҳолат', priceChanged: 'Нарх ўзгарди — янги суммани тасдиқланг', returns: 'Қайтариш шартлари',
    confirmTitle: 'Буюртмани тасдиқланг', confirm: 'Тасдиқлайман', reject: 'Рад этаман', deliveryEta: 'Тахминий муддат', days: 'кун', test: 'TEST / MOCK',
  },
} as const;
export type Key = keyof (typeof dict)['uz-Latn'];

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: Key) => string }>({ lang: 'uz-Latn', setLang: () => {}, t: (k) => dict['uz-Latn'][k] });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('uz-Latn');
  useEffect(() => {
    try {
      const v = localStorage.getItem('om_lang');
      if (v === 'uz-Latn' || v === 'uz-Cyrl') setLangState(v);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === 'uz-Cyrl' ? 'uz-Cyrl' : 'uz';
  }, [lang]);
  // Switching language never clears cart or form state: only the dictionary changes (T015).
  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('om_lang', l); } catch {}
  };
  return <Ctx.Provider value={{ lang, setLang, t: (k) => dict[lang][k] ?? dict['uz-Latn'][k] }}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);

/** Product content is shown in the chosen script with fallback; names/brands/SKUs are never auto-transliterated. */
export function pick(text: Record<string, string> | null | undefined, lang: Lang): string {
  if (!text) return '';
  return text[lang] || text['uz-Latn'] || text['uz-Cyrl'] || text.ru || '';
}
