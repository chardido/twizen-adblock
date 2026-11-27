/**
 * Classificazione (pura) degli URL che il player di twitch.tv richiede dal suo worker.
 * Osservato il 2026-11-27: master su usher.ttvnw.net/api/v2/channel/hls/<login>.m3u8?..., media playlist su
 * <cluster>.playlist.ttvnw.net/v1/playlist/<token>.m3u8 (senza query), segmenti su altri host.
 */
export type UrlClass = { kind: 'master'; login: string } | { kind: 'media'; key: string } | null;

const MASTER_RE = /^\/api\/(?:v\d+\/)?channel\/hls\/([A-Za-z0-9_]{1,40})\.m3u8$/;

/** Chiave per riconoscere una media playlist: URL senza query ne' fragment. */
export function urlKey(url: string): string {
  const i = url.search(/[?#]/);
  return i < 0 ? url : url.slice(0, i);
}

export function classifyUrl(raw: string): UrlClass {
  // percorso veloce: quasi tutte le richieste (segmenti, API) non contengono ".m3u8"
  if (raw.indexOf('.m3u8') < 0) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const m = MASTER_RE.exec(u.pathname);
  if (m && u.hostname === 'usher.ttvnw.net') return { kind: 'master', login: m[1].toLowerCase() };
  if (u.pathname.endsWith('.m3u8')) return { kind: 'media', key: urlKey(raw) };
  return null;
}
