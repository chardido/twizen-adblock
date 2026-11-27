import { parseMaster } from '../../src/net/adPlaylist';
import { urlKey } from './classify';

/** La parte di AdController che serve qui (permette di provare il router con un finto). */
export interface Processor {
  process(text: string, ctx: { kind: 'master' | 'media'; url: string }): string | Promise<string>;
  destroy(): void;
}

interface Slot {
  login: string;
  proc: Processor;
  keys: string[];
}

/**
 * Instrada le playlist al controller che le possiede. Un worker puo' servire piu' canali nel tempo (navigazione):
 * si tiene un piccolo insieme di controller, il meno recente viene distrutto. Una nuova master dello stesso canale
 * e' una nuova sessione di riproduzione (numerazione nuova): sostituisce il controller.
 */
export class PlaylistRouter {
  private slots: Slot[] = [];
  private byKey = new Map<string, Slot>();

  constructor(private make: (login: string) => Processor, private max = 3) {}

  /** Il testo che il player deve vedere per la master. */
  master(login: string, url: string, text: string): string | Promise<string> {
    const old = this.slots.find((s) => s.login === login);
    if (old) this.drop(old);
    const slot: Slot = { login, proc: this.make(login), keys: [] };
    for (const v of parseMaster(text)) {
      const k = urlKey(v.url);
      slot.keys.push(k);
      this.byKey.set(k, slot);
    }
    this.slots.push(slot);
    while (this.slots.length > this.max) this.drop(this.slots[0]);
    return slot.proc.process(text, { kind: 'master', url });
  }

  /** null se la playlist non appartiene a nessun controller: va lasciata com'e', senza nemmeno leggerla. */
  owns(key: string): boolean {
    return this.byKey.has(key);
  }

  media(key: string, url: string, text: string): string | Promise<string> {
    const slot = this.byKey.get(key);
    if (!slot) return text;
    // il piu' recente per ultimo
    const i = this.slots.indexOf(slot);
    if (i >= 0 && i < this.slots.length - 1) {
      this.slots.splice(i, 1);
      this.slots.push(slot);
    }
    return slot.proc.process(text, { kind: 'media', url });
  }

  size(): number {
    return this.slots.length;
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
