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
  let rewriting = false;
  return function twizenFetch(input: any, init?: any): Promise<Response> {
    let url: string | null = null;
    let cls: ReturnType<typeof classifyUrl> = null;
    try {
      url = inputUrl(input);
      cls = url === null ? null : classifyUrl(url);
      if (cls && cls.kind === 'media' && !o.router.owns(cls.key)) cls = null;
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
        const r = c.kind === 'master' ? o.router.master(c.login, u, text) : o.router.media(c.key, u, text);
        const out = await abortable(Promise.resolve(r), signal);
        if (out === text) {
          if (rewriting && c.kind === 'media') {
            rewriting = false;
            o.log('playlist originale ripristinata');
          }
          return res;
        }
        if (!rewriting) {
          rewriting = true;
          o.log(`playlist riscritta (${urlKey(u).slice(-40)})`);
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
