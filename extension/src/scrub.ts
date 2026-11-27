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
  return lines.filter((l) => !(l.indexOf('#EXT-X-DATERANGE:') === 0 && isAdRange(l.replace(/\r$/, '')))).join('\n');
}
