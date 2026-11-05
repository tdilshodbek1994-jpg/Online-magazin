'use client';
import { useEffect, useState } from 'react';

/**
 * Favourites and "recently viewed" kept on this device (localStorage): no account needed, nothing sent to the server.
 * Only ids/slugs are stored; prices are always fetched fresh when shown. Storage may be unavailable (private mode) —
 * every access is wrapped and the page works without it.
 */
const FAV = 'om-favs';
const RECENT = 'om-recent';
const EVT = 'om-favs-change';
type Item = { id: string; slug: string };

function read(key: string): Item[] {
  try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v.filter((x) => x && x.id && x.slug) : []; } catch { return []; }
}
function write(key: string, v: Item[]) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ }
  try { window.dispatchEvent(new Event(EVT)); } catch { /* ignore */ }
}

export const getFavs = () => read(FAV);
export const getRecent = () => read(RECENT);
export function toggleFav(it: Item): boolean {
  const cur = read(FAV);
  const has = cur.some((x) => x.id === it.id);
  write(FAV, has ? cur.filter((x) => x.id !== it.id) : [{ id: it.id, slug: it.slug }, ...cur].slice(0, 100));
  return !has;
}
export function rememberView(it: Item) {
  const cur = read(RECENT).filter((x) => x.id !== it.id);
  write(RECENT, [{ id: it.id, slug: it.slug }, ...cur].slice(0, 12));
}

/** Re-renders when favourites change anywhere on the page (or in another tab). */
export function useFavs(): Item[] {
  const [v, setV] = useState<Item[]>([]);
  useEffect(() => {
    const load = () => setV(read(FAV));
    load();
    window.addEventListener(EVT, load);
    window.addEventListener('storage', load);
    return () => { window.removeEventListener(EVT, load); window.removeEventListener('storage', load); };
  }, []);
  return v;
}
