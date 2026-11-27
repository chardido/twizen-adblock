import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AdController, type AdSink } from './adController';
import type { AdIO, CleanSource } from '../net/adSource';
import type { MasterVariant } from '../net/adPlaylist';
import { parseMaster } from '../net/adPlaylist';
import { AD_TUNING } from '../net/adConfig';

const fx = (n: string): string => readFileSync(new URL(`../net/fixtures/${n}`, import.meta.url), 'utf8');

const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS="a",VIDEO="480p30",FRAME-RATE=30.000', 'https://p.test/480.m3u8'].join('\n');
const ALT_MASTER = parseMaster(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS="a",VIDEO="480p30",FRAME-RATE=30.000', 'https://alt.test/480.m3u8'].join('\n'));
const P = { kind: 'media' as const, url: 'https://p.test/480.m3u8' };

function sink() {
  const s = { breaks: 0, alt: 0, ph: 0, fail: 0 };
  const k: AdSink = { addBreak: () => s.breaks++, addAlt: (n) => (s.alt += n), addPlaceholder: (n) => (s.ph += n), addFailure: () => s.fail++ };
  return { s, k };
}

type TestIO = Partial<AdIO> & { fetchAltMaster?: (login: string, shape: { id: string }) => Promise<MasterVariant[]> };

function make(io: TestIO, enabled = true, now?: () => number) {
  const fa = io.fetchAltMaster || (() => Promise.reject(new Error('no alt')));
  const sources: CleanSource[] = [
    { id: 'ps4', rolls: ['PREROLL'], variants: (l) => fa(l, { id: 'ps4' }) },
    { id: 'autoplay-android', rolls: ['PREROLL', 'MIDROLL'], variants: (l) => fa(l, { id: 'autoplay-android' }) },
  ];
  const sk = sink();
  const logs: string[] = [];
  let t = 0;
  const c = new AdController({
    login: 'x',
    enabled,
    io: { fetchText: io.fetchText || (() => Promise.reject(new Error('no net'))) },
    sources,
    sink: sk.k,
    now: now || (() => (t += 1000)),
    sleep: () => Promise.resolve(),
    log: (m) => logs.push(m),
  });
  c.process(MASTER, { kind: 'master', url: 'https://u/master' });
  return { c, sk, logs };
}

describe('AdController', () => {
  it('playlist pulita con la funzione attiva: testo identico e nessuna richiesta', () => {
    let calls = 0;
    const { c, sk } = make({ fetchAltMaster: () => { calls++; return Promise.reject(new Error('x')); }, fetchText: () => { calls++; return Promise.reject(new Error('x')); } });
    const clean = fx('clean-tumblurr.m3u8');
    expect(c.process(clean, P)).toBe(clean);
    expect(calls).toBe(0);
    expect(sk.s.breaks).toBe(0);
    expect(c.getStatus().mode).toBe('idle');
  });

  it('funzione spenta: il break passa com\'e\' (comportamento di prima)', () => {
    const { c } = make({}, false);
    const ad = fx('preroll-start.m3u8');
    expect(c.process(ad, P)).toBe(ad);
    expect(c.getStatus().mode).toBe('off');
  });

  it('strato 1: pre-roll all\'apertura con alternativa pulita = il live al posto della pubblicita\'', async () => {
    const { c, sk } = make({ fetchAltMaster: () => Promise.resolve(ALT_MASTER), fetchText: () => Promise.resolve(fx('preroll-alt-ps4-08.m3u8')) });
    const out = await c.process(fx('preroll-start.m3u8'), P);
    expect(out).not.toContain('Amazon');
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:');
    expect(c.getStatus().mode).toBe('alt');
    expect(c.active).toBe(true);
    expect(sk.s.breaks).toBe(1);
    // fine del break: contenuto reale dopo la pubblicita', coerente con quello gia' consegnato
    const after = await c.process(fx('preroll-after.m3u8'), P);
    expect(after).not.toContain('Amazon');
    expect(c.getStatus().mode).toBe('idle');
    expect(c.active).toBe(false);
    expect(sk.s.fail).toBe(0);
  });

  it('strato 1 anche per un mid-roll di 3 minuti (soli segmenti pubblicitari, playlist che non scorre)', async () => {
    const { c } = make({ fetchAltMaster: () => Promise.resolve(ALT_MASTER), fetchText: () => Promise.resolve(fx('preroll-alt-ps4-17.m3u8')) });
    for (let i = 0; i < 3; i++) {
      const out = await c.process(fx('tv-midroll-allads.m3u8'), P);
      expect(out).not.toContain('Amazon');
    }
    const back = await c.process(fx('tv-midroll-boundary.m3u8'), P);
    expect(back).not.toContain('Amazon');
  });

  it('una sorgente alternativa che contiene a sua volta pubblicita\' viene scartata', async () => {
    const { c, logs } = make({
      fetchAltMaster: () => Promise.resolve(ALT_MASTER),
      fetchText: (u) => (u.indexOf('alt.test') >= 0 ? Promise.resolve(fx('preroll-start.m3u8')) : Promise.resolve(fx('preroll-boundary.m3u8'))),
    });
    const out = await c.process(fx('preroll-start.m3u8'), P);
    expect(out).not.toContain('Amazon');
    expect(c.getStatus().mode).toBe('idle'); // il contenuto reale e' tornato durante l'attesa
    expect(logs.join('\n')).toContain('non utilizzabile');
  });

  it('strato 2: senza alternativa non arriva mai un segmento pubblicitario; si attende il contenuto e poi si riprende', async () => {
    let n = 0;
    const { c, sk } = make({ fetchText: () => Promise.resolve(++n < 3 ? fx('preroll-growing.m3u8') : fx('preroll-boundary.m3u8')) });
    const p = c.process(fx('preroll-start.m3u8'), P) as Promise<string>;
    // l'attesa e' in corso: hls.js non ha ancora ricevuto nulla
    expect(typeof p.then).toBe('function');
    const out = await p;
    expect(out).not.toContain('Amazon');
    expect(out.split('\n').filter((l) => l.indexOf('https://') === 0).length).toBe(3);
    expect(sk.s.fail).toBe(1);
    expect(c.getStatus().mode).toBe('idle');
  });

  it('strato 2 a meta\' diretta: la playlist consegnata resta ferma finche\' non torna il contenuto', async () => {
    const { c } = make({});
    const clean = fx('clean-illojuan.m3u8');
    const first = (await c.process(clean, P)) as string;
    expect(first).toBe(clean); // nessun break ancora: identica
    // ora un break che lascia solo contenuto precedente + pubblicita' e nessuna alternativa
    const start = fx('midroll-start.m3u8');
    const out = (await c.process(start, P)) as string;
    expect(out).not.toContain('Amazon');
    expect(c.getStatus().mode).toBe('placeholder');
    const again = await c.process(fx('midroll-during.m3u8'), P);
    expect(again).toBe(out);
    const back = await c.process(fx('tv-midroll-after.m3u8'), P);
    expect(back).not.toContain('Amazon');
    expect(c.getStatus().mode).toBe('idle');
  });

  it('strato 3: attesa scaduta = si ripiega sul testo originale e si registra il fallimento', async () => {
    let t = 0;
    const { c, sk, logs } = make({ fetchText: () => Promise.resolve(fx('preroll-growing.m3u8')) }, true, () => (t += AD_TUNING.holdMaxMs / 3));
    const ad = fx('preroll-start.m3u8');
    const out = await c.process(ad, P);
    expect(out).toBe(ad);
    expect(sk.s.fail).toBe(1);
    expect(logs.join('\n')).toContain('riproduzione normale');
    expect(c.active).toBe(false);
  });

  it('i secondi del break vengono contati per modalita\'', async () => {
    let t = 0;
    const { c, sk } = make({ fetchAltMaster: () => Promise.resolve(ALT_MASTER), fetchText: () => Promise.resolve(fx('preroll-alt-ps4-17.m3u8')) }, true, () => t);
    t = 1000;
    await c.process(fx('preroll-start.m3u8'), P);
    t = 31000;
    await c.process(fx('preroll-after.m3u8'), P);
    expect(sk.s.alt).toBe(30);
  });

  it('MIDROLL: salta subito la forma che non e\' pulita nei mid-roll e usa quella giusta', async () => {
    const asked: string[] = [];
    const { c } = make({
      fetchAltMaster: (_l, shape) => { asked.push(shape.id); return Promise.resolve(ALT_MASTER); },
      fetchText: () => Promise.resolve(fx('preroll-alt-ps4-17.m3u8')),
    });
    const out = await c.process(fx('midroll-start.m3u8'), P);
    expect(out).not.toContain('Amazon');
    expect(asked).toEqual(['autoplay-android']);
  });

  it('PREROLL: prova prima la forma a qualita\' piena', async () => {
    const asked: string[] = [];
    const { c } = make({
      fetchAltMaster: (_l, shape) => { asked.push(shape.id); return Promise.resolve(ALT_MASTER); },
      fetchText: () => Promise.resolve(fx('preroll-alt-ps4-17.m3u8')),
    });
    await c.process(fx('preroll-start.m3u8'), P);
    expect(asked).toEqual(['ps4']);
  });
});
