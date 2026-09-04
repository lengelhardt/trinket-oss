# trinket-oss development notes

## Firestore read/write costs

This project uses Firestore as its database backend (configured via `db.backend: firestore`).
Firestore bills per document read and write, so be vigilant when writing or reviewing code that touches the database:

- Avoid fetching documents just to check a field — use targeted queries.
- Avoid N+1 patterns (e.g. loading a list, then fetching each item individually in a loop).
- Prefer batched reads (`$in` queries, `findByIds`) over sequential individual lookups.
- Cache or reuse documents already in scope rather than re-querying.
- Be especially careful in hot paths: embed views, trinket loads, course page loads.

The Firestore backend lives in `lib/db/firestore-backend.js`. The MongoDB backend is still present for local/legacy use.

## Measuring performance in the Pyodide embed

Two traps, both of which have produced wrong conclusions and a reverted commit:

- **Wall-clock timing is meaningless when the Browser pane is hidden.** The pane
  throttles `setTimeout` to ~1s and does not fire `requestAnimationFrame` at all,
  and the console flush is driven by both. A measurement that looked like 8 ms per
  operation was mostly throttled timer latency. Measure main-thread blocking with
  `PerformanceObserver({entryTypes:['longtask']})` instead — it reports real work
  and is immune to throttling. If a run reports `frames: 1`, rAF is not firing and
  any wall-clock number from it is worthless.
- **Warm the interpreter before timing anything.** A cold `sympy.integrate()` costs
  seconds and will dominate whatever you think you are measuring. Run the setup
  once, then measure. A "control" that runs second is warm and is not a control.

A/B against the same build with the variable changed, rather than comparing to a
remembered number from a different session.

## Local stacks

- `docker-compose.yml` (mongo shape, :3000) and `docker-compose.gcr.yml` (GCP shape,
  :3001) share a Compose project name and both define a service called `app`.
  Bringing one up therefore **removes the other's app container**. Run one at a time,
  or expect to recreate the other afterwards.
- `public/css` and `public/components` are masked by volumes, so they come from the
  image, not your working tree. Editing SCSS or vendoring a new component and then
  restarting is not enough: Compose also **preserves anonymous volumes across
  container recreation**, so the old assets keep being served and the new ones 404
  silently. Rebuild and recreate with `-V` (`--renew-anon-volumes`).

## Referencing code from docs

- Pair every `file:line` reference with a **stable string to grep for**. Line numbers
  drift as `main` moves; the anchor is what still resolves a month later. See the
  anchor table in `docs/superpowers/specs/2026-09-03-sympy-math-output-design.md`.
- **Do not restate in prose a value that a test asserts.** A hand-counted expectation
  written into a plan ("the cards are numbered 6 and 8" — they are 6 and 7) is a
  second copy that can be wrong and that nothing checks. Point at the test instead.
- **When you do find a restated value is wrong, grep for it before fixing.** That one
  took three review rounds precisely because it was corrected one occurrence at a
  time: the same wrong number was in three places in the plan, one of which
  contradicted the browser spec that ships the correct value. Fixing the line you
  were shown leaves the others, and the next reviewer finds them one by one.
- **Then check for anything describing the disagreement you just resolved.** A comment
  elsewhere read "the plan's prose says 6 and 8; that is an off-by-one" — correct when
  written, and stale the moment the plan was fixed, leaving a reader hunting for a
  contradiction that no longer exists. Notes that reconcile two documents are a second
  copy of the same fact and rot the same way; state the fact self-containedly instead.
