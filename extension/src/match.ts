/**
 * Quale worker agganciare. Osservato il 2026-11-27 su twitch.tv: il player (Amazon IVS) crea due worker come
 * blob con sorgente `importScripts('https://assets.twitch.tv/assets/amazon-ivs-wasmworker.min-<hash>.js')`.
 * Il riconoscimento e' sul nome dello script (senza hash ne' host); gli altri worker del sito (controlli di
 * integrita' su k.twitchcdn.net, ecc.) non vanno mai toccati.
 */
export const IVS_WORKER_RE = /amazon-ivs-wasmworker[\w.-]*\.js/;

/**
 * true se il worker e' quello del player e va agganciato. `blobSource` e' il testo del blob (solo per URL blob:),
 * null se non letto o non leggibile. I worker "module" non si agganciano (niente importScripts).
 */
export function isPlayerWorker(url: string, options: unknown, blobSource: string | null): boolean {
  if (options && typeof options === 'object' && (options as { type?: unknown }).type === 'module') return false;
  if (url.indexOf('blob:') === 0) return blobSource !== null && IVS_WORKER_RE.test(blobSource);
  return IVS_WORKER_RE.test(url);
}
