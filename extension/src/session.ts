import type { Processor } from './router';

/** La parte di AdController che serve qui (permette di provare la sessione con un finto). */
export interface Controller {
  process(text: string, ctx: { kind: 'master' | 'media'; url: string }): string | Promise<string>;
  destroy(): void;
  on(fn: (s: { mode: string }) => void): () => void;
}

export interface SessionOptions {
  make: () => Controller;
  log: (msg: string) => void;
  /** Chiamata quando il controller viene fermato per inattivita' (per scrivere i totali accumulati). */
  onStopped?: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Senza playlist per tanto con una pausa aperta, la sessione e' considerata abbandonata dal player. */
  /** Testo aggiunto al log dello stop (es. lo stato delle altre sessioni del worker). */
  describe?: () => string;
  quietMs?: number;
  checkMs?: number;
}

/**
 * Una sessione di riproduzione: un controller piu' una guardia. Un controller con una pausa aperta ha un timer interno
 * (contabilita' ogni 5 s) che non si ferma da solo se il player smette di chiedere la playlist di quella sessione:
 * dopo `quietMs` senza playlist lo si ferma (una riga di log) e, se la sessione riprende, se ne crea uno nuovo
 * rimandandogli l'ultima master: la numerazione deriva dal numero live di Twitch, quindi resta coerente.
 */
export function createSession(o: SessionOptions): Processor {
  const now = o.now || (() => Date.now());
  const setT = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer || ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const quietMs = o.quietMs ?? 30000;
  const checkMs = o.checkMs ?? 10000;
  let ctl: Controller | null = null;
  let master: { text: string; url: string } | null = null;
  let lastFed = now();
  let lastUrl = '';
  let timer: unknown = null;

  const stopWatch = (): void => {
    if (timer !== null) clearT(timer);
    timer = null;
  };
  const check = (): void => {
    timer = null;
    if (!ctl) return;
    const quiet = now() - lastFed;
    if (quiet < quietMs) {
      timer = setT(check, checkMs);
      return;
    }
    o.log(`sessione senza playlist da ${Math.round(quiet / 1000)} s con la pausa aperta: controller fermato (riprendera' se il player torna); ultima playlist ${lastUrl.replace(/[?#].*/, '').slice(-24) || '-'}${o.describe ? '; ' + o.describe() : ''}`);
    const c = ctl;
    ctl = null;
    c.destroy();
    if (o.onStopped) o.onStopped();
  };
  const start = (): Controller => {
    const c = o.make();
    ctl = c;
    c.on((s) => {
      if (ctl !== c) return;
      if (s.mode === 'idle') stopWatch();
      else if (timer === null) timer = setT(check, checkMs);
    });
    if (master) c.process(master.text, { kind: 'master', url: master.url });
    return c;
  };

  return {
    process(text, ctx) {
      lastFed = now();
      if (ctx.kind === 'media') lastUrl = ctx.url;
      if (ctx.kind === 'master') master = { text, url: ctx.url };
      return (ctl || start()).process(text, ctx);
    },
    destroy() {
      stopWatch();
      const c = ctl;
      ctl = null;
      if (c) c.destroy();
    },
  };
}
