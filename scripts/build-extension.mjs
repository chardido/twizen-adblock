// Costruisce l'estensione (Chrome e Firefox) in extension/dist/{chrome,firefox}: ognuna e' caricabile "unpacked".
// Due passaggi con il Vite installato: 1) il gancio del worker come stringa classica, 2) lo script di pagina che lo incorpora.
import { build } from 'vite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'extension', 'dist');
const tmp = resolve(out, '.tmp');
// versione dell'estensione: una sola fonte, il package.json del repo pubblico. Nel repo privato e' il template
// extension/public/package.json (il package.json della radice e' quello dell'app TV), nel repo esportato e' ./package.json
const tpl = resolve(root, 'extension', 'public', 'package.json');
const pkg = JSON.parse(readFileSync(existsSync(tpl) ? tpl : resolve(root, 'package.json'), 'utf8'));

async function bundle(entry, name, outDir, define = {}) {
  await build({
    configFile: false,
    logLevel: 'warn',
    root,
    mode: 'production',
    define,
    build: {
      target: 'es2022',
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      lib: { entry: resolve(root, entry), name: 'twizenBundle', formats: ['iife'], fileName: () => `${name}.js` },
    },
  });
  return readFileSync(resolve(outDir, `${name}.js`), 'utf8');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const hook = await bundle('extension/src/workerHook.ts', 'worker-hook', tmp);
const page = await bundle('extension/src/page.ts', 'twizen-adblock', tmp, { __WORKER_HOOK_SOURCE__: JSON.stringify(hook) });
// service worker dell'avviso di aggiornamento: solo Chrome (Firefox si aggiorna da solo tramite update_url)
const background = await bundle('extension/src/background.ts', 'background', tmp);

const base = {
  manifest_version: 3,
  name: 'Twizen adblock',
  version: pkg.version,
  description: 'Su twitch.tv resta sul live durante le pause pubblicitarie (uso personale).',
  icons: { 128: 'icon.png' },
  content_scripts: [{ matches: ['*://*.twitch.tv/*'], js: ['twizen-adblock.js'], run_at: 'document_start', world: 'MAIN', all_frames: true }],
};
const manifests = {
  // alarms: controllo ogni 24 h; storage: ultimo controllo e ultima versione nota. Niente host_permissions: l'API GitHub risponde con CORS aperto
  chrome: {
    ...base,
    minimum_chrome_version: '111',
    permissions: ['alarms', 'storage'],
    background: { service_worker: 'background.js' },
    action: { default_icon: 'icon.png', default_title: 'Twizen adblock' },
  },
  // Firefox MV3: i content script dichiarati richiedono il permesso sull'host (Chrome no, gira nell'origine della pagina)
  // update_url: Firefox controlla da solo ogni 24 h; il file e' un asset della Release (workflow sign-firefox), non un commit nel repo
  firefox: {
    ...base,
    host_permissions: ['*://*.twitch.tv/*'],
    browser_specific_settings: {
      gecko: {
        id: 'twizen-adblock@chardido.github.io',
        strict_min_version: '128.0',
        update_url: 'https://github.com/chardido/twizen-adblock/releases/latest/download/updates.json',
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
};
for (const [target, manifest] of Object.entries(manifests)) {
  const dir = resolve(out, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'twizen-adblock.js'), page);
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (target === 'chrome') writeFileSync(resolve(dir, 'background.js'), background);
  copyFileSync(resolve(root, 'extension', 'icon.png'), resolve(dir, 'icon.png'));
  console.log('estensione', target, '->', dir);
}
rmSync(tmp, { recursive: true, force: true });
