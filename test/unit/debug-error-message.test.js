'use strict';
// `debugErrorMessage` — the one-line banner the step debugger shows when the
// recorded program raised.
//
// It is extracted and EXECUTED rather than read, because the defect it exists
// to guard against was a regex whose shape was right and whose behavior was
// not: an optional suffix group reduced the whole anchor to "any word followed
// by a colon", and a colon inside the student's own message then beat the real
// header. Reading the pattern is how that survived review; running it is how it
// was caught.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'public/js/embed/pyodide.js');

/** Lift one top-level `function name() { ... }` out of the embed source. */
function extract(name) {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in pyodide.js');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) {
      return src.slice(start, j + 1);
    }
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

// `debugRec` is a module-level binding in the embed; give the extracted
// function one it can close over.
function messageFor(error) {
  const body = extract('debugErrorMessage');
  // eslint-disable-next-line no-new-func
  const make = new Function('debugRec', body + '; return debugErrorMessage();');
  return make(error === undefined ? null : { error });
}

const TB = 'Traceback (most recent call last):\n  File "<exec>", line 3, in <module>\n';

describe('debugErrorMessage', () => {
  it('keeps a multi-line message whole, which is why it anchors at all', () => {
    expect(messageFor(TB + "ValueError: line one\nline two"))
      .toBe('ValueError: line one line two');
  });

  it('is not fooled by a colon inside the student\'s own message', () => {
    // The reported defect. With the suffix group optional this returned
    // "foo:" -- the last `word:` line wins -- losing the error type entirely.
    expect(messageFor(TB + "ValueError: a\nfoo:")).toBe('ValueError: a foo:');
  });

  it('still anchors on a custom exception whose name ends in nothing special', () => {
    // Simply making the suffix group required would send this to the
    // last-non-empty-line fallback, i.e. back to the bug above.
    expect(messageFor(TB + 'MyProblem: something went wrong'))
      .toBe('MyProblem: something went wrong');
  });

  it('prefers the header over a colon line below it for a custom exception', () => {
    expect(messageFor(TB + 'MyProblem: a\nfoo:')).toBe('MyProblem: a foo:');
  });

  it('never anchors on the traceback header or an indented File line', () => {
    const out = messageFor(TB + 'KeyError: \'k\'');
    expect(out).toBe("KeyError: 'k'");
    expect(out).not.toContain('Traceback');
    expect(out).not.toContain('File "');
  });

  it('takes the LAST exception of a chained traceback, which is the real one', () => {
    const chained = TB + 'ValueError: inner\n\n'
      + 'During handling of the above exception, another exception occurred:\n\n'
      + TB + 'RuntimeError: outer';
    expect(messageFor(chained)).toBe('RuntimeError: outer');
  });

  it('falls back to the last non-empty line when there is no header at all', () => {
    expect(messageFor('something went wrong\n\n')).toBe('something went wrong');
  });

  it('returns null with no recording and with no error', () => {
    expect(messageFor(undefined)).toBeNull();
    expect(messageFor('')).toBeNull();
  });
});
