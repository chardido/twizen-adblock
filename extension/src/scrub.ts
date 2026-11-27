import { AD_SIGNALS } from '../../src/net/adConfig';
import { analyze, parseAttrs } from '../../src/net/adPlaylist';

/**
 * Twitch annuncia una pausa con i date range PRIMA dei segmenti pubblicitari. Il player web mostra l'interfaccia
 * dell'annuncio (etichetta, conto alla rovescia) gia' da quel date range e non la toglie piu' se poi la playlist cambia:
 * finche' non ci sono segmenti pubblicitari il controller lascia passare il testo com'e', quindi qui si tolgono
 * i date range pubblicitari (e solo quelli) dalla copia che vede il player.
 */
function isAdRange(line: string): boolean {
  const a = parseAttrs(line.slice(17));
  if (AD_SIGNALS.daterangeClasses.indexOf(a.CLASS || '') >= 0) return true;
  if ((a.ID || '').indexOf(AD_SIGNALS.daterangeIdPrefix) === 0) return true;
  if ((a.CLASS || '') === 'twitch-ad-quartile') return true;
  if (a.CLASS === AD_SIGNALS.sourceClass && a[AD_SIGNALS.sourceAttr] !== undefined && a[AD_SIGNALS.sourceAttr] !== AD_SIGNALS.sourceLive) return true;
  for (const k in a) if (k.indexOf(AD_SIGNALS.daterangeAttrPrefix) === 0) return true;
  return false;
}

/** Il testo senza i date range pubblicitari annunciati, se la finestra non contiene ancora segmenti pubblicitari; altrimenti invariato. */
export function stripAnnouncedAds(text: string): string {
  if (text.indexOf('#EXT-X-DATERANGE:') < 0) return text;
  const lines = text.split('\n');
  let hit = false;
  for (const l of lines) {
    if (l.indexOf('#EXT-X-DATERANGE:') === 0 && isAdRange(l.replace(/\r$/, ''))) {
      hit = true;
      break;
    }
  }
  if (!hit) return text;
  if (analyze(text).info.present) return text;
  const adStart = announcedStart(lines);
  const kept = lines.filter((l) => !(l.indexOf('#EXT-X-DATERANGE:') === 0 && isAdRange(l.replace(/\r$/, ''))));
  return adStart === null ? kept.join('\n') : withholdPrefetch(kept, adStart).join('\n');
}

/** Il piu' presto START-DATE (ms) tra i date range pubblicitari annunciati, o null. */
function announcedStart(lines: string[]): number | null {
  let best: number | null = null;
  for (const l of lines) {
    if (l.indexOf('#EXT-X-DATERANGE:') !== 0) continue;
    const a = parseAttrs(l.slice(17));
    if (AD_SIGNALS.daterangeClasses.indexOf(a.CLASS || '') < 0) continue;
    const t = Date.parse(a['START-DATE'] || '');
    if (!isNaN(t) && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * Con la pausa annunciata, le righe prefetch che cadono a partire dall'inizio della pausa sono segmenti pubblicitari.
 * Una riga prefetch non ha PDT: il suo istante si ricava dalla fine dell'ultimo segmento piu' la durata di quel segmento
 * per ogni riga prefetch precedente.
 */
function withholdPrefetch(lines: string[], adStartMs: number): string[] {
  let end: number | null = null;
  let dur = 0;
  let pdt: number | null = null;
  for (const l of lines) {
    if (l.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0) pdt = Date.parse(l.slice(25));
    else if (l.indexOf('#EXTINF:') === 0) {
      dur = Number(l.slice(8).split(',')[0]) || 0;
      if (pdt !== null) end = pdt + dur * 1000;
    }
  }
  if (end === null || !dur) return lines;
  let k = 0;
  return lines.filter((l) => {
    if (l.indexOf('#EXT-X-TWITCH-PREFETCH:') !== 0) return true;
    const start = (end as number) + k++ * dur * 1000;
    return start < adStartMs - 100;
  });
}
