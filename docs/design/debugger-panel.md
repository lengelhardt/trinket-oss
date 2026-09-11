# Floating DEBUG panel — scoping for Wish 3

Status: **slice 1 is BUILT** (2026-09-08, branch `feature/debug-panel`, behind
`features.debugPanel`, which defaults to false and requires `stepDebugger`).
The rest of this document is the scoping that preceded it and is preserved as
the argument, not as a description of the code — where the two disagree, the
code wins. Follow-up to `pyodide-debugger-mvp.md`, whose Phases 1-3 are in
`main` behind `features.stepDebugger`.

**What slice 1 actually shipped, 2026-09-08** — read this before believing
anything below it:

- One new plugin file, `public/js/plugins/debug-panel.js`, plus hooks in
  `pyodide.js`. The panel is a strict **view**: it reads
  `getState()`/`getVarModel()`/`getVars()` and calls back into the existing
  replay functions, so the in-tab controls keep working with the flag off.
- **The panel renders its own variables list** — it is not §5's "variant A"
  (reuse the in-tab table). Every variable the student binds appears under the
  pill in first-appearance order; imported names are excluded by the recorder,
  not by a JS filter.
- **Deferred recording came back as an opt-in** (deleted 2026-09-08, restored
  2026-09-09). A recording still always starts at the program's first line, and
  nothing defers automatically — the difference from the deleted version. When
  a recording truncates *before* reaching the student's breakpoint the panel
  offers a button, and only that button calls `runStepThrough(true)`, which
  coasts to the breakpoint and keeps a `DEBUG_LOOKBACK_STEPS` ring of the steps
  before it. `bpHit`/`truncated` replaced `armed`/`skipped`; auto mode stops at
  breakpoints via `debugAutoStep`.
- **No message ever renders inside the pill.** Everything the panel says —
  error banner, end-of-recording, the recorder's note, transient notes — is
  composed by `saysHtml()` at the top of the floating variables window.
- Slice 2 shipped: the pill appears only after a Run, needs ≥2 non-import
  lines, and never appears for VPython (`debugPanelAvailable()`,
  `debugHasRunOnce`).
- Slice 3 shipped: ←/→ are adjudicated between the panel and Ace by focus,
  with `stopPropagation` on the panel's own controls.
- Slice 4 (matplotlib in replay) is **parked**, 2026-09-09. The gate was
  discharged and it was planned in full; two review rounds then killed both
  designs for grouping artists into loop passes, and the work outgrew its
  1.5–2.5 d estimate. The panel ships without it. See section 3.

The ask (Larry, 2026-09-08): take the step-through debugger out of the
Variables tab and give it its own floating affordance in the editor's file-tab
bar — the word `DEBUG` in small caps over a bug icon, a drag grip on its left,
expanding rightward into the empty part of that bar, styled like the plotpolish
panel. It should appear after the first Run of any program with at least two
non-import lines. The point is not decoration: it is being able to step and
watch the **Result** pane change — VPython scenes building, and matplotlib
plots redrawn once per loop iteration with only the newest one shown.

## 1. What exists today (verified, with refs)

- The debugger is **record & replay**, not live stepping, and for a hard
  reason: Pyodide runs on the browser main thread, so blocking Python at a
  breakpoint freezes the debugger's own UI. `sys.settrace` records a JSON
  trace, replay is pure UI over that trace. See `pyodide-debugger-mvp.md`
  "Why record & replay".
- Recorder + replay live in `public/js/embed/pyodide.js:1712-2290`
  (`RECORD_HELPER`, `runStepThrough`, `debugStepTo`, `paintReplaySnap`,
  `exitReplay`). Caps: 5 000 steps, 50 vars/step, 120-char reprs, **2 MB total
  JSON** (`DEBUG_MAX_BYTES`), frame depth 20. An ordinary recording is bound by
  the 5 000-step / 2 MB pair. A **deferred** one additionally coasts under
  `DEBUG_MAX_DORMANT` (200 000 line events) while it looks for the breakpoint,
  crediting the byte cap back as its ring evicts, so a long coast cannot trip
  the 2 MB bound before the breakpoint fires.
  **`DEBUG_MAX_BYTES` is an ESTIMATE of the payload, not a bound on it, and it
  currently under-counts.** Say that plainly rather than quoting 2 MB as a
  guarantee. `_size[0]` charges characters and two flat constants; `json.dumps`
  emits JSON syntax and escapes. Measured: a quote or newline encodes at 2×, an
  accented letter 6× and a non-BMP emoji 12× (one character becomes a `\uXXXX`
  surrogate pair), an empty variable entry costs 38 bytes against the 24
  charged, and an empty step dict 99 against the 40 charged. `_err` and the
  `type` field are charged nothing at all. Measured end to end: an ordinary
  Euler projectile program with 20 scalars and 5 lists produces a **2.75 MiB**
  payload, and fifty variables initialised to `None` produce **3.49 MiB**.
  Output alone *is* clamped against the encoded length and against the budget
  left after steps and snapshots, with a `DEBUG_MIN_OUTPUT_BYTES` floor so a
  step-heavy recording still shows what the program printed — but `steps` and
  `snaps` share the same `json.dumps` and are not clamped in encoded terms.
  Correcting the accounting is deliberately left to its own change: it touches
  the tracer's hot path, where the bounded-repr work bought 14-180×, so it
  needs measuring under Pyodide rather than native CPython.
- Markup is nested **inside** `#variables-wrap` in
  `lib/views/embed/pyodide.html:439-478`, which is why
  `features.stepDebugger` requires `features.variableExplorer`.
- There are already **two** entry points, and the second one exists for exactly
  the reason Larry gives: `#debug-start-alt`
  (`lib/views/embed/pyodide.html:435`) is an icon dropped into `#console-wrap`
  because "the launcher itself lives in the Variables panel, which a student
  has to know to open first". So discoverability is a known, already-patched-at
  problem — this proposal replaces the patch rather than inventing the concern.
- Breakpoints exist (Ace gutter, `debugBreakpoints`, next/prev navigation).
  **Superseded 2026-09-08:** this bullet used to end "plus deferred recording
  that arms the tracer at the first breakpoint". That was removed. The
  recording now always starts at the program's first line; the recorder reports
  `bpHit` (did any marked line run), and the panel's auto mode stops when it
  steps onto a marked line.
- **VPython is refused**, but only after the click:
  `pyodide.js:2219` shows "Step through is not available for VPython programs".
- matplotlib in a debug run: figures appear at the **end**, as in a normal run.
  Plot state is not stepped at all.

## 2. Question 1 — how much harder is it outside the Variables tab, and draggable?

Short answer: **the panel chrome is cheap; the variables table is the
expensive part.** Split the work and the first slice is small.

### 2a. The tab bar cannot host it. Use an overlay layer instead.

`static/scss/embed/_code_editor.scss:332` gives `.tab-nav`
`height: 2.275rem; overflow: hidden`. A child of that bar can be neither
taller than ~36 px nor dragged out of it, and the `overflow: hidden` is load-
bearing (it clips the horizontally scrolling file-tab strip).

So: render the pill in a **position-absolute overlay layer over the whole
embed**, with its *default* coordinates computed to land in the gap between
`dl.scrollable-content` and `dl.right-options` — visually docked in the bar,
structurally not in it. Zero change to Trinket's layout, and the expanded
panel can then be any size and can be dragged anywhere.

This is not speculative: **plotpolish already ships exactly this widget.**
`plotpolish/src/panel.css` has `.pill.float` (fixed layer, 999px radius, drag
shadow), `.pill .grip`, `.pill.collapsed` (grip only, tucked into a corner),
`.popover` with a `.pop-head` grip and a caret, and `.pill.dragging`
(transition suppressed so it tracks the pointer). Same author, same repo,
BSD-3. The requested aesthetic is a variant of a component we have.

### 2b. The real coupling is `#variables-table`, not the markup

Replay does not own a view of its own — it **paints the explorer's table**:

- `paintReplaySnap(...)` at `pyodide.js:2097` writes the recorded snapshot into
  `#variables-table`;
- `renderVariables()` bails out while replay is live — `if (debugRec) return;`
  at `pyodide.js:2380`, commented "replay owns the table";
- the "changed since last step" diff highlighting is CSS on that table
  (`.var-changed`, `pyodide.html:284-288`);
- and the "`inside f() — called from line N`" breadcrumb, the callables filter,
  the per-row copy buttons and the "expansion disabled in replay" rule all
  belong to that table.

Hence two variants, and they are very different sizes:

| Variant | What moves | Cost |
|---|---|---|
| **A. Controls float, variables stay** | pill + step controls + slider + breakpoint jumps + note go to the overlay; the Variables tab keeps rendering snapshots exactly as now | **~1-1.5 d** |
| **B. Panel owns its own variables view** | plus a compact variables list inside the panel: diff highlighting, breadcrumb, callables filter, truncation notes | **+1.5-2 d** |

**Recommendation: ship A first.** It delivers the whole discoverability win and
the whole "step while watching the Result pane" win, because in A the student
is *no longer forced into the Variables tab at all* — the Result tab can stay
open while they step. B is a nice-to-have that removes the last reason to visit
the tab, and it is the slice that would finally let `features.stepDebugger`
stand without `features.variableExplorer`.

### 2c. Three things that do get harder, and are easy to miss

1. **Arrow keys.** `pyodide.js:3659-3666` binds ←/→ (and Shift+← /→) at
   document level, guarded only by `debugRec` being non-null. Today that is
   safe because you are looking at a table. A panel floating over Ace means
   arrow keys have to be adjudicated: panel focused ⇒ step, editor focused ⇒
   move the caret. Needs an explicit focus rule, ~0.25 d, and it is the kind of
   bug that gets found by a student, not by us.
2. **Occlusion.** The pill sits over the file-tab strip and the expanded panel
   over Ace. Needs a z-index budget and a collapsed "tuck away" state —
   plotpolish's `.pill.collapsed` is that state, already written.
3. **Two panels, one corner.** If `features.plotStyle` and this are both on,
   plotpolish's floating pill and this pill are both draggable overlays in the
   same embed. Decide now whether they share one layer and one drag
   implementation (preferable) or coexist as strangers.

### 2d. The trigger rule

"Appears on first Run if there are ≥2 non-import lines" is cheap:
`editor.getAllFiles()[mainFile]`, drop blank/comment/`import`/`from … import`
lines, count what is left. Edge cases to get right: parenthesized multi-line
imports, module docstrings, `from __future__`. An hour or two. If exactness
matters, the ast-based `_async_transform.py` is already fetched into the
Pyodide FS and could answer it properly — but a regex heuristic is fine for
deciding whether an affordance appears.

Two rules to fold in at the same time:

- **Do not show the pill for VPython programs.** `usesVPython()` already
  exists (`pyodide.js:1040`); refusing before the click beats the current
  refuse-after-the-click note at `:2219`.
- **A wart to resolve deliberately.** An affordance that appears *because you
  just ran* implies it will step *that run*. It will not: `runStepThrough()`
  performs a fresh instrumented run in a **fresh namespace**, while normal Run
  execs in the persistent `pyodide.globals`. So a program that Run-succeeded on
  leftover state can `NameError` under Step through. The existing tooltip says
  so; a pill with two words on it cannot. Suggested panel wording: *"Re-runs
  your program from scratch, slowly, to record it."*

## 3. Question 2 — could this work with matplotlib?

**Not today, and the reason is structural, not a missing wire:** replay never
executes anything. It scrubs a JSON array. There is no live figure behind step
*k* to look at.

**But it can, and the mechanism is small.** Capture a figure frame *during the
recording run*, from inside the tracer:

```
if plt.get_fignums():
    fig = plt.gcf()
    if fig.stale:                      # matplotlib's own dirty flag
        fig.canvas.draw()
        buf = io.BytesIO(); fig.savefig(buf, format='png', dpi=72)
        frames[step] = base64(buf)
```

Pure Python, no DOM, so it works identically on the main thread and in the
worker. Replay then shows, in `#graphic`, the newest frame at or before step
*k* — which **is** the requested "plot in a loop, show only the most recent
one", and stepping backwards walks the plot backwards, which no live debugger
can do.

The whole feature is **capture policy and budget**:

- **Size.** `DEBUG_MAX_BYTES` is 2 MB for the entire JSON payload; a 400×300
  PNG is 10-30 KB, so frames need their own budget and their own channel.
  Either a separate result key with its own cap (~8 MB), or — better — write
  frames into the Pyodide FS during recording and `FS.readFile` them lazily as
  the student steps. The #253 file-outputs work already established FS read
  plumbing on both runtimes, so the lazy route is mostly assembled.
- **Time.** `draw()` + `savefig` is roughly 10-40 ms. Doing it at 5 000 steps
  is 50-200 s — unacceptable. So: capture only when `fig.stale`, cap the frame
  count (~200), and subsample once the cap is hit. For the target program (a
  loop that plots once per iteration) that is tens of frames and tens of
  milliseconds each.
- **Multiple figures.** Decide whether the panel shows `gcf()` only or all
  open figures. Note the known bug that the **worker never closes figures
  between runs** (no `plt.close('all')` in `pyodide-worker.js` MPL_SETUP, while
  the main thread does at `pyodide.js:44`) — figures accumulate across a
  session, so "all open figures" means something different on each runtime.

Estimate: **1.5-2.5 d** on top of the panel work. It should follow wish-list
item **01 (runtime contract spec, 1 d)**, because the two matplotlib
integrations already differ in figure lifecycle, resize plumbing and save path,
and this adds a third divergence point.

Bonus: the same capture mechanism is what "plots in a loop" needs *outside*
the debugger, and it composes with item 06 (plot DPI + Save plot).

### VPython is a different feature, not an extension of this one

Good news first: the async transform **never adds or removes lines**
(`pyodide.js:1303-1305`), so `settrace` line numbers would still map to the
lines the student wrote. That objection is dead.

What actually blocks it: the scene is a live WebGL canvas mutated in place (not
re-rendered from a scene description we can snapshot cheaply), the program is
`while True: rate(30)` so one second of animation is thousands of line events,
and the run is async — every `await rate()` yields to the browser mid-trace.

The right product here is **not a line debugger but a frame scrubber**: treat
each `rate()`/`sleep()` yield as one step, capture `canvas.toDataURL()` at each
yield, and drive it from the same panel with the same slider. Unknowns are
real (WebGL `preserveDrawingBuffer`, per-frame memory, how the glowscript
bridge exposes the canvas). Call it **a separate 2-4 d spike**, listed apart so
it is never confused with the matplotlib slice — and note it is the slice Larry
is most excited about, so it deserves its own prototype before its own
estimate.

## 4. Question 3 — the minimally invasive prototype

Goal: show collaborators the aesthetics and the interaction without touching a
file that item 02/04/07 work is also editing. **Zero repo diff, two pieces:**

1. **A standalone HTML prototype, published as an Artifact.** Fake the embed
   chrome from Larry's screenshot (toolbar row with Run and Clear memory, the
   file-tab bar with `main.py`, a static code pane with a highlighted current
   line, a Result pane). Make the *panel* real: DEBUG-over-bug-icon collapsed
   pill, grip drag, expand rightward, step slider, breakpoint jumps, and a
   canned 40-step recording of a loop that plots — so the plot in the Result
   pane really does advance as you scrub. Styles lifted from
   `plotpolish/src/panel.css` so the family resemblance is literal, not
   described. Collaborators get a link and click it.
2. **One in-situ screenshot or GIF.** The same panel injected into the running
   local embed from a devtools snippet — still zero diff, but the shot shows
   the real toolbar, real Ace, real figure, which is what actually convinces
   people it fits. The embed page is directly reachable
   (`window.TrinketAPI`, `document.querySelector('a.run-it').click()`), so this
   is minutes, not hours.

Then, if the shape is agreed, the real thing lands in the shape
`plotpolish-adapter.js` already established and proved reviewable: **one new
plugin file** (`public/js/plugins/debug-panel.js`), **one feature flag**
(`features.debugPanel`, default `false`), and **two or three small hooks** in
`pyodide.js` handing over the closure-local `api`/`editor`/`debugRec`. Nothing
else in the tree moves, so the diff a collaborator reads is one file plus a
flag.

## 5. Suggested order

| # | Slice | Est. | Notes |
|---|---|---|---|
| 0 | Prototype (artifact + in-situ shot) | 0.5-1 d | zero repo diff |
| 1 | Panel shell, variant A (controls float, variables stay) | 1-1.5 d | **BUILT 2026-09-08, but as variant B**: the panel renders its own variables window. Slice 5 below is therefore done too. |
| 2 | Trigger heuristic; no pill for VPython | 0.25 d | |
| 3 | Focus / arrow-key adjudication | 0.25 d | |
| 4 | matplotlib frame capture + replay in `#graphic` | 1.5-2.5 d | after wish item 01 |
| 5 | Variant B: panel owns its variables view | 1.5-2 d | optional; frees the `variableExplorer` dependency |
| 6 | VPython frame scrubber | 2-4 d | separate spike, own prototype first |

Slices 0-4 — the visible win, stepping while watching a plot redraw — are
**~4-6 engineer-days**. That is meaningfully more than the 2 d that wish item
03 currently carries in the ledger; the ledger figure was for the debugger as
built, not for this.

## 6. Open questions for Larry

**Answered 2026-09-08 while slice 1 was built** — 1 to 4 are settled; only 5 is
still open.

1. Variant A now and B later, or hold out for B? — **B, immediately.** The
   panel renders its own variables list, opt-out rather than opt-in: every name
   the student binds appears under the pill in first-appearance order. The
   paperclip/pinning design of §11 was dropped in its favour.
2. Should the pill *replace* both existing entry points? — **Alongside.** The
   panel is a view; `#debug-start`, `#debug-start-alt` and the in-tab transport
   are untouched and still work with `features.debugPanel` off.
3. Does the panel remember where it was dragged to? — **Per page session
   only.** The dragged position is module state in `debug-panel.js`; a reload
   re-docks it under Run. Not persisted, and nobody has asked for it to be.
4. On the fresh-namespace wart: is re-running on Step-through acceptable? —
   **Yes, and no extra run happens.** One click on the collapsed pill expands
   it *and* starts the recording; step-through already runs the program itself.
   If the runner is busy the panel waits (200 ms poll, ~30 s cap).
5. matplotlib frames: `gcf()` only, or every open figure? — **still open**, and
   it belongs to slice 4, which is gated on a collaborator notice.

## 7. Calibration against plotpolish (the one estimate we can now audit)

Wish item **07 "style panel"** was sized at **2.5-3 engineer-days**. It is the
only wish that has been built end to end, so it is the only place the ledger
can be checked against reality. Measured 2026-09-08:

| | Estimated | Delivered |
|---|---|---|
| Scope | "rcParams style panel" | standalone BSD-3 repo, web component, single-file Python core, host adapter |
| Source | — | ~6 900 lines (`src/`, `python/`, excluding tests) |
| Tests | — | ~9 600 lines |
| Docs | — | ~1 800 lines across 6 files (plus a demo GIF) |
| Trinket side | — | 356-line adapter + 3 hooks in `pyodide.js` |
| History | — | 75 commits over 3 calendar days; 4 releases to v0.3.2 |
| PRs | — | ~6 in plotpolish, 3 in Trinket (#251, #256, #261) |
| Reaching a student | implied | **not yet** — `features.plotStyle` is `false` in `config/default.yaml`, not overridden in production, and #261 is in someone else's merge queue |

Calendar days here are agent-assisted and are **not** the same currency as
engineer-days, so the honest comparison is scope-to-scope, not time-to-time.
On scope, the overrun is large. Where it came from, and whether it repeats:

**Would not repeat (one-time costs, already paid):** new repo, CI, a release
pipeline that gates four version strings, the IIFE build, the Python packaging
— none of that applies to a Trinket plugin file. And the floating pill with a
grip, a collapsed state and drag was **designed three times** (flat panel:
"overwhelming"; strip under the figure: "breadcrumbs suck"; floating pill:
kept). Two of those rounds were thrown away. That component now exists.

**Would repeat:**

1. **UX rounds on the part that is not specified.** Larry's screenshot pins
   the collapsed pill and where it lives — far more specification than the
   plotpolish brief started with. It says nothing about what the *expanded*
   panel contains, and that is precisely where plotpolish's discarded rounds
   were spent.
2. **Review passes.** The plotpolish work ran multiple Copilot passes per PR
   and accumulated 48 unresolved threads at its peak.
3. **The two-runtime tax.** The adapter's `hostRcKeys` had to become
   runtime-conditional because main thread and worker set different rc keys.
   Figure capture (slice 4) hits the same fork harder: figure lifecycle, the
   save path and the worker's missing `plt.close('all')` all differ.
4. **Merge latency**, which is not engineering time at all but is what
   "delivered" waits on.

**Restated estimate.** 4-6 d is a fair figure for slices 0-4 *as specified*.
Against this precedent, "in front of a student" is realistically **8-12 d**,
and the multiplier sits almost entirely in items 1-4 above rather than in the
code scoped in section 5. Note also that the ledger's own line for this work,
**"03 debugger UX (2 d)"**, is what 4-6 d is replacing — so the estimate has
already grown 2-3x on inspection, before any of the plotpolish-style overrun.

## 8. Larry's own time, as a ratio to plotpolish

Asked 2026-09-08: not engineer-days, but **how much of Larry's time** this
costs relative to plotpolish. A judgment call, not a measurement.

Headline: **~0.5-0.7x of plotpolish for slices 0-4.** Including the VPython
frame scrubber (slice 6), **~1.0-1.3x.**

His time on plotpolish broke down as design judgment, hands-on verification,
and process (review clicks, releases, merge chasing). Those three move in
different directions here:

| Category | vs plotpolish | Why |
|---|---|---|
| Design / UX judgment | **~0.3-0.5x** | The pill, grip, collapsed state and drag were designed three times and two were thrown away. That component now exists and he has already approved it; the screenshot settles the collapsed state. What is left unspecified is the expanded panel's contents — one or two rounds, not three. |
| Hands-on verification | **~1.5-2x** | The higher figure, and the important one. plotpolish's claim ("the style applies") is checkable by tests plus a glance. This feature's claim — "step and watch the plot redraw" — is a *feel* claim: stepping latency, whether a captured frame lags the highlighted line, whether the pill fights Ace's arrow keys, and whether the `fig.stale` capture policy picks the right frames **for his actual teaching programs**. None of that is reachable by tests or by an agent; it needs him running real classroom code and reacting. |
| Process | **~0.2-0.4x** | No new repo, no release pipeline, no version gates, no packaging. One or two PRs against ~9, so far fewer Copilot passes to click through, and no release decisions. |
| Pedagogical calls | new, unavoidable | What a student should see at step *k*; whether the fresh-namespace re-run is acceptable; one figure or all. His expertise, not delegable. |

**Why VPython flips it.** Slice 6 is a spike whose value can only be judged by
eye — nobody can tell from a diff whether scrubbing a 3D scene teaches
anything. Its verification cost alone is comparable to plotpolish's entire
design cost, which is why it should carry its own prototype and its own
decision, separately from slices 0-4.

**The lever.** Verification is now the dominant term in his time, so the way
to cut it is to make the prototype (slice 0) run on **his own teaching
programs**, not on invented demo code. A canned recording of a plotting loop
he actually assigns settles the capture policy and the feel question before any
Trinket file is touched, and moves the expensive category earlier and cheaper.

**What would falsify this.** If the expanded panel takes three design rounds
like plotpolish did, the ratio goes to ~1x on slices 0-4 alone.

## 9. Should this be its own repo, like plotpolish?

Three questions were asked together (new Claude folder, own GitHub repo,
minimally invasive hooks) and they do not have the same answer.

### The test plotpolish had to pass

The recorded spinout rationale was three-part: **reusable elsewhere** (Jupyter,
other edtech), **testable against matplotlib versions independently of
Trinket**, and **citable as an open tool**. Scored against the debugger:

| Criterion | plotpolish | Debug panel |
|---|---|---|
| Reusable elsewhere | strong — rcParams are universal to matplotlib | **weak.** Record & replay exists *because* Pyodide is on the browser main thread and cannot block. Jupyter has no such constraint and already has real live stepping, so the strongest reuse target is the weakest one here. Other browser-Python hosts (JupyterLite, PyScript, Basthon) do qualify — a narrower audience than "everyone using matplotlib". |
| Independent version matrix | strong — CI against mpl 3.8.4 and 3.10 | **medium.** There is a real matrix (CPython tracing semantics, `sys.monitoring` from 3.12, matplotlib for frame capture), but narrower. |
| Citable open tool | good | **arguably better** — a record-and-replay debugger for browser teaching environments is more interesting to the physics-education community than a style panel. |
| Adapter surface | tiny: `runPython` + get/setSource | **large:** line highlighting, gutter breakpoints, editor tab switching, console injection, a variables surface, a figure surface. Several are Ace-specific. |

### The decisive argument against a spinout: it is not greenfield

plotpolish was built from nothing. This is not — the recorder and replay are
**already in Trinket's `main`**, ~580 lines in `pyodide.js` plus template and
CSS, reviewed and behind `features.stepDebugger`. Spinning out means one of:

- **(a) Extract the recorder into a library and re-integrate.** A refactor of
  shipped, working, reviewed code in a repo Larry does not own, requiring
  Steve or Andrew to accept a large restructuring PR for **zero user-visible
  benefit**. That is the opposite of minimally invasive.
- **(b) Ship only the panel as a library.** Then the library is a UI shell with
  no engine, and the reuse story collapses — because the portable, valuable
  half (the tracer and the trace format) stays in Trinket.

That asymmetry is the whole answer. For plotpolish the *engine* was the
portable part and it went into the library. Here the engine already lives in
someone else's repo, and a spun-out panel would be the un-portable half.

### And a vendoring cost that plotpolish actually paid

A separate repo makes every change **two PRs** (library release + re-vendor)
plus a multi-hundred-KB blob in the diff. Concretely: Copilot's fork PR #3
returned "needs a closer look" with **zero findings**, the stated reason being
the size of the vendored bundle; and the re-vendor (#261) is still waiting in
Steve's queue. For a feature whose selling point is a small diff, that is
backwards.

### Recommendation

1. **Own GitHub repo: no**, for slices 0-5. Keep it in Trinket.
2. **Minimally invasive hooks: yes, emphatically — and this needs no separate
   repo.** The plotpolish *hook discipline* is independent of the plotpolish
   *packaging* decision: `plotpolish-adapter.js` is 356 lines living inside
   Trinket's own tree, gated by a flag, reaching into `pyodide.js` through
   three hooks. Copy that shape exactly for `public/js/plugins/debug-panel.js`
   + `features.debugPanel` + two or three hooks. It matters *more* here, because
   the diff lands in `pyodide.js` — 4 078 lines that the sympy and
   file-outputs work are also editing.
3. **New Claude folder/project: only if there is a new repo** — so, no. Memory
   is keyed to the project directory, and the stores were **deliberately
   consolidated on 2026-09-07** into the plotpolish store precisely because
   "the Trinket and plotpolish work is one effort". A third store would
   re-create the fragmentation that consolidation just fixed. Keep writing to
   the plotpolish store and treat it as the PICUP-Trinket-effort store.
   (The slice-0 prototype does want its own scratch folder — a standalone HTML
   file and an artifact. A folder, not a repo.)

### The cheap middle path, if the citation matters

Larry's strongest reason to spin out is credit, and that does not require a
library. Two moves get the optionality and the groundwork at near-zero cost:

- **Document and version the trace format** as an artifact in Trinket's
  `docs/design/` — the JSON a recording produces, with its caps and its
  `bpHit`/`truncated` semantics. That is the portable thing. If a
  second host ever wants it, extraction becomes mechanical; if none does,
  nothing was spent.
- **The citable artifact is a writeup**, not a package — the trace format plus
  what stepping backwards does for students in a real classroom. That is
  publishable on its own and does not need a repo to exist first.

Revisit the spinout only when a **second host actually asks**.

## 10. What collaborators would need to avoid

Snapshot of `PICUP-Physics/trinket-oss` on 2026-09-08. **Re-check before
acting; this goes stale fast.**

### The honest headline: almost nothing

Open PRs are exactly **two**: **#262** (Steve, Redis rate-limit TTL) and
**#261** (Larry's own plotpolish vendor). Steve's open-issue queue is LTI,
deploys, the share dialog, static assets, grading and docs; Andrew's is auth
and email. **None of it is in the Pyodide embed runner.** Asking either of them
to avoid files they are not touching would buy friction and nothing else.

Add to that: the feature lands behind `features.debugPanel: false`, so it can
merge dark. There is no reason for anyone to hold off on anything.

### Worth a heads-up, not a freeze (narrow regions, not whole files)

| Where | Why |
|---|---|
| `pyodide.js` ~1712-2290 | the recorder and replay themselves |
| `pyodide.js` ~2380 | `renderVariables()`'s `if (debugRec) return;` — the "replay owns the table" guard |
| `pyodide.js` ~3659-3666 | document-level ←/→ key handler, which the floating panel has to re-adjudicate against Ace |
| `pyodide.html` 412-478 + CSS ~72-300 | the `#variables-wrap` markup and its scoped styles |
| `_code_editor.scss:332` (`.tab-nav`) and `code-editor.js:947` / `.right-options` | any change to the file-tab bar moves the pill's default position |
| `#graphic` / `#graphic-wrap` | plotpolish's pill already anchors to `#graphic-wrap` and frame replay wants an `<img>` in `#graphic` — two features, one container |

Note the first three are **regions of a 4 078-line file**, not the file. Asking
for a ping on those is reasonable; asking for `pyodide.js` to be left alone is
not, and would block the sympy and file-output work for no benefit.

### The real risks are ordering, not simultaneous editing

1. **#261 should land first.** Larry's own, and the debug panel shares the
   overlay/pill concept with the adapter it re-vendors. Building on an
   unmerged vendor branch means rebasing over a 685-line diff.
2. **The matplotlib bump (#215's successor) is the landmine.** It replaces
   Pyodide's matplotlib patch 0004 with a restructured 0003 — new
   `backend_pyodide.py`, new `mpl_pyodide.js`, a different mock socket. Every
   line reference and every intercept in the frame-capture work must be
   re-verified at that bump. **This is the one thing worth explicitly asking to
   be told about in advance**, and Pyodide is still 0.28.1 today, so there is
   time.
3. **#253 / fork PR #4** carries the FS read plumbing that lazy frame-reading
   would reuse. Larry's own branch; just do not let it be refactored away.
4. **#254** ("a figure created after `plt.show()` is silently never drawn") is
   the *same* auto-display guard that frame capture touches. Better fixed **as
   part of** this work than separately, so two people are not in the same
   twenty lines.
5. **#247** (production gate for `features.mathOutput`) — `runProgram()` and
   `_trinket_display.py` wrap program execution, and the recorder wraps
   execution too. Worth knowing when that flag flips.

### One thing to ask *for* rather than warn about

**#206** — "turn on the browser integration suite we already have". Section 8
put hands-on verification as the dominant term in Larry's own time on this
feature. If Steve lands #206, it attacks exactly that cost. That is a request
to make, not a conflict to avoid.

## 11. Added ask: pin ("paperclip") a variable to a watch pane

Requested 2026-09-08: a paperclip button on the left edge of each variable row;
clicking it (a) floats that variable to the top of the list and (b) populates a
window docked to the bottom of the debug panel, the way plotpolish's popovers
dock under its pill.

### Why this is cheaper than it sounds — four facts from the code

1. **Both paint paths already funnel through one row builder.** `paintVariables()`
   (`pyodide.js:2379`, live explorer) and `paintReplaySnap()` (`:2035`, replay)
   both emit rows via **`varRowHtml()` (`:2337`)`. A paperclip cell added there
   appears in both surfaces at once. One insertion point, not two.
2. **Row identity already exists.** Every row carries `data-root` (top-level
   variable name) and `data-path` (path to this node), stashed for the lazy
   expand handler. That is exactly the key a pin set needs — no new identity
   scheme.
3. **Per-row buttons already have a precedent to copy.** `.var-copy` and
   `.var-toggle` are delegated handlers on `#variables-table`
   (`:3599`, `:3609`) with styles at `pyodide.html:170-196`. The paperclip is a
   third one beside them.
4. **Replay snapshots are flat** — `paintReplaySnap` always passes
   `expandable: false, path: [], depth: 0`. So in replay there are only
   top-level rows and the hard cases cannot arise.

### Where the sharp edges actually are

- **Ordering currently belongs to Python.** The only sort is
  `_out.sort(key=lambda d: (d['kind'] != 'value', d['name']))` at
  `pyodide.js:1541`, inside the helper. Pin-to-top means **JS takes over final
  ordering** — a stable sort in the two paint functions, pinned first,
  preserving the existing order within each group. Small, but it is a shift in
  which layer owns presentation order, and worth doing deliberately rather
  than by accident.
- **Pinning a *child* row is the one genuinely messy case.** `data-path` is
  *positional*, so a pinned child of a dict can silently come to mean a
  different key after mutation. **Recommendation: v1 pins top-level rows only**
  (spacer for child rows, exactly as `.var-toggle-spacer` already does). That
  removes the whole class of bugs, and costs nothing in replay where child rows
  do not exist anyway.
- **A pinned name need not exist at step *k*.** Needs an explicit "not defined
  yet" state in the watch pane, not a blank row — a variable appearing partway
  through the loop is the normal case, not an edge case.

### The finding worth acting on: history is already recorded

The recording holds **every** snapshot in `debugRec.snaps[]`. So the full time
series of any pinned variable is **already in memory**, for free, with zero
recorder changes. The watch pane can therefore show not just the current value
but the variable's whole trajectory across the run, with a click on any point
jumping `debugIdx` there.

That is the real teaching feature — watch `i` and `total` evolve across a whole
loop — and it is **impossible in a live debugger**, which only ever has "now".
It is a dividend of the record & replay architecture, not a workaround for it.

Caveats to build in honestly:

- The recorder's caps still apply: 50 vars/step and 120-char reprs. A variable
  dropped by the 50-var cap has **holes** in its history — render gaps as gaps,
  never as continuity.
- Snapshot values are **reprs (strings)**, not numbers. A numeric sparkline
  means parsing a repr back to a float; do that only when it parses cleanly and
  fall back to a text strip otherwise. Do not over-invest here.
- **Live mode has no history** — one snapshot only. So the pane has two modes:
  replay = timeline, live = current value. Decide that asymmetry on purpose.

### The boundary to write down now, because a paperclip invites crossing it

`pyodide-debugger-mvp.md` lists **"watch expressions"** as explicitly out of
scope. What is being asked for here is watch **variables** — pinning a name
that the recorder already captured — which is the cheap half and fine. Watching
an **expression** (`len(xs)`, `total/n`) is the expensive half and record &
replay **cannot do it retroactively**: the value never existed, so it would
require re-recording with the expression registered up front. Expect the
request ("why can't I watch `total/n`?") and have that answer ready.

### Cost

| Piece | Est. |
|---|---|
| Paperclip cell, delegated handler, pin state, pin-to-top stable sort | 0.5 d |
| Docked watch pane, current values, "not defined yet" state | 0.5-0.75 d |
| History timeline over `debugRec.snaps` with click-to-jump | 0.75-1 d |
| Pin persistence across runs/recordings | 0.25 d |
| **Total** | **1.5-2.5 d** |

Slices 0-4 go from **4-6 d** to **5.5-8.5 d**.

**In Larry's own time the ratio barely moves.** Almost all of this is
mechanical work in code with a clear precedent two lines away, and his
description plus plotpolish's docked-popover pattern already specify the
design. Section 8's ratio goes from ~0.5-0.7x to roughly **~0.55-0.75x** if
the pane shows current values, and **~0.7-0.9x** if he wants the history
timeline — the timeline being the only part that needs real design judgment
from him.

Free bonus: pin-to-top composes with the existing `.var-changed` diff
highlighting. Pinned rows at the top, highlighted the moment they change, is
most of a watch window before the docked pane is even built.

### Does it add a block to warn collaborators about?

**Yes, but it needs no new message** — it widens section 10's `pyodide.js`
heads-up from three regions to four:

- **new:** ~2321-2430 (`renderVariables`, `varRowHtml`, `paintVariables`)
- **new:** ~3595-3625 (the delegated `#variables-table` handlers)
- already listed: ~2035 (`paintReplaySnap`), ~2380 (the replay guard),
  ~3659 (keys), plus `pyodide.html`'s CSS which is inside the 72-300 range
  already flagged

No new file to guard, and **nobody's open PR or issue touches variable
rendering** — #262 is Redis rate limiting, and Steve's and Andrew's queues are
LTI, deploys, auth and email. The single sentence from section 10 still covers
it.

## 12. Gate: slice 4 waits for a second message to collaborators

**Decided 2026-09-08. Do not start slice 4 (matplotlib frame capture) until
Larry has sent collaborators a follow-up message naming its code regions.**
Slices 0-3 and 5 are not gated.

The reason is a promise already made in writing. The Mattermost post of
2026-09-08 gave collaborators the region list from section 10, pinned to
`7706618` with blob hashes, and said plainly that **work anywhere else would
not conflict**. That list covers the panel and the paperclip. It does not cover
slice 4, which additionally reaches:

- `RECORD_HELPER` in `pyodide.js`
- `MATPLOTLIB_SETUP_CODE` / `plt.close('all')` around `pyodide.js:44`
- the end-of-run auto-display guard around `pyodide.js:3250` (issue `#254`)
- `pyodide-worker.js` `MPL_SETUP`
- possibly `worker-client.js`, if a frame read needs a new message type
- `#graphic` / `#graphic-wrap` in `lib/views/embed/pyodide.html`

Breaking that promise costs more than a merge conflict does, so the sequencing
is: finish slices 0-3 and 5, send the follow-up, then start slice 4.

**And the converse, decided at the same time:** omissions from the posted list
that **nobody else is touching** &mdash; the `features.debugPanel` flag in
`config/default.yaml`, whatever emits the `<script>` tag for a new
`public/js/plugins/*.js`, test files &mdash; are deliberately **kept out** of
the collaborator message. Completeness and collision risk are different
questions and only the second warrants a correction. They belong in this
document and in the wish list, not in a second Mattermost post.

## 13. What the [Consult Fable] audit changed (2026-09-08)

The section 10 region list had already been given to collaborators as a promise
that work elsewhere would not conflict, so it was re-read adversarially against
`7706618` by a second model. **Every anchor held at its stated line.** The list
was incomplete, and three claims of this document were wrong.

### Added — regions the first pass missed

| File → region | Slice | Collision risk |
|---|---|---|
| `pyodide.html:543-563` — the `js` list and the `{% if config.features.plotStyle %}{% set js = js.concat(...) %}` at 560-562, emitted via `cachify_js` | 1 | **Moderate — the only one that matters.** Same script-emission path as Steve's open **#234** (content-addressing client-built asset URLs); he edited `lib/util/nunjucks.js` on 2026-09-04 and `lib/util/cachify.js` is the obvious next target. |
| `base.html:40-46` — the hand-maintained per-flag projection into `window.trinket.config` | 1 | Adjacent to #234. Without a `debugPanel` line the plugin never sees its flag. |
| `config/default.yaml:10-19` — the `features:` block | 1 | Low. Two lines of YAML. |
| `pyodide.js` five hook sites: `initialize()` ~3716-3735, `finishRun` 3225-3226, `onEditorChange` 3711-3713, `clearMemory` 3866-3890, `resetOutput` 139-140 | 1, 2, 4, 5 | Low. Only Larry has touched these since August. |
| `pyodide.js:3384-3394` — the auto-display guard, `g.querySelector('canvas')` at **3387** | 4 | Low, and it is `#254`, which this work already claims. |
| `pyodide.js:39-45` — `MATPLOTLIB_SETUP_CODE`, `_plt.close('all')` at :43 | 4 | Low, but note the existing sequencing constraint: the SymPy slice injects into the same region. |
| `plotpolish-adapter.js:205-239, 243-264` | 4 (interaction) | None — Larry's own, on #261. |
| `lib/views/static/whats-new.html:31-36` — user-facing text says step-through lives in the Variables tab | 1 | None. Docs-only, but it goes stale the moment the pill ships. |

Per Larry's instruction (2026-09-08), **only the `#234` overlap goes to
collaborators**; the rest are completeness, not collision, and live here.

### Withdrawn

`_code_editor.scss:332` and `code-editor.js` 947 / 1116 / 1120 / 1168 / 1293
**will not change.** The panel floats on its own layer and is never a child of
the tab bar. Listing them was harmless but it pointed at safe files while the
ones above went unlisted.

### Corrections to this document

1. **"Two or three small hooks" was wrong — it is five.** plotpolish needed
   `init`, `afterRun` twice, `onEditorChange` and `onFigureGone`, every one of
   them outside the handler block.
2. **The auto-display guard is at `3387`, not ~3250**, and no listed range
   covered it.
3. **`#253`'s FS read plumbing is NOT in `main`.** At `7706618` there is no
   `FS.readFile` or output-file code in `pyodide.js`, `pyodide-worker.js` or
   `worker-client.js` — it exists only on the fork branch. Section 3's "mostly
   assembled" was wrong; slice 4's lazy-frame route is **new code**, which puts
   it at the top of its 1.5-2.5 d range.
4. Section 2b cited `paintReplaySnap` at `:2097`; it is `:2035`.

### Confirmed as correctly absent

Slice 4 needs **neither** `pyodide-worker.js`'s `MPL_SETUP` **nor** new
`worker-client.js` message types, because the recorder never runs in the worker
(`pyodide.js:2207`). It needs no CSP change either: the real policy already
carries `img-src * data: blob:` and `style-src ... 'unsafe-inline'`.

### The overlay layer — where it can actually live

This was the open risk, and it is now answered. The chain is `#wrapper` (fixed,
inset 0) → `.trinket-wrapper` (`position: relative`) →
`.trinket-content-wrapper` (no position) → `#codeOutput` → `#outputContainer`
(absolute) → `#graphic-wrap`. **`#codeOutput` carries `overflow: hidden` in
`.mode-standard` at medium-up, and `#outputTabs` is `overflow: hidden` too**, so
an `absolute; inset: 0` layer under either is trapped — which is what the
slice-0 prototype does, and it would not survive the real embed.

Two mounts work, both reachable from the plugin with **no SCSS edit**, so "one
plugin file" survives: append the layer to `.trinket-wrapper`, which is already
`position: relative`; or use `position: fixed`, as plotpolish does.

**Z-index budget, to be agreed rather than discovered:** clear `.alert-box`
(999) and `.tab-options.open` (1000) — and plotpolish's pill is `fixed` at
`z-index: 2147483000` inside a shadow root, so with both features on the DEBUG
panel renders *under* it unless a number is chosen on purpose.

**Unverified:** Foundation 5.5.3's `.off-canvas-wrap { overflow: hidden }` and
the `.inner-wrap` transform on `.move-right`. `public/components` is gitignored
and absent from this checkout, so if that transform is present a `fixed` pill
will jump when the left off-canvas menu opens. **Check before choosing `fixed`.**

### Test surface

`embed-csp-contract.test.js:17-22` scans only `public/js/embed/*.js`, so a file
under `plugins/` is outside it, and it forbids only
`createElement('form'|'iframe')` and `.submit()` — nothing about overlays,
canvases or images. The one spec reading this markup is
`worker-runtime.spec.js:251-270` (`#variables-table tbody tr`), which variant A
leaves intact and variant B would have to update. No spec references `#debug-*`.

Also: `features.stepDebugger` requiring `features.variableExplorer` **is
enforced in code**, not only in docs — `pyodide.js:1721-1724` and
`pyodide.html:430`. Variant B relaxes both. And the `outputOnly` template branch
has no `#variables-wrap` or `#outputTabs` at all (`pyodide.html:400-409`) and
would not load the plugin, so the panel is absent there by construction — the
plugin should still null-check.
