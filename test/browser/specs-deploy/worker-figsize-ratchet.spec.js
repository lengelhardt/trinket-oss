const { test, expect } = require('@playwright/test');

// THE FIGSIZE RATCHET, READ OFF THE DOWNLOADED FILE.
//
// The whole claim of the pane fit is that the window sets SCALE and the student
// sets SHAPE: fitting scales `figure.dpi` with `figsize` held fixed, so the file
// you download is the same composition however wide the browser happened to be.
// A ratchet -- a fit that quietly recomputes figsize -- breaks exactly that, and
// it is invisible on screen, because a figure that got 1% narrower in inches and
// 1% denser in dpi occupies the same pixels.
//
// panefit.spec.js checks the fit's own state and the canvas geometry. Neither
// can see figsize on the WORKER: Python is in a worker thread and the page has
// no channel to ask it, so `window.__trinketPaneFit` reports the box and the
// classifier's decisions but nothing from matplotlib. That is the gap this file
// exists for, and it is the runtime where the ratchet is most likely, because
// the worker's fit round trip is asynchronous and can overlap other traffic.
//
// The trick, from Fable's consult-7 probe `t7_3_worker_ratchet.js` (kept at
// harness/pw/consult7-probes/ and NOT runnable as rescued -- its shared `h.js`
// never made it out of that session's scratchpad, so this is a port onto the
// repo's own helpers rather than a copy): drive the toolbar's own Download,
// intercept the blob before it reaches the filesystem, and read the PNG's IHDR.
// `savefig.dpi` is pinned to 300, so width_px / 300 IS figsize[0] in inches,
// straight from Agg. Python never has to be asked.
//
// TWO independent pins that happen to agree, and the WORKER's is the one this
// file is named for: pyodide.js:83 for the main thread, pyodide-worker.js:379
// for the worker, which carries its own setup string, its own
// _trinket_savefig_dpi() and its own save path. Mutating only the main-thread
// pin moves main and leaves the worker at 1440x1080, which looks exactly like
// "the worker ignores savefig.dpi" and is not.
//
// 660_000: see the note in panefit.spec.js. runFigure waits up to 240_000 and
// the slower test then walks five download cycles behind it (a baseline plus
// four fits), so the enclosing budget has to exceed the largest assertion
// timeout AND cover the walk.
test.describe.configure({ timeout: 660_000 });

const SAVEFIG_DPI = 300;

const PROG = [
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  't = np.linspace(0, 10, 300)',
  'plt.plot(t, np.exp(-0.35*t)*np.cos(4*t))',
  "plt.xlabel('time (s)'); plt.ylabel('displacement (m)'); plt.title('Damped')",
  'plt.show()',
  'print("FINI")',
].join('\n');

// Capture the download in the page instead of letting Playwright save it: mpl.js
// builds a blob URL and clicks a synthetic anchor, and the bytes are what we
// want, not a file on disk. Installed as an init script so it is in place before
// any figure exists.
const CAPTURE_DOWNLOADS = () => {
  window.__downloads = [];
  window.__blobs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (b) {
    const u = orig(b);
    window.__blobs.push({ url: u, blob: b });
    return u;
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      const href = this.getAttribute('href') || '';
      const rec = window.__blobs.find(b => b.url === href);
      window.__downloads.push({
        name: this.download,
        href: href.startsWith('data:') ? href : null,
        blob: rec ? rec.blob : null,
      });
      return;                       // swallow it; nothing should hit the disk
    }
    return click.call(this);
  };
};

async function runFigure(page, query, viewport) {
  await page.addInitScript(CAPTURE_DOWNLOADS);
  await page.setViewportSize(viewport);
  await page.goto('/embed/python3' + query);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((s) => {
    document.querySelector('.ace_editor').env.editor.setValue(s, 1);
  }, PROG);
  // The embed's own event, not `.run-it`: below about 1100 px that control is a
  // split button whose click opens a menu instead of running.
  await page.evaluate(() => { $('#editor').trigger('trinket.code.run', { action: 'code.run' }); });
  // textContent, not innerText: at narrow widths the output pane is tabbed and
  // innerText of the hidden console is '', which reads as a run that never
  // finished and times out four minutes later.
  await expect.poll(async () => page.evaluate(() =>
    document.querySelector('#console-output')?.textContent || ''),
    { timeout: 240_000 }).toContain('FINI');
  await page.locator('#graphic canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(4000);           // the fit's round trip, then settle
}

// Press Download and decode the PNG header. Returns null if nothing was
// captured, which the vacuity guard below turns into a failure rather than a
// silently skipped assertion.
async function downloadFigsize(page) {
  await page.evaluate(() => { window.__downloads.length = 0; });
  await page.locator('#graphic button.mpl-widget[title^="Download"]').first().click();
  // Agg has to render the whole figure at 300 dpi and ship it back; on the
  // worker that is a round trip through the worker's own message queue.
  await expect.poll(async () => page.evaluate(() => window.__downloads.length),
    { timeout: 60_000, message: 'the toolbar Download produced no blob' }).toBeGreaterThan(0);
  return page.evaluate(async (dpi) => {
    const d = window.__downloads[0];
    let bytes;
    if (d.blob) {
      bytes = new Uint8Array(await d.blob.arrayBuffer());
    } else if (d.href) {
      const bin = atob(d.href.split(',')[1]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      return { png: false, reason: 'neither a blob nor a data: href' };
    }
    // PNG signature, then IHDR width/height as big-endian u32 at bytes 16..23.
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || sig.some((v, i) => bytes[i] !== v)) {
      return { png: false, reason: 'not a PNG', bytes: bytes.length, name: d.name };
    }
    const u32 = (o) => ((bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0);
    const px = [u32(16), u32(20)];
    return { png: true, name: d.name, bytes: bytes.length, px, figsize: [px[0] / dpi, px[1] / dpi] };
  }, SAVEFIG_DPI);
}

function readProbe(page) {
  return page.evaluate(() => {
    const st = window.__trinketPaneFit.state();
    const one = st[Object.keys(st)[0]];
    const c = document.querySelector('#graphic canvas');
    return {
      box: one.box,
      pendingFits: one.pendingFits,
      // seq/seqAtFit are what the classifier actually decides on since
      // 7d57c8f. Exposed here for the interlock test below, which is the only
      // thing in the suite that reads them.
      seq: one.seq,
      seqAtFit: one.seqAtFit,
      canvas: { w: c.clientWidth, h: c.clientHeight },
      kinds: window.__trinketPaneFit.classified.map(e => e.kind),
      log: window.__trinketPaneFit.classified.map(e => `${e.kind}:${e.w}x${e.h}`),
    };
  });
}

// A drag of the figure's own corner handle: hold ~150 ms, then steps ~40 ms
// apart, matching panefit.spec.js.
//
// The hold is usually justified by "a fast synthetic drag never engages
// `resize: both`". Measured here rather than repeated, three gestures on the
// same page on main:
//
//   A  this drag (80 + 150 + 6x40 ms)      559 ms   +6 drag entries  395 -> 275
//   B  the same with every wait removed     59 ms   +1 drag entry    515 -> 395
//   C  the whole gesture inside one evaluate, synthetic MouseEvents
//                                          5.9 ms    0 drag entries  div UNMOVED
//
// So the fact holds at the limit (C) and not at B: four CDP round trips still
// leave ~15 ms between mousedown and mousemove, and 15 ms is enough to engage
// the native resizer. Removing the explicit waits is a mutation of the waits,
// not of the timing.
//
// The hold stays, for a reason the old comment did not give: B lands ONE drag
// sample and A lands SIX. The guard below is `> 0`, so both pass, but a
// one-sample drag exercises neither the classifier's repeat handling nor the
// 150 ms fit debounce -- and on a faster machine CDP latency shrinks toward C.
async function slowCornerDrag(page, dx, dy) {
  const c = await page.evaluate(() => {
    const r = document.querySelector('#graphic canvas').parentNode.getBoundingClientRect();
    return { x: Math.round(r.right - 5), y: Math.round(r.bottom - 5) };
  });
  await page.mouse.move(c.x, c.y);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.waitForTimeout(150);
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(c.x + dx * i / 6, c.y + dy * i / 6);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(2500);
}

// Both runtimes. The worker is the one this technique exists for, but main is
// the control: the same walk with a synchronous round trip. A ratchet that shows
// on both is a bug in the fit; one that shows only on the worker is a bug in the
// asynchronous path, and the file should say which.
for (const [label, query] of [['worker', '?runtime=worker'], ['main', '?runtime=main']]) {
  test.describe(`figsize ratchet (${label})`, () => {
    test(`${label}: resizing the pane never changes the downloaded figure`, async ({ page }) => {
      await runFigure(page, query, { width: 1280, height: 900 });

      const first = await downloadFigsize(page);

      // VACUITY GUARD, BEFORE ANYTHING ELSE. Every assertion below compares
      // figsizes recovered from a PNG. If the interception missed the blob, if
      // the toolbar shipped an SVG because the format dropdown moved, or if the
      // IHDR decode landed on the wrong offset, the comparisons are between two
      // pieces of the same garbage and pass. Mutation-tested by pointing the
      // decoder at byte 0 instead of 16: the bounds below caught it, reporting
      // figsize 7679138.37 in -- the PNG signature read as a u32 -- before the
      // walk ran. The bounds are the guard; `png === true` alone is not, because
      // a valid signature says nothing about where the dimensions were read.
      expect(first, 'the Download was intercepted').not.toBeNull();
      expect(first.png, `the download is a PNG: ${JSON.stringify(first)}`).toBe(true);
      expect(first.px[0], `IHDR width looks like a figure: ${JSON.stringify(first)}`)
        .toBeGreaterThan(300);
      // PIN THE DIVISOR. If the effective savefig.dpi is not 300, every figsize
      // here is wrong by that ratio and the walk still passes, because it only
      // ever compares figsizes to each other -- invariance and change are both
      // ratios. What a wrong divisor corrupts is every number printed in a
      // failure message, which is what a person debugging acts on.
      //
      // The figure is 4.8 x 3.6 in: BOTH setup strings set figure.figsize
      // (pyodide.js:78, pyodide-worker.js:374), so at 300 dpi this is
      // 1440 x 1080 px on both runtimes, measured. An earlier version of this
      // comment said "matplotlib's default figure, which the program does not
      // resize: 6.4 x 4.8 in ... 1920 x 1440" -- wrong on both counts, and that
      // error is how the bounds came to be 3..20, a window admitting 187 to
      // 1250 dpi. Verified: at those bounds, mutating either setup string to
      // savefig.dpi = 600 gave 2880 x 2160 and the guard said nothing.
      //
      // +/-10% of the true figure, which is a guard rather than a sanity check.
      expect(first.figsize[0], `figsize from a ${SAVEFIG_DPI} dpi PNG: ${JSON.stringify(first)}`)
        .toBeGreaterThan(4.3);
      expect(first.figsize[0], `figsize from a ${SAVEFIG_DPI} dpi PNG: ${JSON.stringify(first)}`)
        .toBeLessThan(5.3);

      // THE WALK. Fits only -- four different pane widths, no drags. Every one
      // of these must leave the downloaded file byte-identical in composition.
      const FITS = [1000, 1400, 900, 1280];
      const seen = [{ at: 'start (1280)', figsize: first.figsize, px: first.px }];
      for (const w of FITS) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(3500);            // debounce, round trip, settle
        const d = await downloadFigsize(page);
        expect(d.png, `download at ${w}px is a PNG: ${JSON.stringify(d)}`).toBe(true);
        seen.push({ at: `fit ${w}`, figsize: d.figsize, px: d.px });
      }

      // Vacuity guard for the walk itself: if the fits never bit, nothing was
      // tested. The canvas must actually have changed size across the sequence.
      const probe = await readProbe(page);
      expect(probe.kinds.filter(k => k === 'echo').length,
        `the fits never reached Python: ${probe.log.join(' ')}`).toBeGreaterThan(1);

      // SYMPTOM FIRST: what a student would see, which is that the file they
      // download is the same picture whatever the window did. Compared in whole
      // PIXELS, not rounded inches -- a ratchet of a hundredth of an inch is 3 px
      // at 300 dpi and is exactly the drift this guards against.
      for (const s of seen.slice(1)) {
        expect(s.px, `${s.at} changed the downloaded file. Walk: ${JSON.stringify(seen)}`)
          .toEqual(seen[0].px);
      }

      // MECHANISM SECOND: a fit is classified as an echo, never as a drag.
      // Nobody dragged anything yet, and a misclassified echo IS the ratchet.
      expect(probe.kinds.filter(k => k === 'drag'),
        `no drags yet: ${probe.log.join(' ')}`).toHaveLength(0);
      expect(probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
    });

    test(`${label}: a corner drag does change it, and the new shape then holds`, async ({ page }) => {
      // The other half, and the reason the test above is not vacuous: figsize is
      // not simply frozen. The student's corner drag is the one thing that IS
      // allowed to recompute it, so if the first test passed because nothing can
      // ever change figsize, this one fails.
      await runFigure(page, query, { width: 1280, height: 900 });
      const before = await downloadFigsize(page);
      expect(before.png, `baseline is a PNG: ${JSON.stringify(before)}`).toBe(true);

      await slowCornerDrag(page, -140, -90);

      const probe = await readProbe(page);
      // Vacuity guard: the native resizer is easy to miss entirely, and a walk
      // over a drag that never happened proves nothing.
      expect(probe.kinds.filter(k => k === 'drag').length,
        `the corner drag never engaged the native resizer: ${probe.log.join(' ')}`)
        .toBeGreaterThan(0);

      const after = await downloadFigsize(page);
      expect(after.png, `post-drag download is a PNG: ${JSON.stringify(after)}`).toBe(true);
      expect(after.px, `the drag did not reach the downloaded file: ${before.px} -> ${after.px}`)
        .not.toEqual(before.px);

      // And then the NEW shape is what fits preserve. This is the ratchet's real
      // hiding place: a fit after a drag, where the classifier has just seen a
      // genuine drag and the next echo arrives on its heels.
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.waitForTimeout(3500);

      // VACUITY GUARD for this clause, and it was missing: with paneFit disabled
      // outright the assertion below passes, because "the fit preserved the
      // shape" and "no fit happened" are the same pixels. Test 1's guard caught
      // that mutation and this one did not.
      const afterProbe = await readProbe(page);
      expect(afterProbe.kinds.filter(k => k === 'echo').length,
        `the post-drag fit never reached Python: ${afterProbe.log.join(' ')}`)
        .toBeGreaterThan(probe.kinds.filter(k => k === 'echo').length);

      const refit = await downloadFigsize(page);
      expect(refit.px, `a fit after a drag moved figsize: ${after.px} -> ${refit.px}`)
        .toEqual(after.px);
    });

    test(`${label}: three fits in flight, four times over, never ratchet figsize`, async ({ page }) => {
      // THE RATCHET COPILOT FOUND ON #305, as a test rather than as an argument.
      //
      // paneFit caps `pendingFits` at 2 (pyodide.js:3954) and sends
      // unconditionally two lines later, so with THREE fits in flight the
      // counter reads 2, three echoes come back, and the third finds the
      // counter at 0. Under the old classifier -- `st.pendingFits > 0 &&
      // st.seq === st.seqAtFit` -- that third echo fell through to the drag
      // branch and handle_resize recomputed figsize from CSS pixels.
      //
      // WHY THE OTHER TWO TESTS IN THIS FILE CANNOT SEE IT. Both walk the pane
      // one width at a time with a 3.5 s settle between, which produces one fit
      // at a time by construction; the state is never reached. And the only
      // thing either asserts about the counter is `toBeLessThanOrEqual(2)`,
      // which is satisfied by the 0 that IS the defect. An upper bound cannot
      // detect an undercount, so the counter is not the observable -- the
      // CLASSIFICATION of the third echo is.
      //
      // THE LEVER, ported from harness/pw/ratchet-repro.js. Wrap
      // `mpl.figure.prototype.send_message` and hold outgoing
      // 'trinket_pane_fit' messages, change the box three times, then release
      // them spaced apart. The page's own logic is untouched: the same three
      // messages are sent, just delivered late, which is what a slow worker
      // does. Holding is what makes "three in flight" deterministic rather than
      // a race against the round trip (9-12 ms worker, 104-117 ms main), and a
      // race is not something to ship in a spec.
      //
      // Two properties of that rig are load-bearing and were both learned by
      // getting them wrong:
      //
      //   WIDTH, not height. dpi = min(w/4.8, h/3.6). At a width-bound
      //   viewport, varying the wrap's HEIGHT gives three distinct box
      //   signatures that all fit to ONE size -- zero div resizes, zero echoes,
      //   and a green test that provoked nothing.
      //
      //   SPACED on release, not released together. Three resizes inside one
      //   animation frame coalesce into a single ResizeObserver delivery, so
      //   three sends produce one echo and the third -- the only one under
      //   test -- never exists.
      //
      // WHY FOUR CYCLES AND NOT ONE, which is the part that makes this a
      // ratchet test rather than a classifier test. Measured against the
      // defective classifier, one provocation moves figsize by NOTHING: the
      // phantom drag recomputes figsize from a canvas size the fit itself just
      // asked for, so at dpr 1 it round-trips back to 4.8 x 3.6 in exactly and
      // the downloaded PNG is still 1440 x 1080. A single cycle is therefore
      // invisible in the file, and a one-cycle version of this test would have
      // shipped a download assertion that cannot fail. Four cycles at different
      // widths accumulate the truncation, monotonically and in one direction --
      // which is what the word ratchet means:
      //
      //   cycle 0  echo:496x372 echo:446x334 drag:396x297   1440x1080
      //   cycle 1  echo:598x448 echo:538x403 drag:478x358   1440x1078
      //   cycle 2  echo:518x387 echo:468x350 drag:418x313   1440x1078
      //   cycle 3  echo:558x417 echo:498x372 drag:438x327   1440x1075
      //
      // Identical on both runtimes. Height only: width is the bound dimension
      // here, so 1440 never moves and only the free dimension drifts. Five
      // pixels at 300 dpi is 0.0167 in -- invisible on screen, permanent in
      // every file the student downloads afterwards.
      await runFigure(page, query, { width: 1280, height: 900 });

      const before = await downloadFigsize(page);
      expect(before.png, `baseline is a PNG: ${JSON.stringify(before)}`).toBe(true);

      // Four triples, each one a different span, so no cycle repeats another's
      // box signatures -- a repeat would be dropped by the signature check at
      // pyodide.js:3937 and the cycle would send fewer than three.
      //
      // THE THINNEST CONSTANT IN THIS TEST is the 600px in cycle 1. dpi =
      // min(w/4.8, h/3.6), and at this viewport width stops binding at a pane
      // of about 634px, so 600 sits roughly 27px of pane height from the point
      // where HEIGHT becomes the bound dimension -- at which case varying width
      // would stop changing the fitted size and the cycle would send three and
      // echo fewer. It fails loudly rather than silently (the delivery guard
      // below catches it), but anyone widening these numbers should know the
      // ceiling is there.
      const CYCLES = [
        ['498px', '448px', '398px'],
        ['600px', '540px', '480px'],
        ['520px', '470px', '420px'],
        ['560px', '500px', '440px'],
      ];
      const every = [];

      for (let cycle = 0; cycle < CYCLES.length; cycle++) {
        const out = await page.evaluate(async (widths) => {
          const held = [];
          const proto = window.mpl.figure.prototype;
          const orig = proto.send_message;
          proto.send_message = function (type, payload) {
            if (type === 'trinket_pane_fit') { held.push([this, type, payload]); return; }
            return orig.call(this, type, payload);
          };
          const wrap = document.getElementById('graphic-wrap');
          const start = window.__trinketPaneFit.classified.length;
          for (const w of widths) {
            wrap.style.width = w;
            window.__trinketPaneFit.fit();
            await new Promise(r => setTimeout(r, 30));
          }
          const sentWhileHeld = held.length;
          const stMid = window.__trinketPaneFit.state();
          const pendingAtRelease = stMid[Object.keys(stMid)[0]].pendingFits;
          proto.send_message = orig;
          for (const [fig, type, payload] of held) {
            const before = window.__trinketPaneFit.classified.length;
            orig.call(fig, type, payload);
            // WAIT FOR THE DELIVERY, do not sleep a fixed gap. This used to be
            // `setTimeout(120)`, which is only 3 ms beyond the measured
            // 104-117 ms main-thread round trip: under load the previous
            // release could still be in flight when the next one went out,
            // both deliveries would land in one animation frame, and the
            // ResizeObserver would coalesce them. The delivery guard below
            // then FAILS -- so the failure mode is a flake, not a false pass,
            // which in this file is the worse of the two. Its own header says
            // a flaky test here reads as the ratchet coming back.
            //
            // This does NOT weaken the precondition. All three fits left
            // paneFit while the messages were held, so they are already in
            // flight by every measure the classifier uses -- `sentWhileHeld`
            // and `pendingAtRelease` are both captured above, before the first
            // release. The spacing exists only to stop the browser merging
            // three deliveries into one, so pacing it on the delivery itself
            // is strictly more faithful than pacing it on a clock.
            const deadline = Date.now() + 5000;
            while (window.__trinketPaneFit.classified.length === before &&
                   Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 20));
            }
            // A frame after it lands, so the next release starts its own.
            await new Promise(r => setTimeout(r, 40));
          }
          await new Promise(r => setTimeout(r, 4000));
          return {
            sentWhileHeld,
            pendingAtRelease,
            log: window.__trinketPaneFit.classified.slice(start).map(e => `${e.kind}:${e.w}x${e.h}`),
          };
        }, CYCLES[cycle]);

        const where = `cycle ${cycle} (${CYCLES[cycle].join(' ')})`;
        every.push(`[${where}] ${out.log.join(' ')}`);
        const kinds = out.log.map(s => s.split(':')[0]);

        // PRECONDITION, asserted EXACTLY. Three fits left paneFit while their
        // echoes were held, and the counter stopped at its cap -- which is the
        // undercount itself, pinned in the direction the six existing
        // `toBeLessThanOrEqual(2)` assertions on this branch cannot pin. If the
        // signature check dropped one of the three, or the cap moved, this says
        // so rather than quietly measuring two fits.
        expect(out.sentWhileHeld, `${where}: three fits sent while echoes were held`).toBe(3);
        // This one pins BOOKKEEPING, not a decision: 7d57c8f deliberately
        // demoted pendingFits out of the discriminator, and `sentWhileHeld`
        // above already establishes the precondition on its own. It is kept as
        // documentation of the state that used to break the classifier. If
        // pendingFits is ever retired, this is the assertion that will look
        // like a real regression and is not one.
        expect(out.pendingAtRelease, `${where}: pendingFits pinned at its cap (bookkeeping)`).toBe(2);

        // VACUITY GUARD, COUNTING DELIVERIES AND NOT ECHOES.
        //
        // The design note for this test (harness/panefit-coverage-round7.md,
        // the addendum) prescribed guarding on the ECHO count, reasoning that
        // `pendingFits` is the broken quantity and cannot witness its own
        // failure. That is right and it does not go far enough: on the defect
        // the third delivery is classified a DRAG, so the echo count drops to
        // 2 and an echo-based guard fires FIRST -- reporting "the releases
        // coalesced" for a run in which nothing coalesced. A vacuity guard must
        // not be computed from the quantity under test, and here the
        // classification is that quantity. The delivery count is independent of
        // it: three held fits released 120 ms apart give three deliveries
        // whatever the classifier calls them, verified on both runtimes against
        // both versions of the classifier.
        // 'chrome' is EXCLUDED because it is a note without a delivery behind
        // it: paneFitNote('chrome', ...) is appended from the echo's own rAF
        // (pyodide.js:4347) when the chrome is re-measured, so two real
        // deliveries plus one chrome note would satisfy a raw log count. The
        // test would still go red on the echo count below, but it would go red
        // with the wrong message -- which is the same class of defect this
        // guard was rewritten to avoid, one step further along.
        expect(out.log.filter(s => !s.startsWith('chrome')).length,
          `${where}: each released fit must produce a delivery -- ${out.log.join(' ')}`)
          .toBeGreaterThanOrEqual(3);

        // MECHANISM. Nobody touched the figure, so nothing here may be read as
        // a drag. `st.seq === st.seqAtFit` asks the question the count was
        // standing in for -- has a gesture begun since we last asked Python for
        // a size -- and no gesture began.
        expect(kinds.filter(k => k === 'drag'), `${where}: a fit was read as a drag -- ${out.log.join(' ')}`)
          .toHaveLength(0);
        // The same fact from the other side, EXACTLY rather than as a bound,
        // because an undercount is the failure this test exists for.
        expect(kinds.filter(k => k === 'echo').length,
          `${where}: every released fit came back as an echo -- ${out.log.join(' ')}`).toBe(3);
      }

      // SYMPTOM, and it is an independent detector rather than decoration:
      // with the two mechanism assertions above removed and the classifier
      // reverted, this one still fails, 1440x1080 -> 1440x1075 on both
      // runtimes. Compared in whole PIXELS, not rounded inches -- the drift is
      // hundredths of an inch and invisible on screen, because a figure 1%
      // shorter in inches and 1% denser in dpi occupies the same pixels.
      const after = await downloadFigsize(page);
      expect(after.png, `post-provocation download is a PNG: ${JSON.stringify(after)}`).toBe(true);
      expect(after.px, `in-flight fits ratcheted figsize: ${before.px} -> ${after.px}\n${every.join('\n')}`)
        .toEqual(before.px);
    });

    test(`${label}: a tab switch after a corner drag is a re-show, not a drag`, async ({ page }) => {
      // THE ONE STATE NOTHING ELSE IN THE SUITE ENTERS: seq !== seqAtFit.
      //
      // Found by an adversarial mutation pass, not by reading. Subordinating
      // the re-show test to the gesture test -- so a re-delivery only reaches
      // it when seq === seqAtFit -- leaves every other test in this file and
      // in panefit.spec.js GREEN, including both corner-drag tests and the
      // re-show test itself. The re-show test only ever exercises an ORDINARY
      // re-show, where no gesture has happened and seq === seqAtFit, so the
      // echo branch would have caught it anyway.
      //
      // The uncovered path is the one a student actually walks: resize the
      // figure by its corner, click to Instructions and back. A corner drag
      // bumps seq and does NOT change #graphic-wrap's box, so the pointerup
      // fit is skipped by the box-signature check (pyodide.js:3937) before it
      // can stamp seqAtFit -- leaving seq ahead of seqAtFit indefinitely. The
      // re-delivery on show then misses the echo branch, and if the re-show
      // test is not above the drag branch it lands in the drag branch and
      // handle_resize recomputes figsize from CSS pixels. That is the ratchet,
      // reached without a single fit being misclassified.
      //
      // So this test exists because `fd5fbf7`'s claim that the placement
      // invariant was pinned was true only for the ordinary case.
      await runFigure(page, query, { width: 1280, height: 900 });

      await slowCornerDrag(page, -140, -90);

      const dragged = await downloadFigsize(page);
      expect(dragged.png, `post-drag download is a PNG: ${JSON.stringify(dragged)}`).toBe(true);

      // PRECONDITION, asserted rather than assumed, because the whole test is
      // about a state and a test that never reaches it proves nothing. If the
      // pointerup fit were NOT skipped it would stamp seqAtFit, the two would
      // agree, and everything below would be a duplicate of the ordinary
      // re-show test at three times the runtime.
      const before = await readProbe(page);
      expect(before.seq, `the drag never bumped seq: ${JSON.stringify(before)}`).toBeGreaterThan(0);
      expect(before.seqAtFit,
        `the pointerup fit was not skipped, so this is not the state under test: ${JSON.stringify(before)}`)
        .not.toBe(before.seq);

      const n = before.kinds.length;
      await page.evaluate(() => { $(document).trigger('trinket.instructions.view'); });
      await page.waitForTimeout(1200);
      await page.evaluate(() => { $(document).trigger('trinket.output.view'); });
      await page.waitForTimeout(2500);

      const after = await readProbe(page);
      const added = after.log.slice(n);

      // MECHANISM. With seq ahead of seqAtFit the echo branch cannot catch
      // this, so the re-show branch is the only thing standing between the
      // student and a recomputed figsize.
      expect(added.filter(s => s.startsWith('reshow')).length,
        `the post-drag re-show was not classified as one: ${added.join(' ')}`).toBe(1);
      expect(added.filter(s => s.startsWith('drag')),
        `the post-drag re-show was read as a drag: ${added.join(' ')}`).toHaveLength(0);

      // SYMPTOM. The shape the student chose with the corner drag survives the
      // tab switch, in the file they download.
      const reshown = await downloadFigsize(page);
      expect(reshown.px,
        `a tab switch after a drag moved figsize: ${dragged.px} -> ${reshown.px}. Notes: ${added.join(' ')}`)
        .toEqual(dragged.px);
    });

    test(`${label}: a fit during a held gesture never stamps seqAtFit`, async ({ page }) => {
      // THE INTERLOCK, which 7d57c8f leans on and nothing asserted.
      //
      // The classifier's whole question is `st.seq === st.seqAtFit` -- has a
      // gesture begun since we last asked Python for a size. That is only
      // exact because paneFit returns at `if (st.pointerDown)` BEFORE it
      // stamps seqAtFit, and the single pointerdown listener does
      // `st.seq++; st.pointerDown = true;` in one synchronous statement. Move
      // the stamp above the guard and the interlock is gone.
      //
      // THE FIRST VERSION OF THIS TEST WAS VACUOUS AND IS WORTH RECORDING. It
      // did a six-sample corner drag and asserted seqAtFit had not moved --
      // which passes with the stamp moved above the guard, because a plain
      // corner drag never calls paneFit AT ALL. canvas_div is what resizes,
      // #graphic-wrap is what the observer watches, so no fit is issued during
      // the gesture and there is nothing for the guard to stop. The assertion
      // held for a reason unrelated to the thing it claimed to pin.
      //
      // The provocation has to CALL paneFit while the pointer is down, which
      // `__trinketPaneFit.fit()` does directly and deterministically -- no
      // viewport race, no reliance on the native resizer.
      //
      // If this breaks, a real drag gets classified as an echo: Python drops
      // the resize and the student's corner drag does nothing at all.
      await runFigure(page, query, { width: 1280, height: 900 });

      const before = await readProbe(page);
      // Boot leaves the two agreeing -- the startup fit stamps seqAtFit. Said
      // out loud because the comparison below is only meaningful if they
      // started equal.
      expect(before.seqAtFit, `boot should leave the two agreeing: ${JSON.stringify(before)}`)
        .toBe(before.seq);

      const held = await page.evaluate(() => {
        const div = document.querySelector('#graphic canvas').parentNode;
        const opts = { bubbles: true, composed: true, pointerId: 1, pointerType: 'touch', isPrimary: true };
        div.dispatchEvent(new PointerEvent('pointerdown', opts));
        // The box must CHANGE, or paneFit returns at the signature check
        // (pyodide.js:3937) on its way past and the guard is never the thing
        // that stopped it -- the same vacuity as the drag version, one step
        // further in.
        document.getElementById('graphic-wrap').style.width = '470px';
        window.__trinketPaneFit.fit();
        const st = window.__trinketPaneFit.state();
        const one = st[Object.keys(st)[0]];
        const out = { seq: one.seq, seqAtFit: one.seqAtFit, pointerDown: one.pointerDown, deferred: one.deferred };
        div.dispatchEvent(new PointerEvent('pointercancel', opts));
        return out;
      });

      // VACUITY GUARDS. The gesture has to be live and the fit has to have
      // reached the guard, or seqAtFit standing still proves nothing.
      expect(held.pointerDown, `the synthetic pointerdown did not register: ${JSON.stringify(held)}`)
        .toBe(true);
      expect(held.seq, `pointerdown did not bump seq: ${JSON.stringify(held)}`)
        .toBeGreaterThan(before.seq);
      expect(held.deferred, `the fit did not reach the pointerDown guard: ${JSON.stringify(held)}`)
        .toBe(true);

      // THE INVARIANT. paneFit returned at the guard without stamping, so
      // seqAtFit still holds the value boot left it with and the classifier
      // can still tell a gesture from an echo.
      expect(held.seqAtFit,
        `a fit stamped seqAtFit mid-gesture: ${JSON.stringify(held)}`)
        .toBe(before.seqAtFit);
    });
  });
}
