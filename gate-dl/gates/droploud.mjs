// Droploud download gate (droploud.com/track/<uuid>).
//
// How the page works (verified 2026-11-12 on droploud.com/track/cec52afb-99a1-46e7-9e87-c4587a5d7f81):
// - Landing: button.ds-gate-wide "Free download" opens .ds-gate-card "Connect SoundCloud".
// - input#dltg-sc-comment is REQUIRED (Connect stays disabled until it has text). Droploud
//   posts that comment itself, so the core skips its own comment for this gate (postsComment).
// - button.ds-sc-btn "Connect with SoundCloud" opens a popup to secure.soundcloud.com/authorize
//   (OAuth, Droploud client_id JDo1wTXw41y4VCQcDRpA1cffQv55K9ea). Button #submit_approval "Allow".
//   Authorized for phvraoh_music on 2026-11-12 (user OK'd it), so later runs may skip the Allow page.
// - Over OAuth, Droploud then does follow + like + comment server-side. Repost is "manual"
//   (repost_enforce:true): the account must already have reposted (lib/soundcloud.mjs does it
//   before the gate). Card: "Open track on SoundCloud" (must be clicked once, which sets
//   repost_manual_engaged) -> "Verify" -> POST api.droploud.com/api/soundcloud/verify-repost
//   {track_id, session_id, fresh, verify_trigger} -> {"found":true|false,"reason":"page1_miss"}.
// - POST /api/soundcloud/gate-status -> {connected, steps:{droploud_sc,sc_follow,sc_like,sc_repost,sc_comment}, …}.
// - NOT YET SEEN: what comes after a successful repost verify. The SoundCloud repost was blocked
//   by DataDome during the first run. The code below looks for a visible "download" button in the card and
//   captures whatever Chrome downloads, or fails with GATE_CHANGED and the card text.
// - Every Connect posts a NEW comment (3 runs gave 3 comments). The gate deletes all of mine on the
//   track except the oldest (DELETE /comments/{id} -> 204), and refuses to connect if the repost
//   wasn't done.

import { COMMENT_PHRASES } from '../config.mjs';

export default {
  name: 'droploud',
  postsComment: true,
  match: url => /(^|\.)droploud\.com$/i.test(new URL(url).hostname) && /^\/track\//.test(new URL(url).pathname),

  async run({ browser, page, sc, track, url, actions, step, fail, CODES, sleep, browserDownload }) {
    // Tags the first visible element in scope matching css whose text matches re; returns a selector.
    const byText = async (css, re, label, timeoutMs = 20000) => page.waitFor((css, src) => {
      const re = new RegExp(src, 'i');
      const el = [...document.querySelectorAll(css)].find(e => e.offsetParent && !e.disabled && re.test(e.innerText || e.value || ''));
      if (!el) return null;
      el.id ||= 'gate-dl-' + Math.random().toString(36).slice(2);
      return '#' + CSS.escape(el.id);
    }, { timeoutMs, label, args: [css, re.source] });
    const cardText = () => page.eval(() => document.querySelector('.ds-gate-card')?.innerText || '');

    // Droploud enforces the repost, and every Connect posts a comment: don't connect when the
    // repost couldn't be done (actions blocked by CAPTCHA), or we'd only add comments.
    if (actions?.skipped) fail(CODES.GATE_FAILED, `Droploud needs a SoundCloud repost, but the core's actions were skipped (${actions.skipped}); rerun once SoundCloud writes work`, { actions });

    step('droploud: open gate');
    await page.goto(url);
    await page.click(await byText('button', /free download/, '"Free download" button'));

    step('droploud: comment + connect SoundCloud');
    await page.waitVisible('#dltg-sc-comment', { timeoutMs: 15000 });
    await page.click('#dltg-sc-comment');
    await page.eval(() => { document.getElementById('dltg-sc-comment').value = ''; });
    await page.type(COMMENT_PHRASES[Math.floor(Math.random() * COMMENT_PHRASES.length)]);
    await page.waitFor(() => !document.querySelector('.ds-gate-card button.ds-sc-btn')?.disabled, { label: 'Connect button enabled after typing comment' });
    await page.click('.ds-gate-card button.ds-sc-btn');

    // Either the OAuth popup shows "Allow", or (already authorized) it redirects straight back.
    step('droploud: authorize');
    const end = Date.now() + 45000;
    let allowed = false;
    while (Date.now() < end) {
      if (/connected as|repost the track|download/i.test(await cardText()) && !/connect with/i.test(await cardText())) break;
      const auth = (await browser.pageTargets()).find(t => t.url.includes('secure.soundcloud.com/authorize'));
      if (auth && !allowed) {
        const p = await browser.attach(auth.targetId);
        const ok = await p.eval(() => !!document.querySelector('#submit_approval')).catch(() => false);
        if (ok) { await p.click('#submit_approval'); allowed = true; }
      }
      await sleep(700);
    }
    const afterAuth = await cardText();
    if (/connect with/i.test(afterAuth)) fail(CODES.GATE_CHANGED, 'still on "Connect SoundCloud" 45s after clicking Connect (OAuth popup not found/handled)', { card: afterAuth });

    // Each Connect posts a fresh comment: keep my oldest one on this track, delete the rest.
    step('droploud: dedupe comments');
    const mine = [];
    for (let path = `/users/${sc.me.id}/comments?limit=200`, i = 0; path && i < 5; i++) {
      const r = await sc.api(path);
      if (r.status !== 200) break;
      mine.push(...(r.body.collection || []).filter(c => c.track_id === track.id));
      path = r.body.next_href ? r.body.next_href.replace('https://api-v2.soundcloud.com', '') : null;
    }
    mine.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const c of mine.slice(1)) {
      const d = await sc.api(`/comments/${c.id}`, 'DELETE');
      if (![200, 204].includes(d.status)) fail(CODES.SC_ACTION, `could not delete duplicate comment ${c.id}: HTTP ${d.status}`, { body: d.body });
    }

    if (/repost the track/i.test(afterAuth)) {
      step('droploud: verify repost');
      const open = await byText('.ds-gate-card button, .ds-gate-card a', /open track on soundcloud/, '"Open track on SoundCloud"', 5000).catch(() => null);
      if (open) { await page.click(open); await sleep(2500); await browser.closePopups(); }
      const since = Date.now();
      await page.click(await byText('.ds-gate-card button', /^verify/, '"Verify" button'));
      const { body } = await page.waitResponse('/api/soundcloud/verify-repost', { since, timeoutMs: 30000 });
      let j = null; try { j = JSON.parse(body); } catch {}
      // The body is sometimes unavailable to CDP; fall back to the card ("Not seen" = refused).
      if (!j) { await sleep(1500); const c = await cardText(); j = { found: !/not seen|haven.t seen/i.test(c), reason: 'from card text', card: c.slice(0, 300) }; }
      if (!j.found) fail(CODES.GATE_FAILED, `Droploud can't see the repost (${j.reason || 'no reason'}); the core's SoundCloud repost must succeed first (blocked if actions hit CAPTCHA)`, { response: j });
    }

    step('droploud: download');
    const dl = await byText('.ds-gate-card button, .ds-gate-card a', /download/, 'a download button in the gate card after unlocking', 30000)
      .catch(async () => fail(CODES.GATE_CHANGED, 'no download button after unlock (flow past repost verify not seen yet; probe the tab and finish gates/droploud.mjs)', { card: await cardText() }));
    const { file } = await browserDownload(() => page.click(dl));
    return { file };
  },
};
