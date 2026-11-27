import { describe, expect, it } from 'vitest';
import { classifyUrl, urlKey } from './classify';

describe('classifyUrl', () => {
  it('master v2 e v1 di usher: canale in minuscolo', () => {
    expect(classifyUrl('https://usher.ttvnw.net/api/v2/channel/hls/Summit1g.m3u8?acmb=x&token=y')).toEqual({ kind: 'master', login: 'summit1g' });
    expect(classifyUrl('https://usher.ttvnw.net/api/channel/hls/pgl.m3u8?sig=1')).toEqual({ kind: 'master', login: 'pgl' });
  });

  it('media playlist: URL .m3u8 su altri host, chiave senza query', () => {
    const u = 'https://euc12.playlist.ttvnw.net/v1/playlist/Cs8Hmc2l1N.m3u8';
    expect(classifyUrl(u)).toEqual({ kind: 'media', key: u });
    expect(classifyUrl(u + '?x=1#f')).toEqual({ kind: 'media', key: u });
  });

  it('il resto e\' ignorato (segmenti, API, VOD su usher non e\' una master di canale)', () => {
    expect(classifyUrl('https://gql.twitch.tv/gql')).toBeNull();
    expect(classifyUrl('https://video-weaver.fra02.hls.ttvnw.net/v1/segment/abc.ts')).toBeNull();
    expect(classifyUrl('http://usher.ttvnw.net/api/v2/channel/hls/pgl.m3u8')).toBeNull();
    expect(classifyUrl('not a url .m3u8')).toBeNull();
    expect(classifyUrl('https://example.com/x.m3u8.txt')).toBeNull();
    // /vod/ non e' una master di canale: e' una .m3u8 qualsiasi (il router la ignora perche' nessun controller la possiede)
    expect(classifyUrl('https://usher.ttvnw.net/vod/123.m3u8')?.kind).toBe('media');
  });

  it('urlKey toglie query e fragment', () => {
    expect(urlKey('https://a/b.m3u8?x=1')).toBe('https://a/b.m3u8');
    expect(urlKey('https://a/b.m3u8')).toBe('https://a/b.m3u8');
  });
});
