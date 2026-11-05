import type { ReactElement } from 'react';
/**
 * UzShop's own level symbols (drawn for this site, no emoji/stock icons). Each glyph lives in a 100×100 box centred at
 * (50,50) and is painted with the badge's metal gradient (`fill`) and a dark outline (`ink`) so all 20 share one style.
 */
type G = (fill: string, ink: string, gem: string) => ReactElement;
const s = { strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };

export const GLYPHS: G[] = [
  // 0 Boshlovchi — sprout in a pot
  (f, k, g) => <g {...s}><path d="M50 62 C50 48 50 40 50 34" stroke={k} strokeWidth="5" fill="none" /><path d="M50 44 C38 44 28 36 26 24 C40 22 50 30 50 44 Z" fill={g} stroke={k} strokeWidth="3" /><path d="M50 38 C60 36 72 28 74 16 C60 14 50 24 50 38 Z" fill={g} stroke={k} strokeWidth="3" /><path d="M32 62 H68 L63 84 H37 Z" fill={f} stroke={k} strokeWidth="3.5" /><rect x="29" y="58" width="42" height="8" rx="3" fill={f} stroke={k} strokeWidth="3" /></g>,
  // 1 Do‘st — two clasped hands (stylised)
  (f, k) => <g {...s}><path d="M14 52 L32 36 L50 42 L68 36 L86 52 L70 70 L50 64 L30 70 Z" fill={f} stroke={k} strokeWidth="3.5" /><path d="M38 50 L52 60 M46 46 L60 56 M54 44 L66 52" stroke={k} strokeWidth="3" fill="none" /></g>,
  // 2 Qadrdon — heart with a shine
  (f, k, g) => <g {...s}><path d="M50 82 C20 62 14 44 22 32 C30 20 46 22 50 36 C54 22 70 20 78 32 C86 44 80 62 50 82 Z" fill={g} stroke={k} strokeWidth="3.5" /><path d="M30 36 C32 30 38 28 42 30" stroke="#fff" strokeWidth="4" fill="none" opacity=".8" /></g>,
  // 3 Ishonchli — shield with check
  (f, k, g) => <g {...s}><path d="M50 14 L80 24 V48 C80 66 66 78 50 86 C34 78 20 66 20 48 V24 Z" fill={f} stroke={k} strokeWidth="3.5" /><path d="M50 22 L72 30 V48 C72 61 62 70 50 76 Z" fill={g} opacity=".55" /><path d="M36 50 L46 60 L66 38" stroke={k} strokeWidth="6" fill="none" /></g>,
  // 4 Faol — lightning
  (f, k) => <g {...s}><path d="M58 10 L26 54 H48 L40 90 L76 42 H54 Z" fill={f} stroke={k} strokeWidth="3.5" /></g>,
  // 5 Tajribali — target with arrow
  (f, k, g) => <g {...s}><circle cx="46" cy="54" r="30" fill={f} stroke={k} strokeWidth="3.5" /><circle cx="46" cy="54" r="19" fill="#fff" stroke={k} strokeWidth="3" /><circle cx="46" cy="54" r="9" fill={g} stroke={k} strokeWidth="3" /><path d="M46 54 L82 18" stroke={k} strokeWidth="5" /><path d="M74 14 L86 14 L86 26" stroke={k} strokeWidth="5" fill="none" /></g>,
  // 6 Professional — briefcase
  (f, k) => <g {...s}><rect x="18" y="34" width="64" height="44" rx="8" fill={f} stroke={k} strokeWidth="3.5" /><path d="M38 34 V26 C38 22 41 20 44 20 H56 C59 20 62 22 62 26 V34" stroke={k} strokeWidth="4" fill="none" /><path d="M18 52 H82" stroke={k} strokeWidth="3" /><rect x="44" y="47" width="12" height="11" rx="2" fill={k} /></g>,
  // 7 Usta sotuvchi — crossed hammer and wrench
  (f, k) => <g {...s}><path d="M26 76 L60 42" stroke={k} strokeWidth="10" /><path d="M26 76 L60 42" stroke={f} strokeWidth="5" /><path d="M50 22 L74 46 L82 38 L58 14 Z" fill={f} stroke={k} strokeWidth="3.5" /><path d="M74 76 L44 46" stroke={k} strokeWidth="10" /><path d="M74 76 L44 46" stroke={f} strokeWidth="5" /><path d="M30 24 C22 30 22 42 32 46 L40 38 L36 30 L44 26 C40 20 34 20 30 24 Z" fill={f} stroke={k} strokeWidth="3" /></g>,
  // 8 Oltin — medal with ribbon and "1"
  (f, k, g) => <g {...s}><path d="M34 10 L46 40 H54 L66 10 H54 L50 22 L46 10 Z" fill={g} stroke={k} strokeWidth="3" /><circle cx="50" cy="62" r="24" fill={f} stroke={k} strokeWidth="3.5" /><circle cx="50" cy="62" r="16" fill="none" stroke={k} strokeWidth="2" /><path d="M46 56 L52 52 V72" stroke={k} strokeWidth="5" fill="none" /></g>,
  // 9 Platina — faceted platinum ingot
  (f, k) => <g {...s}><path d="M16 66 L30 38 H70 L84 66 Z" fill={f} stroke={k} strokeWidth="3.5" /><path d="M30 38 L38 66 M70 38 L62 66 M16 66 H84" stroke={k} strokeWidth="2.5" /><path d="M36 44 H52" stroke="#fff" strokeWidth="4" opacity=".8" /><text x="50" y="60" fontSize="12" fontWeight="900" textAnchor="middle" fill={k} fontFamily="system-ui">PT</text></g>,
  // 10 Elita — royal crown
  (f, k, g) => <g {...s}><path d="M16 70 L20 30 L36 48 L50 22 L64 48 L80 30 L84 70 Z" fill={f} stroke={k} strokeWidth="3.5" /><rect x="16" y="68" width="68" height="12" rx="3" fill={f} stroke={k} strokeWidth="3.5" /><circle cx="50" cy="58" r="6" fill={g} stroke={k} strokeWidth="2.5" /><circle cx="20" cy="28" r="4" fill={g} stroke={k} strokeWidth="2" /><circle cx="50" cy="20" r="4" fill={g} stroke={k} strokeWidth="2" /><circle cx="80" cy="28" r="4" fill={g} stroke={k} strokeWidth="2" /></g>,
  // 11 Brilliant — cut diamond
  (f, k, g) => <g {...s}><path d="M28 26 H72 L88 44 L50 86 L12 44 Z" fill={g} stroke={k} strokeWidth="3.5" /><path d="M12 44 H88 M28 26 L38 44 L50 86 L62 44 L72 26 M38 44 L50 26 L62 44" stroke={k} strokeWidth="2.5" fill="none" /><path d="M30 34 L36 30" stroke="#fff" strokeWidth="4" opacity=".9" /></g>,
  // 12 VIP — star with "VIP"
  (f, k) => <g {...s}><path d="M50 10 L61 36 L89 38 L67 56 L74 84 L50 69 L26 84 L33 56 L11 38 L39 36 Z" fill={f} stroke={k} strokeWidth="3.5" /><text x="50" y="58" fontSize="15" fontWeight="900" textAnchor="middle" fill={k} fontFamily="system-ui">VIP</text></g>,
  // 13 Ambassador — order with ribbon
  (f, k, g) => <g {...s}><path d="M38 8 H62 L58 34 H42 Z" fill={g} stroke={k} strokeWidth="3" /><path d="M50 30 L56 44 L72 44 L59 54 L64 70 L50 60 L36 70 L41 54 L28 44 L44 44 Z" fill={f} stroke={k} strokeWidth="3" /><circle cx="50" cy="76" r="0" /><path d="M24 82 H76" stroke={k} strokeWidth="4" /></g>,
  // 14 Grandmaster — chess king
  (f, k) => <g {...s}><path d="M50 8 V22 M43 15 H57" stroke={k} strokeWidth="5" /><path d="M36 30 C36 22 64 22 64 30 C64 38 58 42 58 48 H42 C42 42 36 38 36 30 Z" fill={f} stroke={k} strokeWidth="3.5" /><path d="M40 48 H60 L64 74 H36 Z" fill={f} stroke={k} strokeWidth="3.5" /><rect x="28" y="74" width="44" height="10" rx="3" fill={f} stroke={k} strokeWidth="3.5" /></g>,
  // 15 Legenda — flame
  (f, k, g) => <g {...s}><path d="M50 10 C58 26 76 34 76 58 C76 74 64 86 50 86 C36 86 24 74 24 58 C24 44 32 38 36 28 C40 38 44 42 46 44 C46 32 46 22 50 10 Z" fill={g} stroke={k} strokeWidth="3.5" /><path d="M50 48 C56 56 62 60 62 70 C62 77 56 82 50 82 C44 82 38 77 38 70 C38 62 46 58 50 48 Z" fill={f} stroke={k} strokeWidth="2.5" /></g>,
  // 16 Royal — castle
  (f, k, g) => <g {...s}><path d="M14 84 V40 H24 V48 H32 V40 H42 V30 H58 V40 H68 V48 H76 V40 H86 V84 Z" fill={f} stroke={k} strokeWidth="3.5" /><path d="M42 84 V66 C42 60 58 60 58 66 V84" fill={k} /><path d="M50 30 V14 L62 18 L50 22" fill={g} stroke={k} strokeWidth="2.5" /><rect x="22" y="56" width="8" height="10" rx="2" fill={k} /><rect x="70" y="56" width="8" height="10" rx="2" fill={k} /></g>,
  // 17 Crown — crown on a cushion
  (f, k, g) => <g {...s}><path d="M22 58 L24 26 L38 40 L50 18 L62 40 L76 26 L78 58 Z" fill={f} stroke={k} strokeWidth="3.5" /><circle cx="50" cy="46" r="5" fill={g} stroke={k} strokeWidth="2" /><path d="M12 64 C12 58 88 58 88 64 V76 C88 84 12 84 12 76 Z" fill={g} stroke={k} strokeWidth="3.5" /><path d="M20 70 H80" stroke="#fff" strokeWidth="3" opacity=".5" /></g>,
  // 18 Ultimate — rocket
  (f, k, g) => <g {...s}><path d="M50 8 C66 22 70 44 64 66 H36 C30 44 34 22 50 8 Z" fill={f} stroke={k} strokeWidth="3.5" /><circle cx="50" cy="36" r="8" fill={g} stroke={k} strokeWidth="3" /><path d="M36 50 L22 66 L36 66 M64 50 L78 66 L64 66" fill={f} stroke={k} strokeWidth="3" /><path d="M42 66 L50 90 L58 66" fill="#ff8a00" stroke={k} strokeWidth="3" /></g>,
  // 19 UzShop Legend — trophy with UzShop bag
  (f, k, g) => <g {...s}><path d="M30 14 H70 V40 C70 54 60 62 50 62 C40 62 30 54 30 40 Z" fill={f} stroke={k} strokeWidth="3.5" /><path d="M30 22 H18 C18 36 24 42 32 44 M70 22 H82 C82 36 76 42 68 44" stroke={k} strokeWidth="4" fill="none" /><path d="M44 62 H56 V72 H44 Z" fill={f} stroke={k} strokeWidth="3" /><rect x="32" y="72" width="36" height="12" rx="3" fill={f} stroke={k} strokeWidth="3.5" /><path d="M42 30 H58 L56 46 H44 Z" fill={g} stroke={k} strokeWidth="2.5" /><path d="M46 30 C46 24 54 24 54 30" stroke={k} strokeWidth="2.5" fill="none" /></g>,
];
