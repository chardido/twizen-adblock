import { CLEAN_SHAPES, type RequestShape } from './adConfig';
import { httpText } from './http';
import { parseMaster, type MasterVariant } from './adPlaylist';
import { getMasterUrl } from './playback';

/**
 * Rete per la mitigazione delle pause pubblicitarie. Solo mentre un break e' in corso o imminente.
 */
export interface AdIO {
  /** Testo di una playlist (media dell'alternativa o ricontrollo di quella originale). */
  fetchText(url: string, signal?: AbortSignal): Promise<string>;
}

export function createAdIO(timeoutMs: number): AdIO {
  return {
    fetchText(url, signal) {
      return httpText(url, { timeoutMs, signal });
    },
  };
}

/**
 * STRATEGIA di sorgente pulita (punto di estensione): dato il canale, puo' restituire le varianti (con l'URL della media
 * playlist del live) da usare al posto di quelle con la pubblicita'. Puo' lanciare o restituire una lista vuota se non
 * e' applicabile. Per aggiungerne una (es. un endpoint che serve la master senza break) basta implementare questa
 * interfaccia e metterla in `defaultSources`; il resto (rilevamento, numerazione, ripiego) non cambia.
 * Per una sola URL senza qualita' multiple restituire una sola variante con name '' e height 0.
 */
export interface CleanSource {
  id: string;
  /** Tipi di break (ROLL-TYPE) per cui ha senso provarla; vuoto = tutti. */
  rolls: string[];
  variants(login: string, signal?: AbortSignal): Promise<MasterVariant[]>;
}

/** Strategia "stessa master richiesta con un altro playerType/platform" (token GQL + usher). */
export function requestShapeSource(shape: RequestShape, timeoutMs: number): CleanSource {
  return {
    id: shape.id,
    rolls: shape.rolls,
    async variants(login, signal) {
      const url = await getMasterUrl(login, signal, shape);
      const v = parseMaster(await httpText(url, { timeoutMs, signal }));
      if (!v.length) throw new Error('master alternativa vuota');
      return v;
    },
  };
}

/** Strategie attive, in ordine di preferenza. */
export function defaultSources(timeoutMs: number): CleanSource[] {
  return CLEAN_SHAPES.map((s) => requestShapeSource(s, timeoutMs));
}
