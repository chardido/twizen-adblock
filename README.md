# twizen-adblock

A small browser extension for twitch.tv (Chrome and Firefox, Manifest V3). During an ad break it keeps the player on the live stream instead of the ad.

It does nothing else: no popup, no options, no UI, no filtering of other content.

## Install from source

Requires Node.js and npm.

```
npm install
npm run build
```

This produces two unpacked extensions: `extension/dist/chrome` and `extension/dist/firefox`.

**Chrome (111 or newer):** open `chrome://extensions`, enable Developer mode, choose "Load unpacked" and select `extension/dist/chrome`. Reload any open twitch.tv tab.

**Firefox (128 or newer):** open `about:debugging#/runtime/this-firefox`, choose "Load Temporary Add-on" and select `extension/dist/firefox/manifest.json`. Allow access to twitch.tv in the add-on's permissions and reload the tab. A temporary add-on is removed when Firefox restarts, so this has to be repeated each session.

## How it works

The extension runs a script in the page at document start. twitch.tv plays video with the Amazon IVS player, which downloads its playlists from a Web Worker. The script wraps `window.Worker` and, for the IVS player worker only, puts a small hook in front of the original worker code. The hook wraps `fetch` inside the worker and inspects the HLS playlists. When a playlist contains a stitched ad break, it requests the same live stream again with a different request shape that Twitch serves without the break (anonymous, no cookies, no account) and hands the player that playlist instead, renumbered so the player sees a continuous stream. Playlists without ads are passed through untouched.

## Is it working

Open the browser console on a twitch.tv channel page. You should see:

```
[twizen-adblock] worker agganciato: blob:...
[twizen-adblock] [xxx] gancio attivo nel worker
```

During a break:

```
[twizen-adblock] [xxx] pausa pubblicitaria rilevata (PREROLL, 30 s)
[twizen-adblock] [xxx] sorgente pulita ps4: 6 varianti
...
[twizen-adblock] [xxx] pausa pubblicitaria terminata
```

The messages are in Italian.

## Known limits

- Pre-rolls were verified on several real channels in Chrome. Mid-rolls were seen on very few real samples; during a mid-roll the stream drops to 360p for the length of the break, because only that request shape stays ad-free.
- The Firefox build has not been tested.
- Embedded players on other sites have not been tested.
- Twitch can change playlist formats or request rules at any time and break this without notice.
- It conflicts with other scripts or extensions that also wrap `Worker` on twitch.tv.
- Twitch's integrity check can fail logins and some requests while DevTools is open. This happens with or without the extension.

## Maintenance

`src/net/adConfig.ts` holds everything specific to Twitch (ad signals, request shapes, tuning). `extension/src/match.ts` decides which worker is hooked. `npm run check -- <channel> [...]` runs a live check in a visible Chrome window with a throwaway profile (it needs Google Chrome installed) and prints a verdict per channel. If the video plays but the hook never attaches, it reports a failure.

## Disclaimer

This is a personal project. It is not affiliated with or endorsed by Twitch, and using it may violate Twitch's terms of service. Use it at your own risk. The ad-handling core is shared with another personal project.

## Licence

MIT, see `LICENSE`.
