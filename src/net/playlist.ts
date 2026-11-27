/**
 * UNICO punto da cui passano le playlist HLS (master e media) dirette a hls.js.
 * Riceve il testo ricevuto dalla rete e restituisce il testo che hls.js vedra'.
 * Per ora e' l'identita': una fase successiva elaborera' le playlist qui.
 * I segmenti non passano da qui.
 */
export interface PlaylistContext {
  kind: 'master' | 'media';
  url: string;
}

export type PlaylistHandler = (text: string, ctx: PlaylistContext) => string | Promise<string>;

let handler: PlaylistHandler | null = null;

/** Installa (o rimuove, con null) l'elaborazione attiva: il motore la imposta per ogni sessione di riproduzione. */
export function setPlaylistHandler(h: PlaylistHandler | null): void {
  handler = h;
}

/** Senza elaborazione attiva (o con la funzione "Salta le pause pubblicitarie" spenta) e' l'identita'. */
export function processPlaylist(text: string, ctx: PlaylistContext): string | Promise<string> {
  return handler ? handler(text, ctx) : text;
}

/* Tipi strutturali minimi del loader di hls.js (evita di importare hls.js in questo modulo). */
interface LoaderContextLike {
  type: string;
  url: string;
}
interface LoaderResponseLike {
  data: unknown;
}
interface LoaderCallbacksLike<C> {
  onSuccess: (response: LoaderResponseLike, stats: unknown, context: C, networkDetails: unknown) => void;
  [k: string]: unknown;
}
interface LoaderLike {
  context: unknown;
  stats: unknown;
  destroy(): void;
  abort(): void;
  load(context: LoaderContextLike, config: unknown, callbacks: LoaderCallbacksLike<LoaderContextLike>): void;
  getCacheAge?(): number | null;
  getResponseHeader?(name: string): string | null;
}
export type LoaderCtor = new (config: never) => LoaderLike;

/**
 * Costruisce il loader delle playlist per hls.js (`config.pLoader`): delega al loader predefinito e fa passare
 * il testo di ogni playlist di tipo manifest (master) o level (media) da `process`.
 */
export function createPlaylistLoader(Base: LoaderCtor, process: (text: string, ctx: PlaylistContext) => string | Promise<string> = processPlaylist): LoaderCtor {
  return class PlaylistLoader implements LoaderLike {
    private inner: LoaderLike;
    private cancelled = false;
    constructor(config: never) {
      this.inner = new Base(config);
    }
    get context(): unknown {
      return this.inner.context;
    }
    get stats(): unknown {
      return this.inner.stats;
    }
    destroy(): void {
      this.cancelled = true;
      this.inner.destroy();
    }
    abort(): void {
      this.cancelled = true;
      this.inner.abort();
    }
    load(context: LoaderContextLike, config: unknown, callbacks: LoaderCallbacksLike<LoaderContextLike>): void {
      const declared: PlaylistContext['kind'] = context.type === 'manifest' ? 'master' : 'media';
      const wrapped: LoaderCallbacksLike<LoaderContextLike> = {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          if (typeof response.data === 'string') {
            // hls.js carica come "manifest" anche una media playlist data direttamente (es. variante solo audio)
            const kind: PlaylistContext['kind'] = declared === 'master' && response.data.indexOf('#EXT-X-TARGETDURATION') >= 0 ? 'media' : declared;
            let out: string | Promise<string>;
            try {
              out = process(response.data, { kind, url: ctx.url });
            } catch {
              out = response.data;
            }
            if (typeof out !== 'string') {
              // risposta differita (es. attesa della fine di una pausa pubblicitaria): se hls.js annulla nel frattempo, si scarta
              const orig = response.data;
              const base = response;
              out.then(
                (t) => this.deliver(callbacks, { ...base, data: t }, stats, ctx, details),
                () => this.deliver(callbacks, { ...base, data: orig }, stats, ctx, details),
              );
              return;
            }
            response = { ...response, data: out };
          }
          callbacks.onSuccess(response, stats, ctx, details);
        },
      };
      this.inner.load(context, config, wrapped);
    }
    private deliver(callbacks: LoaderCallbacksLike<LoaderContextLike>, response: LoaderResponseLike, stats: unknown, ctx: LoaderContextLike, details: unknown): void {
      if (!this.cancelled) callbacks.onSuccess(response, stats, ctx, details);
    }
    getCacheAge(): number | null {
      return this.inner.getCacheAge ? this.inner.getCacheAge() : null;
    }
    getResponseHeader(name: string): string | null {
      return this.inner.getResponseHeader ? this.inner.getResponseHeader(name) : null;
    }
  };
}
