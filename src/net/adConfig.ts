/**
 * Tutto cio' che dipende da come Twitch inserisce la pubblicita' sta in questo file (e solo qui):
 * quando Twitch cambia qualcosa, di norma basta ritoccare queste costanti.
 *
 * Situazione osservata il 2026-11-26 (catture reali in samples/ads, fixture in src/net/fixtures):
 *  - Le pause sono "stitched" lato server nelle media playlist. Un break compare come:
 *      #EXT-X-DATERANGE:ID="stitched-ad-<ts>-<durata ns>",CLASS="twitch-stitched-ad",START-DATE=...,DURATION=30.235,
 *         X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"|"MIDROLL", X-TV-TWITCH-AD-POD-FILLED-DURATION="30" ...
 *      #EXT-X-DATERANGE:...CLASS="twitch-stream-source"...X-TV-TWITCH-STREAM-SOURCE="Amazon|<creativeId>"   ("live" a pausa finita)
 *      segmenti con titolo "Amazon|<creativeId>" invece di "live", preceduti da #EXT-X-DISCONTINUITY.
 *    Il contenuto della pausa (creativita' o la schermata "Commercial break in progress") sostituisce il video live.
 *  - Il pre-roll di una sessione nuova parte con MEDIA-SEQUENCE:0 e la playlist cresce di un segmento ogni 2 s;
 *    i segmenti live tornano dopo un #EXT-X-DISCONTINUITY + #EXT-X-TWITCH-LIVE-SEQUENCE:<n>.
 *  - Gli stessi segmenti live hanno lo stesso URL (senza query) in tutte le forme di richiesta: LIVE-SEQUENCE e'
 *    la numerazione comune, usata dal riscrittore per tenere hls.js coerente.
 *  - Forme di richiesta pulite (senza stitching) alla stessa ora, verificate con catture parallele:
 *      site/ps4        -> tutte le qualita' (1080p60 compresa), nessun annuncio (0 su 41 canali con pause attive)
 *      autoplay/android -> solo 360p/160p/audio, nessun annuncio
 *    (embed, popout, site/web, picture-by-picture, frontpage... ricevono il break.)
 */

/** Una forma alternativa di richiesta (token GQL + parametro usher) che restituisce lo stesso live senza break. */
export interface RequestShape {
  id: string;
  /** variables.playerType del token GQL e parametro usher player_type. */
  playerType: string;
  /** variables.platform del token GQL. */
  platform: string;
  /** Tipi di break (X-TV-TWITCH-AD-ROLL-TYPE) per cui la forma e' pulita; un break di tipo sconosciuto le prova tutte. */
  rolls: string[];
}

/**
 * In ordine di preferenza. Verificato il 2026-11-26 con sessioni parallele alla stessa ora:
 *  - PREROLL (sessione nuova): site/ps4 pulito su 41/41 canali, a qualita' piena; autoplay/android pulito (max 360p).
 *  - MIDROLL (break lanciato sul canale): site/ps4, site/ps5 e tutte le forme "web" ricevono il break dopo pochi
 *    secondi (anche se la sessione e' nuova); solo autoplay/android e' rimasto pulito in tutte le prove.
 */
export const CLEAN_SHAPES: RequestShape[] = [
  { id: 'ps4', playerType: 'site', platform: 'ps4', rolls: ['PREROLL'] },
  { id: 'autoplay-android', playerType: 'autoplay', platform: 'android', rolls: ['PREROLL', 'MIDROLL'] },
];

/** Segnali che riconoscono un segmento/break pubblicitario. */
export const AD_SIGNALS = {
  /** CLASS di un EXT-X-DATERANGE di pausa. */
  daterangeClasses: ['twitch-stitched-ad'],
  /** Prefisso dell'ID di quel date range. */
  daterangeIdPrefix: 'stitched-ad-',
  /** Qualsiasi attributo con questo prefisso marca il date range come pubblicitario. */
  daterangeAttrPrefix: 'X-TV-TWITCH-AD-',
  /** CLASS del date range con la sorgente del flusso (valore "live" = contenuto reale). */
  sourceClass: 'twitch-stream-source',
  sourceAttr: 'X-TV-TWITCH-STREAM-SOURCE',
  sourceLive: 'live',
  /** Titolo EXTINF dei segmenti reali. Un titolo diverso e non vuoto e' pubblicita' o slate. */
  contentTitle: 'live',
  /** Prefissi (prima di "|") dei titoli dei segmenti pubblicitari noti (streamlink, Xtra). */
  titleVendors: ['Amazon', 'Adform', 'DCM'],
};

/** Parametri operativi. */
export const AD_TUNING = {
  /** Tempo massimo di attesa del primo contenuto reale senza alternativa (poi si torna alla riproduzione normale). */
  holdMaxMs: 75000,
  /** Intervallo con cui si ricontrolla la playlist durante l'attesa. */
  holdPollMs: 1500,
  /** Finche' dopo un break i segmenti reali sono meno di cosi', se l'alternativa e' ancora calda la si usa. */
  minContentSegments: 3,
  /** Timeout delle richieste dell'alternativa. */
  altTimeoutMs: 8000,
  /** Una forma che ha restituito pubblicita' viene saltata per questo tempo. */
  badShapeMs: 120000,
  /** Quanti segmenti ricordare per la numerazione coerente. */
  memorySegments: 400,
};
