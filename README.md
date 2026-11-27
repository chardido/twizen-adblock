<div align="center">

# twizen-adblock

Keeps twitch.tv on the live stream during ad breaks. A small browser extension for Chrome and Firefox.

[![Latest release](https://img.shields.io/github/v/release/chardido/twizen-adblock?sort=semver)](https://github.com/chardido/twizen-adblock/releases/latest)
[![Licence: MIT](https://img.shields.io/github/license/chardido/twizen-adblock)](LICENSE)

</div>

It does one thing: when twitch.tv inserts an ad break, the player is handed the same live stream without the break. There is no popup, no options page and no page interface. On Chrome the toolbar icon only tells you when a newer release exists (see [Updates](#updates)).

## Install

Download the file for your browser from the [latest release](https://github.com/chardido/twizen-adblock/releases/latest), then follow the steps for that browser.

| | Chrome | Firefox |
|---|---|---|
| Version | 111 or newer | 128 or newer |
| File to download | `twizen-adblock-chrome-v<version>.zip` | `twizen-adblock-firefox-v<version>.xpi` |
| Stays installed after a restart | Yes, until you remove it | Yes, until you remove it |
| Updates | Manual, with a badge on the toolbar icon when a newer release exists | Automatic (from 0.1.4) |

### Chrome

1. Download `twizen-adblock-chrome-v<version>.zip` from the latest release and unzip it. Keep the unzipped folder somewhere permanent: Chrome reads the extension from it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. Reload any open twitch.tv tab.

To update, see [Updates](#updates).

### Firefox

1. Download `twizen-adblock-firefox-v<version>.xpi` from the latest release.
2. Open it in Firefox (or drag it onto a Firefox window) and confirm the installation prompt.
3. Reload any open twitch.tv tab.

The `.xpi` is signed by Mozilla (unlisted, self-distributed) and installs as a regular add-on that stays installed across restarts. It updates itself, see [Updates](#updates).

If a release has no `.xpi` (for example because signing did not complete), it carries the unsigned `twizen-adblock-firefox-v<version>.zip` instead. Do not unzip it: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and select the zip. It is removed when Firefox restarts and does not update itself.

## Updates

**Firefox.** From 0.1.4 on, the signed `.xpi` updates itself: its manifest points to an update file attached to each release, and Firefox checks it about once a day and installs a newer signed version without asking you to do anything. If you have 0.1.3 or earlier, install 0.1.4 by hand once; those versions do not look for updates. If a release has no signed `.xpi` yet, Firefox simply finds nothing new and tries again later. The unsigned zip never updates.

**Chrome.** An unpacked extension cannot update itself, so the update stays manual. About once a day the extension asks GitHub whether a newer release exists. If one does, a small `NEW` badge appears on the toolbar icon and the icon's tooltip names the installed and the available version. Clicking the icon always opens the [latest release page](https://github.com/chardido/twizen-adblock/releases/latest). To update, download the new zip, replace the contents of your extension folder with it, then press the reload button on the extension's card in `chrome://extensions`. The badge goes away on its own once the running version is the latest one. If the check fails (offline, GitHub rate limit, unexpected answer) nothing is shown and it is tried again at the next scheduled check.

## Privacy

- Chrome: the extension makes one request about every 24 hours to `https://api.github.com/repos/chardido/twizen-adblock/releases/latest`. It is sent without cookies and with only the headers Chrome adds to any request (such as the user agent and language), no identifier of its own, and nothing about you, your browsing or your Twitch use is included. Like any request it reveals your IP address to GitHub, and Chrome adds the extension's origin (`chrome-extension://<id>`; for an unpacked extension the id is derived from the folder path). The answer is read for the version number only; the extension stores the time of the last check and the latest version it saw, in its own local storage. It asks for the `alarms` permission (the daily schedule) and the `storage` permission (those two values) and for no site access beyond twitch.tv.
- Firefox: the extension itself makes no requests. Firefox, as part of its normal add-on update check, fetches `https://github.com/chardido/twizen-adblock/releases/latest/download/updates.json` about once a day, and downloads the new `.xpi` from GitHub when there is one. Both are requests to GitHub from your browser, like any download, and reveal your IP address to it.
- Nothing is sent to any other server. The extension has no analytics and no account.

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
- In Firefox, one real mid-roll (0.1.1) showed 1 to 2 seconds of the ad video at the start of the break before the live stream came back. From 0.1.3 the extension withholds the prefetch entries that point at the start of an announced break, and prefetch entries whose URL has a different shape from the live ones (see How it works). That second rule is a heuristic based on a handful of captured breaks; whether it removes the flash in practice has not been confirmed.
- In Firefox, one report of the video staying on "loading" after a break could not be reproduced. During real mid-rolls twitch.tv was seen opening a second playback session for the same channel; the extension keeps both.
- Only live streams are handled. Ads in VODs and replays are not, including the recording Twitch autoplays when a channel goes offline.
- Embedded players on other sites have not been tested.
- It conflicts with other scripts or extensions that also wrap `Worker` on twitch.tv.
- With DevTools open, Twitch's integrity check can fail logins and some requests. This happens with or without the extension.
- Twitch can change playlist formats or request rules at any time and break this without notice.

## How it works

The extension runs a script in the page at document start. twitch.tv plays video with the Amazon IVS player, which downloads its playlists from a Web Worker. The script wraps `window.Worker` and, for the IVS player worker only, puts a small hook in front of the original worker code. The hook wraps `fetch` inside the worker and inspects the HLS playlists. When a playlist contains a stitched ad break, it requests the same live stream again in a form Twitch serves without the break (anonymous, no cookies, no account) and hands the player that playlist instead, renumbered so the player sees a continuous stream. Playlists without ads are passed through untouched.

The low-latency playlists Twitch serves also list the next segments to fetch (`#EXT-X-TWITCH-PREFETCH`). Around the start of some breaks, those lines already point at the first ad segments before any playlist shows the break. The extension withholds a prefetch line in two cases: when an ad break is already announced in the playlist and the line falls at or after the announced start, and when the line's URL has a different shape from the prefetch lines it has seen turn into live segments (ad segment URLs were observed to have a shorter token). A wrongly withheld line only costs low-latency fetching for that poll.

When playback switches between the clean source and the original playlist, the extension marks a discontinuity at the boundary, because the two are different renditions.

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
