import { describe, expect, it } from 'vitest';
import { PrefetchGuard } from './prefetch';

/** URL neutro con la sola forma che conta: lunghezza del token dopo /segment/ (campioni reali: live 535, pubblicita' 521-523). */
const url = (n: number, tag: string): string => `https://seg.test/v1/segment/${(tag + 'x'.repeat(n)).slice(0, n)}?q=1`;

type Seg = [string, string]; // [url, titolo]
function pl(segs: Seg[], pf: string[]): string {
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:10', '#EXT-X-TWITCH-LIVE-SEQUENCE:10'];
  segs.forEach(([u, t], i) => out.push(`#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:${String(i * 2).padStart(2, '0')}.000Z`, `#EXTINF:2.000,${t}`, u));
  for (const u of pf) out.push('#EXT-X-TWITCH-PREFETCH:' + u);
  return out.join('\n') + '\n';
}
const live = (...us: string[]): Seg[] => us.map((u) => [u, 'live']);
const lens = (t: string): number[] => t.split('\n').filter((l) => l.startsWith('#EXT-X-TWITCH-PREFETCH:')).map((l) => /segment\/([^?]*)/.exec(l)![1].length);

describe('PrefetchGuard', () => {
  it('impara dalle righe prefetch poi comparse come segmenti live e trattiene quelle con un\'altra forma', () => {
    const g = new PrefetchGuard();
    const k = 'https://v.test/a.m3u8';
    const [a, b, c, d] = [url(535, 'a'), url(535, 'b'), url(535, 'c'), url(535, 'd')];
    // all'inizio non si sa nulla: niente viene toccato
    const t1 = pl(live(a), [b, c]);
    expect(g.filter(k, t1)).toBe(t1);
    // b e c compaiono come segmenti live: la lunghezza 535 e' provata live
    const t2 = pl(live(a, b, c), [d]);
    expect(g.filter(k, t2)).toBe(t2);
    // inizio pausa: nessun segnale nella playlist, ma la 2a e la 3a riga prefetch hanno un'altra lunghezza
    const out = g.filter(k, pl(live(a, b, c, d), [url(535, 'e'), url(521, 'ad1'), url(523, 'ad2')]));
    expect(lens(out)).toEqual([535]);
    expect(out.split('\n').filter((l) => l.startsWith('https://')).length).toBe(4);
  });

  it('una forma che compare solo come segmento pubblicitario non viene mai imparata', () => {
    const g = new PrefetchGuard();
    const k = 'a';
    const [a, b, ad1] = [url(535, 'a'), url(535, 'b'), url(521, 'ad1')];
    g.filter(k, pl(live(a), [b, ad1]));
    // b diventa live, ad1 diventa un segmento Amazon
    g.filter(k, pl([[a, 'live'], [b, 'live'], [ad1, 'Amazon|1']], []));
    expect(lens(g.filter(k, pl(live(a, b), [url(521, 'ad3'), url(535, 'z')])))).toEqual([535]);
  });

  it('varianti diverse non si mescolano; senza righe prefetch la stessa stringa', () => {
    const g = new PrefetchGuard();
    const [a, b] = [url(535, 'a'), url(535, 'b')];
    g.filter('a', pl(live(a), [b]));
    g.filter('a', pl(live(a, b), []));
    const t = pl(live(a), [url(521, 'x')]);
    expect(g.filter('b', t)).toBe(t);
    expect(lens(g.filter('a', t))).toEqual([]);
    const none = pl(live(a, b), []);
    expect(g.filter('a', none)).toBe(none);
  });
});
