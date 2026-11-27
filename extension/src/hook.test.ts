import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AdController } from '../../src/player/adController';
import { createFetchHook } from './hook';
import { extShapeSource } from './io';
import { CLEAN_SHAPES } from '../../src/net/adConfig';
import { PlaylistRouter, type Processor } from './router';
import { rewrittenResponse } from './response';

const fx = (n: string): string => readFileSync(new URL(`../../src/net/fixtures/${n}`, import.meta.url), 'utf8');
const MASTER_URL = 'https://usher.ttvnw.net/api/v2/channel/hls/pgl.m3u8?acmb=x&token=t';
const MEDIA_URL = 'https://euc.playlist.ttvnw.net/v1/playlist/AAA.m3u8';
const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS="a",VIDEO="480p30",FRAME-RATE=30.000', MEDIA_URL].join('\n');

function resp(text: string, init: ResponseInit = {}): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'x-test': '1' }, ...init });
}

/** Un processore che restituisce `out(text)` e conta le chiamate. */
function router(out: (t: string) => string | Promise<string>) {
  const calls: string[] = [];
  const proc: Processor = {
    process(text, ctx) {
      calls.push(ctx.kind);
      return ctx.kind === 'master' ? text : out(text);
    },
    destroy() {},
  };
  return { r: new PlaylistRouter(() => proc), calls };
}

describe('createFetchHook', () => {
  it('testo invariato: la risposta e\' LA STESSA originale (corpo non consumato)', async () => {
    const { r } = router((t) => t);
    const orig = resp('#EXTM3U\n#EXT-X-TARGETDURATION:2\n');
    const f = createFetchHook({ fetch: async (i) => (String(i) === MASTER_URL ? resp(MASTER) : orig), router: r, log: () => {} });
    await f(MASTER_URL);
    const out = await f(MEDIA_URL);
    expect(out).toBe(orig);
    expect(await out.text()).toBe('#EXTM3U\n#EXT-X-TARGETDURATION:2\n');
  });

  it('testo diverso: nuova Response con status, header e url originali', async () => {
    const { r } = router(() => 'NUOVO');
    const f = createFetchHook({ fetch: async (i) => (String(i) === MASTER_URL ? resp(MASTER) : resp('vecchio', { status: 200, statusText: 'OK', headers: { 'x-test': '1', 'content-length': '6' } })), router: r, log: () => {} });
    await f(MASTER_URL);
    const out = await f(new URL(MEDIA_URL));
    expect(await out.text()).toBe('NUOVO');
    expect(out.url).toBe(MEDIA_URL);
    expect(out.status).toBe(200);
    expect(out.headers.get('x-test')).toBe('1');
    expect(out.headers.get('content-length')).toBeNull();
  });

  it('accetta Request e URL; le richieste non di playlist non vengono lette', async () => {
    const { r, calls } = router(() => 'NUOVO');
    let read = 0;
    const seg = resp('seg');
    seg.clone = () => {
      read++;
      return seg;
    };
    const f = createFetchHook({ fetch: async (i) => (String(i instanceof Request ? i.url : i) === MASTER_URL ? resp(MASTER) : seg), router: r, log: () => {} });
    await f(new Request(MASTER_URL));
    expect(calls).toEqual(['master']);
    expect(await f('https://cdn.ttvnw.net/v1/segment/x.ts')).toBe(seg);
    expect(await f('https://euc.playlist.ttvnw.net/v1/playlist/SCONOSCIUTA.m3u8')).toBe(seg);
    expect(read).toBe(0);
    expect(calls).toEqual(['master']);
  });

  it('errori e risposte non ok: risposta originale', async () => {
    const { r } = router(() => {
      throw new Error('boom');
    });
    const logs: string[] = [];
    const bad = resp('x', { status: 403 });
    const f = createFetchHook({ fetch: async (i) => (String(i) === MASTER_URL ? resp(MASTER) : bad), router: r, log: (m) => logs.push(m) });
    await f(MASTER_URL);
    expect(await f(MEDIA_URL)).toBe(bad);
    const orig = resp('y');
    const f2 = createFetchHook({ fetch: async (i) => (String(i) === MASTER_URL ? resp(MASTER) : orig), router: r, log: (m) => logs.push(m) });
    await f2(MASTER_URL);
    expect(await f2(MEDIA_URL)).toBe(orig);
    expect(logs.join('\n')).toContain('boom');
  });

  it('una richiesta annullata durante un\'attesa lunga lancia AbortError', async () => {
    const { r } = router(() => new Promise<string>(() => {}));
    const f = createFetchHook({ fetch: async (i) => (String(i) === MASTER_URL ? resp(MASTER) : resp('x')), router: r, log: () => {} });
    await f(MASTER_URL);
    const ctl = new AbortController();
    const p = f(MEDIA_URL, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('sessioni parallele dello stesso canale', () => {
  it('una nuova master non toglie il controller alla sessione ancora in riproduzione: un annuncio sulla vecchia viene gestito, non lasciato passare', async () => {
    const MEDIA_B = 'https://euc.playlist.ttvnw.net/v1/playlist/BBB.m3u8';
    const MASTER_B = MASTER.replace(MEDIA_URL, MEDIA_B);
    const sink = { addBreak() {}, addAlt() {}, addPlaceholder() {}, addFailure() {} };
    const raw = async (input: any, init?: any): Promise<Response> => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (url === MASTER_URL) return resp(MASTER);
      if (url.startsWith('https://usher.ttvnw.net/api/v2/') && url.includes('sessione=b')) return resp(MASTER_B);
      if (url === MEDIA_URL) return resp(fx('preroll-start.m3u8'));
      if (url.startsWith('https://gql.twitch.tv/')) return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } }));
      if (url.startsWith('https://usher.ttvnw.net/api/channel/')) return resp(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS="a",VIDEO="480p30",FRAME-RATE=30.000', 'https://alt.test/480.m3u8'].join('\n'));
      if (url === 'https://alt.test/480.m3u8') return resp(fx('preroll-alt-ps4-08.m3u8'));
      void init;
      throw new Error('inatteso ' + url);
    };
    const io = { fetchText: async (u: string) => (await raw(u, {})).text() };
    const sources = CLEAN_SHAPES.map((s) => extShapeSource(s, raw, 1000, () => {}));
    const r = new PlaylistRouter((login) => new AdController({ login, enabled: true, io, sources, sink, log: () => {} }));
    const f = createFetchHook({ fetch: raw, router: r, log: () => {} });
    await f(MASTER_URL); // sessione A
    await f(MASTER_URL.replace('?', '?sessione=b&')); // sessione B, stesso canale
    expect(r.sessions('pgl')).toBe(2);
    const out = await f(MEDIA_URL); // un annuncio arriva sulla variante di A
    expect(await out.text()).not.toContain('Amazon');
  });
});

describe('diagnostica', () => {
  it('avvisa quando il player riceve segmenti pubblicitari e quando una media playlist non ha master', async () => {
    const ad = fx('preroll-start.m3u8');
    const { r } = router((t) => t); // il processore lascia passare tutto, come in un fallimento della mitigazione
    const logs: string[] = [];
    const f = createFetchHook({ fetch: async (i) => (String(i) === MASTER_URL ? resp(MASTER) : resp(ad)), router: r, log: (m) => logs.push(m) });
    await f(MASTER_URL);
    await f(MEDIA_URL);
    await f(MEDIA_URL);
    expect(logs.filter((m) => m.includes('ATTENZIONE'))).toHaveLength(1);
    await f('https://euc.playlist.ttvnw.net/v1/playlist/SCONOSCIUTA.m3u8');
    await f('https://euc.playlist.ttvnw.net/v1/playlist/SCONOSCIUTA.m3u8');
    expect(logs.filter((m) => m.includes('non associata'))).toHaveLength(1);
  });
});

describe('integrazione con AdController (senza rete)', () => {
  it('pre-roll: il player riceve il live della sorgente pulita e le richieste del controller NON passano dal gancio', async () => {
    const seen: string[] = [];
    const raw = async (input: any, init?: any): Promise<Response> => {
      const url = String(typeof input === 'string' ? input : input.url);
      seen.push((init && init.method) + ' ' + url.replace(/\?.*/, ''));
      if (url === MASTER_URL) return resp(MASTER);
      if (url === MEDIA_URL) return resp(fx('preroll-start.m3u8'));
      if (url.startsWith('https://gql.twitch.tv/')) {
        expect(init.credentials).toBe('omit');
        expect(JSON.parse(init.body).variables.platform).toBe('ps4');
        return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } }));
      }
      if (url.startsWith('https://usher.ttvnw.net/api/channel/hls/pgl.m3u8')) {
        expect(url).toContain('player_type=site');
        return resp(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS="a",VIDEO="480p30",FRAME-RATE=30.000', 'https://alt.test/480.m3u8'].join('\n'));
      }
      if (url === 'https://alt.test/480.m3u8') return resp(fx('preroll-alt-ps4-08.m3u8'));
      throw new Error('inatteso ' + url);
    };
    const logs: string[] = [];
    const sink = { addBreak() {}, addAlt() {}, addPlaceholder() {}, addFailure() {} };
    const io = { fetchText: async (u: string) => (await raw(u, { credentials: 'omit' })).text() };
    const sources = CLEAN_SHAPES.map((s) => extShapeSource(s, raw, 1000, (m) => logs.push(m)));
    const r = new PlaylistRouter((login) => new AdController({ login, enabled: true, io, sources, sink, log: (m) => logs.push(m) }));
    const f = createFetchHook({ fetch: raw, router: r, log: (m) => logs.push(m) });
    await f(MASTER_URL, { headers: {} });
    const out = await f(MEDIA_URL);
    const text = await out.text();
    expect(text).not.toContain('Amazon');
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:');
    expect(out.url).toBe(MEDIA_URL);
    expect(r.size()).toBe(1); // la master alternativa non e' diventata una nuova sessione
    expect(logs.join('\n')).toContain('pausa pubblicitaria rilevata (PREROLL');
    expect(seen.filter((s) => s.includes('usher.ttvnw.net')).length).toBe(2);
  });
});

describe('rewrittenResponse', () => {
  it('url e type riportati sull\'originale', () => {
    const o = resp('a');
    const r = rewrittenResponse(o, 'b', 'https://x/y.m3u8');
    expect(r.url).toBe('https://x/y.m3u8');
    expect(r.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
  });
});
