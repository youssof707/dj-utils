#!/usr/bin/env node
// Probe CLI for the babysitting agent. Talks to the same Chrome (port 9333) the
// script uses, so you can inspect a gate page after a failure.
//
//   node gate-dl/tools/cdp.mjs launch                 start/reuse the hidden Chrome
//   node gate-dl/tools/cdp.mjs tabs                   list page tabs
//   node gate-dl/tools/cdp.mjs open <url>             open url in a new tab, print its id
//   node gate-dl/tools/cdp.mjs nav <url>              navigate the selected tab
//   node gate-dl/tools/cdp.mjs eval '<js>'            evaluate JS (await-able), print JSON
//   node gate-dl/tools/cdp.mjs shot [file.png]        screenshot (default /tmp/gate-dl-shot.png)
//   node gate-dl/tools/cdp.mjs click '<css>' [index]  trusted click on a visible element
//   node gate-dl/tools/cdp.mjs clickxy <x> <y>        trusted click at coordinates
//   node gate-dl/tools/cdp.mjs type '<text>'          insert text at focus
//   node gate-dl/tools/cdp.mjs enter                  press Enter
//   node gate-dl/tools/cdp.mjs net [filter] [secs]    watch network for N secs (default 10), print requests (+XHR bodies)
//   node gate-dl/tools/cdp.mjs hide                   move all windows off-screen
//   node gate-dl/tools/cdp.mjs close                  quit the Chrome
//
// Select a tab with TAB=<target id or url substring> (default: first page tab).
// Every command has a 60s hard timeout.

import { launchBrowser } from '../lib/browser.mjs';
import { sleep } from '../lib/cdp.mjs';
import fs from 'node:fs';

setTimeout(() => { console.error('cdp.mjs: hard timeout'); process.exit(3); }, 60000).unref();

const [, , cmd, ...args] = process.argv;
const b = await launchBrowser();
const pick = async () => {
  const pages = await b.pageTargets();
  const sel = process.env.TAB;
  const t = sel ? pages.find(p => p.targetId === sel || p.url.includes(sel)) : pages[0];
  if (!t && !sel) return b.newPage();
  if (!t) throw new Error(`no tab matches ${sel}`);
  return b.attach(t.targetId);
};

try {
  switch (cmd) {
    case 'launch': console.log('ok'); break;
    case 'tabs': for (const p of await b.pageTargets()) console.log(p.targetId, p.url); break;
    case 'open': { const p = await b.newPage(); await p.goto(args[0]); console.log(p.targetId); break; }
    case 'nav': { const p = await pick(); await p.goto(args[0]); break; }
    case 'eval': { const p = await pick(); console.log(JSON.stringify(await p.eval(args.join(' ')), null, 1)); break; }
    case 'shot': { const p = await pick(); const f = args[0] || '/tmp/gate-dl-shot.png'; fs.writeFileSync(f, await p.screenshot()); console.log(f); break; }
    case 'click': { const p = await pick(); console.log(JSON.stringify(await p.click(args[0], { index: +(args[1] || 0) }))); break; }
    case 'clickxy': { const p = await pick(); await p.clickAt(+args[0], +args[1]); break; }
    case 'type': { const p = await pick(); await p.type(args.join(' ')); break; }
    case 'enter': { const p = await pick(); await p.pressEnter(); break; }
    case 'net': {
      const p = await pick(); const filt = args[0] || ''; await sleep((+args[1] || 10) * 1000);
      for (const r of await p.networkDump()) if (r.url.includes(filt)) console.log(JSON.stringify(r));
      break;
    }
    case 'hide': for (const t of await b.pageTargets()) await b.hideTarget(t.targetId).catch(() => {}); break;
    case 'close': await b.close(); break;
    default: console.error('unknown command; see header of gate-dl/tools/cdp.mjs'); process.exitCode = 1;
  }
} finally { b.disconnect(); }
process.exit(process.exitCode || 0);
