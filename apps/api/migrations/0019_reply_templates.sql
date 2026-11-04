-- Operator Centre 3.0 — P2: saved replies (spec §16). Versioned; Uzbek Latin + Cyrillic; placeholders are filled only
-- from verified order data — a missing value stays visible and blocks sending (no invented dates or prices).
CREATE TABLE reply_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version int NOT NULL DEFAULT 1,
  title text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('customer','partner')),
  body_latn text NOT NULL,
  body_cyrl text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX reply_templates_one_active ON reply_templates (code) WHERE status='active';

-- Starter set (DEMO wording, owner can retire/replace). No promised times or amounts beyond order data.
INSERT INTO reply_templates (code, title, audience, body_latn, body_cyrl) VALUES
 ('confirm_info', 'Buyurtma tarkibi va summasi', 'customer',
  'Assalomu alaykum, {name}! {number} buyurtmangiz: {items}. Jami {total} (yetkazish bilan). To‘lov mahsulotni olganda.',
  'Ассалому алайкум, {name}! {number} буюртмангиз: {items}. Жами {total} (етказиш билан). Тўлов маҳсулотни олганда.'),
 ('no_answer', 'Qo‘ng‘iroqqa javob bo‘lmadi', 'customer',
  '{name}, {number} buyurtma bo‘yicha qo‘ng‘iroq qildik, lekin bog‘lana olmadik. Qulay vaqtda qayta qo‘ng‘iroq qilamiz.',
  '{name}, {number} буюртма бўйича қўнғироқ қилдик, лекин боғлана олмадик. Қулай вақтда қайта қўнғироқ қиламиз.'),
 ('delivery_day', 'Yetkazish kuni', 'customer',
  '{name}, {number} buyurtmangiz {delivery_date} kuni yetkaziladi. Kuryer yetib kelganda qo‘ng‘iroq qiladi.',
  '{name}, {number} буюртмангиз {delivery_date} куни етказилади. Курьер етиб келганда қўнғироқ қилади.'),
 ('partner_waiting', 'Hamkorga: mijoz javobini kutyapmiz', 'partner',
  '{number}: mijoz bilan hali bog‘lana olmadik. Imkon bo‘lsa, mijozga qo‘ng‘iroqni kutishini ayting.', NULL),
 ('partner_confirmed', 'Hamkorga: tasdiqlandi', 'partner',
  '{number}: mijoz tasdiqladi, buyurtma omborga o‘tdi. Komissiya yetkazilgandan keyin hisoblanadi.', NULL);
