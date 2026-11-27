import type { AdIO, CleanSource } from '../../src/net/adSource';
import { AdController } from '../../src/player/adController';
import { createFetchHook } from './hook';
import { createExtIO, extSources } from './io';
import { PlaylistRouter, type Processor } from './router';
import { createSession } from './session';
import { PrefetchGuard } from './prefetch';
import { stripAnnouncedAds } from './scrub';

/**
 * Codice che gira DENTRO il worker del player (bundle classico, incorporato in page.ts). Avvolge self.fetch:
 * master e media playlist passano dal controller delle pause pubblicitarie, il resto no.
 */
// piu' worker possono coesistere (il player ne crea due): un tag corto distingue i log
const TAG = Math.random().toString(36).slice(2, 5);
const LOG_PREFIX = `[twizen-adblock] [${TAG}] `;
const log = (m: string): void => console.log(LOG_PREFIX + m);

/**
 * Un controller con il suo sink silenzioso: i secondi si accumulano e si scrive UNA riga per break (al ritorno a 'idle',
 * o alla distruzione se la sessione viene scartata a meta' break). Il testo passa da scrub.ts finche' non ci sono
 * segmenti pubblicitari: li' si tolgono i date range annunciati.
 */
function makeProcessor(login: string, id: number, io: AdIO, mkSources: (log: (m: string) => void) => CleanSource[], describe: () => string): Processor {
  const slog = (m: string): void => log(`s${id} ${m}`);
  const sources = mkSources(slog);
  let alt = 0;
  let wait = 0;
  const flush = (why: string): void => {
    if (alt || wait) slog(`pausa pubblicitaria${why}: live da sorgente pulita ${alt} s${wait ? `, in attesa senza sorgente ${wait} s` : ''}`);
    alt = 0;
    wait = 0;
  };
  const sink = {
    addBreak() {},
    addAlt(sec: number) {
      alt += sec;
    },
    addPlaceholder(sec: number) {
      wait += sec;
    },
    addFailure() {
      slog('mitigazione non riuscita');
    },
  };
  const make = (): AdController => {
    const c = new AdController({ login, enabled: true, io, sources, sink, log: slog, markSourceSwitch: true });
    c.on((s) => {
      if (s.mode === 'idle') flush('');
    });
    return c;
  };
  const guard = new PrefetchGuard();
  let withheld = 0;
  const f = (text: string, ctx: { kind: 'master' | 'media'; url: string }) => (out: string): string => {
    if (ctx.kind !== 'media' || out !== text) return out;
    const scrubbed = stripAnnouncedAds(text);
    const res = guard.filter(ctx.url.replace(/[?#].*/, ''), scrubbed);
    const dropped = (scrubbed.match(/#EXT-X-TWITCH-PREFETCH:/g) || []).length - (res.match(/#EXT-X-TWITCH-PREFETCH:/g) || []).length;
    const announced = (text.match(/#EXT-X-TWITCH-PREFETCH:/g) || []).length - (scrubbed.match(/#EXT-X-TWITCH-PREFETCH:/g) || []).length;
    if (dropped + announced > 0 && withheld < 20) {
      withheld++;
      slog(`prefetch trattenute: ${dropped + announced} (${announced > 0 ? 'pausa annunciata' : 'forma diversa da quelle live'})`);
    }
    return res;
  };
  const session = createSession({ make, log: slog, describe, onStopped: () => flush(' (sessione senza playlist)') });
  return {
    process(text, ctx) {
      const r = session.process(text, ctx);
      return typeof r === 'string' ? f(text, ctx)(r) : r.then(f(text, ctx));
    },
    destroy() {
      session.destroy();
      flush(' (sessione scartata)');
    },
  };
}

const g = self as unknown as { fetch: (input: any, init?: any) => Promise<Response> };
// nessun flag sul global: il gancio e' incorporato una sola volta per worker
if (typeof g.fetch === 'function') {
  // presa PRIMA di installare il gancio: e' la rete del controller (vedi io.ts)
  const rawFetch = g.fetch.bind(self);
  const io = createExtIO(rawFetch, 8000);
  const router: PlaylistRouter = new PlaylistRouter((login, id) => makeProcessor(login, id, io, (l) => extSources(rawFetch, l), () => router.describe()));
  const hooked = createFetchHook({ fetch: rawFetch, router, log });
  // l'etichetta sulla funzione (non sul global) permette all'osservatore del check di collegare le sue righe a quelle del gancio
  (hooked as unknown as { twizenTag: string }).twizenTag = TAG;
  g.fetch = hooked;
  log('gancio attivo nel worker');
}
