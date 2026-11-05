/** E.164 normalization for Uzbekistan numbers (M02). Returns null when not a valid UZ mobile/landline. */
export function normalizeUzPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let d = digits.startsWith('+') ? digits.slice(1) : digits;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9) d = '998' + d; // local 9-digit (e.g. 901234567)
  if (d.length === 10 && d.startsWith('8')) d = '998' + d.slice(1); // legacy 8 prefix
  if (!/^998\d{9}$/.test(d)) return null;
  return '+' + d;
}

export function maskPhone(e164: string): string {
  return e164.length > 7 ? e164.slice(0, 6) + '***' + e164.slice(-2) : '***';
}
