import { parseMaster } from '../../src/net/adPlaylist';
import { urlKey } from './classify';

/** La parte di AdController che serve qui (permette di provare il router con un finto). */
export interface Processor {
  process(text: string, ctx: { kind: 'master' | 'media'; url: string }): string | Promise<string>;
  destroy(): void;
}

interface Slot {
  id: number;
  login: string;
  proc: Processor;
  keys: string[];
  lastUse: number;
}

/** Un giocatore in pausa smette di interrogare la playlist e puo' riprendere la stessa URL molto dopo: si scarta solo dopo un'inattivita' lunga. */
const IDLE_MS = 30 * 60 * 1000;

/**
 * Instrada le playlist al controller che le possiede. L'unita' e' la SESSIONE (una risposta master con le sue
 * varianti), non il canale: una nuova master dello stesso canale non toglie la proprieta' alle playlist di
 * una sessione ancora in riproduzione (resterebbero senza controller e un annuncio passerebbe indisturbato).
 * La memoria e' limitata per numero (si scarta la meno usata di recente) e per inattivita' lunga; la pulizia
 * avviene durante le chiamate, senza timer.
 */
export class PlaylistRouter {
  private slots: Slot[] = [];
  private byKey = new Map<string, Slot>();

  private nextId = 1;
  /** Id (1, 2, ...) della sessione creata dall'ultima master. */
  lastId = 0;

  constructor(
    private make: (login: string, id: number) => Processor,
    private max = 8,
    private now: () => number = () => Date.now(),
    private idleMs = IDLE_MS,
  ) {}

  /** Il testo che il player deve vedere per la master: crea una sessione nuova. */
  master(login: string, url: string, text: string): string | Promise<string> {
    this.sweep();
    const id = this.nextId++;
    this.lastId = id;
    const slot: Slot = { id, login, proc: this.make(login, id), keys: [], lastUse: this.now() };
    for (const v of parseMaster(text)) {
      const k = urlKey(v.url);
      slot.keys.push(k);
      this.byKey.set(k, slot); // la sessione piu' recente possiede una chiave condivisa
    }
    this.slots.push(slot);
    while (this.slots.length > this.max) this.drop(this.slots[0]);
    return slot.proc.process(text, { kind: 'master', url });
  }

  /** Id della sessione che possiede la playlist, 0 se nessuna. */
  idOf(key: string): number {
    const s = this.byKey.get(key);
    return s ? s.id : 0;
  }

  /** Quante sessioni vive ci sono per il canale. */
  sessions(login: string): number {
    return this.slots.filter((s) => s.login === login).length;
  }

  /** false se la playlist non appartiene a nessun controller: va lasciata com'e', senza nemmeno leggerla. */
  owns(key: string): boolean {
    return this.byKey.has(key);
  }

  media(key: string, url: string, text: string): string | Promise<string> {
    const slot = this.byKey.get(key);
    if (!slot) return text;
    slot.lastUse = this.now();
    this.sweep();
    // il piu' recente per ultimo
    const i = this.slots.indexOf(slot);
    if (i >= 0 && i < this.slots.length - 1) {
      this.slots.splice(i, 1);
      this.slots.push(slot);
    }
    return slot.proc.process(text, { kind: 'media', url });
  }

  /** Stato sintetico per i log: per ogni sessione il canale e da quanto tempo non viene interrogata. */
  describe(): string {
    const t = this.now();
    return 'sessioni: ' + this.slots.map((s) => `s${s.id} ${s.login} (ultima playlist ${Math.round((t - s.lastUse) / 1000)} s fa)`).join(', ');
  }

  size(): number {
    return this.slots.length;
  }

  private sweep(): void {
    const t = this.now();
    for (const s of this.slots.slice()) if (t - s.lastUse > this.idleMs) this.drop(s);
  }

  private drop(slot: Slot): void {
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    for (const k of slot.keys) if (this.byKey.get(k) === slot) this.byKey.delete(k);
    try {
      slot.proc.destroy();
    } catch {
      /* gia' distrutto */
    }
  }
}
