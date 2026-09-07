'use strict';
// The worker's Save path (#252) is Python embedded in a JS string array, so
// nothing in this suite type-checks it and nothing runs it. What can be pinned
// here is the structural property the fix actually rests on, plus the shape of
// the page-side half.
//
// The ordering is the load-bearing part. The {type:'save'} swallow has to come
// BEFORE `_m.handle_json(_evt)`. If it ever moves after, handle_json dispatches
// to Pyodide's patched Python handle_save first, which renders the figure and
// delivers it with document.createElement('a') -- against the worker's inert
// stub. The swallow would then still run and the file would still arrive, so
// the regression would not look like a failure: Save would appear to work while
// rendering the figure twice, once into nothing. That is precisely the kind of
// thing a human does not notice and a test does.
const fs = require('node:fs');
const path = require('node:path');

const ROOT   = path.join(__dirname, '..', '..');
const WORKER = path.join(ROOT, 'public/js/embed/pyodide-worker.js');
const PAGE   = path.join(ROOT, 'public/js/embed/pyodide.js');

/**
 * The worker source as text. Deliberately NOT evaluated: every assertion below
 * is about the order and presence of lines, which the raw source answers just
 * as well, and evaluating the MPL_SETUP array literal would break confusingly
 * the day it stops being one.
 */
function workerSource() {
  return fs.readFileSync(WORKER, 'utf8');
}

describe('worker figure save — the worker source', () => {
  const py = workerSource();

  it('swallows the save message before handle_json can dispatch it', () => {
    const swallow = py.indexOf("if _evt.get('type') == 'save':");
    const dispatch = py.indexOf('_m.handle_json(_evt)');

    expect(swallow).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(swallow).toBeLessThan(dispatch);
  });

  it('returns from the save branch rather than falling through to dispatch', () => {
    const branch = py.slice(py.indexOf("if _evt.get('type') == 'save':"),
                            py.indexOf('_m.handle_json(_evt)'));
    expect(branch).toContain('return');
  });

  it('renders with savefig, not from a canvas', () => {
    expect(py).toContain('savefig');
    expect(py).not.toContain('toDataURL');
  });

  it('reports a failed render instead of swallowing it', () => {
    const branch = py.slice(py.indexOf("if _evt.get('type') == 'save':"),
                            py.indexOf('_m.handle_json(_evt)'));
    expect(branch).toContain('save-error');
  });

  // The same silence that made #252 hard to find: matplotlib alerts on an
  // unsupported format, and a no-op stub makes that indistinguishable from a
  // successful save.
  it('routes alert() to the console rather than discarding it', () => {
    const src = fs.readFileSync(WORKER, 'utf8');
    const stub = src.slice(src.indexOf('function installDomStubs()'),
                           src.indexOf('var MPL_SETUP'));
    expect(stub).toContain('self.alert');
    expect(stub).toMatch(/self\.alert = function[^}]*stderr/s);
  });
});

// This is the half that running it actually caught. Everything above was in
// place and the button still did nothing, because worker-client scopes every
// `type: 'figure'` message to the current run and drops the rest -- and a save
// reply, by its nature, arrives after the run has settled and `current` is
// null. The scoping is right for frame data and wrong for a file.
describe('worker figure save — the run-scoping exemption', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/embed/worker-client.js'), 'utf8');
  const branch = src.slice(src.indexOf("if (msg.type === 'figure')"),
                           src.indexOf("if (msg.type === 'scene-ops')"));

  it('lets a save reply through after the run that made the figure has settled', () => {
    expect(branch).toContain("msg.kind === 'save'");
    expect(branch).toContain("msg.kind === 'save-error'");
  });

  it('still scopes ordinary figure frames to the current run', () => {
    expect(branch).toMatch(/!current \|\| msg\.id !== current\.id/);
  });
});

describe('worker figure save — the page half', () => {
  const src = fs.readFileSync(PAGE, 'utf8');

  it('handles the save and save-error kinds the worker sends', () => {
    expect(src).toContain("msg.kind === 'save'");
    expect(src).toContain("msg.kind === 'save-error'");
  });

  // The worker's reply is not a trusted source for this: MPL_SETUP and the
  // student's program share pyodide.globals, so student Python can call
  // _trinket_mpl_send and pick the string that lands in `download`.
  it('constrains the extension it puts in the download filename', () => {
    expect(src).toMatch(/\[a-z0-9\]\{1,5\}/);
    expect(src).not.toContain("'plot.' + (saved.format");
  });

  // Pyodide's patched mpl.js does not call ondownload, but the patch is theirs
  // and not ours. If a future Pyodide restores the call, this must not quietly
  // become a canvas grab -- toDataURL ignores savefig.dpi, .transparent and
  // .bbox_inches, so a student who set dpi=300 would get screen pixels.
  it('does not grab the canvas anywhere', () => {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(code).not.toContain('toDataURL');
  });
});
