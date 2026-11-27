/** Costruzione delle risposte restituite al player (pure, senza rete). */

/** L'URL di un input di fetch: stringa, URL o Request. null se non riconoscibile. */
export function inputUrl(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const o = input as { href?: unknown; url?: unknown };
    if (typeof o.href === 'string') return o.href;
    if (typeof o.url === 'string') return o.url;
  }
  return null;
}

/** Il segnale di annullamento di una richiesta (init.signal o Request.signal), se c'e'. */
export function inputSignal(input: unknown, init?: { signal?: AbortSignal | null }): AbortSignal | null {
  if (init && init.signal) return init.signal;
  if (input && typeof input === 'object' && (input as { signal?: unknown }).signal) return (input as { signal: AbortSignal }).signal;
  return null;
}

/** Una risposta nuova con il testo dato: stesso status e header (tranne quelli legati al corpo originale), url originale. */
export function rewrittenResponse(orig: Response, text: string, url: string): Response {
  const headers = new Headers(orig.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  // 204/205/304 non ammettono un corpo; una playlist non arriva mai cosi', ma non si lancia
  const r = new Response(text, { status: orig.status, statusText: orig.statusText, headers });
  // una Response costruita ha url '' e type 'default': il player potrebbe usarli per risolvere gli URI relativi
  try {
    Object.defineProperty(r, 'url', { value: url, configurable: true });
    Object.defineProperty(r, 'type', { value: orig.type, configurable: true });
  } catch {
    /* proprieta' non ridefinibile: resta il valore predefinito */
  }
  return r;
}

/** Rifiuta con AbortError se il segnale scatta prima della promessa (l'attesa di un break puo' durare a lungo). */
export function abortable<T>(p: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(typeof DOMException === 'function' ? new DOMException('Aborted', 'AbortError') : new Error('Aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}
