/**
 * Service worker dell'estensione (solo Chrome): avvisa quando esiste una release piu' recente.
 * Un'estensione "unpacked" non si aggiorna da sola; questo e' l'unico traffico di rete dell'estensione oltre a Twitch:
 * una GET al giorno all'API pubblica di GitHub, senza cookie ne' intestazioni proprie. Non tocca la pagina di twitch.tv.
 * La logica e' in update.ts; qui solo il collante con le API del browser.
 */
import { CHECK_INTERVAL_MS, RELEASE_API_URL, RELEASE_PAGE_URL, isCheckDue, latestFromRelease, parseVersion, viewFor } from './update';

// tipi minimi: nessuna dipendenza da @types/chrome
declare const chrome: {
  runtime: { getManifest(): { version: string }; onInstalled: Ev; onStartup: Ev };
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  alarms: { get(name: string): Promise<unknown>; create(name: string, info: { periodInMinutes: number }): Promise<void>; onAlarm: Ev };
  action: { setBadgeText(d: { text: string }): Promise<void>; setBadgeBackgroundColor(d: { color: string }): Promise<void>; setTitle(d: { title: string }): Promise<void>; onClicked: Ev };
  tabs: { create(p: { url: string }): Promise<unknown> };
};
interface Ev {
  addListener(cb: () => void): void;
}

const ALARM = 'twizen-update-check';
const installed = chrome.runtime.getManifest().version;

async function show(latest: unknown): Promise<void> {
  const v = viewFor(installed, latest);
  await chrome.action.setBadgeText({ text: v.badgeText });
  await chrome.action.setTitle({ title: v.title });
}

/** Una sola richiesta per controllo; qualsiasi errore e' silenzioso e si riprova al prossimo controllo programmato. */
async function check(): Promise<void> {
  const stored = await chrome.storage.local.get(['lastCheck', 'latest']);
  const latestStored = parseVersion(stored.latest) ? (stored.latest as string) : undefined;
  // il badge si ricalcola sempre con la versione in esecuzione: dopo un aggiornamento sparisce senza rete
  await show(latestStored);
  const now = Date.now();
  if (!isCheckDue(now, stored.lastCheck)) return;
  // si segna il tentativo prima della richiesta: un fallimento non provoca ripetizioni a ogni risveglio del worker
  await chrome.storage.local.set({ lastCheck: now });
  try {
    const res = await fetch(RELEASE_API_URL, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return;
    const latest = latestFromRelease(await res.json());
    if (!latest) return;
    await chrome.storage.local.set({ latest });
    await show(latest);
  } catch {
    /* offline, limite di richieste, corpo inatteso: niente */
  }
}

let running: Promise<void> | null = null;
function run(): void {
  if (!running) running = check().catch(() => undefined).finally(() => (running = null));
}

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: CHECK_INTERVAL_MS / 60000 });
}

// listener registrati in modo sincrono al primo avvio del worker, come richiede MV3
chrome.alarms.onAlarm.addListener(run);
chrome.runtime.onInstalled.addListener(run);
chrome.runtime.onStartup.addListener(run);
chrome.action.onClicked.addListener(() => void chrome.tabs.create({ url: RELEASE_PAGE_URL }));
void chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
void ensureAlarm().catch(() => undefined);
run();
