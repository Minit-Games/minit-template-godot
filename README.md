# Godot Minit Template

> **Learn page:** [Godot on Minit](https://minit.studio/docs/godot) — the official guide this template implements.

A complete, working Minit game in Godot 4, kept deliberately small so the parts
around it are easy to read. Tap the ball to bounce it; each tap scores. A
30 second clock ends the run and reports the result.

Start here, replace the game, keep the plumbing. There is a matching
`defold-minit` template with the same game.

```bash
tools/build.sh                     # Web export -> dist/web
tools/package.sh                   # regenerate assets, export, verify, zip for upload
tools/play.mjs dist/web            # run the build in a real browser and screenshot it
```

The SDK is `addons/minit/minit.gd`, registered as the `Minit` **autoload** in
`project.godot`. The docs' primary route is AssetLib plus enabling the plugin;
this is the documented standalone route, so a fresh clone works with no editor
step. Switch to the plugin if you want AssetLib to keep it updated.

## What the game shows you

| Where | What it demonstrates |
|---|---|
| `scripts/main.gd` → `_read_config()` | Config values, with defaults and clamping. Booleans follow the backend's coercion: anything but `"true"` is false. |
| `scripts/main.gd` → `_ready()` | `Minit.loading_done()` at the end, once the scene is built and placed. |
| `scripts/main.gd` → `_finish()` | `Minit.report_result()` **exactly once**, with `flavor_text`, a persisted `user_data`, and a `delay` so the outro is seen. |
| `scripts/main.gd` → `_ready()` | `Minit.get_user_data()` read back as the player's previous best. |
| `web/shell.html` | **Both** audio fixes. Read this before touching sound. |
| `scripts/main.gd` → `_layout()` | Everything measured from `get_viewport_rect().size`. |
| `meta.json` | The three config keys the game reads, plus store copy and credits. |

## Read this before you touch audio

Godot games have been shipped to Minit that were **audible in a browser and
completely silent in the app**. Three independent causes, all of which produce
that same symptom with nothing in the game able to detect it. `web/shell.html`
handles all three; the export preset points at it, and `tools/package.sh` fails
the build if any of it goes missing.

**0. The host's volume message never arrives (the root cause).** The app tells a
game its volume with `window.postMessage(payload, window.location.origin)`. On
iOS the game is served from `minitlocal://`, a custom scheme whose origin is
**opaque** -- so `location.origin` is the string `"null"`, and `postMessage`
does not fail soft with that, it **throws**. Every volume message is discarded,
and the only value the page ever sees is the seed baked into the injection at
mount time -- which is `0` for a drop mounted before it was scrolled into view.
The game is then healthy and permanently inaudible, and only a foreground
transition fixes it, because `__minitResumeAudio` is a direct call rather than a
postMessage. That is exactly the "silent until you background and come back"
symptom.

The shell repairs the channel rather than guessing the volume: a same-window
`postMessage` rejected for its target origin is retried with `'*'`, so the
host's own message arrives and its real intent flows through untouched --
**including a deliberate mute**. Verified both ways: host says 1 and the game is
audible, host says 0 and it is silent. Tracked app-side as DROP-8164; the shell
keeps working either way.

**1. AudioWorklet cannot load over the app's URL scheme.** Godot's web audio
driver loads two `AudioWorklet` modules at boot (the sibling
`*.audio.worklet.js` files). Over http(s) they load fine. Inside the app the
game is served from `minitlocal://`, a custom scheme a worklet module fetch
cannot reach: `addModule()` rejects, the driver never connects its output node,
and the game is silent. Godot never retries, and cannot be told to skip the
worklet — it calls `addModule()` unconditionally, so hiding the API throws
inside audio init instead of falling back to a `ScriptProcessorNode`. The shell
retries by fetching the module with the page's own `fetch()`, which the app's
scheme handler *does* serve, and handing the worklet a `blob:` URL.

**2. A suspended AudioContext.** Audio produced while the context is suspended
is dropped, so a loop started too early is simply lost. The shell resumes on any
gesture (capture phase), on visibility and focus changes, and on a watchdog; and
`main.gd` will not start the music until the context reports running.

**3. The host owns the output gain.** The app routes every game through a mute
gain it controls, seeded at zero and faded up. If that fade never lands the game
is entirely healthy and inaudible — only a foreground transition re-applies it,
which is why backgrounding the app and returning "fixes" it. The shell
re-applies *the host's own* target volume when the host says it wants sound
while the gain is still zero, and never touches it when the host has
deliberately muted or ducked the drop.

Godot exposes no handle on its `AudioContext`, so the shell wraps the
constructor to keep a registry at `window.__minitAudioContexts`. `main.gd` asks
that registry whether audio is running before starting the loop.

Verified together, against the app's real `injections/audio.ts`, with
`addModule` forced to reject for non-`blob:` URLs and the autoplay exemption
removed so the context starts suspended:

```
worklet loads rejected (simulating minitlocal://): 2
before any tap (should be silent): 0
after first tap on the ball     : 0.37296
context running, host mute gain 1.00
```

## Export settings that are not optional

- **`variant/thread_support=false`.** A threaded build needs COOP/COEP
  cross-origin isolation headers, which the Minit host does not send — with
  threads on the game does not boot at all. Pre-flight checks the flag the
  loader itself reads (`GODOT_THREADS_ENABLED`), not the string
  `SharedArrayBuffer`, which appears in `index.js` either way.
- **`html/canvas_resize_policy=2`** (Adaptive), so the canvas backing store
  follows the host frame at whatever size and aspect it is given.
- **`progressive_web_app/enabled=false`.** Games run embedded, never installed.
- **`html/custom_html_shell="res://web/shell.html"`** — this is what carries the
  audio fixes.

## Layout: no design surface

`window/stretch/mode="canvas_items"` with `aspect="expand"` against 390×844
means exactly **one** axis lands on its design value and the other is larger. So
treat both numbers as floors, never as a surface to draw to, and read
`get_viewport_rect().size` live — which is what `_layout()` does.

This matters because the Minit app's game slot is roughly **2:3**, far wider
relative to its height than a phone screen, because the game sits between the
app's header and its toolbar. A game drawn to a fixed design width paints a
fraction of that slot and leaves a band down one side, and you cannot see it in
a desktop browser at a phone viewport. Check both:
`tools/play.mjs dist/web --w 600 --h 900 --dpr 2`.

## A note on size

The bundle is **~10 MB zipped**, nearly all of it Godot's 39 MB WebAssembly
runtime. That is over Minit's 5 MB recommendation and far under its 50 MB limit,
and there is little to do about it short of a custom size-optimised engine
build — the game's own content here is under 0.5 MB. Worth knowing when choosing
an engine: the Defold template of the same game is 1.5 MB.

## Cloning: this repo uses Git LFS

Art, audio and fonts are tracked with [Git LFS](https://git-lfs.com). Install it
once (`git lfs install`) before cloning, or the asset files arrive as small text
pointers and the build produces a game with no textures and no sound.

Already cloned without it? `git lfs install && git lfs checkout` fixes the
working tree in place.

Why, when the assets here are only ~540 KB: they are **generated**
(`tools/gen-*.mjs`), and regenerating them is the normal workflow. Git stores a
whole new blob for a compressed format every time, so without LFS the history
would grow by the full asset size on every palette or synthesis tweak. It also
sets the pattern before a fork commits a real sprite sheet. Note the remote you
push to must support LFS.

Only genuinely binary formats are tracked. Defold's `.atlas` / `.collection` /
`.go` / `.font` and Godot's `.tscn` / `.tres` / `.import` are text and stay out
of LFS, so they keep diffing and merging normally.

## Assets

No binary art or audio is authored by hand. `tools/gen-art.mjs` rasterises every
sprite from signed distance fields and `tools/gen-audio.mjs` synthesises the
effects; Godot imports them on its next run. Replace either wholesale when you
bring your own — only the file names matter.

The background music is the one third-party asset: a CC0 chiptune, converted by
`tools/gen-music.mjs` from 2.0 MB of 44.1 kHz stereo to 0.35 MB of 16 kHz mono.
It is a plain WAV, so looping is set in `_ready()` rather than in an import
preset — note `loop_end` is in **frames**, not bytes. That script also checks
whether the loop point is genuinely seamless before "fixing" it; this track's
is, so it is left exactly as the author wrote it. See `THIRD-PARTY-NOTICES.txt`.

## Testing

`tools/play.mjs` drives the actual export in Chrome over CDP with **no npm
dependencies** (Node 22 ships a global `WebSocket`). It taps, samples frame
timing from inside the page, and captures console output and screenshots.

Audio cannot be heard from a headless browser, but it can be measured: splice an
`AnalyserNode` between the host's `_muteGain` and its `_trueDestination` and you
are measuring what would actually reach the speaker. To reproduce the app,
launch Chrome **without** `--autoplay-policy=no-user-gesture-required`
(`tools/cdp.mjs` takes `autoplay: false`) so the context starts suspended.

## Shipping

`tools/package.sh` regenerates every asset, exports release, validates
`meta.json`, and writes `dist/godot-minit-template.zip` with `index.html`,
`meta.json` and the notices at the archive root. Pre-flight refuses a bundle
that has lost either audio fix, is threaded, is missing the Adaptive canvas
policy, contains project sources, or is over Minit's 50 MB limit.

Then, from the `minits` tooling repo:

```bash
npm run createProject godot-minit/dist/godot-minit-template.zip --dry-run
```
