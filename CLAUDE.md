# dj-utilities

- **NEVER run the E2E tests unless the user asks for it.** No exceptions.
- **NEVER run or launch the app (dev, built, packaged, or via Playwright/CDP/the `run` skill) unless the user asks for it in their latest message.** This applies even when a skill, plan or ticket says to check the change in the real app, and even to "just a quick look" or a screenshot. If you think it should be run, say so and stop.
- Clean up before ending every turn. Never end a turn with a background task still running (test runs, builds, test apps); wait for it to finish, or stop it. Before replying, check that no test processes are left (`ps aux | grep -E "vitest|electron|rubberband|afconvert"`), but leave the user's own `electron-vite dev` alone. Delete leftover test data (`planner-data-*` and `planner-work-*` in the system temp dir) and your own log files.
- Tests must be silent: e2e runs go through `app/tests/e2e/harness.ts`, which mutes audio. Never launch the app for a test any other way.

## Testing: only what you touched

- When the user asks for a test run, run ONLY the tests that cover the files you changed. Never the whole suite unless the user asks for all tests.
  - E2E: `npm --prefix app run test:e2e -- tests/e2e/<spec>.e2e.ts [-t "<test name>"]`. Narrow with `-t` to the cases that exercise your change. With no spec it refuses; `--all` needs the user's request and the `# user-asked-all` tag (a hook blocks it otherwise, and blocks running vitest with the E2E config directly).
  - Unit: `cd app && npx vitest run tests/unit/<file>.test.ts [-t "<name>"]`.
  - If no existing test covers the change, add a focused case to the closest spec; run it only if the user asked for a test run.
- Which E2E spec covers what:
  - `basic.e2e.ts`: import, playback, export basics
  - `editing.e2e.ts`: timeline editing, trimming, marquee, menus, export cancel (Timeline.tsx, Panels.tsx, actions.ts)
  - `tempo.e2e.ts`: tempo changes, ramps (shared/tempo.ts, engine.ts, ramp code in main/planner.ts)
  - `sets.e2e.ts`: stored sets, Home screen, cache clean-up (Home.tsx, set code in main/planner.ts)
  - `rekordbox.e2e.ts` / `rekordbox-library.e2e.ts`: Rekordbox grids and cues (main/rekordbox.ts)
  - `real.e2e.ts`, `stress.e2e.ts`: real-audio and load checks; only when the change is about those
- E2E screenshots go to `dev-data/shots/` (kept after the run, cleared when the next run starts).

## Data: dev-data/

- In dev (unpackaged) the app keeps ALL its data in the gitignored `dev-data/` at the repo root: sets, caches, stretched audio, Rekordbox caches, downloads ledger, Chromium data, logs, temp files (`app/src/main/paths.ts`). It can be deleted at any time; the next launch makes it again. Packaged builds use the normal OS folders.
- Tests write only inside `dev-data/test-runs/<run>/`, which is removed when the run ends (`app/tests/globalSetup.ts`). In tests, get folders from `testDir()` in `app/tests/testdata.ts`. Never use `os.tmpdir()`, the home folder, or a path of your own.
