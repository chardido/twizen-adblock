// Verifica dal vivo dell'estensione su twitch.tv: npm run check:ext (o check) -- <canale> [<canale>...] [--control] [--headless] [--secs=90] [--after=30] [--script=path] [--keep]
//  - inietta lo script di pagina COSTRUITO (addInitScript equivale a un content script MAIN a document_start), senza
//    caricare l'estensione; con --control non inietta nulla (serve a confermare che i pre-roll arrivano davvero).
//  - profilo Chrome usa e getta (mai quello vero), Chrome di sistema, finestra visibile salvo --headless (che non riceve i pre-roll).
//  - campiona <video> e la UI degli annunci, raccoglie i log di pagina e worker, stampa un verdetto per canale.
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const a = argv.find((x) => x.startsWith('--' + n + '='));
  return a ? a.slice(n.length + 3) : d;
};
const channels = argv.filter((a) => !a.startsWith('--'));
const control = flag('control');
const browser = opt('browser', 'chrome'); // 'chrome' (Chrome di sistema, script iniettato) | 'firefox' (Firefox installato, estensione caricata come temporanea via WebDriver BiDi)
const firefoxBin = opt('firefox-bin', '/Applications/Firefox.app/Contents/MacOS/firefox');
const extDir = resolve(root, opt('ext', 'extension/dist/firefox'));
const sim = opt('sim', ''); // 'midroll' | 'midroll-noalt': i mid-roll non si possono provocare, si simulano marcando come annuncio segmenti LIVE veri (vedi simulate)
const simAt = Number(opt('sim-at', 20));
const simLen = Number(opt('sim-len', 30));
const simAnnounce = Number(opt('sim-announce', 0)); // secondi di anticipo con cui il date range compare prima dei segmenti pubblicitari (osservato in un mid-roll vero)
const dump = opt('dump', ''); // file in cui accodare il testo completo delle playlist al cambio di stato (serve --trace)
const trace = flag('trace'); // registra ogni media playlist vista dal player
// Chrome headless non riceve i pre-roll (verificato: controllo senza script, 0 annunci su 3 canali; headed: annunci su 2 su 2): di base si apre la finestra
const headed = !flag('headless');
const secs = Number(opt('secs', 90)); // finestra in cui aspettare un break
const after = Number(opt('after', 30)); // secondi da osservare dopo la fine del break
const script = resolve(root, opt('script', 'extension/dist/chrome/twizen-adblock.js'));
if (!channels.length) {
  console.error('uso: npm run check:ext (o check) -- <canale> [<canale>...] [--control] [--headless] [--secs=90] [--after=30]');
  process.exit(2);
}
if (!control && !existsSync(script)) {
  console.error('script non trovato (npm run build:ext):', script);
  process.exit(2);
}

/**
 * Simulazione di un mid-roll (solo con --sim): intercetta le media playlist a livello di rete, SOTTO il gancio, e marca come
 * "stitched ad" (titolo Amazon|..., date range con ROLL-TYPE MIDROLL) i segmenti live con PDT in [t0, t0+simLen s].
 * I segmenti restano live veri: serve a vedere come il player digerisce il passaggio alla playlist dell'alternativa
 * (autoplay/android, 360p) e il ritorno, non la pubblicita' vera. Con 'midroll-noalt' le richieste di token dell'alternativa
 * (platform ps4/android) vengono fatte fallire, per osservare lo strato "nessuna sorgente pulita".
 */
/** I date range di un break vero (copiati da una cattura reale in src/net/fixtures, con le date spostate): stitched-ad con tutti gli attributi X-TV-TWITCH-AD-*, e la sorgente Amazon. */
function simRanges(t0, iso) {
  const src = readFileSync(resolve(root, 'src/net/fixtures/tv-midroll-boundary.m3u8'), 'utf8').split('\n');
  const pick = (cls) => src.find((l) => l.startsWith('#EXT-X-DATERANGE:') && l.includes('CLASS="' + cls + '"'));
  const ad = pick('twitch-stitched-ad')
    .replace(/START-DATE="[^"]*"/, `START-DATE="${iso(t0)}"`)
    .replace(/DURATION=[0-9.]+/, `DURATION=${simLen}.000`)
    .replace(/ID="stitched-ad-[^"]*"/, `ID="stitched-ad-${Math.floor(t0 / 1000)}-${simLen}000000000"`)
    .replace(/X-TV-TWITCH-AD-POD-FILLED-DURATION="[^"]*"/, `X-TV-TWITCH-AD-POD-FILLED-DURATION="${simLen}"`)
    .replace(/X-TV-TWITCH-AD-ROLL-TYPE="[^"]*"/, 'X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"');
  const source = pick('twitch-stream-source').replace(/START-DATE="[^"]*"/, `START-DATE="${iso(t0)}"`).replace(/ID="source-[^"]*"/, `ID="source-${Math.floor(t0 / 1000)}"`);
  // a pausa finita Twitch apre una nuova sorgente "live": senza, i segmenti dopo la pausa risulterebbero ancora pubblicitari
  const t1 = t0 + simLen * 1000;
  const back = source.replace(/START-DATE="[^"]*"/, `START-DATE="${iso(t1)}"`).replace(/ID="source-[^"]*"/, `ID="source-${Math.floor(t1 / 1000)}"`).replace(/X-TV-TWITCH-STREAM-SOURCE="[^"]*"/, 'X-TV-TWITCH-STREAM-SOURCE="live"');
  return [ad, source, back];
}

function simulate(text, state) {
  if (text.indexOf('#EXT-X-TARGETDURATION') < 0 || text.indexOf('stitched-ad') >= 0) return text;
  const lines = text.split('\n');
  const pdts = lines.map((l) => (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:') ? Date.parse(l.slice(25)) : null)).filter((x) => x !== null);
  if (!pdts.length) return text;
  if (state.t0 === null) {
    if ((Date.now() - state.start) / 1000 < simAt) return text;
    state.t0 = pdts[pdts.length - 1] + simAnnounce * 1000;
  }
  const t1 = state.t0 + simLen * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  const out = [];
  let pdt = null;
  let prevAd = false;
  let first = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25));
    if (first && l.startsWith('#EXT-X-PROGRAM-DATE-TIME:') === false && l.startsWith('#EXT-X-TWITCH-LIVE-SEQUENCE:')) {
      out.push(l);
      for (const d of simRanges(state.t0, iso)) out.push(d);
      first = false;
      continue;
    }
    if (l.startsWith('#EXTINF:') && pdt !== null) {
      const ad = pdt >= state.t0 && pdt < t1;
      if (ad !== prevAd && out.length) {
        // discontinuita' dove cambia la natura del segmento (prima del PDT che la precede)
        const k = out.length - 1;
        out.splice(k, 0, '#EXT-X-DISCONTINUITY');
      }
      prevAd = ad;
      out.push(ad ? l.replace(/,.*$/, ',Amazon|sim') : l);
      continue;
    }
    out.push(l);
  }
  if (first) return text;
  return out.join('\n');
}

// Osservatore passivo (solo lettura) installato nel worker SOPRA l'eventuale gancio: registra cosa vede il player.
const VIEW_SPY_SRC = `(function(){
  var f=self.fetch, st=null, n=0, id=(f&&f.twizenTag)||Math.random().toString(36).slice(2,5), TRACE=__TRACE__;
  self.fetch=function(i,o){
    var u=typeof i==='string'?i:(i&&i.url)||String(i);
    var p=f.apply(this,arguments);
    if(u.indexOf('.m3u8')<0||u.indexOf('usher.ttvnw.net')>=0) return p;
    return p.then(function(r){
      try{ r.clone().text().then(function(t){
        if(t.indexOf('#EXT-X-TARGETDURATION')<0) return;
        var ad=/CLASS="twitch-stitched-ad"/.test(t);
        var tl=t.split('\\n').filter(function(l){return l.indexOf('#EXTINF')===0});
        var tail=tl.length?tl[tl.length-1].split(',')[1]||'':'';
        var tailAd=!!tail&&tail!=='live';
        var m=/X-TV-TWITCH-AD-ROLL-TYPE="([A-Z]+)"/.exec(t);
        var s=(ad?'ad':'-')+(tailAd?'/tailAd':'')+(m?'/'+m[1]:'');
        n++;
        if(TRACE&&s!==st)console.log('[twizen-view-dump] ['+id+'] '+s+' @'+Date.now()+' '+t.replace(/\\n/g,' \\u23ce ').slice(0,9000));
        if(TRACE||s!==st){st=s;var dc=t.split('\\n').filter(function(l){return l.indexOf('#EXT-X-DISCONTINUITY')===0&&l.indexOf('SEQUENCE')<0}).length;console.log('[twizen-view] ['+id+'] '+s+' disc='+dc+' pdt='+((/PROGRAM-DATE-TIME:(\\S+)/.exec(t)||[])[1])+' media#'+n+' seq='+((/MEDIA-SEQUENCE:(\\d+)/.exec(t)||[])[1])+' segs='+tl.length+' tailTitle='+tail)}
      }).catch(function(){}) }catch(e){}
      return r;
    });
  };
})();`;

const VIEW_SPY = VIEW_SPY_SRC.replace('__TRACE__', String(trace));
const INIT_VIEW = `(() => { const W = window.Worker; const spy = ${JSON.stringify(VIEW_SPY)};
  window.Worker = new Proxy(W, { construct(t, a, nt) { try { const u = String(a[0]); if (u.startsWith('blob:') && !(a[1] && a[1].type === 'module')) { const x = new XMLHttpRequest(); x.open('GET', u, false); x.send(); console.log('[twizen-view] Worker creato in ' + location.origin + (window === top ? ' (top)' : ' (frame)') + ' ' + u.slice(0, 48) + ' ivs=' + /amazon-ivs-wasmworker/.test(x.responseText) + ' status=' + x.status); a = [URL.createObjectURL(new Blob([spy + '\\n' + x.responseText], { type: 'text/javascript' })), ...a.slice(1)]; } } catch (e) {} return Reflect.construct(t, a, nt); } }); })();`;

const AD_UI = [
  '[data-a-target="video-ad-label"]',
  '[data-a-target="video-ad-countdown"]',
  '[data-test-selector="ad-banner-default-text"]',
  '[data-test-selector="sad-overlay"]',
];
const ERR_UI = ['[data-a-target="player-overlay-content-gate"]', '[data-a-target="player-error"]', '[data-test-selector="player-error"]'];

async function sample(page) {
  return page.evaluate(
    ([adSel, errSel]) => {
      const v = document.querySelector('video');
      const q = (l) => l.filter((s) => document.querySelector(s)).map((s) => s.replace(/^\[data-(a-target|test-selector)="|"\]$/g, ''));
      const txt = (document.querySelector('.video-player') || document.body).innerText || '';
      const err = /something went wrong|error #\d|content is not available|this video is unavailable|playback error|Errore/i.exec(txt);
      return {
        t: v ? v.currentTime : null, buf: v ? Array.from({ length: v.buffered.length }, (_, i) => v.buffered.start(i).toFixed(1) + '-' + v.buffered.end(i).toFixed(1)).join(' ') : '', paused: v ? v.paused : null, rs: v ? v.readyState : null, w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0,
        ad: q(adSel), err: q(errSel), errText: err ? err[0] : null,
        adText: /ad (will )?(end|break)|commercial|Ads? (in|will)|\bAd\b.*\d+:\d+|\d+ of \d+/i.exec(txt) ? txt.split('\n').filter((l) => /\bad\b|commercial|ads/i.test(l)).slice(0, 3).join(' | ') : '',
      };
    },
    [AD_UI, ERR_UI],
  );
}

/**
 * Firefox installato, pilotato con WebDriver BiDi (integrato in Firefox, nessuna dipendenza): profilo usa e getta,
 * estensione costruita caricata come add-on temporaneo (webExtension.install), come fa l'utente. Espone la parte di
 * API Playwright che runChannel usa (on, goto, evaluate, locator, waitForTimeout, close).
 */
async function launchFirefox(dir, ch, simState) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(firefoxBin, ['--profile', dir, '--no-remote', '--new-instance', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  for (let i = 0; i < 40 && !ws; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const w = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((res, rej) => {
        w.onopen = res;
        w.onerror = () => rej(new Error('x'));
      });
      ws = w;
    } catch {
      /* Firefox non e' ancora pronto */
    }
  }
  if (!ws) {
    proc.kill();
    throw new Error('Firefox: WebDriver BiDi non raggiungibile (' + firefoxBin + ')');
  }
  let id = 0;
  const pending = new Map();
  const handlers = { console: [], request: [] };
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
    else if (d.method === 'log.entryAdded') handlers.console.forEach((f) => f(String(d.params.text || '')));
    else if (d.method === 'network.beforeRequestSent') {
      handlers.request.forEach((f) => f(d.params.request.url));
      if (d.params.isBlocked && simState) simIntercept(d.params).catch(() => {});
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolveP, reject) => {
      const i = ++id;
      pending.set(i, (d) => (d.type === 'error' ? reject(new Error(method + ': ' + d.message)) : resolveP(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('session.new', { capabilities: {} });
  // simulazione di mid-roll anche su Firefox: intercettazione BiDi (network.addIntercept/provideResponse) di master e media playlist
  const hosts = new Set();
  const simIntercept = async (params) => {
    const url = params.request.url;
    const id = params.request.request;
    const base = url.replace(/[?#].*/, '');
    const isMaster = /usher\.ttvnw\.net\/api\/v2\/channel\/hls\//.test(url);
    if (!isMaster && !simState.own.has(base)) return send('network.continueRequest', { request: id });
    const text = await (await fetch(url)).text();
    let body = text;
    if (isMaster) {
      for (const l of text.split('\n')) {
        if (!l.startsWith('https://')) continue;
        simState.own.add(l.trim().replace(/[?#].*/, ''));
        const h = new URL(l.trim()).hostname;
        if (!hosts.has(h)) {
          hosts.add(h);
          await send('network.addIntercept', { phases: ['beforeRequestSent'], urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: h }] });
        }
      }
    } else body = simulate(text, simState);
    await send('network.provideResponse', {
      request: id,
      statusCode: 200,
      reasonPhrase: 'OK',
      headers: [
        { name: 'content-type', value: { type: 'string', value: 'application/vnd.apple.mpegurl' } },
        { name: 'access-control-allow-origin', value: { type: 'string', value: '*' } },
      ],
      body: { type: 'string', value: body },
    });
  };
  if (!control) await send('webExtension.install', { extensionData: { type: 'path', path: extDir } });
  await send('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });
  if (simState) await send('network.addIntercept', { phases: ['beforeRequestSent'], urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'usher.ttvnw.net', pathname: `/api/v2/channel/hls/${ch.toLowerCase()}.m3u8` }] });
  const context = (await send('browsingContext.getTree', {})).contexts[0].context;
  const evalStr = async (expression) => {
    const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (r.type !== 'success') throw new Error('script: ' + JSON.stringify(r.exceptionDetails && r.exceptionDetails.text));
    return r.result.type === 'string' ? r.result.value : undefined;
  };
  const page = {
    on: (ev, f) => ev === 'console' && handlers.console.push((t) => f({ text: () => t })),
    goto: async (url) => {
      await send('script.addPreloadScript', { functionDeclaration: `() => { ${INIT_VIEW} }` });
      await send('browsingContext.navigate', { context, url, wait: 'none' });
    },
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    evaluate: async (fn, arg) => JSON.parse((await evalStr(`JSON.stringify((${fn})(${JSON.stringify(arg)}))`)) || 'null'),
    locator: (sel) => ({ first: () => ({ click: async () => { await evalStr(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return 'ok'; })()`); } }) }),
  };
  const ctx = {
    on: (ev, f) => ev === 'request' && handlers.request.push((u) => f({ url: () => u })),
    addInitScript: async () => {},
    close: async () => {
      try {
        ws.close();
      } catch {
        /* gia' chiuso */
      }
      proc.kill();
    },
  };
  return { ctx, page };
}

async function runChannel(ch) {
  const dir = mkdtempSync(resolve(tmpdir(), 'twizen-ext-check-'));
  const simState = sim ? { t0: null, start: Date.now(), own: new Set() } : null;
  const ff = browser === 'firefox' ? await launchFirefox(dir, ch, simState) : null;
  const ctx =
    ff
      ? ff.ctx
      : await chromium.launchPersistentContext(dir, {
          channel: 'chrome',
          headless: !headed,
          args: ['--autoplay-policy=no-user-gesture-required', ...(headed ? [] : ['--headless=new'])],
          viewport: { width: 1280, height: 720 },
        });
  const logs = [];
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  const keep = (src, text) => {
    if (dump && text.startsWith('[twizen-view-dump]')) appendFileSync(dump, text + '\n\n');
    if (/\[twizen-(adblock|view)\]/.test(text)) {
      // la pagina riceve anche i console dei worker: si scarta il duplicato
      const flat = text.replace(/\s+/g, ' ').slice(0, 300);
      if (logs.some((l) => l.text === flat && (Date.now() - t0) / 1000 - l.t < 1.5)) return;
      logs.push({ t: (Date.now() - t0) / 1000, text: text.replace(/\s+/g, ' ').slice(0, 300) });
      console.log(`  ${stamp()}s ${src} ${text.slice(0, 220)}`);
    }
  };
  const reqs = { usher: [], playlist: 0, gql: 0 };
  try {
    if (!control && !ff) await ctx.addInitScript({ path: script });
    await ctx.addInitScript({ content: INIT_VIEW });
    if (sim && !ff) {
      const state = simState;
      // solo le playlist della master del player (api/v2): quelle richieste dal controller (altra master, api/channel) restano pulite
      await ctx.route(/usher\.ttvnw\.net\/api\/v2\/channel\/hls\//, async (route) => {
        try {
          const res = await route.fetch();
          const body = await res.text();
          for (const l of body.split('\n')) if (l.startsWith('https://')) state.own.add(l.trim().replace(/[?#].*/, ''));
          await route.fulfill({ response: res, body });
        } catch {
          await route.continue().catch(() => {});
        }
      });
      await ctx.route(/playlist\.ttvnw\.net\/.*\.m3u8/, async (route) => {
        try {
          const res = await route.fetch();
          const txt = await res.text();
          const body = state.own.has(route.request().url().replace(/[?#].*/, '')) ? simulate(txt, state) : txt;
          await route.fulfill({ response: res, body });
        } catch {
          await route.continue().catch(() => {});
        }
      });
      if (sim === 'midroll-noalt') {
        await ctx.route('https://gql.twitch.tv/gql', async (route) => {
          const d = route.request().postData() || '';
          if (/"platform":"(ps4|android)"/.test(d)) return route.abort();
          return route.continue();
        });
      }
    }
    const page = ff ? ff.page : await ctx.newPage();
    page.on('console', (m) => keep('page', m.text()));
    if (!ff) page.on('pageerror', (e) => console.log(`  ${stamp()}s pageerror ${String(e).slice(0, 160)}`));
    if (!ff) page.on('worker', (w) => w.on('console', (m) => keep('worker', m.text())));
    ctx.on('request', (r) => {
      const u = r.url();
      if (u.startsWith('https://usher.ttvnw.net/')) console.log(`  ${stamp()}s richiesta usher ${u.replace(/\?.*/, '')} player_type=${(/player_type=([^&]*)/.exec(u) || [])[1] || '-'}`);
      if (u.startsWith('https://usher.ttvnw.net/')) reqs.usher.push(u.replace(/\?.*/, '?…') + ' player_type=' + ((/player_type=([^&]*)/.exec(u) || [])[1] || '-'));
      else if (/playlist\.ttvnw\.net/.test(u)) reqs.playlist++;
    });
    await page.goto('https://www.twitch.tv/' + ch, { waitUntil: 'domcontentloaded' });
    // gate dei contenuti per maturi: non e' un errore, si conferma e basta
    const gate = () => page.locator('[data-a-target="content-classification-gate-overlay-start-watching-button"]').first().click({ timeout: 500 }).catch(() => {});
    const samples = [];
    let firstPlay = null;
    let adStart = null;
    let adEnd = null;
    const end = secs;
    while (true) {
      await page.waitForTimeout(1000);
      const el = (Date.now() - t0) / 1000;
      if (samples.length < 20) await gate();
      const s = await sample(page).catch(() => null);
      if (!s) continue;
      s.at = el;
      samples.push(s);
      if (firstPlay === null && s.t > 0.5 && s.rs >= 3 && !s.paused) firstPlay = el;
      // inizio/fine del break: dalla UI degli annunci, o dal gancio (rilevato/terminato)
      const detected = logs.find((l) => l.text.includes('pausa pubblicitaria rilevata'));
      const ended = logs.find((l) => l.text.includes('pausa pubblicitaria terminata'));
      if (adStart === null && (s.ad.length || detected)) adStart = detected ? Math.min(detected.t, s.ad.length ? el : Infinity) : el;
      if (adStart !== null && adEnd === null) {
        if (ended && ended.t > adStart) adEnd = ended.t;
        else if (!control && !detected) { /* senza gancio: solo UI */ if (!s.ad.length) adEnd = el; }
        else if (control && !s.ad.length) adEnd = el;
      }
      if (s.err.length || s.errText) {
        if (samples.filter((x) => x.err.length || x.errText).length === 1) console.log(`  ${stamp()}s ERRORE UI ${JSON.stringify(s.err)} ${s.errText}`);
      }
      if (firstPlay !== null && samples.length > 3 && samples.slice(-3).every((x) => x.t === s.t) && samples.length % 3 === 0) console.log(`  ${stamp()}s FERMO t=${s.t && s.t.toFixed(1)} rs=${s.rs} paused=${s.paused} buffered=[${s.buf}] ad=${JSON.stringify(s.ad)}`);
      if (samples.length % 10 === 0) console.log(`  ${stamp()}s video t=${s.t && s.t.toFixed(1)} rs=${s.rs} ${s.w}x${s.h} buf=[${s.buf}] ad=${JSON.stringify(s.ad)} ${s.adText ? 'adText=' + s.adText : ''}`);
      const viewAd = logs.some((l) => /\[twizen-view\] \[\w+\] ad/.test(l.text));
      if (adEnd !== null && el > adEnd + after) break;
      if (adStart === null && !viewAd && el > end) break;
      if (el > Number(opt("max", 300))) break;
    }
    // analisi
    const log = (re) => logs.filter((l) => re.test(l.text));
    const adSamples = samples.filter((s) => s.ad.length);
    const playing = samples.filter((s) => s.t > 0.5 && !s.paused && s.rs >= 3);
    // stallo: tempo massimo senza avanzamento di currentTime dopo il primo play
    let maxStall = 0;
    let stallStart = null;
    for (let i = 1; i < samples.length; i++) {
      if (firstPlay === null || samples[i].at < firstPlay) continue;
      if (samples[i].t === samples[i - 1].t) {
        if (stallStart === null) stallStart = samples[i - 1].at;
        maxStall = Math.max(maxStall, samples[i].at - stallStart);
      } else stallStart = null;
    }
    const last = samples[samples.length - 1] || {};
    const post = adEnd === null ? [] : samples.filter((s) => s.at > adEnd);
    const postAdBack = post.some((s) => s.ad.length);
    const errs = samples.filter((s) => s.err.length || s.errText);
    const v = {
      channel: ch,
      mode: (control ? 'CONTROLLO (senza script)' : 'CON SCRIPT') + ' [' + browser + ']',
      firstPlaySec: firstPlay,
      adUiSeen: adSamples.length > 0 ? `${adSamples.length} s (primo a ${adSamples[0].at.toFixed(0)} s, ${JSON.stringify(adSamples[0].ad)})` : 'no',
      viewSpy: log(/twizen-view/).map((l) => l.text.replace('[twizen-view] ', '')).join(' -> ') || '(nessuna playlist osservata)',
      breakDetected: log(/pausa pubblicitaria rilevata/).map((l) => l.text.replace(/.*rilevata/, 'rilevata')).join('; ') || 'no',
      source: log(/sorgente pulita|live da sorgente|nessuna sorgente|non utilizzabile|mitigazione/).map((l) => l.text.replace(/.*\[twizen-adblock\] /, '')).join('; ') || '-',
      breakEnded: log(/pausa pubblicitaria terminata/).length > 0,
      maxStallSec: maxStall,
      playingSamples: playing.length + '/' + samples.length,
      lastVideo: `t=${last.t && last.t.toFixed(1)} rs=${last.rs} ${last.w}x${last.h} paused=${last.paused}`,
      errorOverlay: errs.length ? JSON.stringify(errs[0].err) + ' ' + errs[0].errText : 'no',
      adAfterEnd: postAdBack,
      secondsObservedAfterEnd: adEnd === null ? 0 : (last.at - adEnd).toFixed(0),
      usherRequests: reqs.usher.length + (reqs.usher.length ? ' [' + [...new Set(reqs.usher)].join(', ') + ']' : ''),
      mediaPlaylistRequests: reqs.playlist,
    };
    let verdict;
    const hadBreak = adSamples.length > 0 || /(^| )ad/.test(v.viewSpy) || v.breakDetected !== 'no';
    if (firstPlay === null) verdict = 'FALLITO: il video non e\' mai partito';
    else if (!control && !log(/gancio attivo nel worker/).length) verdict = 'FALLITO: il video parte ma nessun "gancio attivo nel worker": il riconoscimento del worker del player (extension/src/match.ts) non corrisponde piu\' a quello di Twitch, le pubblicita\' tornerebbero senza errori';
    else if (!hadBreak) verdict = 'NON CONCLUSIVO: nessun break nella finestra osservata';
    else if (control) verdict = 'CONTROLLO: il break e\' stato servito (annuncio visibile: ' + (adSamples.length > 0) + ')';
    else {
      const bad = [];
      if (v.breakDetected === 'no') bad.push('break non rilevato dal gancio');
      if (adSamples.length) bad.push('UI annuncio visibile per ' + adSamples.length + ' s');
      if (errs.length) bad.push('overlay di errore');
      if (maxStall > 8) bad.push('stallo di ' + maxStall.toFixed(0) + ' s');
      if (postAdBack) bad.push('annuncio di nuovo visibile dopo la fine');
      if (adEnd === null && !v.breakEnded) bad.push('fine del break non osservata');
      verdict = bad.length ? 'FALLITO: ' + bad.join('; ') : 'OK: break gestito, live continuo' + (v.breakEnded ? '' : ' (fine break solo da UI)');
    }
    console.log('\n  == ' + ch + ' ==');
    for (const k of Object.keys(v)) console.log(`  ${k}: ${typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k]}`);
    console.log('  VERDETTO: ' + verdict + '\n');
    return { channel: ch, verdict, ...v };
  } finally {
    await ctx.close().catch(() => {});
    if (!flag('keep')) rmSync(dir, { recursive: true, force: true });
  }
}

const results = [];
for (const ch of channels) {
  console.log(`--- ${ch} (${control ? 'controllo' : 'con script'}) ---`);
  try {
    results.push(await runChannel(ch));
  } catch (e) {
    console.log('  ERRORE script:', e && e.message ? e.message : e);
    results.push({ channel: ch, verdict: 'ERRORE: ' + (e && e.message) });
  }
}
console.log('RIEPILOGO');
for (const r of results) console.log(`  ${r.channel}: ${r.verdict}`);
process.exit(results.every((r) => r.verdict.startsWith('OK') || r.verdict.startsWith('CONTROLLO') || r.verdict.startsWith('NON CONCLUSIVO')) ? 0 : 1);
