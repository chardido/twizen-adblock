import { describe, expect, it } from 'vitest';
import { createSession, type Controller } from './session';

function setup() {
  let t = 0;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nid = 0;
  const made: Array<{ seen: string[]; destroyed: boolean; emit: (mode: string) => void } & Controller> = [];
  const logs: string[] = [];
  let stopped = 0;
  const s = createSession({
    make: () => {
      let fn: ((s: { mode: string }) => void) | null = null;
      const c = {
        seen: [] as string[],
        destroyed: false,
        emit: (mode: string) => fn && fn({ mode }),
        process: (text: string, ctx: { kind: string }) => {
          c.seen.push(ctx.kind);
          return text;
        },
        destroy: () => {
          c.destroyed = true;
        },
        on: (f: (s: { mode: string }) => void) => {
          fn = f;
          return () => {};
        },
      };
      made.push(c);
      return c;
    },
    log: (m) => logs.push(m),
    onStopped: () => stopped++,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++nid;
      timers.push({ fn, at: t + ms, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    quietMs: 30000,
    checkMs: 10000,
  });
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const n = timers[0];
      if (!n || n.at > end) break;
      timers.shift();
      t = n.at;
      n.fn();
    }
    t = end;
  };
  return { s, made, logs, advance, stopped: () => stopped };
}

describe('createSession', () => {
  it('pausa aperta e nessuna playlist per oltre 30 s: controller fermato con una riga di log, senza timer che restano', () => {
    const { s, made, logs, advance, stopped } = setup();
    s.process('M', { kind: 'master', url: 'u' });
    s.process('T', { kind: 'media', url: 'u' });
    made[0].emit('alt'); // pausa aperta
    advance(25000);
    expect(made[0].destroyed).toBe(false);
    advance(20000);
    expect(made[0].destroyed).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('senza playlist');
    expect(stopped()).toBe(1);
    advance(120000);
    expect(logs).toHaveLength(1);
  });

  it('una playlist che arriva dopo lo stop crea un nuovo controller che riceve prima l\'ultima master', () => {
    const { s, made, advance } = setup();
    s.process('M', { kind: 'master', url: 'u' });
    made[0].emit('alt');
    advance(60000);
    expect(made[0].destroyed).toBe(true);
    expect(s.process('T2', { kind: 'media', url: 'u' })).toBe('T2');
    expect(made).toHaveLength(2);
    expect(made[1].seen).toEqual(['master', 'media']);
  });

  it('ritorno a idle o playlist regolari: nessuno stop', () => {
    const { s, made, advance, logs } = setup();
    s.process('M', { kind: 'master', url: 'u' });
    made[0].emit('alt');
    for (let i = 0; i < 20; i++) {
      advance(5000);
      s.process('T', { kind: 'media', url: 'u' });
    }
    made[0].emit('idle');
    advance(200000);
    expect(made[0].destroyed).toBe(false);
    expect(logs).toHaveLength(0);
  });
});
