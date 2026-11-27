import { describe, expect, it } from 'vitest';
import { parseMedia, Timeline } from './adPlaylist';

/** Playlist minima con numero live consecutivo: `from`..`to` inclusi, URL con prefisso `host` (una rendition diversa per sorgente). */
function pl(host: string, from: number, to: number): string {
  const out = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${from}`, `#EXT-X-TWITCH-LIVE-SEQUENCE:${from}`, `#EXT-X-MAP:URI="https://${host}/init.mp4"`];
  for (let n = from; n <= to; n++) out.push('#EXTINF:2.000,live', `https://${host}/seg${n}.mp4`);
  return out.join('\n') + '\n';
}

const run = (t: Timeline, host: string, from: number, to: number, src: string): string => {
  const p = parseMedia(pl(host, from, to));
  const r = t.emit(p, p.entries, `https://${host}/v.m3u8`, src);
  return (r as { text: string }).text;
};

/** Numero live del segmento che segue ogni EXT-X-DISCONTINUITY. */
const discBefore = (text: string): string[] => {
  const l = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < l.length; i++) if (l[i] === '#EXT-X-DISCONTINUITY') out.push((l.slice(i + 1).find((x) => x.startsWith('https://')) as string).replace(/.*seg(\d+).*/, '$1'));
  return out;
};

describe('Timeline.emit: passaggio tra sorgenti', () => {
  it('senza opt-in (default) nessuna discontinuita\' al cambio di sorgente: stesso output di prima', () => {
    const t = new Timeline(400);
    run(t, 'alt.test', 100, 104, 'clean');
    const a = run(t, 'main.test', 102, 108, 'main');
    const t2 = new Timeline(400);
    const p1 = parseMedia(pl('alt.test', 100, 104));
    t2.emit(p1, p1.entries, 'https://alt.test/v.m3u8');
    const p2 = parseMedia(pl('main.test', 102, 108));
    const b = (t2.emit(p2, p2.entries, 'https://main.test/v.m3u8') as { text: string }).text;
    expect(a).toBe(b);
    expect(discBefore(a)).toEqual([]);
    expect(a).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0');
  });

  it('con opt-in: discontinuita\' sul primo segmento nuovo, in entrambe le direzioni, e le playlist successive restano coerenti', () => {
    const t = new Timeline(400, { markSourceSwitch: true });
    expect(discBefore(run(t, 'main.test', 98, 102, 'main'))).toEqual([]);
    expect(discBefore(run(t, 'alt.test', 100, 104, 'clean'))).toEqual(['103']);
    // i segmenti gia' consegnati (<= 102) non cambiano numerazione; il 103 e' il primo della sorgente nuova
    const again = run(t, 'alt.test', 101, 106, 'clean');
    expect(discBefore(again)).toEqual(['103']);
    expect(again).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0');
    // ritorno alla playlist originale: nuova discontinuita' sul primo segmento dopo l'ultimo consegnato (106)
    const back = run(t, 'main.test', 104, 110, 'main');
    expect(discBefore(back)).toEqual(['107']);
    expect(back).toContain('#EXT-X-MEDIA-SEQUENCE:104');
    expect(back).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
  });

  it('con opt-in ma la stessa sorgente: nessuna discontinuita\' aggiunta', () => {
    const t = new Timeline(400, { markSourceSwitch: true });
    run(t, 'main.test', 100, 104, 'main');
    expect(discBefore(run(t, 'main.test', 102, 108, 'main'))).toEqual([]);
  });
});
