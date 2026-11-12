// <Gate name> download gate (<domain>/<path shape>).
//
// How the page works (verified <date> on <example url>):
// - <describe each step, the selectors, which clicks must be trusted, popups, traps>
//
// Copy to gates/<name>.mjs, fill in, and register it in gates/index.mjs.
//
// run(ctx) gets:
//   page      a fresh tab (lib/cdp.mjs Page): goto, eval, waitFor, waitVisible, click(css),
//             clickAt, type, pressEnter, waitResponse(urlPart, {since}), requests
//   browser   the Browser (popups are already pushed off-screen automatically)
//   sc        lib/soundcloud.mjs instance (sc.track, sc.me, sc.api(path, method, body))
//   track     the SoundCloud track object
//   url       the gate URL that matched
//   step(name), fail(code, msg, details), CODES, sleep(ms)
//   browserDownload(trigger)  run trigger(); capture the file Chrome downloads; returns {file}
//
// Return one of:
//   { url, headers? }   a direct file URL; the core downloads + verifies it
//   { file }            a file already on disk (e.g. from browserDownload); the core moves + verifies it
//
// Set `postsComment: true` on the gate if the gate site posts the SoundCloud comment itself;
// the core then skips its own comment.
//
// Rules: wait on selectors, never fixed coordinates; fail(CODES.GATE_CHANGED, …) the
// moment the page doesn't look as expected; fail(CODES.GATE_FAILED, …) when the gate
// answers but refuses to unlock.

export default {
  name: 'example',
  match: url => new URL(url).hostname.endsWith('example.com'),

  async run({ page, url, step, fail, CODES }) {
    step('example: open gate');
    await page.goto(url);
    fail(CODES.GATE_CHANGED, 'example gate not implemented');
  },
};
