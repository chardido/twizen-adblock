import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripAnnouncedAds } from './scrub';

const fx = (n: string): string => readFileSync(new URL(`../../src/net/fixtures/${n}`, import.meta.url), 'utf8');

const AD = '#EXT-X-DATERANGE:ID="stitched-ad-1-30000000000",CLASS="twitch-stitched-ad",START-DATE="2026-11-27T10:00:30.000Z",DURATION=30.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"';
const SRC = '#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",START-DATE="2026-11-27T10:00:30.000Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="Amazon|1"';
const SESSION = '#EXT-X-DATERANGE:ID="playlist-session-1",CLASS="twitch-session",START-DATE="2026-11-27T10:00:00.000Z",END-ON-NEXT=YES,X-TV-TWITCH-SESSIONID="1"';
const live = (n: number): string[] => [`#EXT-X-PROGRAM-DATE-TIME:2026-11-27T10:00:${String(n * 2).padStart(2, '0')}.000Z`, '#EXTINF:2.000,live', `https://seg.test/${n}.ts`];

describe('stripAnnouncedAds', () => {
  it('playlist senza date range: identica (stessa stringa)', () => {
    const t = fx('clean-tumblurr.m3u8');
    expect(stripAnnouncedAds(t)).toBe(t);
  });

  it('break annunciato ma senza segmenti pubblicitari: via i date range pubblicitari, restano gli altri', () => {
    const t = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:5', SESSION, AD, SRC, ...live(0), ...live(1), ''].join('\n');
    const out = stripAnnouncedAds(t);
    expect(out).toContain('twitch-session');
    expect(out).not.toContain('stitched-ad');
    expect(out).not.toContain('Amazon|1');
    expect(out.split('\n').filter((l) => l.startsWith('#EXTINF'))).toHaveLength(2);
  });

  it('con segmenti pubblicitari nella finestra: invariata (ci pensa il controller)', () => {
    const t = fx('preroll-start.m3u8');
    expect(stripAnnouncedAds(t)).toBe(t);
  });

  it('solo sessione/timestamp/source live: invariata', () => {
    const t = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', SESSION, '#EXT-X-DATERANGE:ID="source-0",CLASS="twitch-stream-source",START-DATE="2026-11-27T10:00:00.000Z",X-TV-TWITCH-STREAM-SOURCE="live"', ...live(0), ''].join('\n');
    expect(stripAnnouncedAds(t)).toBe(t);
  });
});
