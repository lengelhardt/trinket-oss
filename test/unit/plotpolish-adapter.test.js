'use strict';
// The plot-style adapter, executed rather than read.
//
// This exists because a commit that claimed to stop the pill mounting over a
// Web VPython scene fixed exactly one of the two scene containers. hasFigure()
// excluded `#glowscript` by id, which is what setupGlowScene() builds for a
// main-thread run — but the worker path builds `#vpython-scene`, so with
// features.workerVPython on the matplotlib pill mounted over a 3D canvas and
// offered to write rcParams into a VPython program. Both containers carry
// className 'glowscript'; matching the class covers the pair. Nothing caught
// that, because nothing ran this file.
//
// The bundle is a real vendored artifact (public/js/vendor/plotpolish.iife.js),
// tracked but only present when features.plotStyle ships. Skip loudly rather
// than fail if it is missing, the same way glowcomm-host.test.js does.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..', '..');
const BUNDLE  = path.join(ROOT, 'public/js/vendor/plotpolish.iife.js');
const ADAPTER = path.join(ROOT, 'public/js/plugins/plotpolish-adapter.js');
const HAVE = fs.existsSync(BUNDLE) && fs.existsSync(ADAPTER);

// The embed's output pane, reduced to the nodes the adapter touches.
const PAGE = `<!doctype html><html><body>
  <div id="graphic-wrap" class="hide"><div id="graphic"></div></div>
  <div id="editor"></div>
</body></html>`;

function boot(opts) {
  const options = opts || {};
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;

  win.trinket = { config: { plotStyle: options.plotStyle !== false } };
  win.ace = { require: () => ({ Range: { fromPoints: (a, b) => [a, b] } }) };

  win.eval(fs.readFileSync(BUNDLE, 'utf8'));
  win.eval(fs.readFileSync(ADAPTER, 'utf8'));

  if (win.trinketPlotpolish) {
    const widget = { _files: [], getFile: () => '' };
    win.trinketPlotpolish.init({
      api: { getEditor: () => widget, getMainFile: () => 'main.py' },
      getPyodide: () => null,          // no live preview; mounting is what we test
      isBusy: () => false,
    });
  }
  return win;
}

/** Put a <canvas> in #graphic, optionally inside a scene container. */
function addCanvas(win, id) {
  const fig = win.document.getElementById('graphic');
  let host = fig;
  if (id) {
    const div = win.document.createElement('div');
    div.id = id;
    div.className = 'glowscript';   // both containers set this
    fig.appendChild(div);
    host = div;
  }
  host.appendChild(win.document.createElement('canvas'));
}

const pill = (win) => win.document.querySelector('plotpolish-panel');

const d = HAVE ? describe : describe.skip;
if (!HAVE) {
  // eslint-disable-next-line no-console
  console.warn('plotpolish-adapter.test.js: vendored bundle not present, skipping');
}

d('plot-style adapter — mounting', () => {
  it('mounts over a real matplotlib figure', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).not.toBeNull();
  });

  it('does not mount over a main-thread VPython scene (#glowscript)', () => {
    const win = boot();
    addCanvas(win, 'glowscript');
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).toBeNull();
  });

  // The sibling the original guard missed. pyodide.js builds this container id
  // on the worker path; an id-based check let it through.
  it('does not mount over a WORKER VPython scene (#vpython-scene)', () => {
    const win = boot();
    addCanvas(win, 'vpython-scene');
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).toBeNull();
  });

  it('does not mount when the output pane holds no figure at all', () => {
    const win = boot();
    win.document.getElementById('graphic').innerHTML = '<table><tr><td>1</td></tr></table>';
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).toBeNull();
  });
});

d('plot-style adapter — runtime and teardown', () => {
  it('gives a worker run no backend, and still mounts so the block can be written', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    const panel = pill(win);
    expect(panel).not.toBeNull();
    expect(panel.backend).toBeNull();
    expect(panel.features.livePreview).toBe(false);
  });

  it('Clear memory takes the panel down, and a later figure gets a fresh one', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).not.toBeNull();

    win.document.getElementById('graphic').innerHTML = '';
    win.trinketPlotpolish.onFigureGone();
    expect(pill(win)).toBeNull();

    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).not.toBeNull();
  });

  it('onFigureGone is a no-op when nothing was mounted', () => {
    const win = boot();
    expect(() => win.trinketPlotpolish.onFigureGone()).not.toThrow();
  });
});

d('plot-style adapter — the flag', () => {
  it('defines no global at all when features.plotStyle is false', () => {
    const win = boot({ plotStyle: false });
    expect(win.trinketPlotpolish).toBeUndefined();
  });

  it('so every hook in pyodide.js is a no-op when the flag is off', () => {
    const win = boot({ plotStyle: false });
    // This is the shape of all four call sites in pyodide.js.
    expect(() => { if (win.trinketPlotpolish) win.trinketPlotpolish.afterRun('main'); }).not.toThrow();
    expect(pill(win)).toBeNull();
  });
});
