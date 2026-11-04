# Qarorlar reyestri — UZSHOP Landing & Target v1

Bu fayl foydalanuvchi bergan talablarni yangi muhandislik takliflaridan ajratadi. `owner_gate` — joriy hujjat taklif qilayotgan boshlang‘ich siyosat; avtomatik ravishda amaldagi biznes qoidasi emas.

| ID | Holat | Qaror | Qo‘llash |
|---|---|---|---|
| D01 | user_requirement | Mahsulotlarni egasi/vakolatli xodim joylaydi; hamkor mustaqil sotuvchi emas. | Barcha rollar va landinglarda. |
| D02 | user_requirement | Hamkor havola orqali ham, mijoz roziligi bilan uning nomidan ham buyurtma beradi. | Bitta Order xizmati, alohida actor/attribution. |
| D03 | user_requirement | Beshta nom saqlanadi: Oddiy, PRO, Boom, Multi Product, AI Landing. | AI — birinchi to‘rt shablondan draft yaratish usuli. |
| D04 | user_requirement | Reklama egasi tasdiqlagandan keyin ishga tushadi. | Aktivatsiya va xarajatni oshirishga server-side gate. |
| D05 | existing_user_policy | 1 dona: 100%; 2 dona: 100%+25%; 3 dona: 100%+50%+25%. | Mavjud commission service natijasini o‘qish, yangi kalkulyator emas. |
| D06 | existing_user_policy | 1 eligible dona = 1 UzCoin; dastlabki cash value 3 000 UZS. | UzCoin xizmatini qayta yozmaslik. |
| D07 | existing_user_policy | Reklama xarajati walletdan yashirin yechilmaydi; charity va jarima alohida. | Marketing o‘lchovlari moliyaviy buyruq emas. |
| D08 | project_constraint | Faqat Online-magazin / ONLINE-MAGAZIN-DEV; TAQVIMga tegmaslik. | Kod, DB, kalit, foydalanuvchi ma’lumotlari va deploy alohida. |
| D09 | owner_gate | Mavjud attribution yo‘q bo‘lsa: explicit valid code, aks holda oxirgi mos click, 30 kun. | Koddagi amaldagi siyosatni tekshirib, productiondan oldin tasdiqlash. |
| D10 | owner_gate | Purchase: prepaid captured accepted order; COD final delivered+verified collection. | Qisman to‘lov/yetkazish va refund siyosati alohida tekshiriladi. |
| D11 | proposed_safe_default | Optional Pixel/CAPI consent yo‘q bo‘lsa o‘chiq; checkout ishlaydi. | Hududiy huquqiy talablar va Meta shartlari release oldidan tekshiriladi. |
| D12 | proposed_safe_default | P0da egaga tegishli bitta dataset; partner datasetlari o‘chiq. | Keyin alohida ownership, consent va data-sharing review. |
| D13 | proposed_safe_default | External obyektlar avval PAUSED; testda live_spend=false. | PAUSED yaratish testi haqiqiy reklama natijasi emas. |
| D14 | owner_gate | Daily/lifetime budget, payer, account, valyuta, muddat va cap. | Hech qanday pul miqdori bu paket bilan avtomatik tasdiqlanmaydi. |
| D15 | proposed_safe_default | Product tugasa tushunarli unavailable sahifa; ichki fallback. | Boshqa mahsulotga yashirin buyurtma, cloaking yo‘q. |
| D16 | proposed_safe_default | P0 bitta domenda; custom domain va A/B keyin. | Registrator xizmati qurish yoki yangi domen sotib olish shart emas. |
| D17 | proposed_safe_default | AI faqat draft/recommendation; write/launch huquqi yo‘q. | Tool permissions backendda, promptga ishonish emas. |
| D18 | owner_gate | A/B primary metric, minimal sample, stop policy, attribution window. | Tajriba boshlanishidan oldin qayd qilinadi. |
| D19 | implementation_gate | Actual current Meta permissions, app/access review, asset binding, API version. | Accountga kirish bo‘lmagani uchun bu yerda verified emas. |
| D20 | implementation_gate | Cookie/data retention, billing, offer/contact/return policy. | Tegishli mutaxassis va egasi review qilmaguncha live gate yopiq. |

## Hech qachon taxmin qilinmaydigan holatlar
Repository ichidagi stack, production konfiguratsiyasi, `uzshop.net` DNS egasi, Meta access tokenlari, real campaign mavjudligi va API javoblari bu paket tayyorlanganda tekshirilmagan. Claude ularni repoda yoki vakolatli hisobda tekshiradi. Bu ochiq joylarni soxta muvaffaqiyat bilan to‘ldirmaydi.

## Raqamli misollar
30 000 UZS komissiya bazasi, 56 order / 76 dona / 1 830 000 UZS, 100 000 UZS reklama sarfi — arifmetik test misollari. Ular real buyurtma yoki reklama hisoboti emas. 30 kunlik referral window ham yangi taklif, mavjud qoidani avtomatik bekor qilmaydi.
