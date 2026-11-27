import { parseMedia } from '../../src/net/adPlaylist';
import { urlKey } from './classify';

/**
 * Le playlist a bassa latenza di twitch.tv elencano i prossimi segmenti con `#EXT-X-TWITCH-PREFETCH:<url>`. All'inizio
 * di una pausa (osservato il 2026-11-27) quelle righe puntano gia' ai primi segmenti pubblicitari, mentre la playlist
 * non contiene ancora nessun segnale della pausa; nell'unico campione completo il token dell'URL dei segmenti
 * pubblicitari era piu' corto di quello dei segmenti live (521-523 contro 535 caratteri).
 * Si impara, per variante, la lunghezza del token delle righe prefetch che in una playlist successiva compaiono come
 * segmenti "live" (provati live: quelli pubblicitari compaiono con titolo Amazon|...) e si trattengono le righe prefetch
 * con un'altra lunghezza. Un falso positivo costa solo la bassa latenza per quel giro; un falso negativo lascia il
 * comportamento di prima. Senza conoscenza (inizio sessione) non si tocca nulla.
 */
function tokenLength(url: string): number {
  const m = /\/segment\/([^?]*)/.exec(url);
  return m ? m[1].length : -1;
}

const PREFETCH = '#EXT-X-TWITCH-PREFETCH:';
const MAX_PENDING = 32;
const MAX_KNOWN = 8;

export class PrefetchGuard {
  private pending = new Map<string, Map<string, number>>();
  private known = new Map<string, Set<number>>();

  /** Il testo senza le righe prefetch che non hanno la forma di quelle provate live per la variante `key`. */
  filter(key: string, text: string): string {
    const p = parseMedia(text);
    let known = this.known.get(key);
    let pend = this.pending.get(key);
    if (pend) {
      for (const e of p.entries) {
        if (e.prefetch) continue;
        const b = urlKey(e.uri);
        const n = pend.get(b);
        if (n !== undefined && e.title === 'live' && n > 0) {
          if (!known) {
            known = new Set();
            this.known.set(key, known);
          }
          if (known.size < MAX_KNOWN) known.add(n);
          pend.delete(b);
        }
      }
    }
    const pf = p.entries.filter((e) => e.prefetch);
    if (!pf.length) return text;
    if (!pend) {
      pend = new Map();
      this.pending.set(key, pend);
    }
    for (const e of pf) if (pend.size < MAX_PENDING) pend.set(urlKey(e.uri), tokenLength(e.uri));
    if (!known || known.size === 0) return text;
    const k = known;
    let i = 0;
    let drop = false;
    const out = text.split('\n').filter((l) => {
      if (l.indexOf(PREFETCH) !== 0) return true;
      const n = tokenLength(pf[i++].uri);
      const bad = n > 0 && !k.has(n);
      if (bad) drop = true;
      return !bad;
    });
    return drop ? out.join('\n') : text;
  }
}
