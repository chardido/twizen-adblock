import { AdController } from '../../src/player/adController';
import { createFetchHook } from './hook';
import { createExtIO, extSources } from './io';
import { PlaylistRouter, type Processor } from './router';
import { stripAnnouncedAds } from './scrub';

/**
 * Codice che gira DENTRO il worker del player (bundle classico, incorporato in page.ts). Avvolge self.fetch:
 * master e media playlist passano dal controller delle pause pubblicitarie, il resto no.
 */
// piu' worker possono coesistere (il player ne crea due): un tag corto distingue i log
const LOG_PREFIX = `[twizen-adblock] [${Math.random().toString(36).slice(2, 5)}] `;
const log = (m: string): void => console.log(LOG_PREFIX + m);

/** Il controller lascia passare il testo finche' non ci sono segmenti pubblicitari: li' si tolgono i date range annunciati (scrub.ts). */
function withScrub(c: AdController): Processor {
  const f = (text: string, ctx: { kind: 'master' | 'media' }) => (out: string): string => (ctx.kind === 'media' && out === text ? stripAnnouncedAds(text) : out);
  return {
    process(text, ctx) {
      const r = c.process(text, ctx);
      return typeof r === 'string' ? f(text, ctx)(r) : r.then(f(text, ctx));
    },
    destroy: () => c.destroy(),
  };
}

const g = self as unknown as { fetch: (input: any, init?: any) => Promise<Response> };
// nessun flag sul global: il gancio e' incorporato una sola volta per worker
if (typeof g.fetch === 'function') {
  // presa PRIMA di installare il gancio: e' la rete del controller (vedi io.ts)
  const rawFetch = g.fetch.bind(self);
  const io = createExtIO(rawFetch, 8000);
  const sources = extSources(rawFetch, log);
  const sink = {
    addBreak() {},
    addAlt(sec: number) {
      log(`live da sorgente pulita per ${sec} s`);
    },
    addPlaceholder(sec: number) {
      log(`nessuna sorgente pulita: attesa per ${sec} s`);
    },
    addFailure() {
      log('mitigazione non riuscita');
    },
  };
  const router = new PlaylistRouter((login) => withScrub(new AdController({ login, enabled: true, io, sources, sink, log })));
  const hooked = createFetchHook({ fetch: rawFetch, router, log });
  g.fetch = hooked;
  log('gancio attivo nel worker');
}
