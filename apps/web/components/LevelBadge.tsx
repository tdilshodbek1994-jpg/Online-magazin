'use client';
import { useId } from 'react';

/**
 * Partner level badge (SVG, no image files): metal frame by tier (bronze 0–4, silver 5–9, gold 10–14, royal 15+),
 * inner gem-like background in the level colour, laurel branches, crown with a gem, a sparkle, the level symbol in the
 * middle and a ribbon «N-Daraja». Locked levels render greyscale.
 */
const METALS = {
  bronze: ['#ffe2c4', '#e0a06a', '#a8622c', '#6e3a14', '#f6c89a'],
  silver: ['#ffffff', '#e3e8ee', '#a9b4bf', '#5f6b77', '#f4f7fa'],
  gold: ['#fff6c7', '#f7cf4a', '#c8921a', '#7a520b', '#ffe58a'],
  royal: ['#fffbe0', '#ffd84d', '#e0a412', '#8a5a00', '#fff0a6'],
} as const;
const tierOf = (level: number) => (level >= 15 ? 'royal' : level >= 10 ? 'gold' : level >= 5 ? 'silver' : 'bronze');
const GEMS: Record<string, [string, string]> = { bronze: ['#7ee2a8', '#1f8f55'], silver: ['#9fd8ff', '#2378c8'], gold: ['#6dffa0', '#0b9a45'], royal: ['#ff8fa3', '#c1121f'] };

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? s + (255 - s) * f : s * (1 + f))));
  return `#${[ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Left laurel branch (mirrored for the right): leaves along an arc around the symbol, tilted along the stem. */
function laurel(fill: string, stroke: string) {
  const out = [];
  for (let k = 0; k < 6; k++) {
    const phi = ((62 - k * 21) * Math.PI) / 180;
    const x = 100 - 54 * Math.cos(phi), y = 122 + 54 * Math.sin(phi);
    const rot = -((62 - k * 21)) + 35;
    out.push(<ellipse key={k} cx={x} cy={y} rx={5.2} ry={11.5} transform={`rotate(${rot} ${x} ${y})`} fill={fill} stroke={stroke} strokeWidth={0.8} />);
  }
  return out;
}

export function LevelBadge({ level, color, symbol, size = 72, locked = false, label }: { level: number; color: string; symbol: string; size?: number; locked?: boolean; label?: string }) {
  const id = useId().replace(/[:]/g, '');
  const tier = tierOf(level);
  const m = METALS[tier];
  const [g1, g2] = GEMS[tier];
  const text = label ?? (level > 0 ? `${level}-Daraja` : 'Start');
  const leaves = laurel(`url(#m${id})`, m[3]);
  return (
    <svg viewBox="0 0 200 220" width={size} height={size * 1.1} role="img" aria-label={`${text} nishoni`} style={locked ? { filter: 'grayscale(1)', opacity: 0.5 } : undefined}>
      <defs>
        <linearGradient id={`m${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={m[0]} /><stop offset=".35" stopColor={m[1]} /><stop offset=".7" stopColor={m[2]} /><stop offset="1" stopColor={m[4]} />
        </linearGradient>
        <linearGradient id={`e${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={m[3]} /><stop offset="1" stopColor={m[2]} /></linearGradient>
        <radialGradient id={`i${id}`} cx=".5" cy=".38" r=".75">
          <stop offset="0" stopColor={shade(color, 0.35)} /><stop offset=".55" stopColor={shade(color, -0.15)} /><stop offset="1" stopColor={shade(color, -0.55)} />
        </radialGradient>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={g1} /><stop offset="1" stopColor={g2} /></linearGradient>
      </defs>
      {/* frame */}
      <rect x="14" y="40" width="172" height="164" rx="38" fill={`url(#e${id})`} />
      <rect x="18" y="44" width="164" height="156" rx="34" fill={`url(#m${id})`} />
      <rect x="29" y="55" width="142" height="134" rx="26" fill={`url(#i${id})`} stroke={m[3]} strokeWidth="1.5" />
      {/* gem facets */}
      <path d="M29 95 L70 55 L100 55 L58 120 Z" fill="#fff" opacity=".07" />
      <path d="M171 100 L130 55 L110 55 L150 140 Z" fill="#fff" opacity=".06" />
      <path d="M40 189 L100 140 L160 189 Z" fill="#000" opacity=".1" />
      {/* sparkle */}
      <path d="M100 62 L103 76 L117 79 L103 82 L100 96 L97 82 L83 79 L97 76 Z" fill="#fffbe6" opacity=".95" />
      {/* laurels */}
      <g>{leaves}</g><g transform="translate(200 0) scale(-1 1)">{leaves}</g>
      {/* symbol */}
      <circle cx="100" cy="122" r="31" fill="#000" opacity=".12" />
      <text x="100" y="124" fontSize="46" textAnchor="middle" dominantBaseline="central">{symbol}</text>
      {/* crown */}
      <path d="M62 44 L70 14 L86 32 L100 6 L114 32 L130 14 L138 44 Z" fill={`url(#m${id})`} stroke={m[3]} strokeWidth="2" strokeLinejoin="round" />
      <rect x="60" y="40" width="80" height="10" rx="4" fill={`url(#m${id})`} stroke={m[3]} strokeWidth="2" />
      <path d="M100 18 L108 30 L100 42 L92 30 Z" fill={`url(#g${id})`} stroke="#fff" strokeWidth="1.2" />
      {(tier === 'gold' || tier === 'royal') && <><circle cx="70" cy="14" r="4" fill={g1} stroke={m[3]} /><circle cx="130" cy="14" r="4" fill={g1} stroke={m[3]} /></>}
      {/* ribbon */}
      <path d="M8 168 L32 160 L32 196 L8 190 L18 179 Z" fill={m[3]} />
      <path d="M192 168 L168 160 L168 196 L192 190 L182 179 Z" fill={m[3]} />
      <path d="M26 158 Q100 146 174 158 L174 192 Q100 180 26 192 Z" fill={`url(#m${id})`} stroke={m[3]} strokeWidth="2" />
      <text x="100" y="176" fontSize={text.length > 8 ? 21 : 25} fontWeight="900" textAnchor="middle" dominantBaseline="central" fill="#123b24" fontFamily="system-ui, sans-serif">{text}</text>
      {tier === 'royal' && <><circle cx="40" cy="70" r="2.2" fill="#fff" /><circle cx="160" cy="82" r="1.8" fill="#fff" /><circle cx="150" cy="176" r="1.6" fill="#fff" /></>}
    </svg>
  );
}
