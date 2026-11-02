import { describe, expect, it } from 'vitest';
import { normalizeSearch, slugify, tokenize } from './text.js';
import { normalizeUzPhone } from './phone.js';
import { pickText } from './i18n.js';

describe('search normalization (M07, AC-M07-1, AC-X05)', () => {
  it('cyrillic and latin forms match', () => {
    expect(normalizeSearch('Қулоқчин')).toBe(normalizeSearch('quloqchin'));
  });
  it('apostrophe variants are unified', () => {
    expect(normalizeSearch('O‘zbekiston')).toBe(normalizeSearch("O'zbekiston"));
    expect(normalizeSearch('Oʻzbekiston')).toBe(normalizeSearch("O'zbekiston"));
    expect(normalizeSearch('Ўзбекистон')).toBe("o'zbekiston");
  });
  it('model numbers are preserved', () => {
    expect(tokenize('iPhone 17 Pro 256 GB')).toEqual(['iphone', '17', 'pro', '256', 'gb']);
    expect(tokenize('128GB')).not.toEqual(tokenize('256GB'));
  });
  it('slugify', () => {
    expect(slugify("Simsiz quloqchin O'zbek")).toBe('simsiz-quloqchin-ozbek');
  });
});

describe('phone normalization (M02)', () => {
  it.each([
    ['+998 90 123 45 67', '+998901234567'],
    ['998901234567', '+998901234567'],
    ['90 123-45-67', '+998901234567'],
    ['8 90 123 45 67', '+998901234567'],
    ['00998901234567', '+998901234567'],
  ])('%s -> %s', (i, o) => expect(normalizeUzPhone(i)).toBe(o));
  it('rejects foreign/invalid', () => {
    expect(normalizeUzPhone('+7 999 123 45 67')).toBeNull();
    expect(normalizeUzPhone('12345')).toBeNull();
  });
});

describe('i18n fallback (AC-M04-1: no raw keys)', () => {
  it('falls back between scripts', () => {
    expect(pickText({ 'uz-Latn': 'Salom' }, 'uz-Cyrl')).toBe('Salom');
    expect(pickText({ ru: 'Привет', 'uz-Cyrl': 'Салом' }, 'uz-Latn')).toBe('Салом');
  });
});
