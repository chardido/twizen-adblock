import { describe, expect, it } from 'vitest';
import { PlaylistRouter, type Processor } from './router';

const master = (n: number): string => ['#EXTM3U', `#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720,VIDEO="720p"`, `https://p.test/${n}/720.m3u8?x=${n}`, `#EXT-X-STREAM-INF:BANDWIDTH=500,RESOLUTION=640x360,VIDEO="360p"`, `https://p.test/${n}/360.m3u8`].join('\n');

function fake() {
  const made: Array<{ login: string; seen: string[]; destroyed: boolean } & Processor> = [];
  const router = new PlaylistRouter((login) => {
    const p = {
      login,
      seen: [] as string[],
      destroyed: false,
      process(text: string, ctx: { kind: string; url: string }) {
        p.seen.push(ctx.kind + ':' + ctx.url);
        return ctx.kind === 'media' ? 'X' + text : text;
      },
      destroy() {
        p.destroyed = true;
      },
    };
    made.push(p);
    return p;
  }, 2);
  return { router, made };
}

describe('PlaylistRouter', () => {
  it('instrada le media al controller che possiede la variante (query ignorata)', () => {
    const { router, made } = fake();
    expect(router.master('a', 'https://u/a', master(1))).toBe(master(1));
    expect(router.owns('https://p.test/1/720.m3u8')).toBe(true);
    expect(router.media('https://p.test/1/720.m3u8', 'https://p.test/1/720.m3u8?x=1', 'T')).toBe('XT');
    expect(made[0].seen).toEqual(['master:https://u/a', 'media:https://p.test/1/720.m3u8?x=1']);
  });

  it('media sconosciuta: non e\' posseduta e il testo resta com\'e\'', () => {
    const { router } = fake();
    router.master('a', 'https://u/a', master(1));
    expect(router.owns('https://other/x.m3u8')).toBe(false);
    expect(router.media('https://other/x.m3u8', 'https://other/x.m3u8', 'T')).toBe('T');
  });

  it('una nuova master dello stesso canale sostituisce il controller e distrugge il vecchio', () => {
    const { router, made } = fake();
    router.master('a', 'u', master(1));
    router.master('a', 'u', master(2));
    expect(made).toHaveLength(2);
    expect(made[0].destroyed).toBe(true);
    expect(router.owns('https://p.test/1/720.m3u8')).toBe(false);
    expect(router.owns('https://p.test/2/720.m3u8')).toBe(true);
    expect(router.size()).toBe(1);
  });

  it('insieme limitato: il meno recente (per uso) viene distrutto e le sue chiavi tolte', () => {
    const { router, made } = fake();
    router.master('a', 'u', master(1));
    router.master('b', 'u', master(2));
    router.media('https://p.test/1/360.m3u8', 'https://p.test/1/360.m3u8', 'T'); // a torna il piu' recente
    router.master('c', 'u', master(3));
    expect(made.map((m) => m.destroyed)).toEqual([false, true, false]);
    expect(router.owns('https://p.test/2/360.m3u8')).toBe(false);
    expect(router.owns('https://p.test/1/360.m3u8')).toBe(true);
    expect(router.size()).toBe(2);
  });
});
