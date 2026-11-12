// Launches (or reuses) the dedicated Chrome with the persistent SoundCloud profile.
// ALWAYS HEADLESS: no window ever exists. If a non-headless Chrome is found on the
// port (e.g. left over from a manual sign-in), it is shut down and relaunched headless.

import { spawn, execFileSync } from 'node:child_process';
import { CDP_PORT, PROFILE_DIR, VIEWPORT } from '../config.mjs';
import { connectBrowser, sleep } from './cdp.mjs';
import { fail, CODES } from './fail.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function version(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function shutdown(port) {
  try { const b = await connectBrowser(port); await b.close(); b.disconnect(); } catch {}
  for (let i = 0; i < 20 && (await version(port)); i++) await sleep(250);
  if (await version(port)) {
    try { execFileSync('pkill', ['-f', PROFILE_DIR]); } catch {}
    for (let i = 0; i < 20 && (await version(port)); i++) await sleep(250);
  }
  if (await version(port)) fail(CODES.BROWSER, `could not shut down the non-headless Chrome on port ${port}`);
  await sleep(500); // let Chrome release the profile lock
}

// Chrome 157's --headless=new reports a normal "Chrome/…" version string, so check the
// main browser process's command line instead (helpers carry --type=…).
function runningHeadless(port) {
  let out = '';
  try { out = execFileSync('ps', ['-axww', '-o', 'command']).toString(); } catch { return false; }
  const main = out.split('\n').filter(l => l.includes(`--remote-debugging-port=${port}`) && !l.includes('--type='));
  return main.length > 0 && main.every(l => /--headless(=new)?\b/.test(l));
}

export async function launchBrowser() {
  let v = await version(CDP_PORT);
  if (v && !runningHeadless(CDP_PORT)) {
    // A headed instance is running (e.g. left from a manual sign-in): replace it.
    await shutdown(CDP_PORT);
    v = null;
  }
  if (!v) {
    let major = '157';
    try { major = execFileSync(CHROME, ['--version']).toString().match(/(\d+)\./)[1]; } catch {}
    // Sites (and bot walls like DataDome) treat "HeadlessChrome" UAs differently: present as normal Chrome.
    const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const args = [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      `--user-agent=${ua}`,
      '--mute-audio',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--no-first-run', '--no-default-browser-check',
      'about:blank',
    ];
    spawn(CHROME, args, { stdio: 'ignore', detached: true }).unref();
    const end = Date.now() + 30000;
    while (!(v = await version(CDP_PORT))) {
      if (Date.now() > end) fail(CODES.BROWSER, `headless Chrome did not open CDP port ${CDP_PORT} within 30s`);
      await sleep(300);
    }
    if (!runningHeadless(CDP_PORT)) fail(CODES.BROWSER, `Chrome on port ${CDP_PORT} is not headless`);
  }
  const browser = await connectBrowser(CDP_PORT);
  await browser.watchPopups();
  return browser;
}
