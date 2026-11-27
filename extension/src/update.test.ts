import { describe, expect, it } from 'vitest';
import { BADGE_TEXT, CHECK_INTERVAL_MS, compareVersions, isCheckDue, isUpdateAvailable, latestFromRelease, parseVersion, viewFor } from './update';

describe('parseVersion', () => {
  it('legge versioni puntate, con o senza v', () => {
    expect(parseVersion('0.1.4')).toEqual([0, 1, 4]);
    expect(parseVersion('v0.1.10')).toEqual([0, 1, 10]);
    expect(parseVersion(' V1.2 ')).toEqual([1, 2]);
  });
  it('rifiuta tutto il resto', () => {
    for (const bad of ['', 'v', '1..2', '1.2.x', '1.2.3-rc1', '1.2.3+b', 'latest', '1.2.3.4.5', '-1.0', null, undefined, 3, {}, ['1.0']]) expect(parseVersion(bad)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('confronta in modo numerico per componente', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.1.99')).toBe(1);
  });
  it('null se una delle due non e\' interpretabile', () => {
    expect(compareVersions('1.0.0', 'abc')).toBeNull();
    expect(compareVersions(undefined, '1.0.0')).toBeNull();
  });
});

describe('latestFromRelease', () => {
  it('legge e normalizza tag_name', () => {
    expect(latestFromRelease({ tag_name: 'v0.1.4', draft: false, prerelease: false })).toBe('0.1.4');
    expect(latestFromRelease({ tag_name: '0.2' })).toBe('0.2');
  });
  it('ignora bozze, prerelease e corpi inattesi', () => {
    expect(latestFromRelease({ tag_name: 'v0.1.4', prerelease: true })).toBeNull();
    expect(latestFromRelease({ tag_name: 'v0.1.4', draft: true })).toBeNull();
    expect(latestFromRelease({ tag_name: 'v0.1.4-beta' })).toBeNull();
    expect(latestFromRelease({ message: 'API rate limit exceeded' })).toBeNull();
    expect(latestFromRelease({ tag_name: 5 })).toBeNull();
    expect(latestFromRelease(null)).toBeNull();
    expect(latestFromRelease('v1.0.0')).toBeNull();
    expect(latestFromRelease([])).toBeNull();
  });
});

describe('isUpdateAvailable / viewFor', () => {
  it('solo se la piu\' recente e\' strettamente maggiore', () => {
    expect(isUpdateAvailable('0.1.3', '0.1.4')).toBe(true);
    expect(isUpdateAvailable('0.1.4', '0.1.4')).toBe(false);
    expect(isUpdateAvailable('0.1.4', '0.1.3')).toBe(false);
    expect(isUpdateAvailable('0.1.4', 'boh')).toBe(false);
    expect(isUpdateAvailable('0.1.4', null)).toBe(false);
  });
  it('badge e titolo con aggiornamento', () => {
    const v = viewFor('0.1.0', '0.1.3');
    expect(v.badgeText).toBe(BADGE_TEXT);
    expect(v.title).toContain('0.1.0');
    expect(v.title).toContain('0.1.3');
  });
  it('nessun badge se aggiornati, se la memorizzata e\' piu\' vecchia (dopo l\'aggiornamento) o senza dati', () => {
    expect(viewFor('0.1.4', '0.1.4')).toEqual({ badgeText: '', title: 'Twizen adblock 0.1.4' });
    expect(viewFor('0.1.4', '0.1.3').badgeText).toBe('');
    expect(viewFor('0.1.4', undefined).badgeText).toBe('');
  });
});

describe('isCheckDue', () => {
  const now = 1_000_000_000_000;
  it('dovuto senza controllo precedente o con valore inatteso', () => {
    expect(isCheckDue(now, undefined)).toBe(true);
    expect(isCheckDue(now, 'x')).toBe(true);
    expect(isCheckDue(now, NaN)).toBe(true);
  });
  it('dovuto se l\'orologio e\' tornato indietro', () => {
    expect(isCheckDue(now, now + 1000)).toBe(true);
  });
  it('non dovuto prima dell\'intervallo, dovuto dopo (con tolleranza per l\'allarme)', () => {
    expect(isCheckDue(now, now - 60_000)).toBe(false);
    expect(isCheckDue(now, now - 12 * 3600_000)).toBe(false);
    expect(isCheckDue(now, now - CHECK_INTERVAL_MS + 60_000)).toBe(true);
    expect(isCheckDue(now, now - CHECK_INTERVAL_MS)).toBe(true);
  });
});
