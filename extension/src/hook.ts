import { analyze } from '../../src/net/adPlaylist';
import { classifyUrl, urlKey } from './classify';
import { abortable, inputSignal, inputUrl, rewrittenResponse } from './response';
import type { PlaylistRouter } from './router';

type FetchFn = (input: any, init?: any) => Promise<Response>;

export interface HookOptions {
  fetch: FetchFn;
  router: PlaylistRouter;
  log: (msg: string) => void;
}

/**
 * Avvolge fetch: solo master e media playlist note passano dal router, tutto il resto (segmenti, API) e' la fetch
 * originale senza leggere il corpo. Se il testo non cambia si restituisce la risposta originale; ogni errore ripiega
 * su di essa.
 */
export function createFetchHook(o: HookOptions): FetchFn {
  const rewritten = new Set<string>(); // chiavi delle playlist attualmente riscritte (le sessioni parallele alternano, il log deve seguire la singola playlist)
  let leaking = false;
  const unowned = new Set<string>();
  return function twizenFetch(input: any, init?: any): Promise<Response> {
    let url: string | null = null;
    let cls: ReturnType<typeof classifyUrl> = null;
    try {
      url = inputUrl(input);
      cls = url === null ? null : classifyUrl(url);
      if (cls && cls.kind === 'media' && !o.router.owns(cls.key)) {
        // diagnostica: una media playlist che nessuna master nota possiede passa senza essere elaborata, e potrebbe contenere pubblicita'
        if (unowned.size < 20 && !unowned.has(cls.key) && /ttvnw\.net/.test(cls.key)) {
          unowned.add(cls.key);
          o.log(`media playlist non associata a nessuna master, non elaborata: ${cls.key.slice(-40)}`);
        }
        cls = null;
      }
    } catch {
      cls = null;
    }
    const p = o.fetch(input, init);
    if (!cls || url === null) return p;
    const u = url;
    const c = cls;
    const signal = inputSignal(input, init);
    return p.then(async (res) => {
      if (!res.ok) return res;
      try {
        const text = await res.clone().text();
        if (c.kind === 'master') o.log(`master ricevuta per ${c.login}${o.router.sessions(c.login) > 0 ? ` (sessioni gia' vive per il canale: ${o.router.sessions(c.login)})` : ''}`);
        const r = c.kind === 'master' ? o.router.master(c.login, u, text) : o.router.media(c.key, u, text);
        const out = await abortable(Promise.resolve(r), signal);
        if (c.kind === 'media') {
          // diagnostica: se il player sta per ricevere segmenti pubblicitari lo si dice (una volta per break) con il motivo noto
          const bad = (out.indexOf('stitched-ad') >= 0 || /#EXTINF:[^,\n]*,[^l\n]/.test(out)) && analyze(out).info.active;
          if (bad && !leaking) o.log(`ATTENZIONE: playlist con pubblicita' consegnata al player (${out === text ? 'testo originale' : 'testo riscritto'})`);
          leaking = bad;
        }
        if (out === text) {
          if (c.kind === 'media' && rewritten.delete(c.key)) o.log(`playlist originale ripristinata (${c.key.slice(-24)})`);
          return res;
        }
        if (c.kind === 'media' && rewritten.size < 50 && !rewritten.has(c.key)) {
          rewritten.add(c.key);
          o.log(`playlist riscritta (${urlKey(u).slice(-24)})`);
        }
        const rw = rewrittenResponse(res, out, u);
        try {
          if (res.body) res.body.cancel();
        } catch {
          /* corpo gia' letto o bloccato */
        }
        return rw;
      } catch (e) {
        if (e && (e as Error).name === 'AbortError') throw e;
        o.log('errore, risposta originale: ' + ((e as Error) && (e as Error).message ? (e as Error).message : String(e)));
        return res;
      }
    });
  };
}
