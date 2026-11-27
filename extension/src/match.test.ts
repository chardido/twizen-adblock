import { describe, expect, it } from 'vitest';
import { isPlayerWorker } from './match';

const IVS = "importScripts('https://assets.twitch.tv/assets/amazon-ivs-wasmworker.min-9e2e233d2a3a82ab632a.js')";

describe('isPlayerWorker', () => {
  it('blob del player IVS: si aggancia (anche con hash o host diversi)', () => {
    expect(isPlayerWorker('blob:https://www.twitch.tv/x', undefined, IVS)).toBe(true);
    expect(isPlayerWorker('blob:https://www.twitch.tv/x', {}, "importScripts('https://static.example/amazon-ivs-wasmworker.min-ffff.js')")).toBe(true);
  });

  it('blob non del player, o non leggibile: no', () => {
    expect(isPlayerWorker('blob:https://k.twitchcdn.net/x', undefined, 'onmessage=function(){postMessage(navigator.language)}')).toBe(false);
    expect(isPlayerWorker('blob:https://www.twitch.tv/x', undefined, null)).toBe(false);
  });

  it('worker module: mai, nemmeno se il nome corrisponde', () => {
    expect(isPlayerWorker('https://assets.twitch.tv/amazon-ivs-wasmworker.min-1.js', { type: 'module' }, null)).toBe(false);
  });

  it('URL semplice: solo se e\' lo script IVS', () => {
    expect(isPlayerWorker('https://assets.twitch.tv/assets/amazon-ivs-wasmworker.min-1.js', undefined, null)).toBe(true);
    expect(isPlayerWorker('https://assets.twitch.tv/assets/worker.js', undefined, null)).toBe(false);
  });
});
