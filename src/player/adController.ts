import { AD_TUNING } from '../net/adConfig';
import { analyze, isMediaPlaylist, matchVariant, parseMaster, Timeline, type BreakInfo, type Entry, type MasterVariant, type ParsedMedia } from '../net/adPlaylist';
import type { AdIO, CleanSource } from '../net/adSource';
import type { PlaylistContext } from '../net/playlist';

/**
 * Gestione delle pause pubblicitarie, a strati. Per ogni media playlist che hls.js sta per ricevere:
 *  - nessun break: il testo passa identico (nessuna richiesta in piu');
 *  - break in corso, alternativa pulita disponibile (strato 1): hls.js riceve la media playlist del live richiesta con
 *    un'altra forma (config.CLEAN_SHAPES), con numerazione coerente: il viewer continua a vedere la diretta;
 *  - nessuna alternativa (strato 2): hls.js non riceve mai segmenti pubblicitari; la playlist resta ferma (o, se e' la
 *    prima, si attende) e il video mostra l'ultimo fotogramma + scheda di attesa finche' torna il contenuto reale;
 *  - se la mitigazione stessa fallisce (eccezioni, attesa scaduta) si ripiega sul testo originale (strato 3), registrando il motivo.
 */
export type AdMode = 'off' | 'idle' | 'alt' | 'placeholder';

export interface AdStatus {
  mode: AdMode;
  expectedSec: number | null;
  roll: string | null;
  /** Fine prevista del pod sull'orologio del dispositivo (ms), corretta con l'orologio del server; null se ignota. */
  endsAtMs: number | null;
  podPosition: number | null;
  podLength: number | null;
  /** Sorgente da cui arriva il live durante il break (modalita' 'alt'). */
  source: string | null;
}

export interface AdSink {
  addBreak(): void;
  addAlt(sec: number): void;
  addPlaceholder(sec: number): void;
  addFailure(): void;
}

export interface AdControllerOptions {
  login: string;
  enabled: boolean;
  io: AdIO;
  /** Strategie di sorgente pulita, in ordine di preferenza. */
  sources: CleanSource[];
  sink: AdSink;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Opt-in: una EXT-X-DISCONTINUITY al passaggio tra la playlist originale e la sorgente pulita (vedi Timeline). Default: spento. */
  markSourceSwitch?: boolean;
}

interface AltEntry {
  source: CleanSource;
  variants: MasterVariant[];
}

interface AltResult {
  parsed: ParsedMedia;
  url: string;
}

export const IDLE_AD: AdStatus = { mode: 'idle', expectedSec: null, roll: null, endsAtMs: null, podPosition: null, podLength: null, source: null };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AdController {
  private variants: { [url: string]: MasterVariant } = {};
  private timeline: Timeline;
  private engaged = false;
  private alt: AltEntry | null = null;
  private badShapes: { [id: string]: number } = {};
  private lastOut: { [url: string]: string } = {};
  private breakOpen = false;
  private breakFailed = false;
  private mode: AdMode;
  private modeSince = 0;
  private listeners: Array<(s: AdStatus) => void> = [];
  private info: { expectedSec: number | null; roll: string | null; endsAtMs: number | null; podPosition: number | null; podLength: number | null } = { expectedSec: null, roll: null, endsAtMs: null, podPosition: null, podLength: null };
  private sourceId: string | null = null;
  private destroyed = false;
  private ctl = typeof AbortController === 'function' ? new AbortController() : null;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private log: (m: string) => void;
  private flushTimer = 0;
  /** true mentre un break e' in corso: il motore sospende i controlli di stallo. */
  active = false;

  constructor(private o: AdControllerOptions) {
    this.timeline = new Timeline(AD_TUNING.memorySegments, { markSourceSwitch: !!o.markSourceSwitch });
    this.now = o.now || (() => Date.now());
    this.sleep = o.sleep || defaultSleep;
    this.log = o.log || ((m) => console.log('[ads] ' + m));
    this.mode = o.enabled ? 'idle' : 'off';
  }

  on(fn: (s: AdStatus) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  getStatus(): AdStatus {
    return { mode: this.mode, expectedSec: this.info.expectedSec, roll: this.info.roll, endsAtMs: this.info.endsAtMs, podPosition: this.info.podPosition, podLength: this.info.podLength, source: this.mode === 'alt' ? this.sourceId : null };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.account();
    this.destroyed = true;
    this.active = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.ctl) this.ctl.abort();
    this.listeners = [];
  }

  /** Punto d'ingresso: il testo che hls.js vedra' (o una promessa dello stesso). Non lancia mai. */
  process(text: string, ctx: PlaylistContext): string | Promise<string> {
    if (!this.o.enabled || this.destroyed) return text;
    try {
      if (ctx.kind === 'master' && !isMediaPlaylist(text)) {
        const v = parseMaster(text);
        for (const x of v) this.variants[x.url] = x;
        return text;
      }
      if (!isMediaPlaylist(text)) return text;
      const r = this.media(text, ctx);
      if (typeof r === 'string') return r;
      return r.then(
        (s) => s,
        (e: unknown) => this.degrade(text, e),
      );
    } catch (e) {
      return this.degrade(text, e);
    }
  }

  private degrade(text: string, e: unknown): string {
    this.log('mitigazione fallita, riproduzione normale: ' + (e && (e as Error).message ? (e as Error).message : String(e)));
    if (!this.breakFailed) {
      this.breakFailed = true;
      this.o.sink.addFailure();
    }
    this.setMode('idle');
    this.active = false;
    return text;
  }

  // ---- logica ----

  private variantFor(url: string): MasterVariant | null {
    if (this.variants[url]) return this.variants[url];
    const path = url.split('?')[0];
    for (const k in this.variants) if (k.split('?')[0] === path) return this.variants[k];
    return null;
  }

  private media(text: string, ctx: PlaylistContext): string | Promise<string> {
    const { parsed, info } = analyze(text);
    if (!info.present && !this.engaged) {
      // una sessione pulita ha MEDIA-SEQUENCE == numero live: se non e' cosi' (pre-roll finito prima del primo caricamento)
      // dobbiamo gia' da ora consegnare la numerazione live, altrimenti un break successivo la cambierebbe a meta'
      const f = parsed.entries[0];
      if (!f || f.live === null || f.live === parsed.mediaSequence) {
        this.endBreak();
        return text;
      }
    }
    this.engaged = true;
    const content = parsed.entries.filter((e) => !e.ad && !e.prefetch);
    if (info.active) this.startBreak(info);
    const warm = !info.active && info.present && info.contentAfterAd < AD_TUNING.minContentSegments && !!this.alt;
    if (info.active || warm) {
      return this.getAlt(this.variantFor(ctx.url), info.roll || this.info.roll).then((alt) => {
        if (this.destroyed) return text;
        if (alt) {
          const r = this.timeline.emit(alt.parsed, alt.parsed.entries.filter((e) => !e.prefetch), alt.url, 'clean');
          if (r) {
            this.setMode(info.active ? 'alt' : 'idle');
            this.lastOut[ctx.url] = r.text;
            return r.text;
          }
        }
        if (info.active) return this.placeholder(text, ctx, parsed, content);
        return this.emitPrimary(parsed, content, ctx, text);
      });
    }
    this.endBreak(info);
    return this.emitPrimary(parsed, content, ctx, text);
  }

  private emitPrimary(parsed: ParsedMedia, content: Entry[], ctx: PlaylistContext, original: string): string {
    const r = this.timeline.emit(parsed, content, ctx.url, 'main');
    if (!r) return original;
    this.lastOut[ctx.url] = r.text;
    return r.text;
  }

  /** Strato 2: nessuna alternativa. */
  private placeholder(text: string, ctx: PlaylistContext, parsed: ParsedMedia, content: Entry[]): string | Promise<string> {
    if (this.mode !== 'placeholder') {
      this.setMode('placeholder');
      this.timeline.markGap();
      if (!this.breakFailed) {
        this.breakFailed = true;
        this.o.sink.addFailure();
        this.log('nessuna sorgente pulita: scheda di attesa fino al ritorno del live');
      }
    }
    const frozen = this.lastOut[ctx.url];
    if (frozen) return frozen;
    // mai consegnato nulla per questo livello: il contenuto reale precedente al break (se c'e') e' tutto cio' che si puo' dare
    const r = content.length ? this.timeline.emit(parsed, content, ctx.url, 'main') : null;
    if (r) {
      this.lastOut[ctx.url] = r.text;
      this.timeline.markGap();
      return r.text;
    }
    return this.hold(text, ctx);
  }

  /** Prima playlist del livello e break in corso: si risponde a hls.js solo quando compare contenuto reale. */
  private async hold(original: string, ctx: PlaylistContext): Promise<string> {
    const deadline = this.now() + AD_TUNING.holdMaxMs;
    while (!this.destroyed && this.now() < deadline) {
      await this.sleep(AD_TUNING.holdPollMs);
      if (this.destroyed) return original;
      let t: string;
      try {
        t = await this.o.io.fetchText(ctx.url, this.ctl ? this.ctl.signal : undefined);
      } catch {
        continue;
      }
      const a = analyze(t);
      if (!a.info.active && a.info.contentSegments > 0) {
        this.endBreak(a.info);
        this.timeline.markGap();
        return this.emitPrimary(a.parsed, a.parsed.entries.filter((e) => !e.ad && !e.prefetch), ctx, t);
      }
    }
    throw new Error('attesa del contenuto reale scaduta');
  }

  private async getAlt(variant: MasterVariant | null, roll: string | null): Promise<AltResult | null> {
    if (!variant) {
      this.log('variante sconosciuta, nessuna alternativa');
      return null;
    }
    const signal = this.ctl ? this.ctl.signal : undefined;
    for (const source of this.o.sources) {
      if ((this.badShapes[source.id] || 0) > this.now()) continue;
      if (roll && source.rolls.length && source.rolls.indexOf(roll) < 0) continue;
      try {
        let ent = this.alt && this.alt.source.id === source.id ? this.alt : null;
        if (!ent) {
          ent = { source, variants: await source.variants(this.o.login, signal) };
          this.alt = ent;
        }
        const v = matchVariant(variant, ent.variants);
        if (!v) throw new Error('variante assente');
        const t = await this.o.io.fetchText(v.url, signal);
        const a = analyze(t);
        if (a.info.present || !a.parsed.entries.length) throw new Error('la sorgente contiene pubblicita\' o e\' vuota');
        this.sourceId = source.id;
        return { parsed: a.parsed, url: v.url };
      } catch (e) {
        if (this.destroyed) return null;
        this.log(`sorgente ${source.id} non utilizzabile: ${e && (e as Error).message ? (e as Error).message : String(e)}`);
        this.alt = null;
        this.badShapes[source.id] = this.now() + AD_TUNING.badShapeMs;
      }
    }
    return null;
  }

  // ---- stato e contatori ----

  private updateInfo(info: BreakInfo): void {
    let endsAt: number | null = null;
    if (info.podEndMs !== null && info.adEdgeMs !== null) {
      // i segmenti pubblicitari escono in tempo reale: quanto manca alla fine del pod, misurato dal loro bordo, senza dipendere dall'orologio del TV
      endsAt = this.now() + Math.max(0, info.podEndMs - info.adEdgeMs);
    }
    const changed = this.info.podPosition !== info.podPosition || this.info.endsAtMs === null || endsAt === null || Math.abs(endsAt - this.info.endsAtMs) > 3000;
    this.info = { expectedSec: info.expectedSec, roll: info.roll, endsAtMs: endsAt, podPosition: info.podPosition, podLength: info.podLength };
    if (changed && this.breakOpen) {
      const st = this.getStatus();
      this.listeners.slice().forEach((f) => f(st));
    }
  }

  private startBreak(info: BreakInfo): void {
    this.updateInfo(info);
    if (this.breakOpen) return;
    this.breakOpen = true;
    this.breakFailed = false;
    this.active = true;
    this.o.sink.addBreak();
    this.log(`pausa pubblicitaria rilevata (${info.roll || '?'}, ${info.expectedSec === null ? '?' : info.expectedSec} s)`);
    this.flushTimer = setInterval(() => this.account(), 5000) as unknown as number;
  }

  private endBreak(info?: BreakInfo): void {
    if (info && info.active) return;
    if (!this.breakOpen) {
      if (this.mode !== 'off') this.setMode('idle');
      return;
    }
    if (info && info.contentAfterAd < AD_TUNING.minContentSegments && this.alt) {
      // l'alternativa resta calda ancora un giro
    } else {
      this.alt = null;
    }
    this.breakOpen = false;
    this.active = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = 0;
    this.setMode('idle');
    this.log('pausa pubblicitaria terminata');
  }

  private account(): void {
    const t = this.now();
    const sec = Math.max(0, Math.round((t - this.modeSince) / 1000));
    if (this.mode === 'alt' && sec > 0) this.o.sink.addAlt(sec);
    else if (this.mode === 'placeholder' && sec > 0) this.o.sink.addPlaceholder(sec);
    if (this.mode === 'alt' || this.mode === 'placeholder') this.modeSince = this.modeSince + sec * 1000;
    else this.modeSince = t;
  }

  private setMode(m: AdMode): void {
    if (m === this.mode) return;
    this.account();
    this.mode = m;
    this.modeSince = this.now();
    const s = this.getStatus();
    this.listeners.slice().forEach((f) => f(s));
  }
}
