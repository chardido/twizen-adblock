<div align="center">

# twizen-adblock

Keeps twitch.tv on the live stream during ad breaks. A small browser extension for Chrome and Firefox.

[![Latest release](https://img.shields.io/github/v/release/chardido/twizen-adblock?sort=semver)](https://github.com/chardido/twizen-adblock/releases/latest)
[![Licence: MIT](https://img.shields.io/github/license/chardido/twizen-adblock)](LICENSE)

<!-- Support button: add it on the line below this comment (one line, it will sit under the badges). -->

</div>

It does one thing: when twitch.tv inserts an ad break, the player is handed the same live stream without the break. There is no popup, no options page and no interface.

## Install

Download the file for your browser from the [latest release](https://github.com/chardido/twizen-adblock/releases/latest), then follow the steps for that browser.

| | Chrome | Firefox |
|---|---|---|
| Version | 111 or newer | 128 or newer |
| File to download | `twizen-adblock-chrome-v<version>.zip` | `twizen-adblock-firefox-v<version>.xpi` if the release has one, otherwise `twizen-adblock-firefox-v<version>.zip` |
| Stays installed after a restart | Yes, until you remove it | `.xpi`: intended to (not tested yet). `.zip`: no, it is removed when Firefox restarts |
| Updates | Manual: replace the folder with a newer release | Manual: install the newer file |

### Chrome

1. Download `twizen-adblock-chrome-v<version>.zip` from the latest release and unzip it. Keep the unzipped folder somewhere permanent: Chrome reads the extension from it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. Reload any open twitch.tv tab.

To update, download the new release, replace the contents of the folder, then press the reload button on the extension's card in `chrome://extensions`.

### Firefox

A release may include a `.xpi` signed by Mozilla. The release workflow attaches it when signing succeeds, so check the assets of the release: not every release has one, and this signing path has not been exercised yet.

**With a signed `.xpi`**

1. Download `twizen-adblock-firefox-v<version>.xpi` from the latest release.
2. Open it in Firefox (or drag it onto a Firefox window) and confirm the installation prompt.
3. Reload any open twitch.tv tab.

**Without a `.xpi` (the unsigned zip, as a temporary add-on)**

1. Download `twizen-adblock-firefox-v<version>.zip`. Do not unzip it.
2. Open `about:debugging#/runtime/this-firefox` and click **Load Temporary Add-on**.
3. Select the zip.
4. Allow access to twitch.tv in the add-on's permissions and reload any open twitch.tv tab.

The zip is unsigned, so Firefox only accepts it as a temporary add-on. It is removed when Firefox restarts and has to be loaded again.

## Is it working

Open the browser console (F12) on a twitch.tv channel page. You should see lines like these (the text is in Italian, and `xyz` is a short random tag that tells the player's workers apart):

```
[twizen-adblock] worker agganciato: blob:https://www.twitch.tv/...
[twizen-adblock] [xyz] gancio attivo nel worker
[twizen-adblock] [xyz] master ricevuta per <channel>
```

When an ad break starts and is handled:

```
[twizen-adblock] [xyz] pausa pubblicitaria rilevata (PREROLL, 30 s)
[twizen-adblock] [xyz] sorgente pulita ps4: 6 varianti
[twizen-adblock] [xyz] pausa pubblicitaria: live da sorgente pulita 27 s
[twizen-adblock] [xyz] pausa pubblicitaria terminata
```

The `pausa pubblicitaria:` line is a single total written when the break ends. Chrome's console folds identical consecutive lines into one with a counter.

`ATTENZIONE: playlist con pubblicita' consegnata al player` means an ad playlist reached the player despite the extension. It is worth reporting with the surrounding lines.

## What to expect during a break

| Break | What happens |
|---|---|
| Pre-roll (start of a session) | The live stream plays at the normal quality. |
| Mid-roll | The live stream plays at 360p for the length of the break, then returns to normal quality. |

## Known limits

- Pre-rolls were checked on real channels in both Chrome and Firefox. Real mid-rolls have been seen handled in both browsers, but only a few times.
- In Firefox, one real mid-roll showed 1 to 2 seconds of the ad video at the start of the break before the live stream came back. A likely cause is described under How it works; that link was not confirmed in a browser, and it is not fixed.
- Only live streams are handled. Ads in VODs and replays are not, including the recording Twitch autoplays when a channel goes offline.
- Embedded players on other sites have not been tested.
- It conflicts with other scripts or extensions that also wrap `Worker` on twitch.tv.
- With DevTools open, Twitch's integrity check can fail logins and some requests. This happens with or without the extension.
- Twitch can change playlist formats or request rules at any time and break this without notice.

## How it works

The extension runs a script in the page at document start. twitch.tv plays video with the Amazon IVS player, which downloads its playlists from a Web Worker. The script wraps `window.Worker` and, for the IVS player worker only, puts a small hook in front of the original worker code. The hook wraps `fetch` inside the worker and inspects the HLS playlists. When a playlist contains a stitched ad break, it requests the same live stream again in a form Twitch serves without the break (anonymous, no cookies, no account) and hands the player that playlist instead, renumbered so the player sees a continuous stream. Playlists without ads are passed through untouched.

The low-latency playlists Twitch serves also list the next segments to fetch (`#EXT-X-TWITCH-PREFETCH`). Around the start of some breaks, those lines already point at the first ad segments, before any playlist shows the break. The extension has no earlier signal to act on, so a player that fetches those segments can briefly show the ad. Removing the prefetch lines would avoid it but would also give up the low-latency fetching for every playlist, so it is not done.

## Build from source

Requires Node.js and npm. For a reproducible build (what the release workflow and a source review use, with Node 24 and the committed lockfile):

```
npm ci
npm run build
```

This produces `extension/dist/chrome` and `extension/dist/firefox`, each a loadable unpacked extension. `npm test` runs the tests.

## Maintenance

`src/net/adConfig.ts` holds everything specific to Twitch (ad signals, request shapes, tuning). `extension/src/match.ts` decides which worker is hooked. `npm run check -- <channel> [...]` runs a live check in a visible browser window with a throwaway profile (it needs Google Chrome installed; `--browser=firefox` uses an installed Firefox) and prints a verdict per channel. If the video plays but the hook never attaches, it reports a failure.

## Disclaimer

This is a personal project. It is not affiliated with or endorsed by Twitch, and using it may violate Twitch's terms of service. Use it at your own risk. The ad-handling core is shared with another personal project.

## Licence

MIT, see [LICENSE](LICENSE).
