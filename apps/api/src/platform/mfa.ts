import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — second factor for owner/finance (§07, T020). */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totpAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);
/** Returns the matched step (±1 window) or null. Caller rejects step <= last used (replay protection). */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): number | null {
  const s = currentStep(now);
  for (const st of [s - 1, s, s + 1]) {
    const c = totpAt(secretB32, st);
    if (c.length === code.length && timingSafeEqual(Buffer.from(c), Buffer.from(code))) return st;
  }
  return null;
}
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

function key(k: string): Buffer {
  return createHash('sha256').update(k).digest();
}
export function encrypt(plain: string, k: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(k), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(blob: string, k: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(k), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
}
export const hashRecovery = (c: string) => createHash('sha256').update(`recovery:${c.toUpperCase()}`).digest('hex');
