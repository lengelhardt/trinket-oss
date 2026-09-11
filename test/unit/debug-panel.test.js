'use strict';
// The floating DEBUG panel, executed rather than read.
//
// This exists because the panel is 1,900 lines of stateful DOM with no
// coverage at all, next to plotpolish-adapter.test.js which has some -- and
// because three of the four real defects found in this plugin during review
// were found by RUNNING it, not by reading it. The invisible button, the pill
// that hid before it could deliver its own explanation, and the message that
// told students a variable was "not defined yet" when the filter above had
// already ruled that out: all three are the kind of thing an assertion catches
// and a careful reading does not.
//
// The panel talks to pyodide.js only through the handover object, which makes
// it testable without loading the 5,000-line host: hand it a fake ctx and drive
// the hooks the host would call.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT  = path.join(__dirname, '..', '..');
const PANEL = path.join(ROOT, 'public/js/plugins/debug-panel.js');

// The embed's editor pane, reduced to the nodes the panel actually anchors to.
// .trinket-wrapper is the mount target (it is position:relative; #codeOutput
// clips an absolute layer, which is why the panel does not live there).
const PAGE = `<!doctype html><html><body>
  <div id="wrapper"><div class="trinket-wrapper">
    <div class="trinket-content-wrapper"><div id="codeOutput"></div></div>
  </div></div>
</body></html>`;

function snap(names) {
  return names.map(function (n) {
    return { name: n[0], type: n[1] || 'int', repr: n[2] == null ? '1' : n[2] };
  });
}

// A ctx that answers everything the panel asks, with the interesting parts
// overridable per test.
function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM(PAGE, {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const win = dom.window;
  win.trinket = { config: { debugPanel: o.debugPanel !== false } };

  win.eval(fs.readFileSync(PANEL, 'utf8'));

  const calls = { start: 0, startDeferred: 0, cancel: 0, exit: 0, stepTo: [], autoStep: 0 };
  const state = Object.assign(
    { replaying: false, recording: false, idx: 0, note: '', total: 0, line: 0 },
    o.state || {}
  );
  const ctx = {
    isAvailable: function () { return o.available !== false; },
    getState: function () { return state; },
    getVarModel: function () {
      return o.model || { order: [], firstStep: Object.create(null), fromImport: Object.create(null) };
    },
    getVars: function (i) { return (o.vars && o.vars[i]) || []; },
    actions: {
      start: function () { calls.start++; },
      startDeferred: function () { calls.startDeferred++; },
      cancel: function () { calls.cancel++; },
      exit: function () { calls.exit++; },
      stepTo: function (i) { calls.stepTo.push(i); },
      step: function () {}, first: function () {}, last: function () {},
      autoStep: function () { calls.autoStep++; return true; },
      jumpBp: function () {},
    },
  };
  const panel = win.trinketDebugPanel;
  if (panel) panel.init(ctx);
  return { win, panel, ctx, state, calls, doc: win.document };
}

const pill = (d) => d.querySelector('.tk-dbg');
const vars = (d) => d.querySelector('.tk-dbg-vars');

// The variables window only paints while the pill is expanded -- collapsed is
// the resting state, and paintVars() returns early on it.
//
// NOTE: this DOES arm a recording. The click handler's `if (!expanded)` branch
// runs setExpanded(true, true) for ANY click on the closed pill, the toggle
// included -- an earlier version of this comment claimed otherwise and a test
// written against it armed twice. The arm is deferred one tick, so a test that
// cares has to advance the timer.
function expand(doc) {
  doc.querySelector('.tk-dbg [data-act="toggle"]').click();
}

// armRecording re-arms itself through setTimeout while the runner is busy, so
// a test that never advances the queue cannot observe what the queue does.
// Collect the callbacks instead of waiting 200ms a turn, and flush them by
// hand: the point of these tests is the ORDER of arm, cancel and retry.
function manualTimers(win) {
  const queued = [];
  const real = win.setTimeout;
  win.setTimeout = function (fn) { queued.push(fn); return queued.length; };
  return {
    pending: () => queued.length,
    flush() { queued.splice(0).forEach((fn) => fn()); },
    restore() { win.setTimeout = real; },
  };
}

describe('debug panel — the feature gate', () => {
  it('does not exist at all when features.debugPanel is off', () => {
    const { win, doc } = boot({ debugPanel: false });
    // The template also refuses to serve the file, but the guard inside it is
    // the one that has to hold if the flag is ever projected without the
    // template being updated.
    expect(win.trinketDebugPanel).toBeUndefined();
    expect(pill(doc)).toBeNull();
  });

  it('mounts a pill into .trinket-wrapper when the flag is on', () => {
    const { panel, doc } = boot({});
    expect(panel).toBeTruthy();
    const p = pill(doc);
    expect(p).toBeTruthy();
    expect(p.closest('.trinket-wrapper')).toBeTruthy();
    // NOT inside #codeOutput, which clips an absolutely positioned layer.
    expect(p.closest('#codeOutput')).toBeNull();
  });

  it('mount is idempotent — a second init does not build a second pill', () => {
    const { panel, ctx, doc } = boot({});
    panel.init(ctx);
    expect(doc.querySelectorAll('.tk-dbg').length).toBe(1);
  });
});

describe('debug panel — availability', () => {
  it('hides the pill when the host says the program cannot be stepped', () => {
    const { doc } = boot({ available: false });
    expect(pill(doc).hidden).toBe(true);
  });

  it('shows it when the host says it can', () => {
    const { doc } = boot({ available: true });
    expect(pill(doc).hidden).toBe(false);
  });
});

describe('debug panel — edit teardown', () => {
  // REGRESSION. An edit that drops the program below two runnable lines (or
  // turns it into VPython) makes isAvailable() false. sync() hid the pill on
  // that alone -- so the explanation onEditorChange() had just promised was
  // never delivered, and the student was left with a replay that vanished and
  // no account of why.
  it('keeps the pill visible after an edit exits replay, even if the program is no longer steppable', () => {
    const h = boot({ available: true, state: { replaying: true, idx: 3 } });
    h.state.replaying = false;
    h.ctx.isAvailable = () => false;      // the edit made it unsteppable
    h.panel.onEditorChange(true);         // ...and it exited a replay
    expect(pill(h.doc).hidden).toBe(false);
  });

  it('relabels the launch control so the message has an answer', () => {
    const h = boot({ available: true, state: { replaying: true, idx: 3 } });
    h.state.replaying = false;
    h.panel.onEditorChange(true);
    expect(h.doc.querySelector('.tk-dbg').textContent).toContain('Restart Debugger');
  });

  it('a plain Run answers the edit message too', () => {
    const h = boot({ available: true, state: { replaying: true, idx: 3 } });
    h.state.replaying = false;
    h.panel.onEditorChange(true);
    h.panel.afterRun();
    expect(h.doc.querySelector('.tk-dbg').textContent).toContain('Step Through');
  });

  it('an edit that did NOT interrupt a replay promises nothing', () => {
    const h = boot({ available: true });
    h.panel.onEditorChange(false);
    expect(h.doc.querySelector('.tk-dbg').textContent).not.toContain('Restart Debugger');
  });
});

describe('debug panel — the variables window', () => {
  const model = {
    order: ['t', 'constructor', 'gone'],
    firstStep: Object.assign(Object.create(null), { t: 0, constructor: 0, gone: 0 }),
    fromImport: Object.create(null),
  };

  function replaying(extra) {
    const h0 = boot(Object.assign({
      available: true,
      state: { replaying: true, recording: false, idx: 1, total: 4, line: 2 },
      model,
      vars: { 0: snap([['t'], ['constructor'], ['gone']]),
              1: snap([['t', 'int', '2'], ['constructor', 'int', '7']]) },
    }, extra || {}));
    expand(h0.doc);
    return h0;
  }

  // REGRESSION. The name-keyed maps were plain objects, so `dropped[nm]` and
  // `nm in firstStep` answered truthy through Object.prototype for a student
  // variable called `constructor`, `toString` or `valueOf` -- and the row
  // vanished before it was ever recorded.
  it('shows a variable whose name collides with Object.prototype', () => {
    const h = replaying();
    const text = vars(h.doc).textContent;
    expect(text).toContain('constructor');
    expect(text).toContain('7');
  });

  // REGRESSION. Names first defined AFTER this step are already filtered out
  // by `firstStep[nm] > s.idx`, so reaching the null branch means the name was
  // deleted or belongs to another frame -- not that it is yet to appear.
  it('does not claim a missing value is "not defined yet"', () => {
    const h = replaying();
    const text = vars(h.doc).textContent;
    expect(text).toContain('gone');
    expect(text).not.toContain('not defined yet');
    expect(text).toContain('not available at this step');
  });

  it('says nothing about variables while not replaying', () => {
    const h = boot({ available: true, model, vars: { 0: snap([['t']]) } });
    const v = vars(h.doc);
    expect(!v || v.hidden).toBe(true);
  });
});

describe('debug panel — cancelling a queued recording', () => {
  // The panel queues a recording when the runner is busy and starts it once the
  // host goes idle. A cancel pressed during the queued window has nothing to
  // cancel yet, so it has to be remembered -- otherwise the recording starts
  // after the student asked for it not to.
  // These two used to call h.ctx.actions.cancel() / .start() directly and
  // assert the fake's own counter had moved. That passes with the panel
  // deleted -- it exercised the mock, not armWaiting/armCancelled. Drive the
  // pill instead.
  it('a cancel while the recording is only QUEUED stops it ever starting', () => {
    const h = boot({ available: true, state: { busy: true } });
    const t = manualTimers(h.win);
    try {
      // Opening the COLLAPSED pill is itself the request to record: the
      // click handler's `if (!expanded)` branch runs setExpanded(true, true)
      // for any click on the closed pill, the toggle included. (The helper's
      // comment above claiming otherwise is wrong -- found by this test.)
      expand(h.doc);
      // setExpanded defers the arm one tick so the expand animation and the
      // blocking recording do not fight over a frame, so nothing has armed
      // yet -- this pending callback IS the arm.
      expect(t.pending(), 'opening the pill should queue the arm').toBeGreaterThan(0);
      t.flush();                           // the arm runs; the runner is busy
      expect(h.calls.start, 'a busy runner must not be recorded yet').toBe(0);

      // The cancel the pill renders WHILE it waits. Assert it is actually
      // SHOWN: querySelector finds hidden nodes, and a first draft of this
      // test passed a hidden button and proved nothing.
      const recGrp = h.doc.querySelector('[data-grp="recording"]');
      expect(recGrp.hidden, 'the waiting state has to be visible').toBe(false);
      const cancel = recGrp.querySelector('[data-act="cancel"]');
      expect(cancel).toBeTruthy();

      // Its whole point: nothing is recording yet, so it must NOT reach
      // actions.cancel() -- there is nothing there to flag. Refusing to
      // re-arm is the only thing that can actually stop it.
      cancel.click();
      expect(h.calls.cancel, 'nothing is recording, so there is nothing to cancel').toBe(0);

      t.flush();                           // the queued retry runs, and refuses
      h.state.busy = false;                // the runner goes idle afterwards
      t.flush();
      expect(h.calls.start, 'a cancelled queue must never start').toBe(0);
    } finally { t.restore(); }
  });

  it('a queued recording that is NOT cancelled starts once the runner idles', () => {
    // The control for the test above: without it, "start was never called"
    // proves nothing, because a queue that is simply broken never starts
    // anything either.
    const h = boot({ available: true, state: { busy: true } });
    const t = manualTimers(h.win);
    try {
      expand(h.doc);
      t.flush();                           // the deferred arm; runner is busy
      expect(h.calls.start).toBe(0);
      t.flush();                           // still busy -> re-arms
      expect(h.calls.start).toBe(0);
      h.state.busy = false;
      t.flush();                           // now idle -> starts, exactly once
      expect(h.calls.start).toBe(1);
      t.flush();
      expect(h.calls.start, 'and not again').toBe(1);
    } finally { t.restore(); }
  });
});
