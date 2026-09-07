'use strict';
// The file-outputs strip (#253) is rendered by renderFileOutputs() inside
// pyodide.js's top-level IIFE, so it is not reachable to import and the file is
// far too entangled to evaluate in jsdom. What can be pinned is the structural
// property the accessibility fix rests on, which is the same approach
// worker-figure-save.test.js takes to the page half of #252.
//
// The defect: every entry was built as
// `<a class="file-output" role="button" tabindex="0">`, including the ones over
// the size cap. A too-large entry has no click and no keydown handler, so a
// screen reader announced a button that does nothing and the keyboard stopped
// on it. Raised in the review of #253.
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', '..', 'public/js/embed/pyodide.js');

describe('file outputs — the entry element', () => {
  const src = fs.readFileSync(PAGE, 'utf8');

  it('does not put role or tabindex on the element every entry starts as', () => {
    expect(src).toContain("$('<a class=\"file-output\"></a>')");
    expect(src).not.toContain('class="file-output" role="button"');
    expect(src).not.toContain('class="file-output" tabindex');
  });

  it('makes only a downloadable entry interactive, and marks the other disabled', () => {
    const from = src.indexOf('var tooBig = entry.size >');
    expect(from).toBeGreaterThan(-1);
    const block = src.slice(from, src.indexOf('$wrap.append($a);', from));

    const disabled = block.indexOf("aria-disabled");
    const role     = block.indexOf("$a.attr('role', 'button')");
    const tabindex = block.indexOf("$a.attr('tabindex', '0')");
    const elseArm  = block.indexOf('} else {');

    expect(disabled).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(-1);
    expect(tabindex).toBeGreaterThan(-1);
    // aria-disabled belongs to the tooBig arm, role/tabindex to the other one.
    expect(disabled).toBeLessThan(elseArm);
    expect(role).toBeGreaterThan(elseArm);
    expect(tabindex).toBeGreaterThan(elseArm);
  });

  // On the worker path `read` is client.readFile(), whose promise carries no
  // reject but is built around a w.postMessage() call -- and a throw from
  // postMessage inside the Promise constructor becomes a rejection. A click on
  // a dead worker would then produce an unhandled rejection in the student's
  // console with nothing said on screen. Raised in the review of #253.
  it('handles a failed read on the download click instead of rejecting into the void', () => {
    const from = src.indexOf('var save = function()');
    expect(from).toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf("$a.on('click', save)", from));

    expect(body).toContain('.catch(');
    // and it says something, rather than swallowing a click the student made
    expect(body).toMatch(/\.catch\([\s\S]*writeOut\(/);
  });
});
