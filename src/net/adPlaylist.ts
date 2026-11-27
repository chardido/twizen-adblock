import { AD_SIGNALS } from './adConfig';

/**
 * Analisi e riscrittura (pure, senza rete) delle playlist HLS di Twitch per le pause pubblicitarie.
 * Nessuna dipendenza da hls.js o dal DOM: si testa con le catture reali in src/net/fixtures.
 */

export type Attrs = Record<string, string>;

/** Legge una lista di attributi HLS (KEY=valore,KEY="valore, con virgole"). */
export function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const v = m[2];
    out[m[1]] = v.charAt(0) === '"' ? v.slice(1, -1) : v;
  }
  return out;
}

export interface DateRange {
  id: string;
  cls: string;
  startMs: number | null;
  durationSec: number | null;
  attrs: Attrs;
}

export interface Entry {
  /** Posizione tra i segmenti della playlist originale. */
  idx: number;
  uri: string;
  duration: number;
  title: string;
  pdtMs: number | null;
  /** C'era un EXT-X-DISCONTINUITY subito prima. */
  discBefore: boolean;
  /** Riga EXT-X-MAP in vigore per il segmento (fMP4), o null (MPEG-TS). */
  map: string | null;
  /** Numero di sequenza live di Twitch (EXT-X-TWITCH-LIVE-SEQUENCE), indipendente da variante e forma di richiesta. */
  live: number | null;
  ad: boolean;
  prefetch: boolean;
}

export interface ParsedMedia {
  version: string;
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  entries: Entry[];
  dateranges: DateRange[];
}

function dateMs(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

export function isMediaPlaylist(text: string): boolean {
  return text.indexOf('#EXT-X-TARGETDURATION') >= 0 && text.indexOf('#EXT-X-STREAM-INF') < 0;
}

function isAdDaterange(d: DateRange): boolean {
  if (AD_SIGNALS.daterangeClasses.indexOf(d.cls) >= 0) return true;
  if (d.id.indexOf(AD_SIGNALS.daterangeIdPrefix) === 0) return true;
  for (const k in d.attrs) if (k.indexOf(AD_SIGNALS.daterangeAttrPrefix) === 0) return true;
  return false;
}

export function parseMedia(text: string): ParsedMedia {
  const lines = text.split('\n');
  const p: ParsedMedia = { version: '3', targetDuration: 6, mediaSequence: 0, endList: false, entries: [], dateranges: [] };
  let disc = false;
  let map: string | null = null;
  let pdt: number | null = null;
  let live: number | null = null;
  let duration = 0;
  let title = '';
  let haveInf = false;
  for (let raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line.charAt(0) === '#') {
      if (line.indexOf('#EXT-X-VERSION:') === 0) p.version = line.slice(15);
      else if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) p.targetDuration = Number(line.slice(22)) || 6;
      else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) p.mediaSequence = Number(line.slice(22)) || 0;
      else if (line.indexOf('#EXT-X-TWITCH-LIVE-SEQUENCE:') === 0) live = Number(line.slice(28));
      else if (line.indexOf('#EXT-X-ENDLIST') === 0) p.endList = true;
      else if (line.indexOf('#EXT-X-DISCONTINUITY') === 0 && line.indexOf('#EXT-X-DISCONTINUITY-SEQUENCE') !== 0) disc = true;
      else if (line.indexOf('#EXT-X-MAP:') === 0) map = line;
      else if (line.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0) pdt = dateMs(line.slice(25));
      else if (line.indexOf('#EXT-X-DATERANGE:') === 0) {
        const a = parseAttrs(line.slice(17));
        const dur = a.DURATION !== undefined ? Number(a.DURATION) : a['PLANNED-DURATION'] !== undefined ? Number(a['PLANNED-DURATION']) : NaN;
        p.dateranges.push({ id: a.ID || '', cls: a.CLASS || '', startMs: dateMs(a['START-DATE']), durationSec: isNaN(dur) ? null : dur, attrs: a });
      } else if (line.indexOf('#EXTINF:') === 0) {
        const rest = line.slice(8);
        const c = rest.indexOf(',');
        duration = Number(c >= 0 ? rest.slice(0, c) : rest) || 0;
        title = c >= 0 ? rest.slice(c + 1).trim() : '';
        haveInf = true;
      } else if (line.indexOf('#EXT-X-TWITCH-PREFETCH:') === 0) {
        p.entries.push({ idx: p.entries.length, uri: line.slice(23), duration: 0, title: '', pdtMs: null, discBefore: false, map, live: live, ad: false, prefetch: true });
        if (live !== null) live++;
      }
      continue;
    }
    if (haveInf) {
      p.entries.push({ idx: p.entries.length, uri: line, duration, title, pdtMs: pdt, discBefore: disc, map, live, ad: false, prefetch: false });
      if (live !== null) live++;
      if (pdt !== null) pdt = pdt + duration * 1000;
      disc = false;
      haveInf = false;
    }
  }
  classify(p);
  return p;
}

function classify(p: ParsedMedia): void {
  const ranges = p.dateranges.filter(isAdDaterange);
  const sources = p.dateranges
    .filter((d) => d.cls === AD_SIGNALS.sourceClass && d.startMs !== null)
    .sort((a, b) => (a.startMs as number) - (b.startMs as number));
  let last: Entry | null = null;
  for (const e of p.entries) {
    if (e.prefetch) {
      e.ad = !!last && last.ad;
      continue;
    }
    let ad = false;
    const t = e.title;
    if (t && t !== AD_SIGNALS.contentTitle) ad = true;
    if (!ad && e.pdtMs !== null) {
      const ms = e.pdtMs;
      for (const r of ranges) {
        if (r.startMs !== null && r.durationSec !== null && ms >= r.startMs - 20 && ms < r.startMs + r.durationSec * 1000 - 20) ad = true;
      }
      if (!ad) {
        let src: DateRange | null = null;
        for (const s of sources) if ((s.startMs as number) <= ms + 20) src = s;
        if (src && src.attrs[AD_SIGNALS.sourceAttr] !== undefined && src.attrs[AD_SIGNALS.sourceAttr] !== AD_SIGNALS.sourceLive) ad = true;
      }
    }
    e.ad = ad;
    last = e;
  }
}

export interface BreakInfo {
  /** Il contenuto in coda alla playlist (la parte piu' recente) e' pubblicita': il break e' in corso. */
  active: boolean;
  /** Ci sono segmenti pubblicitari nella finestra (anche vecchi, gia' superati da contenuto reale). */
  present: boolean;
  adSegments: number;
  contentSegments: number;
  /** Segmenti reali in coda dopo l'ultimo segmento pubblicitario. */
  contentAfterAd: number;
  /** Inizio del break (ms epoch) se noto. */
  startMs: number | null;
  /** Durata annunciata in secondi, se nota. */
  expectedSec: number | null;
  roll: string | null;
  /** Pod in corso (l'ultimo annuncio annunciato e quelli con lo stesso commercial id): inizio e fine previste, ms epoch del server. */
  podStartMs: number | null;
  podEndMs: number | null;
  /** Posizione dell'annuncio corrente (1-based) e annunci totali del pod, se annunciati. */
  podPosition: number | null;
  podLength: number | null;
  /** Fine dell'ultimo segmento pubblicitario della playlist (ms, orologio Twitch): i segmenti dell'annuncio escono in tempo reale, quindi e' "adesso". */
  adEdgeMs: number | null;
}

export function detectBreak(p: ParsedMedia): BreakInfo {
  let adSegments = 0;
  let contentSegments = 0;
  let contentAfterAd = 0;
  let firstAdPdt: number | null = null;
  for (const e of p.entries) {
    if (e.prefetch) continue;
    if (e.ad) {
      adSegments++;
      contentAfterAd = 0;
      if (firstAdPdt === null) firstAdPdt = e.pdtMs;
    } else {
      contentSegments++;
      contentAfterAd++;
    }
  }
  let startMs: number | null = firstAdPdt;
  let expectedSec: number | null = null;
  let roll: string | null = null;
  for (const d of p.dateranges) {
    if (!isAdDaterange(d) || d.cls !== AD_SIGNALS.daterangeClasses[0]) continue;
    if (d.startMs !== null && (startMs === null || d.startMs < startMs)) startMs = d.startMs;
    const pod = d.attrs['X-TV-TWITCH-AD-POD-FILLED-DURATION'];
    const v = pod !== undefined && !isNaN(Number(pod)) ? Number(pod) : d.durationSec;
    if (v !== null && (expectedSec === null || v > expectedSec)) expectedSec = v;
    if (d.attrs['X-TV-TWITCH-AD-ROLL-TYPE']) roll = d.attrs['X-TV-TWITCH-AD-ROLL-TYPE'];
  }
  // il pod in corso: l'annuncio piu' recente e quelli con lo stesso commercial id
  let latest: DateRange | null = null;
  for (const d of p.dateranges) {
    if (d.cls !== AD_SIGNALS.daterangeClasses[0] || d.startMs === null) continue;
    if (!latest || d.startMs >= (latest.startMs as number)) latest = d;
  }
  let podStartMs: number | null = null;
  let podEndMs: number | null = null;
  let podPosition: number | null = null;
  let podLength: number | null = null;
  if (latest) {
    const cid = latest.attrs['X-TV-TWITCH-AD-COMMERCIAL-ID'];
    for (const d of p.dateranges) {
      if (d.cls !== AD_SIGNALS.daterangeClasses[0] || d.startMs === null) continue;
      if (cid !== undefined && d.attrs['X-TV-TWITCH-AD-COMMERCIAL-ID'] !== cid) continue;
      if (podStartMs === null || d.startMs < podStartMs) podStartMs = d.startMs;
      const e = d.startMs + (d.durationSec || 0) * 1000;
      if (podEndMs === null || e > podEndMs) podEndMs = e;
    }
    const filled = Number(latest.attrs['X-TV-TWITCH-AD-POD-FILLED-DURATION']);
    if (podStartMs !== null && isFinite(filled) && filled > 0) podEndMs = Math.max(podEndMs || 0, podStartMs + filled * 1000);
    const pos = Number(latest.attrs['X-TV-TWITCH-AD-POD-POSITION']);
    const len = Number(latest.attrs['X-TV-TWITCH-AD-POD-LENGTH']);
    podPosition = latest.attrs['X-TV-TWITCH-AD-POD-POSITION'] !== undefined && isFinite(pos) ? pos + 1 : null;
    podLength = latest.attrs['X-TV-TWITCH-AD-POD-LENGTH'] !== undefined && isFinite(len) ? len : null;
  }
  let adEdgeMs: number | null = null;
  for (const e of p.entries) if (e.ad && !e.prefetch && e.pdtMs !== null) adEdgeMs = e.pdtMs + e.duration * 1000;
  const tail = p.entries.filter((e) => !e.prefetch);
  const active = tail.length > 0 && tail[tail.length - 1].ad;
  return { active, present: adSegments > 0, adSegments, contentSegments, contentAfterAd, startMs, expectedSec, roll, podStartMs, podEndMs, podPosition, podLength, adEdgeMs };
}

/** Comodo per i test e per il controller: classifica un testo. */
export function analyze(text: string): { parsed: ParsedMedia; info: BreakInfo } {
  const parsed = parseMedia(text);
  return { parsed, info: detectBreak(parsed) };
}

// ---- Riscrittura con numerazione coerente ----

export interface EmitResult {
  text: string;
  firstSn: number;
  lastSn: number;
}

function absolute(uri: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function absMap(line: string, base: string): string {
  return line.replace(/URI="([^"]*)"/, (_m, u: string) => `URI="${absolute(u, base)}"`);
}

/**
 * Mantiene la numerazione (media sequence, discontinuity sequence) delle playlist consegnate a hls.js, in modo che
 * restino coerenti passando tra la playlist originale e quella alternativa: il numero di un segmento e' il suo numero
 * live di Twitch (uguale in ogni forma di richiesta e variante), meno un "salto" accumulato quando un buco di
 * contenuto viene volutamente chiuso (nessuna alternativa disponibile).
 */
export class Timeline {
  private skew = 0;
  private lastSn: number | null = null;
  private lastCc = 0;
  private cc: { [sn: number]: number } = {};
  private known: number[] = [];
  private elide = false;
  private lastSrc: string | undefined;
  private switchSn: number | null = null;

  /**
   * `markSourceSwitch` (opt-in, spento di default): quando emit riceve un `src` diverso dal precedente (es. dall'alternativa
   * alla playlist originale, di solito un'altra rendition con un altro init segment) mette una EXT-X-DISCONTINUITY sul
   * primo segmento nuovo, come richiede HLS quando cambia la sorgente o la EXT-X-MAP.
   */
  constructor(private memory = 400, private opts: { markSourceSwitch?: boolean } = {}) {}

  /** Il prossimo contenuto reale va attaccato subito dopo l'ultimo consegnato, con una discontinuita'. */
  markGap(): void {
    this.elide = true;
  }

  hasEmitted(): boolean {
    return this.lastSn !== null;
  }

  private raw(e: Entry, p: ParsedMedia): number {
    return e.live !== null ? e.live : p.mediaSequence + e.idx;
  }

  /** Produce la playlist per hls.js con i soli segmenti `use` (nell'ordine) di `p`. `base` risolve gli URI relativi. */
  emit(p: ParsedMedia, use: Entry[], base: string, src?: string): EmitResult | null {
    if (!use.length) return null;
    // Una playlist numera i segmenti in modo consecutivo: dopo un buco nel contenuto (es. una pausa gia' scartata
    // in mezzo alla finestra) si tiene solo la parte piu' recente, contigua.
    let from = 0;
    for (let i = use.length - 1; i > 0; i--) {
      if (this.raw(use[i], p) !== this.raw(use[i - 1], p) + 1) {
        from = i;
        break;
      }
    }
    if (from > 0) use = use.slice(from);
    let forceDisc = false;
    const firstRaw = this.raw(use[0], p);
    if (this.elide && this.lastSn !== null) {
      if (firstRaw - this.skew > this.lastSn + 1) {
        this.skew = firstRaw - (this.lastSn + 1);
        forceDisc = true;
      }
      this.elide = false;
    }
    if (this.opts.markSourceSwitch && src !== undefined) {
      if (this.lastSrc !== undefined && this.lastSrc !== src && this.lastSn !== null && this.switchSn === null) this.switchSn = this.lastSn + 1;
      this.lastSrc = src;
    }
    const sns: number[] = [];
    const ccs: number[] = [];
    for (let i = 0; i < use.length; i++) {
      const e = use[i];
      const sn = this.raw(e, p) - this.skew;
      let cc: number;
      if (this.cc[sn] !== undefined) {
        cc = this.cc[sn];
      } else {
        const prevSn = i > 0 ? sns[i - 1] : this.lastSn;
        const prevCc = i > 0 ? ccs[i - 1] : this.lastCc;
        let incr = 0;
        if (i === 0) {
          if (forceDisc) incr = 1;
          else if (prevSn !== null && sn > prevSn + 1) incr = 1;
          else if (sn === this.switchSn) incr = 1;
        } else if (sn > (prevSn as number) + 1) incr = 1;
        else if (e.discBefore && this.raw(use[i - 1], p) + 1 === this.raw(e, p)) incr = 1; // discontinuita' reale dentro il contenuto
        else if (sn === this.switchSn) incr = 1;
        cc = prevCc + incr;
      }
      if (i > 0 && cc < ccs[i - 1]) cc = ccs[i - 1];
      sns.push(sn);
      ccs.push(cc);
    }
    let maxDur = 0;
    for (const e of use) if (e.duration > maxDur) maxDur = e.duration;
    const out: string[] = ['#EXTM3U', `#EXT-X-VERSION:${p.version}`, `#EXT-X-TARGETDURATION:${Math.max(p.targetDuration, Math.ceil(maxDur))}`, `#EXT-X-MEDIA-SEQUENCE:${sns[0]}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${ccs[0]}`];
    let lastMap: string | null = null;
    for (let i = 0; i < use.length; i++) {
      const e = use[i];
      if (i > 0 && ccs[i] > ccs[i - 1]) out.push('#EXT-X-DISCONTINUITY');
      if (e.map && e.map !== lastMap) {
        out.push(absMap(e.map, base));
        lastMap = e.map;
      }
      out.push(`#EXTINF:${e.duration.toFixed(3)},live`);
      out.push(absolute(e.uri, base));
    }
    for (let i = 0; i < use.length; i++) {
      if (this.cc[sns[i]] === undefined) {
        this.cc[sns[i]] = ccs[i];
        this.known.push(sns[i]);
      }
    }
    while (this.known.length > this.memory) delete this.cc[this.known.shift() as number];
    const lastSn = sns[sns.length - 1];
    if (this.switchSn !== null && lastSn >= this.switchSn) this.switchSn = null;
    if (this.lastSn === null || lastSn >= this.lastSn) {
      this.lastSn = lastSn;
      this.lastCc = ccs[ccs.length - 1];
    }
    return { text: out.join('\n') + '\n', firstSn: sns[0], lastSn };
  }
}

// ---- Master ----

export interface MasterVariant {
  /** Nome della variante: attributo VIDEO (es. "chunked", "720p60", "audio_only"). */
  name: string;
  url: string;
  width: number;
  height: number;
  fps: number;
  bandwidth: number;
}

export function parseMaster(text: string): MasterVariant[] {
  const lines = text.split('\n');
  const out: MasterVariant[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (l.indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
    const a = parseAttrs(l.slice(18));
    const url = lines[i + 1].replace(/\r$/, '').trim();
    if (!url || url.charAt(0) === '#') continue;
    const res = (a.RESOLUTION || '').split('x');
    out.push({
      name: a.VIDEO || '',
      url,
      width: Number(res[0]) || 0,
      height: Number(res[1]) || 0,
      fps: Number(a['FRAME-RATE']) || 0,
      bandwidth: Number(a.BANDWIDTH) || 0,
    });
  }
  return out;
}

/** La variante dell'alternativa che corrisponde a quella in riproduzione: stesso nome, altrimenti la piu' vicina per area e fps. */
export function matchVariant(target: MasterVariant, candidates: MasterVariant[]): MasterVariant | null {
  if (!candidates.length) return null;
  for (const c of candidates) if (c.name && c.name === target.name) return c;
  if (!target.height) {
    for (const c of candidates) if (!c.height) return c;
    return null;
  }
  let best: MasterVariant | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (!c.height) continue;
    const d = Math.abs(c.width * c.height - target.width * target.height) + Math.abs(c.fps - target.fps) * 1000;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
