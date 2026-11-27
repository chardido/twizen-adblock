import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyze, matchVariant, parseAttrs, parseMaster, parseMedia, Timeline } from './adPlaylist';

const fx = (n: string): string => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

/** uri -> numero di sequenza, letti da una playlist prodotta dal riscrittore. */
function snByUri(text: string): { [uri: string]: number } {
  const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
  let sn = Number(m && m[1]);
  const out: { [uri: string]: number } = {};
  for (const l of text.split('\n')) if (l.indexOf('https://') === 0) out[l] = sn++;
  return out;
}
const uris = (t: string): string[] => t.split('\n').filter((l) => l.indexOf('https://') === 0);

describe('parseAttrs', () => {
  it('gestisce virgole dentro le virgolette e ordine variabile', () => {
    const a = parseAttrs('ID="a,b",CLASS="x",DURATION=30.235,X-K="v"');
    expect(a).toEqual({ ID: 'a,b', CLASS: 'x', DURATION: '30.235', 'X-K': 'v' });
  });
});

describe('rilevamento su catture reali', () => {
  it('non segnala mai le playlist pulite', () => {
    for (const f of ['clean-tumblurr.m3u8', 'clean-illojuan.m3u8', 'preroll-alt-ps4-17.m3u8', 'preroll-alt-ps4-33.m3u8', 'preroll-after.m3u8', 'tv-midroll-after.m3u8', 'midroll-alt-ps4-00.m3u8']) {
      const { info } = analyze(fx(f));
      expect(info.present, f).toBe(false);
      expect(info.active, f).toBe(false);
    }
  });

  it('pre-roll all inizio: solo pubblicita\', break in corso, durata annunciata', () => {
    const { info } = analyze(fx('preroll-start.m3u8'));
    expect(info.active).toBe(true);
    expect(info.contentSegments).toBe(0);
    expect(info.adSegments).toBeGreaterThan(0);
    expect(info.roll).toBe('PREROLL');
    expect(info.expectedSec).toBe(30);
    expect(info.startMs).toBe(Date.parse('2026-11-26T21:12:54.138Z'));
  });

  it('pre-roll al confine: contenuto reale dopo la pubblicita\' = break finito', () => {
    const { info } = analyze(fx('preroll-boundary.m3u8'));
    expect(info.present).toBe(true);
    expect(info.active).toBe(false);
    expect(info.adSegments).toBe(16);
    expect(info.contentAfterAd).toBe(3);
  });

  it('mid-roll: contenuto reale prima, pubblicita\' in coda', () => {
    const { info } = analyze(fx('midroll-start.m3u8'));
    expect(info.active).toBe(true);
    expect(info.roll).toBe('MIDROLL');
    expect(info.contentSegments).toBe(14);
    expect(info.adSegments).toBe(3);
  });

  it('mid-roll della TV: 3 minuti di soli segmenti pubblicitari, poi il ritorno al live', () => {
    const during = analyze(fx('tv-midroll-allads.m3u8')).info;
    expect(during.active).toBe(true);
    expect(during.contentSegments).toBe(0);
    const edge = analyze(fx('tv-midroll-boundary.m3u8')).info;
    expect(edge.active).toBe(false);
    expect(edge.adSegments).toBe(96);
    expect(edge.contentAfterAd).toBe(16);
    expect(analyze(fx('tv-midroll-after.m3u8')).info.present).toBe(false);
  });

  it('riconosce la pausa anche solo dalla sorgente "non live" (senza titoli ne\' date range pubblicitari)', () => {
    const t = [
      '#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:5',
      '#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",START-DATE="2026-01-01T00:00:10.000Z",X-TV-TWITCH-STREAM-SOURCE="Slate"',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:08.000Z', '#EXTINF:2.000,live', 'https://s/1.ts',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:10.000Z', '#EXTINF:2.000,live', 'https://s/2.ts',
    ].join('\n');
    const { parsed, info } = analyze(t);
    expect(parsed.entries.map((e) => e.ad)).toEqual([false, true]);
    expect(info.active).toBe(true);
  });
});

describe('pod e conto alla rovescia', () => {
  it('mid-roll della TV: pod di 6 annunci da 180 s, posizione e tempo rimasto dal bordo dei segmenti', () => {
    const { info } = analyze(fx('tv-midroll-allads.m3u8'));
    expect(info.podLength).toBe(6);
    expect(info.podPosition).toBe(4);
    expect((info.podEndMs as number) - (info.podStartMs as number)).toBe(180000);
    const left = ((info.podEndMs as number) - (info.adEdgeMs as number)) / 1000;
    expect(left).toBeGreaterThan(60);
    expect(left).toBeLessThan(80);
  });
  it('pre-roll: un solo annuncio da 30 s', () => {
    const { info } = analyze(fx('preroll-start.m3u8'));
    expect([info.podPosition, info.podLength]).toEqual([1, 1]);
  });
});

describe('master', () => {
  it('legge nome, risoluzione e fps delle varianti e abbina per nome o per vicinanza', () => {
    const m = parseMaster(readFileSync(new URL('../../src/net/fixtures/clean-tumblurr.m3u8', import.meta.url), 'utf8') && [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5849873,RESOLUTION=1920x1080,CODECS="a",VIDEO="chunked",FRAME-RATE=60.000', 'https://m/1080.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360,CODECS="a",VIDEO="360p30",FRAME-RATE=30.000', 'https://m/360.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="a",VIDEO="audio_only"', 'https://m/audio.m3u8',
    ].join('\n'));
    expect(m.map((v) => v.name)).toEqual(['chunked', '360p30', 'audio_only']);
    const alt = [m[1], m[2]];
    expect((matchVariant(m[0], alt) as { name: string }).name).toBe('360p30');
    expect((matchVariant(m[2], alt) as { name: string }).name).toBe('audio_only');
  });
});

describe('riscrittura con numerazione coerente', () => {
  it('lo stesso segmento ha lo stesso numero nella playlist alternativa e in quella originale dopo il break', () => {
    const tl = new Timeline();
    const alt = parseMedia(fx('preroll-alt-ps4-17.m3u8'));
    const a = tl.emit(alt, alt.entries, 'https://x/alt.m3u8');
    expect(a).not.toBeNull();
    const orig = parseMedia(fx('preroll-boundary.m3u8'));
    const content = orig.entries.filter((e) => !e.ad && !e.prefetch);
    const b = tl.emit(orig, content, 'https://x/p.m3u8');
    expect(b).not.toBeNull();
    const sa = snByUri((a as { text: string }).text);
    const sb = snByUri((b as { text: string }).text);
    const common = Object.keys(sb).filter((u) => sa[u] !== undefined);
    expect(common.length).toBeGreaterThan(0);
    for (const u of common) expect(sb[u]).toBe(sa[u]);
    // nessun segmento pubblicitario, nessuna discontinuita', nessun PROGRAM-DATE-TIME
    expect((b as { text: string }).text).not.toMatch(/Amazon|DISCONTINUITY\n|PROGRAM-DATE/);
    expect((b as { text: string }).text).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0');
  });

  it('senza alternativa: il contenuto che torna si attacca subito dopo l\'ultimo consegnato, con una discontinuita\'', () => {
    const tl = new Timeline();
    const p1 = parseMedia(fx('clean-illojuan.m3u8'));
    const first = tl.emit(p1, p1.entries, 'https://x/1')!;
    tl.markGap();
    const p2 = parseMedia(fx('clean-tumblurr.m3u8'));
    const second = tl.emit(p2, p2.entries, 'https://x/2')!;
    expect(second.firstSn).toBe(first.lastSn + 1);
    expect(second.text).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
    expect(second.text).not.toContain('#EXT-X-DISCONTINUITY\n');
  });

  it('un buco dentro la finestra (contenuto, pausa scartata, contenuto) tiene solo la parte recente e contigua', () => {
    const tl = new Timeline();
    const p = parseMedia(fx('tv-midroll-boundary.m3u8'));
    const r = tl.emit(p, p.entries.filter((e) => !e.ad), 'https://x/p')!;
    expect(uris(r.text).length).toBe(16);
    expect(r.firstSn).toBe(5781);
  });

  it('la numerazione e\' la stessa per tutte le varianti (numero live), indipendente da MEDIA-SEQUENCE', () => {
    const p = parseMedia(fx('preroll-after.m3u8'));
    expect(p.mediaSequence).not.toBe(p.entries[0].live);
    const r = new Timeline().emit(p, p.entries, 'https://x/')!;
    expect(r.firstSn).toBe(p.entries[0].live);
  });
});
