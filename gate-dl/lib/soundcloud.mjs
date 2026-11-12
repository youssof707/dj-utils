// SoundCloud side: resolve the track, find download links, do support actions.
// All API calls run inside the logged-in soundcloud.com tab, using the page's
// client_id and the oauth_token cookie (api-v2 allows CORS from soundcloud.com).
//
// Verified endpoints (2026-11):
//   GET  /resolve?url=…                    track object (id, user_id, purchase_url, description, downloadable)
//   PUT  /users/{me}/track_likes/{track}   like   (idempotent, 200 "OK")
//   PUT  /me/track_reposts/{track}         repost (idempotent, 204)
//   POST /me/followings/{user}?signature=…  follow (idempotent, 204; PUT returns 404). The web app signs follows with
//                                          sign(me, user, client_id, __FOLLOWS_SIGNATURE_SECRET__) from its own webpack
//                                          modules; followSignature() runs those modules so a rotated secret keeps working.
//                                          Unsigned follow bursts got the session DataDome-flagged (2026-11-12).
//   Any write can return 403 {"url":"https://geo.captcha-delivery.com/…"}: DataDome captcha -> CODES.CAPTCHA.
//   POST /tracks/{track}/comments?body=…&timestamp=…   comment: params go in the QUERY STRING (200 + comment).
//                                          A JSON body, wrapped {comment:{…}} or flat, gives 400 "missing params". Verified 2026-11-12
//   GET  /me/track_likes/ids, /me/track_reposts/ids, /users/{me}/followings/ids  verification (newest first)
//   GET  /users/{me}/comments              my comments, newest first (dedupe)
//   GET  /tracks/{id}/download             native SoundCloud download -> {redirectUri}

import { fail, CODES, step } from './fail.mjs';
import { ACTIONS, COMMENT_PHRASES } from '../config.mjs';

// Runs inside the page: finds the app's follow-signing modules in webpackJsonp and signs.
function followSignatureInPage(me, user) {
  const fns = [];
  for (const ch of window.webpackJsonp || []) for (const k in ch[1] || {}) {
    const f = ch[1][k];
    if (typeof f !== 'function') continue;
    const s = f.toString();
    if (s.includes('__FOLLOWS_SIGNATURE_VERSION__') || s.includes('__FOLLOWS_SIGNATURE_SECRET__="')) fns.push(f);
  }
  const ex = fns.map(f => { const m = { exports: {} }; try { f(m, m.exports, null); } catch (e) { return { error: String(e) }; } return m.exports; });
  const signer = ex.find(e => typeof e.sign === 'function');
  const secret = ex.find(e => typeof e.__FOLLOWS_SIGNATURE_SECRET__ === 'string')?.__FOLLOWS_SIGNATURE_SECRET__;
  if (!signer || !secret) return { error: 'signer/secret module not found', found: fns.length, ex: ex.map(e => Object.keys(e)) };
  return { signature: signer.sign(me, user, window.__gateDlClientId, secret) };
}

// Runs inside the page. Returns {status, body}.
function apiInPage(path, method, body) {
  const tok = (document.cookie.match(/(?:^|; )oauth_token=([^;]+)/) || [])[1];
  let cid = window.__gateDlClientId;
  if (!cid) {
    const u = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('api-v2.soundcloud.com') && n.includes('client_id='));
    cid = u && new URL(u).searchParams.get('client_id');
    window.__gateDlClientId = cid;
  }
  if (!tok) return { status: -1, body: 'NO_OAUTH_TOKEN' };
  if (!cid) return { status: -2, body: 'NO_CLIENT_ID' };
  const url = 'https://api-v2.soundcloud.com' + path + (path.includes('?') ? '&' : '?') + 'client_id=' + cid;
  return fetch(url, {
    method, headers: { Authorization: 'OAuth ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => { const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch {} return { status: r.status, body: b }; });
}

export class SoundCloud {
  constructor(page) { this.page = page; }

  async api(path, method = 'GET', body) {
    const r = await this.page.eval(apiInPage, path, method, body);
    if (r.status === -1) fail(CODES.NOT_LOGGED_IN, 'no oauth_token cookie: sign in to SoundCloud in the gate-dl Chrome profile');
    if (r.status === -2) fail(CODES.TRACK, 'could not find SoundCloud client_id in page network entries');
    if (r.status === 403 && /captcha-delivery\.com/.test(r.body?.url || ''))
      fail(CODES.CAPTCHA, `SoundCloud (DataDome) wants a captcha for ${method} ${path.split('?')[0]}: the session is flagged; writes are blocked until it clears or a human solves the captcha`, { captcha: r.body.url });
    return r;
  }

  // Loads a soundcloud.com page and waits until api() works (client_id + logged in).
  async boot(url) {
    await this.page.goto(url);
    // client_id appears once the app has made its first api-v2 call.
    await this.page.waitFor(() => performance.getEntriesByType('resource').some(e => e.name.includes('api-v2.soundcloud.com') && e.name.includes('client_id=')),
      { timeoutMs: 20000, label: 'SoundCloud app to call api-v2', code: CODES.TRACK });
    const me = await this.api('/me');
    if (me.status !== 200) fail(CODES.NOT_LOGGED_IN, `GET /me returned ${me.status}: session expired? sign in again in the gate-dl Chrome profile`, { body: me.body });
    this.me = me.body;
  }

  // Playlist / album URL -> [{id, title, url}] in playlist order.
  // /resolve only fills in the first few tracks; the rest are {id} stubs, so they are
  // fetched with /tracks?ids= in batches of 50.
  async playlistTracks(setUrl) {
    step('soundcloud: open playlist');
    await this.boot(setUrl);
    const r = await this.api('/resolve?url=' + encodeURIComponent(setUrl.split('#')[0]));
    if (r.status !== 200 || r.body?.kind !== 'playlist') fail(CODES.TRACK, `resolve ${setUrl} returned ${r.status} kind=${r.body?.kind}`, { body: r.body });
    const ids = (r.body.tracks || []).map(t => t.id);
    const full = new Map((r.body.tracks || []).filter(t => t.permalink_url).map(t => [t.id, t]));
    const missing = ids.filter(id => !full.has(id));
    for (let i = 0; i < missing.length; i += 50) {
      const q = await this.api('/tracks?ids=' + missing.slice(i, i + 50).join(','));
      if (q.status !== 200 || !Array.isArray(q.body)) fail(CODES.TRACK, `GET /tracks?ids= returned ${q.status}`, { body: q.body });
      for (const t of q.body) full.set(t.id, t);
    }
    const lost = ids.filter(id => !full.get(id)?.permalink_url);
    if (lost.length) fail(CODES.TRACK, `${lost.length} playlist tracks could not be resolved (private/removed?)`, { lost, track_count: r.body.track_count });
    // Private tracks need their secret token in the URL.
    return ids.map(id => { const t = full.get(id); return { id, title: t.title, url: t.secret_token ? `${t.permalink_url}?secret_token=${t.secret_token}` : t.permalink_url }; });
  }

  async open(trackUrl) {
    step('soundcloud: open track');
    await this.boot(trackUrl);
    const clean = trackUrl.split('?')[0].split('#')[0];
    const t = await this.api('/resolve?url=' + encodeURIComponent(clean));
    if (t.status !== 200 || t.body?.kind !== 'track') fail(CODES.TRACK, `resolve ${clean} returned ${t.status} kind=${t.body?.kind}`, { body: t.body });
    this.track = t.body;
    return this.track;
  }

  // Every URL that might lead to a download, in priority order.
  async candidateLinks() {
    const t = this.track;
    const out = [];
    const add = u => {
      if (!u) return;
      u = u.trim().replace(/[).,;!]+$/, '');
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      try { u = new URL(u).href; } catch { return; }
      if (/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(u) && !/soundcloud\.com\/.+\/sets\//.test(u) && !/on\.soundcloud\.com/.test(u)) return;
      if (!out.includes(u)) out.push(u);
    };
    add(t.purchase_url);
    const text = [t.description, t.caption].filter(Boolean).join('\n');
    const re = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?)/gi;
    for (const m of text.matchAll(re)) {
      const s = m[1];
      if (!s.includes('/') && !/^https?:/.test(s)) continue; // bare domains like "afinitymusic.com" are rarely gates
      if (/@/.test(text.slice(Math.max(0, m.index - 1), m.index))) continue; // emails
      add(s);
    }
    return out;
  }

  // Returns a direct URL when SoundCloud's own download button is enabled.
  async nativeDownload() {
    const t = this.track;
    if (!t.downloadable) return null;
    const r = await this.api(`/tracks/${t.id}/download`);
    if (r.status === 200 && r.body?.redirectUri) return r.body.redirectUri;
    return null;
  }

  // comment:false when the gate posts the comment itself (e.g. droploud), so there is never a second one.
  async supportActions({ comment = true } = {}) {
    const t = this.track, me = this.me.id;
    const done = {};
    const must = (r, what, ok = [200, 201, 204]) => {
      if (!ok.includes(r.status)) fail(CODES.SC_ACTION, `${what} failed with HTTP ${r.status}`, { body: r.body });
    };
    const firstPageHas = async (path, id) => {
      const r = await this.api(path);
      return r.status === 200 && (r.body.collection || []).includes(id);
    };

    if (ACTIONS.follow && t.user_id !== me) {
      step('soundcloud: follow');
      const sig = await this.page.eval(followSignatureInPage, me, t.user_id);
      if (!sig.signature) fail(CODES.SC_ACTION, `could not compute follow signature: ${sig.error}`, sig);
      must(await this.api(`/me/followings/${t.user_id}?signature=${encodeURIComponent(sig.signature)}`, 'POST'), 'follow');
      // A new follow lands on page 1 (newest first); an old one may be further back, and the 204 is enough then.
      done.follow = (await firstPageHas(`/users/${me}/followings/ids?limit=200`, t.user_id)) ? true : 'ok (old follow)';
    }
    if (ACTIONS.like) {
      step('soundcloud: like');
      must(await this.api(`/users/${me}/track_likes/${t.id}`, 'PUT'), 'like');
      // Re-liking an old like doesn't move it to page 1 (seen at position 3716); the 200 is enough then.
      done.like = (await firstPageHas('/me/track_likes/ids?limit=200', t.id)) ? true : 'ok (old like)';
    }
    if (ACTIONS.repost) {
      step('soundcloud: repost');
      must(await this.api(`/me/track_reposts/${t.id}`, 'PUT'), 'repost');
      done.repost = (await firstPageHas('/me/track_reposts/ids?limit=200', t.id)) ? true : 'ok (old repost)';
    }
    if (ACTIONS.comment && comment && t.commentable !== false) {
      step('soundcloud: comment');
      const existing = await this.myComment(t.id);
      if (existing) {
        done.comment = `already: ${existing.body}`;
      } else {
        const body = COMMENT_PHRASES[Math.floor(Math.random() * COMMENT_PHRASES.length)];
        const timestamp = Math.floor(Math.random() * Math.max(1, (t.duration || 60000) - 5000));
        must(await this.api(`/tracks/${t.id}/comments?` + new URLSearchParams({ body, timestamp: String(timestamp) }), 'POST'), 'comment');
        if (!(await this.myComment(t.id))) fail(CODES.SC_ACTION, 'comment POST succeeded but comment not found afterwards');
        done.comment = body;
      }
    }
    return done;
  }

  async myComment(trackId) {
    let path = `/users/${this.me.id}/comments?limit=200`;
    for (let i = 0; i < 5 && path; i++) {
      const r = await this.api(path);
      if (r.status !== 200) fail(CODES.SC_ACTION, `listing my comments returned ${r.status}`);
      const hit = (r.body.collection || []).find(c => c.track_id === trackId);
      if (hit) return hit;
      path = r.body.next_href ? r.body.next_href.replace('https://api-v2.soundcloud.com', '') : null;
    }
    return null;
  }
}
