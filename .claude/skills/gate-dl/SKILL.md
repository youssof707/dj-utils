---
name: gate-dl
description: Download free tracks from SoundCloud download gates (Hypeddit, etc.) into ./store with gate-dl/download.mjs, and babysit it — when the script fails, diagnose, fix or add the gate utility, and rerun until the file is saved. Use when the user runs /gate-dl <soundcloud url> [more urls], or asks to grab/download a SoundCloud free download.
---

# /gate-dl

You own a self-healing downloader. The user should never have to think about it: every URL ends with a verified audio file in `./store`, or with a real blocker explained in one line. When the script fails, the fix goes into the script, so the next run of the same kind of gate just works.

## The system (repo root = this project)

- `gate-dl/download.mjs <url> [--force] [--no-actions] [--gate-url <url>]` is the entry point. A playlist URL (`/sets/`) runs every track as its own child run: one JSON line per track, then a summary line. Tracks that performed actions are spaced `PLAYLIST_GAP_MS` apart, and the batch stops on `CAPTCHA`. Fix failed tracks one by one, then rerun the playlist; tracks that are already done return straight away. It runs these steps:
  1. Launches or reuses a **headless** Chrome (port 9333, profile `~/.claude-browser/soundcloud`, already logged in to SoundCloud). Any non-headless Chrome on that port gets killed and relaunched headless. Never launch a visible browser to debug: probe with `tools/cdp.mjs shot` and read the PNG.
  2. Resolves the track through SoundCloud api-v2.
  3. Uses SoundCloud's native download if it's enabled.
  4. Otherwise finds gate links in `purchase_url` and the description.
  5. Does the real follow/like/repost/comment through the API. These are idempotent, and it never posts a second comment.
  6. Runs the matching gate utility.
  7. Downloads the file and verifies it (magic bytes, size).
- **Success:** exit 0 and one JSON line `{"ok":true,"file":…}`. Every successful download is recorded in `~/Library/Application Support/gate-dl/data/downloads.json` (`gate-dl/downloadsStore.ts`, keyed by normalized track URL, also matched by SoundCloud id). A recorded track is skipped and returns `"already":true` straight away, and in a playlist it never spawns a run. Failures are not recorded there. Use `--force` to redo it.
- **Failure:** exit 2, a banner on stderr, and evidence in `gate-dl/runs/<id>/`: `failure.json` (code, step, message, details, state, step history), `screenshot.png`, `page.html`, `network.json` (with XHR bodies) and `console.json`. The failing tab stays open for probing.
- `gate-dl/gates/` holds one file per gate, registered in `gates/index.mjs`. `_template.mjs` documents the `run(ctx)` contract.
- `gate-dl/tools/cdp.mjs` probes the same Chrome: `tabs`, `open`, `nav`, `eval`, `shot`, `click <css>`, `clickxy`, `type`, `enter`, `net`, `hide`, `close`. Select a tab with `TAB=<id or url part>`.
- Core libs: `lib/cdp.mjs` (CDP client and Page helpers), `lib/soundcloud.mjs`, `lib/fetchfile.mjs`, `lib/browser.mjs`, `lib/fail.mjs` (error codes).

## Loop, per URL (one at a time)

1. Run `node gate-dl/download.mjs '<url>'` with a 300000 ms Bash timeout.
2. **Exit 0:** note the file and move on.
3. **Exit 2:** read `failure.json` and look at `screenshot.png`, then act on the code:
   - `UNKNOWN_GATE`: find out what the gate is.
     - Open the candidate URL with `tools/cdp.mjs open`, then `shot` and `eval`.
     - If it's a real download gate or a direct file host, copy `gates/_template.mjs` to `gates/<name>.mjs`, implement it and register it.
     - If the link isn't a download at all (artist site, Spotify, merch), check whether the track has its download elsewhere. Otherwise report "no free download" as a blocker.
   - `GATE_CHANGED` or `GATE_FAILED`: the gate's page or flow changed.
     - Probe the live tab: `TAB=<host> node gate-dl/tools/cdp.mjs shot|eval|click`.
     - Read `network.json` for the unlock request and its response.
     - Fix the gate file.
   - `NO_GATE_FOUND`: look at the track page screenshot or the description.
     - If the link lives somewhere the script doesn't look (comments, the artist's pinned links, a link in the artist bio), extend `SoundCloud.candidateLinks()`.
   - `NOT_LOGGED_IN`: the SoundCloud session has expired. Stop and tell the user they need to sign in once. Only after they say they're ready, run `node gate-dl/tools/cdp.mjs close` and open a visible window with `open -na "Google Chrome" --args --user-data-dir=$HOME/.claude-browser/soundcloud`. When they're done, quit it: `pkill -f claude-browser/soundcloud`. The next script run relaunches headless. This is the ONLY time a window may ever appear.
   - `CAPTCHA`: SoundCloud's DataDome flagged the session and every write (follow/like/repost/comment) returns a captcha. Don't retry in a loop, which only makes it worse. Stop the batch and tell the user. Playlist mode already stops on its own. Never solve it in a visible window without asking.
   - `SC_ACTION`, `TRACK`, `DOWNLOAD`, `BAD_FILE`, `BROWSER`, `TIMEOUT`, `INTERNAL`: fix the core lib that owns it.
4. Rerun the same URL. Repeat until it gives exit 0.
5. **After any code change,** rerun one earlier successful URL from `runs.jsonl` with `--force --no-actions` to catch regressions. Fix anything that breaks.
6. **Give up only on a real blocker:**
   - the gate needs payment;
   - it needs an email confirmation link;
   - it needs a login you don't have (Instagram, Spotify, YouTube, X) and has no SoundCloud option;
   - it's a captcha you can't pass;
   - the gate has been removed.

   Report it in one line, including the URL and the code.

## Rules for fixes

- The fix lives in the script. Never download a file by hand, curl a URL you found while probing, or move files into `./store` yourself as a substitute.
- Keep it loud. On anything unexpected, `fail(CODES.X, message, details)`, with details that would let the next agent fix it without re-probing. Don't use broad try/catch, silent fallbacks, or "best effort" success.
- Find elements with selectors, text or hit tests. Never hard-code coordinates or fixed sleeps as the only wait: wait on a condition (`page.waitFor`, `page.waitVisible`, `page.waitResponse`).
- Clicks that a gate checks for `event.isTrusted` must go through `page.click()` (a CDP mouse event). `page.click` brings the tab to the front first: background tabs drop input.
- Stacked carousels or modals: "has a size" doesn't mean visible. Use a hit test (`document.elementFromPoint`), as `gates/hypeddit.mjs` does.
- Strip or neutralise popup openers. Popups are pushed off-screen automatically, but don't rely on that.
- Use Hypeddit-style platform pickers: prefer SoundCloud, because those actions are done for real by `lib/soundcloud.mjs`. Add other platforms only when a gate offers no SoundCloud path.
- Write what you learn about a gate into the header comment of its gate file: how the page works, the traps, and the date you verified it. That comment is the memory for the next fix.
- Never change `STORE_DIR`, the comment phrases, or which SoundCloud actions are enabled unless the user asks.
- Delete the `gate-dl/runs/<id>/` evidence dirs for failures you have fixed. Keep `runs.jsonl`.

## Report

For each URL, give one line: `✓ <file name> (gate)` or `✗ <url>: <code> (<one-line blocker>)`. Then list any gate utilities you added or changed, one line each. Nothing else.
