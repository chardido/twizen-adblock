import { AD_TUNING, CLEAN_SHAPES, type RequestShape } from '../../src/net/adConfig';
import { parseMaster } from '../../src/net/adPlaylist';
import type { AdIO, CleanSource } from '../../src/net/adSource';
import { GQL_URL } from '../../src/net/http';
import { buildUsherUrl, playbackTokenBody, WEB_CLIENT_ID, type PlaybackToken } from '../../src/net/playback';

type FetchFn = (input: any, init?: any) => Promise<Response>;

const USHER_BASE = 'https://usher.ttvnw.net';
const LOGIN_RE = /^[A-Za-z0-9_]{1,40}$/;

/**
 * Rete del controller, costruita sulla fetch ORIGINALE (presa prima di installare il gancio): le richieste del
 * controller non devono passare dal gancio, altrimenti la master alternativa sembrerebbe una nuova sessione.
 * Tutto anonimo: nessun cookie, nessun token utente.
 */
export function createExtIO(rawFetch: FetchFn, timeoutMs: number): AdIO {
  return {
    fetchText(url, signal) {
      return textOf(rawFetch, url, { signal }, timeoutMs);
    },
  };
}

async function textOf(rawFetch: FetchFn, url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }, timeoutMs: number): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  if (init.signal) {
    if (init.signal.aborted) ctl.abort();
    else init.signal.addEventListener('abort', onAbort);
  }
  try {
    const res = await rawFetch(url, { ...init, credentials: 'omit', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener('abort', onAbort);
  }
}

async function anonymousToken(rawFetch: FetchFn, login: string, shape: RequestShape, signal: AbortSignal | undefined, timeoutMs: number): Promise<PlaybackToken> {
  if (!LOGIN_RE.test(login)) throw new Error('login non valido');
  const body = JSON.stringify(playbackTokenBody(login.toLowerCase(), shape));
  // text/plain: richiesta "semplice", come nell'app TV
  const text = await textOf(rawFetch, GQL_URL, { method: 'POST', headers: { 'Client-ID': WEB_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' }, body, signal }, timeoutMs);
  const r = JSON.parse(text) as { data?: { streamPlaybackAccessToken?: { value?: string; signature?: string } | null }; errors?: Array<{ message?: string }> };
  const t = r && r.data && r.data.streamPlaybackAccessToken;
  if (!t || !t.value || !t.signature) throw new Error((r && r.errors && r.errors[0] && r.errors[0].message) || 'token non disponibile');
  return { value: t.value, signature: t.signature };
}

/** Stessa strategia di requestShapeSource (token GQL + usher con un altro playerType/platform), ma sulla fetch originale. */
export function extShapeSource(shape: RequestShape, rawFetch: FetchFn, timeoutMs: number, log: (m: string) => void): CleanSource {
  return {
    id: shape.id,
    rolls: shape.rolls,
    async variants(login, signal) {
      const token = await anonymousToken(rawFetch, login, shape, signal, timeoutMs);
      const url = buildUsherUrl(login, token, { base: USHER_BASE, playerType: shape.playerType });
      const v = parseMaster(await textOf(rawFetch, url, { signal }, timeoutMs));
      if (!v.length) throw new Error('master alternativa vuota');
      log(`sorgente pulita ${shape.id}: ${v.length} varianti`);
      return v;
    },
  };
}

export function extSources(rawFetch: FetchFn, log: (m: string) => void): CleanSource[] {
  return CLEAN_SHAPES.map((s) => extShapeSource(s, rawFetch, AD_TUNING.altTimeoutMs, log));
}
