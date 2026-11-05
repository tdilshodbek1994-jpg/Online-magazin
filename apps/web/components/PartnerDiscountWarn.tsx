'use client';
import { som } from '@/lib/api';
import { pick } from '@/lib/i18n';

/**
 * Operator warning: the partner gave this customer a discount from their own commission (discount link).
 * The customer saw the lower price, so the operator must say that price, not the catalog one.
 */
export function PartnerDiscountWarn({ lines, lang }: { lines: any[]; lang: any }) {
  const hit = (lines ?? []).filter((l) => l.product_snapshot?.partner_discount);
  if (!hit.length) return null;
  return (
    <div className="pd-warn" role="alert">
      <b>⚠️ Sotuvchi chegirmasi bor</b>
      {hit.map((l) => {
        const d = l.product_snapshot.partner_discount;
        const unit = BigInt(l.unit_price_minor ?? '0');
        const disc = BigInt(d.unit_minor ?? '0');
        return (
          <div key={l.id}>
            «{pick(l.product_snapshot.name, lang)}» uchun hamkor <b>{d.partner_code}</b> tomonidan har donaga <b>{som(disc.toString())}</b> chegirma berilgan.
            {unit > 0n && <> Mijoz <b>{som((unit - disc).toString())}</b> deb ko‘rgan (katalogda {som(unit.toString())}).</>}
          </div>
        );
      })}
      <small>Mijozga chegirmali narxni ayting — jami summa allaqachon chegirma bilan hisoblangan.</small>
    </div>
  );
}
