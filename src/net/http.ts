/**
 * Unico punto di accesso alla rete dell'app. Qualsiasi altro endpoint
 * (fasi successive) deve passare da qui.
 */
export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  form?: Record<string, string>;
  /** Corpo JSON inviato come text/plain (richiesta "semplice": niente preflight CORS). */
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function formBody(o: Record<string, string>): string {
  return Object.keys(o).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o[k])}`).join('&');
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  const onAbort = () => ctl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort();
    else opts.signal.addEventListener('abort', onAbort);
  }
  try {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    let body: string | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formBody(opts.form);
    } else if (opts.json !== undefined) {
      headers['Content-Type'] = 'text/plain;charset=UTF-8';
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await fetch(url, { method: opts.method || 'GET', headers, body, signal: ctl.signal });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      throw new HttpError(0, ctl.signal.aborted ? 'Richiesta scaduta' : 'Connessione non disponibile');
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const m = json && typeof json === 'object' ? (json as { message?: string }).message : undefined;
      const msg = typeof m === 'string' && m ? m : `Errore ${res.status}`;
      throw new HttpError(res.status, msg, json);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

/** GET di un testo (playlist). Stesso schema di timeout/annullamento di httpJson; errori come HttpError. */
export async function httpText(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  const onAbort = () => ctl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort();
    else opts.signal.addEventListener('abort', onAbort);
  }
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: ctl.signal });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      throw new HttpError(0, ctl.signal.aborted ? 'Richiesta scaduta' : 'Connessione non disponibile');
    }
    if (!res.ok) throw new HttpError(res.status, `Errore ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

export const ID_BASE = 'https://id.twitch.tv';
export const GQL_URL = 'https://gql.twitch.tv/gql';
export const HELIX_BASE = 'https://api.twitch.tv/helix';
