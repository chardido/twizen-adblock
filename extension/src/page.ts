/**
 * Twizen adblock (estensione personale, MV3). Gira nel MAIN world di twitch.tv a document_start.
 *
 * Il player di twitch.tv (Amazon IVS) scarica la master (usher) e le media playlist da un Web Worker creato come
 * blob con `importScripts('.../amazon-ivs-wasmworker...js')`. Qui si avvolge window.Worker: per ogni worker classico
 * se ne crea uno con il nostro gancio davanti al codice originale; il gancio (workerHook.ts) avvolge fetch e fa
 * passare le playlist da AdController, che durante una pausa sostituisce la playlist con quella dello stesso live
 * richiesto con un'altra forma (site/ps4, autoplay/android) senza break. Nessuna interazione con il player.
 * Si agganciano SOLO i worker del player IVS (match.ts); gli altri (integrita', login) non si toccano.
 * Qualsiasi errore: si crea il worker originale, intatto.
 */
import { isPlayerWorker } from './match';

declare const __WORKER_HOOK_SOURCE__: string;

const W = window as unknown as { Worker: typeof Worker };

function absolute(u: string): string {
  return new URL(u, document.baseURI).href;
}

/** Legge (sincrono) il sorgente di un blob: puo' essere revocato subito dopo la creazione del worker. */
function readBlob(abs: string): string | null {
  const x = new XMLHttpRequest();
  x.open('GET', abs, false);
  x.send();
  return x.status === 200 || x.status === 0 ? x.responseText : null;
}

// Nessun flag globale (window.__...) per evitare il doppio aggancio: lo script gira una volta per documento.
if (typeof W.Worker === 'function' && typeof Blob === 'function') {
  const Native = W.Worker;
  const Wrapped: typeof Worker = new Proxy(Native, {
    construct(target, args: unknown[], newTarget) {
      let a = args;
      try {
        // solo il worker del player (match.ts): tutti gli altri nascono con il costruttore nativo e gli argomenti originali
        if (args.length > 0) {
          const abs = absolute(String(args[0]));
          const opts = args[1] as WorkerOptions | undefined;
          const isBlob = abs.indexOf('blob:') === 0;
          const src = isBlob && !(opts && opts.type === 'module') ? readBlob(abs) : null;
          if (isBlob && src === null) console.log('[twizen-adblock] blob non leggibile, worker non agganciato: ' + abs.slice(0, 60));
          else if (!isPlayerWorker(abs, opts, src) && /ivs|wasm/i.test(src === null ? abs : src.slice(0, 400))) console.log('[twizen-adblock] worker sospetto NON agganciato: ' + abs.slice(0, 60));
          if (isPlayerWorker(abs, opts, src)) {
            const body = isBlob ? (src as string) : 'importScripts(' + JSON.stringify(abs) + ');';
            const blobUrl = URL.createObjectURL(new Blob([__WORKER_HOOK_SOURCE__ + '\n' + body], { type: 'text/javascript' }));
            a = [blobUrl, ...args.slice(1)];
            setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
          }
        }
      } catch {
        a = args;
      }
      if (a === args) return Reflect.construct(target, args, newTarget);
      try {
        const w = Reflect.construct(target, a, newTarget);
        console.log('[twizen-adblock] worker agganciato: ' + String(args[0]).slice(0, 80));
        return w;
      } catch {
        return Reflect.construct(target, args, newTarget);
      }
    },
  });
  W.Worker = Wrapped;
  // Worker.prototype.constructor deve restare === window.Worker
  try {
    Object.defineProperty(Native.prototype, 'constructor', { value: Wrapped, writable: true, configurable: true, enumerable: false });
  } catch {
    /* non ridefinibile: resta il costruttore nativo */
  }
}
