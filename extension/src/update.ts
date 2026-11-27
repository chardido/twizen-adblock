/**
 * Logica pura dell'avviso di aggiornamento (solo Chrome): confronto versioni, lettura della risposta dell'API GitHub,
 * stato di badge e titolo, scadenza del controllo. Nessuna API del browser: il collante e' in background.ts.
 */

export const RELEASE_API_URL = 'https://api.github.com/repos/chardido/twizen-adblock/releases/latest';
export const RELEASE_PAGE_URL = 'https://github.com/chardido/twizen-adblock/releases/latest';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// l'allarme scatta poco prima delle 24 h dal tentativo precedente: senza tolleranza il controllo saltava un giorno intero
const CHECK_SLACK_MS = 60 * 60 * 1000;
export const BADGE_TEXT = 'NEW';

/** "v0.1.10" o "0.1.10" -> [0, 1, 10]; qualsiasi altra forma (suffissi, vuoto, non stringhe) -> null. */
export function parseVersion(input: unknown): number[] | null {
  if (typeof input !== 'string') return null;
  const m = /^[vV]?(\d{1,9}(?:\.\d{1,9}){0,3})$/.exec(input.trim());
  return m ? m[1].split('.').map(Number) : null;
}

/** Confronto numerico per componente (le mancanti valgono 0); null se una delle due non e' interpretabile. */
export function compareVersions(a: unknown, b: unknown): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Versione normalizzata ("0.1.4") dalla risposta di releases/latest, o null se il corpo non e' quello atteso. */
export function latestFromRelease(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const v = parseVersion(r.tag_name);
  return v ? v.join('.') : null;
}

export function isUpdateAvailable(installed: unknown, latest: unknown): boolean {
  return compareVersions(latest, installed) === 1;
}

export interface UpdateView {
  badgeText: string;
  title: string;
}

/** Cosa mostrare sull'icona: con una versione piu' recente badge e titolo che le nominano, altrimenti niente badge. */
export function viewFor(installed: string, latest: unknown): UpdateView {
  if (isUpdateAvailable(installed, latest)) {
    const l = (parseVersion(latest) as number[]).join('.');
    return { badgeText: BADGE_TEXT, title: `Twizen adblock ${installed}: version ${l} is available. Click to open the release page.` };
  }
  return { badgeText: '', title: `Twizen adblock ${installed}` };
}

/** Il controllo e' dovuto se non ce n'e' mai stato uno, se l'orologio e' tornato indietro o se e' passato (quasi) un intervallo. */
export function isCheckDue(now: number, lastCheck: unknown, interval = CHECK_INTERVAL_MS): boolean {
  if (typeof lastCheck !== 'number' || !Number.isFinite(lastCheck) || lastCheck > now) return true;
  return now - lastCheck >= interval - CHECK_SLACK_MS;
}
