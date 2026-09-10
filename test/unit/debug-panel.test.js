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
// the resting state, and paintVars() returns early on it. The DEBUG toggle is
// the route in that does NOT also start a recording (the grip tap does).
function expand(doc) {
  doc.querySelector('.tk-dbg [data-act="toggle"]').click();
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
  it('a cancel while the recording is only queued stops it starting', () => {
    const h = boot({ available: true, state: { recording: true } });
    h.panel.sync();
    h.ctx.actions.cancel();
    expect(h.calls.cancel).toBe(1);
    expect(h.calls.start).toBe(0);
  });

  it('the host is asked to start exactly once per launch', () => {
    const h = boot({ available: true });
    h.ctx.actions.start();
    expect(h.calls.start).toBe(1);
  });
});

describe('debug panel — plot mode and the third row', () => {
  // The row is a grid item in a grid that declares only its COLUMNS, so it
  // lands in an implicit third row and no grid CSS changes. jsdom does no
  // layout, so these assert the state machine; the geometry (84 -> 121, three
  // 33.5px rows, nothing clipped) was measured in a browser harness rendering
  // the real panel against the repo's own Foundation CSS.
  const plotBtn = (d) => d.querySelector('[data-act="plotstoggle"]');
  const plotRow = (d) => d.querySelector('[data-el="plotrow"]');

  it('plot mode is off until the student asks, and wantsPlots says so', () => {
    const { panel, doc } = boot({});
    expect(panel.wantsPlots()).toBe(false);
    expect(plotRow(doc).hidden).toBe(true);
    expect(pill(doc).classList.contains('plots')).toBe(false);
  });

  it('the plot icon is hidden on the collapsed pill and appears when it opens', () => {
    const { doc } = boot({});
    expect(plotBtn(doc).hidden).toBe(true);
    expect(plotBtn(doc)).toBeTruthy();
    expand(doc);
    expect(plotBtn(doc).hidden).toBe(false);
  });

  it('the icon toggles plot mode, and reaches its handler at all', () => {
    // The delegated listener is on $pill, so a control has to be INSIDE the
    // pill to be clickable. This is the assertion that proves it — the rules
    // sheet's planned home in $help fails exactly here.
    const { panel, doc } = boot({});
    expand(doc);
    plotBtn(doc).click();
    expect(panel.wantsPlots()).toBe(true);
    expect(plotBtn(doc).getAttribute('aria-pressed')).toBe('true');
    plotBtn(doc).click();
    expect(panel.wantsPlots()).toBe(false);
  });

  it('the row appears only while replaying, though the preference outlives that', () => {
    const h = boot({ state: { replaying: false } });
    expand(h.doc);
    plotBtn(h.doc).click();
    expect(h.panel.wantsPlots()).toBe(true);
    // Preference on, but nothing to replay: no frame counter over a program
    // that is not being stepped.
    expect(plotRow(h.doc).hidden).toBe(true);
    expect(pill(h.doc).classList.contains('plots')).toBe(false);

    h.state.replaying = true;
    h.panel.sync();
    expect(plotRow(h.doc).hidden).toBe(false);
    expect(pill(h.doc).classList.contains('plots')).toBe(true);
  });

  it('the X leaves plot mode and returns the pill to two rows', () => {
    const h = boot({ state: { replaying: true } });
    expand(h.doc);
    plotBtn(h.doc).click();
    expect(pill(h.doc).classList.contains('plots')).toBe(true);

    h.doc.querySelector('[data-act="plotsoff"]').click();
    expect(h.panel.wantsPlots()).toBe(false);
    expect(plotRow(h.doc).hidden).toBe(true);
    expect(pill(h.doc).classList.contains('plots')).toBe(false);
    expect(plotBtn(h.doc).getAttribute('aria-pressed')).toBe('false');
  });

  it('line / frame is a two-state control and drives stepsByFrame', () => {
    const h = boot({ state: { replaying: true } });
    expand(h.doc);
    plotBtn(h.doc).click();
    const byline  = () => h.doc.querySelector('[data-act="byline"]');
    const byframe = () => h.doc.querySelector('[data-act="byframe"]');

    expect(byline().getAttribute('aria-pressed')).toBe('true');
    expect(byframe().getAttribute('aria-pressed')).toBe('false');
    expect(h.panel.stepsByFrame()).toBe(false);

    byframe().click();
    expect(byframe().getAttribute('aria-pressed')).toBe('true');
    expect(byline().getAttribute('aria-pressed')).toBe('false');
    expect(h.panel.stepsByFrame()).toBe(true);

    byline().click();
    expect(h.panel.stepsByFrame()).toBe(false);
  });

  it('stepsByFrame is false whenever plot mode is off, whatever was last chosen', () => {
    // Otherwise turning plots off would leave the host stepping by a frame
    // list it is no longer being given.
    const h = boot({ state: { replaying: true } });
    expand(h.doc);
    plotBtn(h.doc).click();
    h.doc.querySelector('[data-act="byframe"]').click();
    expect(h.panel.stepsByFrame()).toBe(true);
    h.doc.querySelector('[data-act="plotsoff"]').click();
    expect(h.panel.stepsByFrame()).toBe(false);
  });

  it('the frame counter says nothing until the recorder supplies frames', () => {
    const h = boot({ state: { replaying: true } });
    expand(h.doc);
    plotBtn(h.doc).click();
    const fc = () => h.doc.querySelector('[data-el="fcount"]');
    expect(fc().textContent).toBe('');

    h.state.frameIdx = 7; h.state.frameTotal = 42;
    h.panel.sync();
    expect(fc().textContent).toBe('7 / 42');
  });

  it('turning plots on does not start, cancel or exit anything', () => {
    // It is a preference, not a command: it must not reach ctx.actions.
    const h = boot({ state: { replaying: true } });
    expand(h.doc);
    plotBtn(h.doc).click();
    h.doc.querySelector('[data-act="byframe"]').click();
    h.doc.querySelector('[data-act="plotsoff"]').click();
    expect(h.calls.start).toBe(0);
    expect(h.calls.cancel).toBe(0);
    expect(h.calls.exit).toBe(0);
    expect(h.calls.stepTo).toEqual([]);
  });

  it('the preference survives a launch that never became a recording', () => {
    // The exact scenario that broke the deferred-recording flag: it was reset
    // by every exit armRecording has that is not "the recording started".
    const h = boot({ state: { replaying: false } });
    expand(h.doc);
    plotBtn(h.doc).click();
    expect(h.panel.wantsPlots()).toBe(true);

    h.state.recording = true;  h.panel.sync();
    h.state.recording = false; h.panel.sync();   // cancelled, never replayed
    expect(h.panel.wantsPlots()).toBe(true);

    h.panel.afterRun();                          // an ordinary Run afterwards
    expect(h.panel.wantsPlots()).toBe(true);
  });
});
