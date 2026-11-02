/**
 * DEMO product illustrations (flat SVG, no text so no font dependency), rendered to PNG by the seed and stored
 * through the normal media pipeline. Original artwork generated in code — no third-party photos, no rights issues.
 * Real product photos replace these from the admin panel (Boshqaruv → Mahsulotlar → Rasm).
 */
export type ArtKind = 'headphones' | 'watch' | 'kettle' | 'phone' | 'earbuds' | 'speaker' | 'laptop' | 'blender' | 'bottle' | 'lamp' | 'backpack' | 'sneaker' | 'perfume' | 'tshirt';
export interface Palette { bg1: string; bg2: string; main: string; dark: string; accent: string }

export const PALETTES: Record<string, Palette> = {
  mint: { bg1: '#e8f7f1', bg2: '#c9eedf', main: '#1f2937', dark: '#111827', accent: '#10b981' },
  sky: { bg1: '#eaf3ff', bg2: '#cfe2ff', main: '#2563eb', dark: '#1e3a8a', accent: '#93c5fd' },
  peach: { bg1: '#fff1e8', bg2: '#ffd9c2', main: '#f97316', dark: '#9a3412', accent: '#fed7aa' },
  lilac: { bg1: '#f3efff', bg2: '#e0d6ff', main: '#7c3aed', dark: '#4c1d95', accent: '#c4b5fd' },
  rose: { bg1: '#fff0f3', bg2: '#ffd3dc', main: '#e11d48', dark: '#881337', accent: '#fda4af' },
  sand: { bg1: '#faf6ee', bg2: '#efe4cc', main: '#a16207', dark: '#713f12', accent: '#fde68a' },
  slate: { bg1: '#f1f5f9', bg2: '#dbe3ec', main: '#334155', dark: '#0f172a', accent: '#94a3b8' },
  white: { bg1: '#eef6ff', bg2: '#d7e7f7', main: '#f8fafc', dark: '#64748b', accent: '#38bdf8' },
};

function shape(kind: ArtKind, c: Palette): string {
  const { main, dark, accent } = c;
  switch (kind) {
    case 'headphones':
      return `<path d="M230 430 C230 230 570 230 570 430" fill="none" stroke="${dark}" stroke-width="34" stroke-linecap="round"/>
        <path d="M230 430 C230 250 570 250 570 430" fill="none" stroke="${main}" stroke-width="16" stroke-linecap="round"/>
        <rect x="175" y="400" width="110" height="190" rx="48" fill="${dark}"/><rect x="200" y="420" width="70" height="150" rx="34" fill="${main}"/>
        <rect x="515" y="400" width="110" height="190" rx="48" fill="${dark}"/><rect x="530" y="420" width="70" height="150" rx="34" fill="${main}"/>
        <circle cx="235" cy="495" r="14" fill="${accent}"/><circle cx="565" cy="495" r="14" fill="${accent}"/>`;
    case 'watch':
      return `<rect x="330" y="170" width="140" height="170" rx="30" fill="${dark}"/><rect x="330" y="460" width="140" height="170" rx="30" fill="${dark}"/>
        <rect x="285" y="285" width="230" height="230" rx="62" fill="${main}"/><rect x="305" y="305" width="190" height="190" rx="48" fill="#0b1220"/>
        <circle cx="400" cy="400" r="62" fill="none" stroke="${accent}" stroke-width="14" stroke-dasharray="290 400" stroke-linecap="round" transform="rotate(-90 400 400)"/>
        <circle cx="400" cy="400" r="38" fill="none" stroke="#f43f5e" stroke-width="12" stroke-dasharray="160 400" stroke-linecap="round" transform="rotate(-90 400 400)"/>
        <rect x="515" y="360" width="16" height="50" rx="6" fill="${dark}"/>`;
    case 'kettle':
      return `<path d="M300 300 L500 300 L545 590 L255 590 Z" fill="${main}"/>
        <path d="M500 330 C620 330 620 520 528 540" fill="none" stroke="${dark}" stroke-width="30" stroke-linecap="round"/>
        <path d="M308 390 L200 300 L222 278 L312 330 Z" fill="${main}"/>
        <rect x="320" y="265" width="160" height="45" rx="20" fill="${dark}"/><rect x="380" y="240" width="40" height="30" rx="10" fill="${dark}"/>
        <rect x="235" y="585" width="330" height="40" rx="14" fill="${dark}"/><rect x="300" y="380" width="22" height="150" rx="10" fill="${accent}" opacity=".7"/>`;
    case 'phone':
      return `<rect x="285" y="150" width="230" height="470" rx="44" fill="${dark}"/><rect x="300" y="168" width="200" height="434" rx="32" fill="url(#scr)"/>
        <rect x="365" y="182" width="70" height="20" rx="10" fill="${dark}"/>
        <rect x="325" y="250" width="70" height="70" rx="18" fill="#ffffff" opacity=".9"/><rect x="405" y="250" width="70" height="70" rx="18" fill="#ffffff" opacity=".55"/>
        <rect x="325" y="330" width="70" height="70" rx="18" fill="#ffffff" opacity=".55"/><rect x="405" y="330" width="70" height="70" rx="18" fill="#ffffff" opacity=".9"/>
        <rect x="350" y="575" width="100" height="8" rx="4" fill="#ffffff" opacity=".8"/>`;
    case 'earbuds':
      return `<rect x="270" y="360" width="260" height="210" rx="90" fill="${main}"/><path d="M270 450 L530 450" stroke="${dark}" stroke-width="6" opacity=".35"/>
        <circle cx="400" cy="505" r="9" fill="${accent}"/>
        <g transform="translate(250 170) rotate(-18)"><rect x="24" y="60" width="34" height="120" rx="17" fill="#ffffff" stroke="${dark}" stroke-width="5"/><circle cx="40" cy="45" r="50" fill="#ffffff" stroke="${dark}" stroke-width="5"/><circle cx="40" cy="45" r="22" fill="${dark}" opacity=".7"/></g>
        <g transform="translate(470 150) rotate(18)"><rect x="24" y="60" width="34" height="120" rx="17" fill="#ffffff" stroke="${dark}" stroke-width="5"/><circle cx="40" cy="45" r="50" fill="#ffffff" stroke="${dark}" stroke-width="5"/><circle cx="40" cy="45" r="22" fill="${dark}" opacity=".7"/></g>`;
    case 'speaker': {
      let dots = '';
      for (let y = 0; y < 4; y++) for (let x = 0; x < 9; x++) dots += `<circle cx="${262 + x * 34}" cy="${352 + y * 32}" r="7" fill="${dark}" opacity=".45"/>`;
      return `<rect x="200" y="300" width="400" height="230" rx="115" fill="${main}"/>${dots}
        <rect x="185" y="320" width="40" height="190" rx="20" fill="${dark}"/><rect x="575" y="320" width="40" height="190" rx="20" fill="${dark}"/>
        <rect x="330" y="270" width="140" height="36" rx="16" fill="${dark}"/>`;
    }
    case 'laptop':
      return `<path d="M250 210 H550 a20 20 0 0 1 20 20 V500 H230 V230 a20 20 0 0 1 20 -20 Z" fill="${dark}"/><rect x="250" y="230" width="300" height="250" rx="8" fill="url(#scr)"/>
        <path d="M160 500 H640 L610 560 H190 Z" fill="${main}"/><rect x="350" y="505" width="100" height="14" rx="7" fill="${dark}" opacity=".4"/>
        <rect x="285" y="270" width="150" height="16" rx="8" fill="#fff" opacity=".8"/><rect x="285" y="300" width="220" height="12" rx="6" fill="#fff" opacity=".5"/><rect x="285" y="325" width="190" height="12" rx="6" fill="#fff" opacity=".5"/>`;
    case 'blender':
      return `<path d="M300 180 H500 L470 470 H330 Z" fill="${accent}" opacity=".55"/><path d="M300 180 H500 L470 470 H330 Z" fill="none" stroke="${dark}" stroke-width="10" stroke-linejoin="round"/>
        <path d="M500 230 C570 240 570 380 485 390" fill="none" stroke="${dark}" stroke-width="22" stroke-linecap="round"/>
        <rect x="290" y="160" width="220" height="34" rx="14" fill="${dark}"/><path d="M360 430 L440 410 M360 410 L440 430" stroke="${dark}" stroke-width="10" stroke-linecap="round"/>
        <path d="M310 470 H490 L520 610 H280 Z" fill="${main}"/><circle cx="400" cy="545" r="28" fill="${dark}"/><circle cx="400" cy="545" r="10" fill="${accent}"/>`;
    case 'bottle':
      return `<rect x="335" y="230" width="130" height="400" rx="56" fill="${main}"/><rect x="350" y="170" width="100" height="80" rx="22" fill="${dark}"/>
        <rect x="370" y="140" width="60" height="40" rx="14" fill="${dark}"/><rect x="335" y="380" width="130" height="70" fill="${dark}" opacity=".25"/>
        <rect x="355" y="270" width="18" height="300" rx="9" fill="#fff" opacity=".35"/>`;
    case 'lamp':
      return `<ellipse cx="400" cy="300" rx="190" ry="120" fill="${accent}" opacity=".35"/><ellipse cx="330" cy="600" rx="120" ry="26" fill="${dark}"/>
        <path d="M330 590 L420 400 L330 260" fill="none" stroke="${main}" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="420" cy="400" r="20" fill="${dark}"/><circle cx="330" cy="260" r="18" fill="${dark}"/>
        <path d="M335 230 L480 180 L520 300 L370 330 Z" fill="${main}"/><ellipse cx="455" cy="320" rx="70" ry="18" fill="#fff7cc" transform="rotate(-12 455 320)"/>`;
    case 'backpack':
      return `<path d="M340 210 C340 150 460 150 460 210" fill="none" stroke="${dark}" stroke-width="26" stroke-linecap="round"/>
        <rect x="250" y="200" width="300" height="410" rx="90" fill="${main}"/><rect x="290" y="420" width="220" height="160" rx="40" fill="${dark}" opacity=".85"/>
        <rect x="320" y="440" width="160" height="14" rx="7" fill="${accent}"/><path d="M250 330 H550" stroke="${dark}" stroke-width="8" opacity=".3"/>
        <circle cx="400" cy="300" r="16" fill="${accent}"/>`;
    case 'sneaker':
      return `<path d="M170 520 C170 440 220 400 300 390 L390 300 C420 280 450 300 470 330 L520 410 C600 420 650 460 650 520 Z" fill="${main}"/>
        <path d="M160 520 H660 V560 C660 575 650 585 635 585 H185 C170 585 160 575 160 560 Z" fill="#ffffff" stroke="${dark}" stroke-width="6"/>
        <path d="M380 345 L420 370 M360 368 L405 395 M342 390 L388 418" stroke="#fff" stroke-width="12" stroke-linecap="round"/>
        <path d="M480 450 C540 455 590 470 620 500" fill="none" stroke="${accent}" stroke-width="16" stroke-linecap="round"/>`;
    case 'perfume':
      return `<rect x="360" y="180" width="80" height="70" rx="12" fill="${dark}"/><rect x="380" y="240" width="40" height="40" fill="${dark}" opacity=".7"/>
        <rect x="270" y="270" width="260" height="330" rx="60" fill="${main}" opacity=".9"/><rect x="290" y="290" width="40" height="280" rx="20" fill="#fff" opacity=".35"/>
        <rect x="330" y="400" width="140" height="90" rx="14" fill="#fff" opacity=".85"/><rect x="355" y="430" width="90" height="12" rx="6" fill="${dark}" opacity=".6"/>`;
    case 'tshirt':
      return `<path d="M310 190 L240 220 L150 330 L230 390 L270 350 L270 620 H530 V350 L570 390 L650 330 L560 220 L490 190 C470 240 330 240 310 190 Z" fill="${main}" stroke="${dark}" stroke-width="8" stroke-linejoin="round"/>
        <path d="M310 190 C330 250 470 250 490 190" fill="none" stroke="${dark}" stroke-width="10"/><circle cx="400" cy="380" r="46" fill="${accent}"/>`;
  }
}

export function productSvg(kind: ArtKind, palette: Palette): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.bg1}"/><stop offset="1" stop-color="${palette.bg2}"/></linearGradient>
    <linearGradient id="scr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.accent}"/><stop offset="1" stop-color="${palette.main === '#f8fafc' ? '#0ea5e9' : palette.main}"/></linearGradient>
  </defs>
  <rect width="800" height="800" fill="url(#bg)"/>
  <circle cx="640" cy="150" r="120" fill="#ffffff" opacity=".35"/><circle cx="140" cy="690" r="90" fill="#ffffff" opacity=".3"/>
  <ellipse cx="400" cy="650" rx="230" ry="28" fill="#000" opacity=".08"/>
  ${shape(kind, palette)}
</svg>`;
}
