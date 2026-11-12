// Minimal CDP client: one browser-level WebSocket for the whole run, pages driven
// through flat sessions. Keeping one connection alive matters: settings such as
// Browser.setDownloadBehavior only last as long as the connection that set them.

import { CDP_PORT, VIEWPORT } from '../config.mjs';
import { fail, CODES } from './fail.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function connectBrowser(port = CDP_PORT) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket error')); });
  return new Browser(ws, port);
}

class Browser {
  constructor(ws, port) {
    this.ws = ws; this.port = port; this.id = 0;
    this.pending = new Map(); this.listeners = new Set();
    this.popups = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej, method } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
      } else if (m.method) {
        for (const l of this.listeners) l(m);
      }
    };
    ws.onclose = () => { for (const { rej } of this.pending.values()) rej(new Error('CDP connection closed')); };
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); }, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  waitEvent(pred, timeoutMs, label) {
    return new Promise((res, rej) => {
      const off = this.on(m => { if (pred(m)) { off(); clearTimeout(t); res(m); } });
      const t = setTimeout(() => { off(); rej(new Error(`timed out waiting for ${label}`)); }, timeoutMs);
    });
  }

  // Popups (gate step buttons open SoundCloud/Spotify windows) are pushed off-screen
  // the moment they appear so nothing flashes on the user's screen.
  async watchPopups() {
    await this.send('Target.setDiscoverTargets', { discover: true });
    this.on(async m => {
      if (m.method !== 'Target.targetCreated') return;
      const t = m.params.targetInfo;
      if (t.type !== 'page' || !t.openerId) return;
      this.popups.push(t);
      await this.hideTarget(t.targetId).catch(() => {});
    });
  }

  async hideTarget(targetId) {
    const { windowId } = await this.send('Browser.getWindowForTarget', { targetId });
    await this.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    await this.send('Browser.setWindowBounds', { windowId, bounds: { left: -10000, top: -10000, ...VIEWPORT } });
  }

  async closePopups() {
    for (const p of this.popups.splice(0)) await this.send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
  }

  async pageTargets() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos.filter(t => t.type === 'page');
  }

  // Opens a fresh tab, or attaches to an existing target.
  async newPage(url = 'about:blank') {
    let targetId;
    try {
      ({ targetId } = await this.send('Target.createTarget', { url, newWindow: false, background: true }));
    } catch (e) {
      // All windows closed (Chrome on macOS keeps running windowless): open a new window.
      if (!/no browser is open/i.test(e.message)) throw e;
      ({ targetId } = await this.send('Target.createTarget', { url, newWindow: true, background: true }));
    }
    await this.hideTarget(targetId).catch(() => {});
    return this.attach(targetId);
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init();
    return page;
  }

  async close() { try { await this.send('Browser.close', {}, undefined, 5000); } catch {} }
  disconnect() { try { this.ws.close(); } catch {} }
}

export class Page {
  constructor(browser, targetId, sessionId) {
    this.b = browser; this.targetId = targetId; this.sessionId = sessionId;
    this.requests = new Map(); // requestId -> record
    this.console = [];
  }

  send(method, params, timeoutMs) { return this.b.send(method, params, this.sessionId, timeoutMs); }

  async init() {
    this.b.on(m => {
      if (m.sessionId !== this.sessionId) return;
      const p = m.params;
      switch (m.method) {
        case 'Network.requestWillBeSent':
          this.requests.set(p.requestId, { id: p.requestId, url: p.request.url, method: p.request.method, type: p.type, postData: p.request.postData, t: Date.now() });
          if (this.requests.size > 400) this.requests.delete(this.requests.keys().next().value);
          break;
        case 'Network.responseReceived': {
          const r = this.requests.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; r.headers = p.response.headers; }
          break;
        }
        case 'Network.loadingFinished': { const r = this.requests.get(p.requestId); if (r) r.done = true; break; }
        case 'Network.loadingFailed': { const r = this.requests.get(p.requestId); if (r) { r.done = true; r.failed = p.errorText; } break; }
        case 'Runtime.consoleAPICalled':
          this.console.push({ type: p.type, text: p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500) });
          if (this.console.length > 200) this.console.shift();
          break;
        case 'Runtime.exceptionThrown':
          this.console.push({ type: 'exception', text: (p.exceptionDetails.exception?.description || p.exceptionDetails.text || '').slice(0, 500) });
          break;
      }
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable', { maxPostDataSize: 65536 });
    await this.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  }

  async goto(url, { timeoutMs = 45000 } = {}) {
    const loaded = this.b.waitEvent(m => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', timeoutMs, `load of ${url}`);
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) fail(CODES.BROWSER, `navigation to ${url} failed: ${r.errorText}`);
    await loaded;
  }

  // Evaluate an expression (string) or function + args in the page.
  async eval(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`
      : fnOrExpr;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, 60000);
    if (r.exceptionDetails) throw new Error(`page eval threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  async url() { return this.eval('location.href'); }

  // Polls a page function until it returns something truthy.
  async waitFor(fn, { timeoutMs = 15000, interval = 250, label = 'condition', code = CODES.GATE_CHANGED, args = [] } = {}) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try { last = await this.eval(fn, ...args); if (last) return last; } catch (e) { last = e.message; }
      await sleep(interval);
    }
    fail(code, `timed out after ${timeoutMs}ms waiting for ${label}`, { lastValue: last });
  }

  // Waits for a visible element matching the selector and returns its center.
  async waitVisible(selector, opts = {}) {
    return this.waitFor(sel => {
      const els = [...document.querySelectorAll(sel)];
      for (const el of els) {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0) return true;
      }
      return false;
    }, { label: `visible ${selector}`, ...opts, args: [selector] });
  }

  // Trusted mouse click on the first visible element matching selector (or an element
  // found by a page function returning one). Scrolls it into view first.
  async click(selector, { timeoutMs = 15000, code = CODES.GATE_CHANGED, index = 0 } = {}) {
    const pt = await this.waitFor((sel, idx) => {
      const vis = [...document.querySelectorAll(sel)].filter(el => {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      const el = vis[idx]; if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { timeoutMs, code, label: `clickable ${selector}`, args: [selector, index] });
    await this.clickAt(pt.x, pt.y);
    return pt;
  }

  async clickAt(x, y) {
    // Input events don't reliably reach a background tab: make this the active tab first.
    await this.send('Page.bringToFront');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async type(text) { await this.send('Input.insertText', { text }); }

  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }

  async body(requestId) {
    try {
      const r = await this.send('Network.getResponseBody', { requestId });
      return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
    } catch { return null; }
  }

  // Waits for a finished network response whose URL matches, returns { record, body }.
  // Only considers requests started after `since` (ms timestamp).
  async waitResponse(match, { timeoutMs = 30000, since = 0, label } = {}) {
    const test = typeof match === 'string' ? u => u.includes(match) : u => match.test(u);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      for (const r of this.requests.values()) {
        if (r.t >= since && r.done && test(r.url) && !r.failed) return { record: r, body: await this.body(r.id) };
      }
      await sleep(200);
    }
    fail(CODES.GATE_CHANGED, `no network response matching ${label || match} within ${timeoutMs}ms`);
  }

  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, 20000);
    return Buffer.from(r.data, 'base64');
  }

  async html() { return this.eval('document.documentElement.outerHTML'); }

  async networkDump() {
    const out = [];
    for (const r of [...this.requests.values()].slice(-200)) {
      const rec = { ...r };
      if (['XHR', 'Fetch'].includes(r.type) && r.done && !r.failed) {
        const b = await this.body(r.id); if (b != null) rec.body = b.slice(0, 4000);
      }
      out.push(rec);
    }
    return out;
  }

  async close() { await this.b.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}); }
}

export { sleep };
