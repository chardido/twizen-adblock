import { GQL_URL, HttpError, httpJson } from './http';
import type { RequestShape } from './adConfig';

/**
 * Accesso allo stream HLS di un canale, in forma anonima (nessun token utente).
 * Gli endpoint sono quelli del player web di Twitch e non sono documentati: la forma della richiesta
 * rispecchia il plugin Twitch di streamlink (query persistita PlaybackAccessToken + usher).
 */
export const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const PLAYBACK_TOKEN_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
// usher non invia Access-Control-Allow-Origin: in sviluppo (browser desktop) passa dal proxy di Vite;
// sul TV (config.xml con <access origin="*">) e nel build si va diretti.
export const USHER_BASE: string = import.meta.env.DEV ? '/__proxy/usher' : 'https://usher.ttvnw.net';

export interface PlaybackToken {
  value: string;
  signature: string;
}

export class OfflineError extends Error {
  constructor(message = 'Il canale non e\' in diretta') {
    super(message);
    this.name = 'OfflineError';
  }
}

const LOGIN_RE = /^[A-Za-z0-9_]{1,40}$/;

export function playbackTokenBody(login: string, shape?: RequestShape): unknown {
  return {
    operationName: 'PlaybackAccessToken',
    extensions: { persistedQuery: { version: 1, sha256Hash: PLAYBACK_TOKEN_HASH } },
    variables: { isLive: true, login, isVod: false, vodID: '', playerType: shape ? shape.playerType : 'embed', platform: shape ? shape.platform : 'site' },
  };
}

interface GqlTokenResponse {
  data?: { streamPlaybackAccessToken?: { value?: string; signature?: string } | null };
  errors?: Array<{ message?: string }>;
}

export async function fetchPlaybackToken(login: string, signal?: AbortSignal, shape?: RequestShape): Promise<PlaybackToken> {
  if (!LOGIN_RE.test(login)) throw new OfflineError();
  const r = await httpJson<GqlTokenResponse>(GQL_URL, {
    method: 'POST',
    headers: { 'Client-ID': WEB_CLIENT_ID },
    json: playbackTokenBody(login.toLowerCase(), shape),
    signal,
  });
  const t = r && r.data && r.data.streamPlaybackAccessToken;
  // token nullo senza errori: il canale non esiste o non e' disponibile
  if (r && r.data && r.data.streamPlaybackAccessToken === null && !(r.errors && r.errors.length)) throw new OfflineError();
  if (!t || !t.value || !t.signature) {
    const msg = r && r.errors && r.errors[0] && r.errors[0].message;
    throw new HttpError(502, msg || 'Token di riproduzione non disponibile');
  }
  return { value: t.value, signature: t.signature };
}

export function buildUsherUrl(login: string, token: PlaybackToken, opts: { base?: string; rand?: number; playerType?: string } = {}): string {
  const params: Record<string, string> = {
    platform: 'web',
    p: String(Math.floor((opts.rand === undefined ? Math.random() : opts.rand) * 999999)),
    allow_source: 'true',
    allow_audio_only: 'true',
    playlist_include_framerate: 'true',
    supported_codecs: 'h264',
    player_type: opts.playerType || 'embed',
    sig: token.signature,
    token: token.value,
  };
  const q = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  return `${opts.base === undefined ? USHER_BASE : opts.base}/api/channel/hls/${encodeURIComponent(login.toLowerCase())}.m3u8?${q}`;
}

/** URL della master playlist per il canale (richiede un token nuovo a ogni chiamata). Con `shape`, una forma alternativa di richiesta. */
export async function getMasterUrl(login: string, signal?: AbortSignal, shape?: RequestShape): Promise<string> {
  return buildUsherUrl(login, await fetchPlaybackToken(login, signal, shape), shape ? { playerType: shape.playerType } : {});
}
