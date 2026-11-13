#!/usr/bin/env node
// gate-dl: SoundCloud track URL -> free download saved in ./store.
//
//   node gate-dl/download.mjs <soundcloud track url> [--no-actions] [--force] [--gate-url <url>]
//
//   --no-actions   skip follow/like/repost/comment on SoundCloud
//   --force        download again even if it's recorded as downloaded
//
// Every successful download is recorded in ~/Library/Application Support/gate-dl/data/downloads.json
// (gate-dl/downloadsStore.ts). A track recorded there is skipped ({"ok":true,"already":true}), in playlists too.
//   --gate-url     skip link discovery and use this gate URL
//
// Success: exit 0, one JSON line on stdout: {"ok":true,"file":…,"gate":…,…}
// Failure: exit 2, loud banner on stderr, evidence in gate-dl/runs/<run id>/
//          (failure.json, screenshot.png, page.html, network.json, console.json).
//          The failing gate tab is left open in the hidden Chrome so it can be probed with
//          TAB=<url part> node gate-dl/tools/cdp.mjs …
// Built to be run and repaired by Claude Code: see .claude/skills/gate-dl/SKILL.md.

import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR, STORE_DIR, RUN_TIMEOUT_MS, PLAYLIST_GAP_MS } from './config.mjs';
import * as cfg from './config.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { sleep } from './lib/cdp.mjs';
import { SoundCloud } from './lib/soundcloud.mjs';
import { fetchToStore, verifyAudio, sanitize, unpackZip } from './lib/fetchfile.mjs';
import { GateDlError, fail, CODES, step, progress } from './lib/fail.mjs';
import { GATES, findGate } from './gates/index.mjs';
import { downloaded, markDownloaded } from './downloadsStore.ts';

const argv = process.argv.slice(2);
const flag = f => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = f => { const i = argv.indexOf(f); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const noActions = flag('--no-actions');
const force = flag('--force');
const gateUrlOverride = opt('--gate-url');
const trackUrl = argv[0];

if (!trackUrl || !/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//.test(trackUrl)) {
  console.error('usage: node gate-dl/download.mjs <soundcloud track or playlist url> [--no-actions] [--force] [--gate-url <url>]');
  process.exit(1);
}

// Playlist mode: resolve the set, then run this script once per track (each in its own
// process, so every track gets its own run dir, evidence and timeout). One failing track
// doesn't stop the rest. Prints one JSON line per track, then a summary line.
// Stops the batch on CAPTCHA (every later write would hit it too).
// Exit 0 only if every track succeeded; otherwise 2 (failed tracks have runs/<id>/ evidence).
if (/soundcloud\.com\/[^/]+\/sets\//.test(trackUrl)) {
  if (gateUrlOverride) { console.error('--gate-url cannot be used with a playlist'); process.exit(1); }
  const { spawnSync } = await import('node:child_process');
  let tracks;
  try {
    const b = await launchBrowser();
    const p = await b.newPage();
    tracks = await new SoundCloud(p).playlistTracks(trackUrl);
    await p.close(); b.disconnect();
  } catch (e) {
    process.stderr.write(`\n██ GATE-DL PLAYLIST FAILED  code=${e.code || CODES.INTERNAL}  ${e.message}\n██ ${trackUrl}\n${e.details ? JSON.stringify(e.details).slice(0, 2000) + '\n' : ''}`);
    process.exit(2);
  }
  process.stderr.write(`[gate-dl] playlist: ${tracks.length} tracks\n`);
  const results = [];
  const ledgerFile = path.join(RUNS_DIR, 'runs.jsonl');
  let lastActed = 0, captcha = null;
  for (const [i, t] of tracks.entries()) {
    const prev = !force && downloaded(t.url, t.id);
    if (prev) { const res = { ok: true, file: prev.files?.[0], files: prev.files, gate: prev.gate, already: true, trackUrl: t.url, title: t.title }; results.push(res); console.log(JSON.stringify(res)); continue; }
    if (captcha) { const res = { ok: false, trackUrl: t.url, title: t.title, skipped: 'CAPTCHA earlier in batch' }; results.push(res); console.log(JSON.stringify(res)); continue; }
    // Bursts of SoundCloud writes get the session DataDome-flagged: space tracks out.
    const wait = lastActed + PLAYLIST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    process.stderr.write(`[gate-dl] ── track ${i + 1}/${tracks.length}: ${t.title}  ${t.url}\n`);
    const args = [process.argv[1], t.url, ...(force ? ['--force'] : []), ...(noActions ? ['--no-actions'] : [])];
    const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: RUN_TIMEOUT_MS + 60000 });
    let out = null;
    try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
    const last = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).reverse().find(l => l?.trackUrl === t.url) : null;
    const res = r.status === 0 && out?.ok ? { ...out, trackUrl: t.url } : { ok: false, trackUrl: t.url, title: t.title, exit: r.status ?? r.signal, code: last?.code, runDir: last?.runDir };
    if (res.code === CODES.CAPTCHA) captcha = res;
    if (!out?.already) lastActed = Date.now();
    results.push(res);
    console.log(JSON.stringify(res));
  }
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ playlist: trackUrl, total: results.length, ok: results.length - failed.length, failed: failed.map(f => ({ url: f.trackUrl, code: f.code || f.skipped })) }));
  process.exit(failed.length ? 2 : 0);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(RUNS_DIR, runId);
fs.mkdirSync(runDir, { recursive: true });
const ledger = path.join(RUNS_DIR, 'runs.jsonl');
const started = Date.now();

let browser, scPage, gatePage, sc;
const state = { trackUrl, candidates: [], gate: null, gateUrl: null, actions: null };

function record(entry) {
  fs.appendFileSync(ledger, JSON.stringify({ runId, t: new Date().toISOString(), secs: Math.round((Date.now() - started) / 1000), trackUrl, ...entry }) + '\n');
}

// Chrome-side download capture for gates that only work via a real browser download.
async function browserDownload(trigger, { timeoutMs = 120000 } = {}) {
  const dir = path.join(runDir, 'browser-downloads');
  fs.mkdirSync(dir, { recursive: true });
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
  try {
    const begin = browser.waitEvent(m => m.method === 'Browser.downloadWillBegin', timeoutMs, 'a browser download to start');
    await trigger();
    const { params: b } = await begin;
    const done = await browser.waitEvent(m => m.method === 'Browser.downloadProgress' && m.params.guid === b.guid && m.params.state !== 'inProgress', timeoutMs, 'the browser download to finish');
    if (done.params.state !== 'completed') fail(CODES.DOWNLOAD, `browser download ${done.params.state}`, { url: b.url });
    const file = path.join(dir, sanitize(b.suggestedFilename || 'track'));
    fs.renameSync(path.join(dir, b.guid), file);
    return { file, url: b.url };
  } finally {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false }).catch(() => {});
  }
}

// Follows redirects (bit.ly, linktr.ee style shorteners) to find the real gate host.
async function expand(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36' } });
    return r.url || url;
  } catch { return url; }
}

async function main() {
  const prev = !force && downloaded(trackUrl);
  if (prev) return { ok: true, file: prev.files?.[0], files: prev.files, gate: prev.gate, already: true };

  step('browser: launch');
  try { browser = await launchBrowser(); }
  catch (e) { if (e instanceof GateDlError) throw e; fail(CODES.BROWSER, `could not start/attach Chrome: ${e.message}`); }
  // Nothing should ever land in ~/Downloads.
  await browser.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

  scPage = await browser.newPage();
  // Tabs left open by earlier failed runs (kept for probing) are closed now.
  for (const t of await browser.pageTargets()) if (t.targetId !== scPage.targetId) await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  sc = new SoundCloud(scPage);
  const track = await sc.open(trackUrl);
  // Same track reached through a different URL (redirected permalink etc.).
  const byId = !force && downloaded(trackUrl, track.id);
  if (byId) return { ok: true, file: byId.files?.[0], files: byId.files, gate: byId.gate, already: true };
  state.track = { id: track.id, title: track.title, user: track.user?.username, purchase_url: track.purchase_url, downloadable: track.downloadable };
  const fallbackName = `${track.user?.username || 'artist'} - ${track.title}`;

  // 1. SoundCloud's own download button, when enabled, beats any gate.
  const native = await sc.nativeDownload();
  if (native) {
    step('download: native SoundCloud download');
    const res = await fetchToStore(native, { fallbackName });
    return { ok: true, ...res, gate: 'soundcloud-native' };
  }

  // 2. Find the gate link.
  step('soundcloud: find gate links');
  state.candidates = gateUrlOverride ? [gateUrlOverride] : await sc.candidateLinks();
  if (!state.candidates.length)
    fail(CODES.NO_GATE_FOUND, 'track has no purchase/buy link and no URLs in its description; check the track page by hand (screenshot) for a download link elsewhere', { description: track.description });

  let gate = null, gateUrl = null;
  for (const u of state.candidates) { if ((gate = findGate(u))) { gateUrl = u; break; } }
  if (!gate) {
    step('soundcloud: expand redirects');
    const expanded = [];
    for (const u of state.candidates) {
      const e = await expand(u); expanded.push({ from: u, to: e });
      if (!gate && (gate = findGate(e))) gateUrl = e;
    }
    state.expanded = expanded;
  }
  if (!gate) fail(CODES.UNKNOWN_GATE, `no gate utility matches any link on this track; known gates: ${GATES.map(g => g.name).join(', ')}`, { candidates: state.candidates, expanded: state.expanded });
  state.gate = gate.name; state.gateUrl = gateUrl;

  // 3. Support actions on SoundCloud (real ones; gates may verify them server-side).
  // User's call (2026-11-12): getting the file matters more than the actions. If DataDome
  // blocks SoundCloud writes, note it loudly on stderr and still run the gate.
  if (!noActions) {
    try { state.actions = await sc.supportActions({ comment: !gate.postsComment }); }
    catch (e) {
      if (e.code !== CODES.CAPTCHA) throw e;
      state.actions = { skipped: 'CAPTCHA', message: e.message };
      process.stderr.write(`[gate-dl] ⚠ SoundCloud actions blocked by DataDome captcha; running the gate anyway\n`);
    }
  }

  // 4. Run the gate.
  gatePage = await browser.newPage();
  const result = await gate.run({ browser, page: gatePage, sc, track, url: gateUrl, actions: state.actions, step, fail, CODES, sleep, browserDownload, runDir, config: cfg });
  if (!result || (!result.url && !result.file)) fail(CODES.INTERNAL, `gate ${gate.name} returned neither url nor file`, { result });

  // 5. Save + verify.
  step('download: save to store');
  let saved;
  if (result.url) saved = await fetchToStore(result.url, { fallbackName, headers: result.headers });
  else {
    verifyAudio(result.file);
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const dest = path.join(STORE_DIR, path.basename(result.file));
    fs.renameSync(result.file, dest);
    saved = { file: dest, ...verifyAudio(dest) };
  }
  if (saved.kind === 'zip') { step('download: unpack zip'); saved = await unpackZip(saved.file); }
  await browser.closePopups();
  await gatePage.close(); gatePage = null;
  await scPage.close(); scPage = null;
  return { ok: true, ...saved, gate: gate.name, gateUrl, actions: state.actions };
}

async function dumpEvidence(err) {
  const page = gatePage || scPage;
  const safe = async (name, fn) => { try { await Promise.race([fn(), sleep(20000).then(() => { throw new Error('timeout'); })]); } catch (e) { fs.writeFileSync(path.join(runDir, name + '.error.txt'), String(e?.message || e)); } };
  if (page) {
    await safe('screenshot', async () => fs.writeFileSync(path.join(runDir, 'screenshot.png'), await page.screenshot()));
    await safe('page', async () => fs.writeFileSync(path.join(runDir, 'page.html'), await page.html()));
    await safe('network', async () => fs.writeFileSync(path.join(runDir, 'network.json'), JSON.stringify(await page.networkDump(), null, 1)));
    await safe('console', async () => fs.writeFileSync(path.join(runDir, 'console.json'), JSON.stringify(page.console, null, 1)));
    await safe('url', async () => { state.pageUrl = await page.url(); });
  }
  const failure = {
    code: err.code || CODES.INTERNAL,
    message: err.message,
    step: progress.step,
    details: err.details,
    stack: err.stack,
    state,
    steps: progress.history,
    evidence: fs.readdirSync(runDir),
    probe: page ? `TAB='${page.targetId}' node gate-dl/tools/cdp.mjs shot|eval|click …` : null,
  };
  fs.writeFileSync(path.join(runDir, 'failure.json'), JSON.stringify(failure, null, 2));
  return failure;
}

const killer = setTimeout(() => { finish(new GateDlError(CODES.TIMEOUT, `run exceeded ${RUN_TIMEOUT_MS / 1000}s`)); }, RUN_TIMEOUT_MS);
let finished = false;

async function finish(err, out) {
  if (finished) return; finished = true;
  clearTimeout(killer);
  if (!err) {
    if (!out.already) markDownloaded(trackUrl, { id: state.track?.id, title: state.track?.title, files: out.files || [out.file], gate: out.gate, gateUrl: out.gateUrl });
    record({ ok: true, file: out.file, gate: out.gate, gateUrl: out.gateUrl, already: !!out.already });
    fs.rmSync(runDir, { recursive: true, force: true });
    console.log(JSON.stringify(out));
    browser?.disconnect();
    process.exit(0);
  }
  const f = await dumpEvidence(err).catch(e => ({ code: err.code || CODES.INTERNAL, message: err.message, step: progress.step, dumpError: e.message }));
  record({ ok: false, code: f.code, step: f.step, message: f.message, gate: state.gate, runDir });
  const bar = '█'.repeat(78);
  process.stderr.write([
    '', bar,
    `██ GATE-DL FAILED  code=${f.code}  step="${f.step}"`,
    `██ ${f.message}`,
    `██ track: ${trackUrl}`,
    state.gate ? `██ gate: ${state.gate}  ${state.gateUrl}` : `██ candidates: ${JSON.stringify(state.candidates)}`,
    `██ evidence: ${runDir}/failure.json`,
    `██ fix it: see .claude/skills/gate-dl/SKILL.md`,
    bar, '',
  ].join('\n'));
  browser?.disconnect();
  process.exit(2);
}

main().then(out => finish(null, out), err => finish(err));
