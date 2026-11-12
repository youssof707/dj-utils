// Hypeddit download gate (hypeddit.com/<artist>/<track>).
//
// How the page works (verified 2026-11 on hypeddit.com/afinity/temperature):
// - `var step_array = [["SoundCloud","Spotify"]]` in the HTML: list of step groups;
//   any platform in a group satisfies that group.
// - Landing button `#downloadProcess` opens a jQuery carousel of slides.
// - Platform pickers on a slide: `a.hype-btn-<platform>.step_button_<n>`.
// - The SoundCloud slide is `#step_sc`. Its tasks are `#soundcloud_status a.undone`
//   (data-step follow/like/comment/repost). Each has an inline onclick that opens a
//   popup to SoundCloud; a jQuery handler marks it `done`. Hypeddit does nothing on
//   SoundCloud itself; the real actions are done by lib/soundcloud.mjs beforehand.
// - Once no task is `undone`, `#skipper_sc_next` is un-hidden. USE IT. The always-visible
//   `#skipper_sc_channel` "Next" is a skip: the final POST then returns download_status:false.
// - Last slide: `#gateDownloadButton` (disabled classes: disable / disabled / hy-btn-lightgray).
//   Its handler checks event.isTrusted, so it needs a CDP mouse click.
// - It POSTs /gate/download/ul -> {"download_status":true,"URL":"<presigned S3 url>"}.
//   The S3 URL carries response-content-disposition with the real filename.
// - Optional groups (verified 2026-11-12 on hypeddit.com/twotrick/whileyouweresleepingtwotrickflip):
//   step_array like [["Email (Optional) "],["SoundCloud"],["Instagram (Optional) "]]. The optional slide
//   (e.g. #step_email: name + email + "Share email address") has a.hype-connect-link#skipper_email
//   "Skip to next step". We click the skip link and never share an email. Instagram: #skipper_ig.
//   Slides are .fangate-slider-content.<key>; finished ones get `move-left`. The current slide is
//   the first without it; hit tests are unreliable because old slides stay hittable.
// - Required non-SoundCloud slides (verified 2026-11-12, ig on hypeddit.com/flozone/…): a.hype-btn-social
//   "Follow <artist>" (Hypeddit can't verify it), after which #skipper_<key>_next appears. As with sc,
//   #skipper_<key>_channel is assumed to be a skip trap and is never used.
// - Required email (["Email"], no visible #skipper_email): fill #email_name/#email_address with
//   config.GATE_EMAIL, click #email_to_downloads_next.

const SUPPORTED_PLATFORMS = ['soundcloud']; // extend as step handlers are added below

export default {
  name: 'hypeddit',
  match: url => /(^|\.)hypeddit\.com$/i.test(new URL(url).hostname) && new URL(url).pathname.split('/').filter(Boolean).length >= 2,

  async run({ page, url, step, fail, CODES, sleep, config }) {
    let emailTries = 0;
    step('hypeddit: open gate');
    await page.goto(url);
    const info = await page.eval(() => {
      const m = document.documentElement.outerHTML.match(/var step_array\s*=\s*(\[[\s\S]*?\]);/);
      return { stepArray: m ? m[1] : null, title: document.title, hasLanding: !!document.querySelector('#downloadProcess') };
    });
    if (!info.hasLanding) fail(CODES.GATE_CHANGED, 'no #downloadProcess button on the Hypeddit page (removed gate, 404, or new layout)', info);
    let groups;
    try { groups = JSON.parse(info.stepArray); } catch { fail(CODES.GATE_CHANGED, 'could not parse step_array', info); }
    // Groups like ["Email (Optional) "] / ["Instagram (Optional) "] can be skipped.
    const optional = g => g.every(p => /\(optional\)/i.test(String(p)));
    // Non-SoundCloud groups are not rejected up front: their slides usually carry a
    // "Skip to next step" a#skipper_<key>, which the loop clicks. If one has none, the loop
    // fails with "stuck on an unknown Hypeddit slide" and the active slide key.
    const unsupported = groups.filter(g => !optional(g) && !g.some(p => SUPPORTED_PLATFORMS.includes(String(p).toLowerCase().trim())));
    if (unsupported.length) step(`hypeddit: non-SoundCloud groups ${JSON.stringify(unsupported)}; will try their skip links`);

    // Never let step buttons open popups.
    const stripPopups = () => page.eval(() => {
      document.querySelectorAll('[onclick*="PopupCenter"]').forEach(a => a.removeAttribute('onclick'));
      window.PopupCenterDual = window.PopupCenter = () => {};
      return true;
    });
    await stripPopups();

    // State machine: look at what is visible, act, repeat. Copes with any number
    // of groups and with slides that are skipped because of cookies.
    const seen = [];
    for (let i = 0; i < 40; i++) {
      await stripPopups();
      const s = await page.eval(() => {
        // Carousel slides are stacked (current-slide over upcomming-slide), so "has a size"
        // is not enough: the element must be the topmost thing at its own centre.
        const vis = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          if (!(r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden')) return false;
          if (r.bottom < 0 || r.top > innerHeight) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); }
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
        };
        const q = sel => [...document.querySelectorAll(sel)].filter(vis);
        // Current slide = first .fangate-slider-content without move-left (done slides get move-left;
        // `current-slide` goes stale on the first slide). Key = first class: email, sc, ig, dw, …
        // Combined groups get keys like "sc|sp" (SoundCloud or Spotify).
        const isSc = k => !!k && k.split('|').includes('sc');
        const active = () => { const sl = [...document.querySelectorAll('.fangate-slider-content')].find(e => !e.classList.contains('move-left')); return sl ? sl.className.trim().split(/\s+/)[0] : null; };
        const gdb = document.querySelector('#gateDownloadButton');
        const visibleForms = q('.hype-sidebar-step-form').map(f => f.id);
        return {
          final: vis(gdb) && !/\b(disable|disabled|hy-btn-lightgray)\b/.test(gdb.className),
          finalDisabled: vis(gdb) ? gdb.className : null,
          scNext: isSc(active()) && q('#skipper_sc_next').length > 0,
          scUndone: q('#soundcloud_status a.undone').length,
          scPicker: q('a.hype-btn-soundcloud[class*="step_button_"]').length > 0,
          landing: q('#downloadProcess').length > 0,
          visibleForms,
          // Optional steps (email, instagram, …) have a visible "Skip to next step" a#skipper_<x>.
          // Never the SoundCloud ones: #skipper_sc_channel is the trap described above.
          optionalSkip: (() => {
            const k = active();
            if (!k || isSc(k) || k === 'dw') return null;
            const a = document.getElementById('skipper_' + k);
            return a && a.offsetParent ? a.id : null;
          })(),
          active: active(),
          emailForm: active() === 'email' && !!document.getElementById('email_address')?.offsetParent && !document.getElementById('skipper_email')?.offsetParent,
          // Required non-SoundCloud slide (e.g. ig: "Follow <artist>" then #skipper_ig_next).
          otherNext: (() => {
            const k = active(); if (!k || isSc(k) || k === 'dw') return null;
            const a = document.getElementById('skipper_' + k + '_next');
            return a && a.offsetParent ? a.id : null;
          })(),
          otherTasks: (() => {
            const k = active(); if (!k || isSc(k) || k === 'dw') return 0;
            const sl = document.querySelector('.fangate-slider-content.' + CSS.escape(k));
            return sl ? [...sl.querySelectorAll('a.hype-btn-social')].filter(a => a.offsetParent && !/jumpGate/.test(a.getAttribute('onclick') || '') && !a.classList.contains('gate-dl-clicked')).length : 0;
          })(),
          modals: q('.modal.in, .modal.show').map(m => m.id || m.className),
        };
      });
      seen.push(s);
      if (s.final) break;
      // Same state 4 times in a row means our clicks aren't doing anything.
      if (seen.length >= 4 && seen.slice(-4).every(x => JSON.stringify(x) === JSON.stringify(s)))
        fail(CODES.GATE_CHANGED, 'Hypeddit page did not react to 3 clicks in a row (click not landing, or a new overlay/step)', { state: s });
      if (s.scUndone) { step(`hypeddit: mark SoundCloud task done (${s.scUndone} left)`); await page.click('#soundcloud_status a.undone'); await sleep(400); continue; }
      if (s.scNext) { step('hypeddit: SoundCloud Next (#skipper_sc_next)'); await page.click('#skipper_sc_next'); await sleep(1200); continue; }
      if (s.emailForm) {
        step('hypeddit: required email step');
        if (!config.GATE_EMAIL) fail(CODES.GATE_FAILED, 'Hypeddit requires an email here (no skip link) and config.GATE_EMAIL is not set; ask the user which address to use', { state: s });
        if (emailTries++ >= 2) fail(CODES.GATE_FAILED, 'Hypeddit email step did not advance after submitting (POST /verifyEmailAddress returns status F for rejected addresses)', { state: s, email: config.GATE_EMAIL.email });
        await page.eval(({ name, email }) => {
          const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
          set('email_name', name); set('email_address', email);
        }, config.GATE_EMAIL);
        await page.click('#email_to_downloads_next'); await sleep(2000); continue;
      }
      if (s.otherNext) { step(`hypeddit: ${s.active} Next (#${s.otherNext})`); await page.click('#' + s.otherNext); await sleep(1200); continue; }
      if (s.otherTasks) {
        step(`hypeddit: ${s.active} task click (${s.otherTasks} left)`);
        const sel = await page.eval(k => {
          const sl = document.querySelector('.fangate-slider-content.' + CSS.escape(k));
          const a = [...sl.querySelectorAll('a.hype-btn-social')].find(a => a.offsetParent && !/jumpGate/.test(a.getAttribute('onclick') || '') && !a.classList.contains('gate-dl-clicked'));
          a.classList.add('gate-dl-clicked'); a.id ||= 'gate-dl-task-' + Math.random().toString(36).slice(2); return '#' + a.id;
        }, s.active);
        await page.click(sel); await sleep(800); continue;
      }
      if (s.optionalSkip) {
        step(`hypeddit: skip optional step (#${s.optionalSkip})`); await page.click('#' + s.optionalSkip); await sleep(1200); continue;
      }
      if (s.scPicker) { step('hypeddit: choose SoundCloud'); await page.click('a.hype-btn-soundcloud[class*="step_button_"]'); await sleep(1000); continue; }
      if (s.landing && !s.visibleForms.length) { step('hypeddit: landing Download'); await page.click('#downloadProcess'); await sleep(1200); continue; }
      // Nothing we know how to handle is visible. Give the carousel a moment, then fail.
      if (i > 0 && JSON.stringify(seen.at(-2)) === JSON.stringify(s)) {
        fail(CODES.GATE_CHANGED, `stuck on an unknown Hypeddit slide (active slide: ${s.active}, visible step forms: ${JSON.stringify(s.visibleForms)}); add a handler`, { state: s, history: seen.slice(-5) });
      }
      await sleep(1500);
    }
    if (!seen.at(-1).final) fail(CODES.GATE_CHANGED, 'never reached an enabled #gateDownloadButton', { history: seen.slice(-5) });

    step('hypeddit: final Download');
    const since = Date.now();
    await page.click('#gateDownloadButton');
    const { body, record } = await page.waitResponse('/gate/download/', { since, timeoutMs: 45000, label: 'POST /gate/download/*' });
    let j; try { j = JSON.parse(body); } catch { fail(CODES.GATE_FAILED, `non-JSON response from ${record.url}`, { body: String(body).slice(0, 1000) }); }
    if (!j.download_status || !j.URL) fail(CODES.GATE_FAILED, `Hypeddit refused to unlock: ${JSON.stringify(j).slice(0, 300)}`, { response: j, request: record.postData?.slice(0, 2000) });
    return { url: j.URL };
  },
};
