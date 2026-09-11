"""
Tests for the step-debugger recorder's byte accounting — DEBUG_MAX_BYTES.

The recorder is the RECORD_HELPER Python source embedded in
public/js/embed/pyodide.js as a JS array of string literals. It runs inside
Pyodide, in the tracer's hot path, and its payload bound is what stops a
student's tab filling with a multi-megabyte recording. That bound was an
ESTIMATE rather than a bound, under-counting the encoded payload by 30-75% on
ordinary programs -- see issue #274, and note it had been patched twice before
without being fixed.

These tests execute the real helper. Payload bytes under Pyodide are IDENTICAL
to native CPython (measured on four programs, 2026-09-10), which is what makes
testing it out here meaningful: `json.dumps` is deterministic and the reprlib
configuration does not vary by build. Only TIMING needs Pyodide, and timing is
deliberately not asserted here -- a wall-clock assertion on a shared CI runner
is a flake generator.

Run under BOTH 3.13 (what Pyodide 0.28.1 ships) and 3.14:

    python3 test/lib/embed/test_debug_recorder_bytes.py
"""
import json
import os
import re
import sys

_HERE = os.path.dirname(__file__)
_PYODIDE_JS = os.path.join(
    _HERE, '..', '..', '..', 'public', 'js', 'embed', 'pyodide.js')


def _read_js():
    with open(_PYODIDE_JS, encoding='utf-8') as fh:
        return fh.read()


def _js_unquote(lit):
    """Decode one JS string literal (either quote style) to a Python str.

    Written out rather than routed through json.loads: a JS single-quoted
    literal can contain a bare `"` and an escaped `\\'`, neither of which JSON
    accepts, and the obvious placeholder trick fails because JSON rejects raw
    control characters.
    """
    body = lit[1:-1]
    out = []
    i = 0
    while i < len(body):
        c = body[i]
        if c != '\\':
            out.append(c)
            i += 1
            continue
        nxt = body[i + 1]
        if nxt == 'u':
            out.append(chr(int(body[i + 2:i + 6], 16)))
            i += 6
        else:
            out.append({'n': '\n', 't': '\t', 'r': '\r'}.get(nxt, nxt))
            i += 2
    return ''.join(out)


def _extract_helper(js):
    """Pull RECORD_HELPER out of pyodide.js and join it back into Python.

    The array holds single- and double-quoted JS string literals plus //
    comment lines. Deliberately not a JS parser: if this stops matching, the
    helper's formatting changed and the test SHOULD fail loudly rather than
    silently test nothing.
    """
    start = js.index('var RECORD_HELPER = [')
    open_br = js.index('[', start)
    end = js.index('].join(', open_br)
    body = js[open_br + 1:end]

    lines = []
    for raw in body.split('\n'):
        s = raw.strip()
        if not s or s.startswith('//'):
            continue
        if s.endswith(','):
            s = s[:-1]
        assert s[0] in '"\'' and s[-1] == s[0], (
            'unparsed RECORD_HELPER entry: %r' % (raw,))
        lines.append(_js_unquote(s))
    assert len(lines) > 100, 'expected the whole helper, got %d lines' % len(lines)
    return '\n'.join(lines)


def _consts(js):
    """The DEBUG_* constants, read from the same file the helper came from."""
    def num(name, mult=1):
        m = re.search(r'^var\s+' + name + r'\s*=\s*([0-9]+)', js, re.M)
        assert m, 'constant not found: %s' % name
        return int(m.group(1)) * mult
    return {
        '_max_steps': num('DEBUG_MAX_STEPS'),
        '_max_vars': num('DEBUG_MAX_VARS'),
        '_max_repr': num('DEBUG_MAX_REPR'),
        '_max_depth': num('DEBUG_MAX_DEPTH'),
        '_lookback': num('DEBUG_LOOKBACK_STEPS'),
        '_max_dormant': num('DEBUG_MAX_DORMANT'),
        '_max_bytes': num('DEBUG_MAX_BYTES', 1024 * 1024),
        '_min_out': num('DEBUG_MIN_OUTPUT_BYTES', 1024),
        '_user_prefix': '/home/pyodide/',
        '_defer': False,
    }


_JS = _read_js()
_HELPER = _extract_helper(_JS)
_CONSTS = _consts(_JS)
_CAP = _CONSTS['_max_bytes']


def record(program, **over):
    """Run the real recorder over `program`; return (payload dict, bytes, ns)."""
    lines = _HELPER.split('\n')
    ns = dict(_CONSTS)
    ns.update(over)
    ns['_bp'] = over.get('_bp', {})
    ns['_user_source'] = program
    exec(compile('\n'.join(lines[:-1]), '<record_helper>', 'exec'), ns)
    payload = eval(compile(lines[-1], '<record_helper_final>', 'eval'), ns)
    return json.loads(payload), len(payload.encode('utf-8')), ns


# A loop that records far more than the cap allows, with enough live variables
# that the snapshots dominate -- the shape the under-count showed up on.
BIG_LOOP = '\n'.join(
    ['a%02d = %d.5' % (i, i) for i in range(1, 21)] + [
        'xs = []',
        'ys = []',
        'i = 0',
        'while i < 3000:',
        '    xs.append(i * 1.5)',
        '    ys.append(i * 2.5)',
        '    i = i + 1',
    ])

# Identifiers and values students actually write: theta, omega, CJK labels.
# Every BMP non-ASCII character costs 6 encoded bytes while being charged 1
# under the old accounting -- cause (2) in #274.
NON_ASCII = (
    'label = "\u4f4d\u7f6e\uff08\u30e1\u30fc\u30c8\u30eb\uff09" * 12\n'
    '\u03b8 = 0.35\n'
    '\u03c9 = 12.5\n'
    'notes = ["\u03b8 \u304c\u5927\u304d\u3044" for _k in range(8)]\n'
    'i = 0\n'
    'while i < 3000:\n'
    '    \u03b8 = \u03b8 + 0.001\n'
    '    i = i + 1\n')


def test_payload_stays_within_the_cap_on_a_big_loop():
    _d, n, _ns = record(BIG_LOOP)
    assert n <= _CAP, (
        'payload %d bytes exceeds DEBUG_MAX_BYTES %d by %.1f%% -- the bound is '
        'an estimate again (issue #274)' % (n, _CAP, (n / _CAP - 1) * 100))


def test_payload_stays_within_the_cap_on_non_ascii():
    _d, n, _ns = record(NON_ASCII)
    assert n <= _CAP, (
        'payload %d bytes exceeds DEBUG_MAX_BYTES %d -- non-ASCII reprs and '
        'identifiers are being charged in characters, not encoded bytes' % (n, _CAP))


def test_the_accounting_predicts_the_payload():
    """_nsize must be a close estimate, not a 1.4-2.0x under-count."""
    for label, prog in (('big loop', BIG_LOOP), ('non-ascii', NON_ASCII)):
        d, n, ns = record(prog)
        assert not d['output'], 'these programs print nothing'
        predicted = ns['_nsize'][0]
        ratio = predicted / float(n)
        assert 0.97 <= ratio <= 1.03, (
            '%s: accounting predicted %d for a %d-byte payload (%.1f%%); it '
            'must be within 3%%' % (label, predicted, n, ratio * 100))


def test_output_is_not_charged_against_its_own_allowance():
    """The double-subtract: moving a print must not change how much survives.

    Output growth used to be charged into the same counter the output allowance
    was computed from, so a mid-program print was budgeted against bytes it had
    already spent -- it kept 40% while the identical print on the last line kept
    100%. Same program, one line moved.
    """
    # 1.5 MB, deliberately: the allowance is 2 MiB, so a print this size only
    # gets truncated if it is charged twice. At 300 KB the bug is invisible --
    # nothing truncates either way and the test passes on the broken code.
    blob = 1500000
    mid = 'blob = "x" * %d\nprint(blob)\na = 1\nb = 2\nc = a + b\n' % blob
    last = 'blob = "x" * %d\na = 1\nb = 2\nc = a + b\nprint(blob)\n' % blob
    d_mid, _n1, _ = record(mid)
    d_last, _n2, _ = record(last)
    kept_mid = len(d_mid['output'])
    kept_last = len(d_last['output'])
    assert kept_mid >= blob, (
        'a mid-program print kept only %d of %d characters; output is being '
        'subtracted from its own allowance (issue #274)' % (kept_mid, blob))
    assert kept_mid == kept_last, (
        'moving the print changed what survived: %d chars mid-program vs %d on '
        'the last line' % (kept_mid, kept_last))


def test_oversized_output_is_still_truncated_and_says_so():
    """The bound must hold when output alone exceeds it."""
    prog = 'blob = "y" * 4000000\nprint(blob)\na = 1\n'
    d, n, _ns = record(prog)
    assert n <= _CAP, 'payload %d exceeds cap %d on a 4 MB print' % (n, _CAP)
    assert 'output truncated' in d['output'], 'no truncation marker for the student'


def test_non_ascii_output_flood_respects_the_bound():
    """The incremental output charge counts raw characters, so it under-counts
    escaped non-ASCII by up to 6x. The final clamp measures json.dumps and is
    what actually enforces the bound -- this is the test that it does.
    """
    prog = ('n = 0\n'
            'while n < 4000:\n'
            '    print("\u4f4d\u7f6e\u3068\u901f\u5ea6\uff1a\u8a08\u7b97\u4e2d" * 20)\n'
            '    n = n + 1\n')
    d, n, _ns = record(prog)
    assert n <= _CAP, (
        'payload %d exceeds cap %d -- encoded non-ASCII output escaped the '
        'bound' % (n, _CAP))
    assert 'output truncated' in d['output']


def test_the_type_name_is_clamped():
    """type(v).__name__ went into every entry, charged nothing, unclamped."""
    name = 'Z' * 5000
    prog = ('class %s:\n    pass\nv = %s()\nw = 1\n' % (name, name))
    d, _n, _ns = record(prog)
    entries = [e for sn in d['snaps'] for e in sn]
    assert entries, 'no variables were snapshotted'
    worst = max(len(e['type']) for e in entries)
    assert worst <= _CONSTS['_max_repr'] + 3, (
        'a type name reached %d characters; it must be clamped to _max_repr '
        '(%d) + the ellipsis' % (worst, _CONSTS['_max_repr']))


def test_the_step_that_trips_the_cap_is_not_appended():
    """Steps and snapshots must stay in lockstep, and the recording must end on
    a step whose snapshot exists -- the cap now trips after building both."""
    d, _n, _ns = record(BIG_LOOP)
    assert d['truncated'] is True, 'this program must trip the cap'
    assert len(d['steps']) == len(d['snaps']), (
        '%d steps vs %d snaps -- a step was appended without its snapshot'
        % (len(d['steps']), len(d['snaps'])))
    assert d['steps'][-1]['func'] == '<end>', (
        'the recording must still end on the synthetic <end> step so a student '
        'can step past the last line')


def test_a_short_program_is_untouched():
    """The accounting must not truncate something that comfortably fits."""
    d, n, _ns = record('a = 1\nb = 2\nc = a + b\nprint(c)\n')
    assert d['truncated'] is False, 'a four-line program was truncated'
    assert d['output'] == '3\n', repr(d['output'])
    assert n < 4000, 'a four-line program produced %d bytes' % n


def test_the_accounting_errs_high_not_low():
    """A bound may overshoot; it must never undershoot.

    Charging every array element a separator overcharges by 2 bytes for the
    first one, and the envelope counts the two array brackets that the element
    charges also cover. So _nsize sits a hair ABOVE the recording it describes
    -- 2 bytes on a five-step program, ~0.1% on one that fills the cap. That
    direction is the whole point: an estimate that runs low is what let the
    payload reach 3.5 MiB against a 2 MiB cap.
    """
    for label, prog in (('short', 'a = 1\nb = 2\nc = a + b\n'),
                        ('big loop', BIG_LOOP),
                        ('non-ascii', NON_ASCII)):
        d, n, ns = record(prog)
        assert not d['output'], '%s must print nothing for this comparison' % label
        assert ns['_nsize'][0] >= n, (
            '%s: accounting said %d for a %d-byte payload -- it is UNDER, which '
            'is how the cap stops being a bound' % (label, ns['_nsize'][0], n))
        assert ns['_nsize'][0] <= n * 1.01 + 8, (
            '%s: accounting said %d for a %d-byte payload -- overshooting by '
            'more than 1%% wastes the student\'s recording' % (label, ns['_nsize'][0], n))


def test_helper_no_longer_uses_the_flat_estimates():
    """Guard against a revert to the constants that caused the under-count:
    +24 per variable (an empty entry encodes to 36) and +40 per step (an empty
    step dict encodes to 100).
    """
    assert '_size[0] += 40' not in _HELPER, 'the flat per-step charge is back'
    assert '+ 24' not in _HELPER, 'the flat per-variable charge is back'
    assert '_nsize' in _HELPER and '_osize' in _HELPER, (
        'the recording and output counters must stay separate, or the output '
        'allowance double-subtracts again')


# ---------------------------------------------------------------------------
# _imported must not hide a variable that merely REUSES an imported name.
#
# `_imported` is filled at module level, from names that appeared on a line the
# source says is an import. The filter then ran over EVERY frame's f_locals, so
# a function-local sharing a name with an import vanished from the Variables
# panel -- and so did a top-level rebinding of one. Found by an ultrareview of
# #266, 2026-09-11, after Copilot's pass 4 had flagged it and it survived.
# ---------------------------------------------------------------------------

def _names(payload):
    seen = set()
    for snap in payload['snaps']:
        for row in snap:
            seen.add(row['name'] if isinstance(row, dict) else row[0])
    return seen


def test_a_function_local_that_shadows_a_star_import_is_still_shown():
    # `from math import *` puts `e` in _imported; the local `e` is a different
    # object in a different frame and is the student's own variable.
    d, _n, _ns = record(
        'from math import *\n'
        'def f(data):\n'
        '    e = sum(data)\n'
        '    return e\n'
        'total = f([1, 2, 3])\n')
    assert 'e' in _names(d), (
        'a function-local shadowing an imported name is missing from the '
        'snapshots; _imported is being applied to a non-module frame')


def test_a_top_level_rebinding_of_an_imported_name_is_still_shown():
    d, _n, _ns = record(
        'from math import pi\n'
        'pi = 3.14\n'
        'r = pi * 2\n')
    assert 'pi' in _names(d), (
        'a top-level reassignment of an imported name is missing; the filter '
        'is keyed on the NAME rather than on the imported object')


def test_the_imported_object_itself_is_still_hidden():
    # The other side of the gate: an import the student never touches is
    # clutter, and must stay filtered. A test for the fix that does not also
    # pin this would pass for a version that simply deleted the filter.
    d, _n, _ns = record(
        'from math import pi\n'
        'r = 2.0\n'
        'r = r + 1.0\n')
    assert 'pi' not in _names(d), (
        'the imported object is showing up as a student variable again')


def test_a_local_bound_to_the_imported_object_is_not_hidden_by_identity_alone():
    # `pi_local = pi` binds the SAME object, so an identity check alone would
    # hide it. The depth gate is what keeps it visible.
    d, _n, _ns = record(
        'from math import pi\n'
        'def g():\n'
        '    pi_local = pi\n'
        '    return pi_local\n'
        'v = g()\n')
    assert 'pi_local' in _names(d), (
        'a local bound to the imported object vanished; the module-frame gate '
        'is not being applied')


if __name__ == "__main__":
    _fns = [v for k, v in sorted(globals().items())
            if k.startswith("test_") and callable(v)]
    _failed = 0
    for _fn in _fns:
        try:
            _fn()
            print("PASS", _fn.__name__)
        except AssertionError as _e:
            _failed += 1
            print("FAIL", _fn.__name__, "-", _e or "assertion failed")
        except Exception as _e:  # noqa: BLE001
            _failed += 1
            print("ERROR", _fn.__name__, "-", repr(_e))
    print()
    print("%d/%d passed" % (len(_fns) - _failed, len(_fns)))
    sys.exit(1 if _failed else 0)
