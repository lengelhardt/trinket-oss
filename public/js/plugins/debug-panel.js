/**
 * debug-panel: float the step-through debugger's controls out of the Variables
 * tab and onto a draggable pill over the embed.
 *
 * Why this exists: the recorder and replay are good, but the only way in is a
 * "Step through" button inside a tab a student has to know to open first. The
 * second entry point (#debug-start-alt, an icon in the console) was already
 * added for that reason. This replaces that patch with an affordance that is
 * visible without opening anything -- and, because the controls no longer live
 * in the Variables tab, lets the student keep the Result tab open and watch the
 * output while they step.
 *
 * Shape deliberately copies public/js/plugins/plotpolish-adapter.js: this file
 * holds everything that knows about the panel, and pyodide.js hands over the
 * few closure-locals it cannot reach (the debugger's state and its actions)
 * through init(). Gated by features.debugPanel, at the TEMPLATE: pyodide.html
 * appends this file to the js list only under
 * `{% if config.features.stepDebugger and config.features.debugPanel %}`, so
 * with either flag off the file is never served at all, window.trinketDebugPanel
 * is undefined, and every hook in pyodide.js is a no-op. (Verified on a deploy
 * with the flag off: the script list carries /js/debug.js and not this file.)
 *
 * Slice 1 of docs/design/debugger-panel.md: the panel shell only. It drives the
 * EXISTING replay functions and does not reimplement any of them, and the
 * in-tab controls are left in place -- whether the pill replaces them is an
 * open product question, not something to decide by deleting markup.
 */
(function(window, document) {
  'use strict';

  var cfg = window.trinket && window.trinket.config;
  if (!cfg || !cfg.debugPanel) return;

  var ctx     = null;   // { isAvailable, getState, actions }, handed over by pyodide.js
  var $layer  = null;
  var $pill   = null;
  var $help   = null;
  var $vars   = null;
  var $vgrip  = null;  // the persistent drag handle inside $vars
  var $dock   = null;
  var armWaiting = false;  // queued a recording, waiting for the runner to idle
  var armCancelled = false;  // a cancel pressed while the recording was only QUEUED
  // Replay ended because the student started typing, rather than because they
  // pressed the exit. The panel stays OPEN in that case and the variables
  // window carries the reason -- see paintVars().
  var editExited = false;
  var noteTimer = null;

  // A transient line in the panel's own note slot, for things the debugger
  // itself has no note for.
  // NOTHING the panel has to say goes in the pill. The pill is full by design:
  // 296x84 holding three captioned boxes, a slider and an exit, settled over
  // ten rounds at the screen. Every message -- this transient one, the
  // recorder's own persistent notes, the error banner and the edit-exit line --
  // renders at the TOP OF THE VARIABLES WINDOW instead, which is where the
  // student is already looking and which can grow.
  //
  // Held as state and painted by paintVars rather than written to a node, so
  // there is no element in the pill for a message to land in even by mistake.
  var transientNote = '';
  // The step the note was true OF, or null for notes that are not about a step
  // (the ~30 s arm give-up). "paused at the breakpoint on line 3" describes a
  // position, so the moment the student leaves that position -- a scrub, a
  // step, a jump -- it is describing somewhere they are no longer standing.
  // Confirmed live: scrubbing five steps past a pause left the pause message
  // sitting above the new step's variables until its 6 s timer ran out.
  // Stamping the index beats clearing it at every mover, because there are
  // eight of them and the next one added would forget.
  var noteIdx = null;
  var wasReplaying = false;   // for the falling edge in sync()
  var wasRecording = false;   // for the rising edge in sync()
  function note(msg, forIdx) {
    transientNote = msg || '';
    noteIdx = (forIdx === undefined) ? null : forIdx;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { transientNote = ''; noteIdx = null; paintVars(); }, 6000);
    paintVars();
  }
  // Is the transient note still about where we are? Cheap enough to ask on
  // every paint, and it cannot go stale the way a cleared flag can.
  function noteStillTrue(s) {
    return !transientNote ? false : (noteIdx === null || noteIdx === s.idx);
  }

  var varsPlaced = false;  // true once the window has been dragged off the pill
  // Null-prototype: keyed by student variable names, so `dropped['constructor']`
  // must not inherit a truthy value from Object.prototype and hide the row.
  var dropped = Object.create(null);   // names dismissed with the red x
  var lifted  = [];     // names promoted with the green arrow, most recent first
  var mounted = false;
  var placed  = false;  // true once the student has dragged it; stop auto-placing
  var placeTries = 0;   // bounded retries while the layout is still settling
  var placeLast  = null; // last computed left/top, to detect convergence
  var expanded = false;

  // ---------------------------------------------------------------------
  // Where the layer lives, and why it is not just `position: fixed`
  // ---------------------------------------------------------------------
  //
  // The pill has to be draggable anywhere over the embed, which rules out
  // living inside .tab-nav: that is 2.275rem tall with `overflow: hidden`
  // (static/scss/embed/_code_editor.scss), and the clipping is load-bearing --
  // it clips the horizontally scrolling file-tab strip.
  //
  // An absolutely-positioned layer is also clipped anywhere under #codeOutput
  // (`overflow: hidden` in .mode-standard at medium-up) or #outputTabs. The
  // nearest ancestor that is BOTH positioned and non-clipping is
  // .trinket-wrapper (`position: relative`, static/scss/embed/_wrapper.scss).
  //
  // `position: fixed` would also escape the clip -- plotpolish does that -- but
  // .trinket-wrapper doubles as Foundation's .inner-wrap, which is TRANSFORMED
  // when the left off-canvas menu opens (.move-right). A fixed pill would stay
  // put while the whole embed slid out from under it; an absolute child of
  // .inner-wrap rides the transform, which is what we want.
  function layerHost() {
    var el = document.querySelector('.trinket-wrapper');
    return el || document.body;
  }

  // ---------------------------------------------------------------------
  // Styles, inlined
  // ---------------------------------------------------------------------
  //
  // Palette is plotpolish's, read out of its src/panel.css :host block, because
  // the two pills should look like one family: accent #0969da, accent-tint
  // #ddf0ff (the pill's own fill), border #d0d7de, muted #59636e. Hover is
  // Primer's next step down, #0550ae. The one exception is #cf222e for the
  // breakpoint jumps, which is plotpolish's danger token -- the debugger's own
  // #a94442 sits oddly against this blue.
  //
  // Trinket has no dark mode and no CSS custom properties, so these are literal
  // light values on purpose.
  //
  // z-index 1200 is a chosen number, not a large one: it has to clear
  // .alert-box (999) and .tab-options.open (1000), and it must stay well under
  // plotpolish's pill (2147483000, inside a shadow root) so that when both
  // features are on the plot-style pill still wins its own corner.
  var CSS = [
    '.tk-dbg-layer{position:absolute;inset:0;pointer-events:none;z-index:1200}',
    '.tk-dbg,.tk-dbg *{box-sizing:border-box}',
    // Foundation 5 ships `button { margin-bottom: 1.25rem }`, which lands on
    // every control in here and shoves each flex child 20px off the pill's
    // midline. Reset it, or nothing inside will ever centre.
    //
    // It also ships `button:hover, button:focus { background-color; color:#fff }`
    // at (0,1,1), which outranks any plain class rule (0,1,0) in this file. The
    // background half is why the grip kept its blue wash however many times its
    // own background was set to none; blanket that here, once, for every control
    // and any added later. The COLOUR half is the vanishing-icon bug: a clicked
    // button is :focus, so its glyph went #fff on the white pill until the
    // pointer came back (the :hover rule below is (0,2,0) and wins), then went
    // white again on leaving. Confirmed by real click + screen capture in Chrome
    // 152 with the colours de-!important-ed: computed color rgb(255,255,255),
    // zero ink. Every colour a control sets below is therefore !important -- a
    // new button here needs one too, or Foundation's :focus paints it white.
    // (Scripted el.focus() in an unfocused browser pane does NOT reproduce it:
    // :focus only matches while the document itself has focus.)
    '.tk-dbg button,.tk-dbg input,.tk-dbg-vars button{margin:0}',
    '.tk-dbg button,.tk-dbg button:hover,.tk-dbg button:focus,.tk-dbg button:active,',
      '.tk-dbg-vars button,.tk-dbg-vars button:hover,.tk-dbg-vars button:focus,',
      '.tk-dbg-vars button:active',
      '{background:none!important;background-color:transparent!important;box-shadow:none;',
      'text-shadow:none}',
    '.tk-dbg-dock{position:absolute;pointer-events:none;display:inline-block;max-width:calc(100% - 12px)}',
    // NOT `.tk-dbg-layer > *`: that is (0,1,0) exactly like `.tk-dbg-dock`'s
    // own pointer-events:none above it, and being later it won the tie -- so
    // the dock's transparent corners swallowed clicks meant for the Ace editor
    // underneath. $vars is the only direct layer child besides the dock that
    // needs them; $pill and $help are dock children and get them from the
    // first fragment.
    '.tk-dbg-dock > *,.tk-dbg-layer > .tk-dbg-vars{pointer-events:auto}',
    '.tk-dbg{position:relative;display:flex;align-items:center;pointer-events:auto;',
      'background:#ffffff;border:0;border-radius:999px;',
      // The "outline" is the shadow's own hairline ring, not a border: a 1px
      // border plus a shadow reads as two edges at this radius.
      // The ring and the drop both carry the accent hue rather than neutral
      // grey, so the collapsed pill reads as an offer instead of a chip of
      // chrome. Kept subtle on purpose: at .20/.22 alpha over white it is a
      // tint, not a glow, and it does not compete with the accented primary
      // action inside. Same hue as everything else that means "this is the
      // debugger" (#0969da = rgb(9,105,218)).
      'box-shadow:0 0 0 1px rgba(9,105,218,.20), 0 3px 12px rgba(9,105,218,.22);',
      'width:72px;height:32px;font-size:13px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'user-select:none;-webkit-user-select:none;',
      'transition:width 170ms cubic-bezier(.2,.7,.3,1),height 170ms cubic-bezier(.2,.7,.3,1),box-shadow 140ms ease}',
    // Only the two axes change on open; the ring must survive both states.
    '.tk-dbg.open{width:296px;height:84px}',
    '.tk-dbg.dragging{box-shadow:0 0 0 1px rgba(9,105,218,.28), 0 10px 26px rgba(9,105,218,.34);transition:none}',
    '.tk-dbg:not(.open){cursor:pointer}',
    '.tk-dbg[hidden]{display:none!important}',
    // align-self:center rather than the pill's stretch, so the dots sit on the
    // pill's vertical midline whatever height it is at.
    '.tk-dbg-grip{display:flex;align-items:center;gap:2px;padding:0 5px 0 8px;',
      'cursor:grab;border-radius:999px 0 0 999px;flex:0 0 auto;background:none;border:0}',
    '.tk-dbg.dragging .tk-dbg-grip{cursor:grabbing}',
    '.tk-dbg-grip span{display:flex;flex-direction:column;gap:2px}',
    '.tk-dbg-grip i{width:3px;height:3px;border-radius:50%;background:#8794a1;display:block;',
      'transition:background 90ms ease}',
    '.tk-dbg-grip:hover i{background:#0969da}',
    // Fills the pill's height rather than sitting in a box inside it: the
    // label takes only the space its 8px caps need, and the glyph gets the
    // rest via flex:1. Backgrounds stay transparent in every state except a
    // faint hover tint -- a filled rectangle inside a rounded pill reads as a
    // second object, which is exactly what it looked like.
    '.tk-dbg-toggle{display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:1px;border:0;background:none;cursor:pointer;',
      'color:#0969da;padding:0 10px 0 4px;border-radius:0 999px 999px 0;',
      'flex:0 0 auto;line-height:1;transition:color 90ms ease}',
    '.tk-dbg.open .tk-dbg-toggle{border-radius:0;border-right:1px solid #e6eaef;padding-right:9px}',
    // No fill on hover, here or on any control below. The icon-only convention
    // is a muted resting colour resolving to the accent on hover, with the
    // tooltip carrying the meaning and opacity alone marking disabled -- a
    // filled rectangle inside a rounded pill reads as a second object.
    // !important is load-bearing: see the Foundation `button:focus` note above.
    '.tk-dbg-toggle{color:#4a5b69!important}',
    '.tk-dbg-toggle:hover,.tk-dbg-toggle:active{color:#0969da!important;background:none}',
    '.tk-dbg-toggle .w{font-size:8px;font-weight:700;letter-spacing:.14em;line-height:1}',
    // Shown only while the pill is shut and replay is still live.
    '.tk-dbg-live{position:absolute;top:5px;right:6px;width:6px;height:6px;',
      'border-radius:50%;background:#0969da;box-shadow:0 0 0 1.5px #fff}',
    '.tk-dbg-live[hidden]{display:none}',
    '.tk-dbg-toggle{position:relative}',
    // flex:1 + a line-height of 1 lets the glyph occupy the whole remaining
    // height; font-size then sets how much of that it actually inks.
    '.tk-dbg-toggle .fa{display:block;font-size:17px;line-height:1}',
    '.tk-dbg-bug{display:block;color:inherit}',
    '.tk-dbg-body{display:none;flex-direction:column;justify-content:center;',
      // Symmetric: the 2px bottom padding was pushing the (centred) content up
      // by a pixel, leaving 6 above against 8 below.
      'gap:3px;padding:0 8px 0 6px;min-width:0;flex:1;overflow:hidden}',
    '.tk-dbg.open .tk-dbg-body{display:flex}',
    // Row 1 transport + jumps + exit; row 2 the slider and its counter.
    '.tk-dbg-row{display:flex;align-items:center;gap:1px;min-width:0}',
    '.tk-dbg-row.two,.tk-dbg-row.three{gap:6px}',
    '.tk-dbg-rate{font-size:10px;color:#4a5b69;white-space:nowrap;',
      'font-variant-numeric:tabular-nums;min-width:50px}',
    '.tk-dbg-speed{flex:0 0 72px;accent-color:#8794a1;height:12px;margin:0}',
    '.tk-dbg-spd-ic{font-size:10px;color:#8794a1;flex:0 0 auto}',
    /* Groups lay themselves out with flex, so `hidden` has to beat that: the
       attribute alone carries only UA-level display:none, which any stylesheet
       rule outranks -- an inline display:flex here would never hide. */
    '.tk-dbg [data-grp]{display:flex;align-items:center;gap:1px}',
    '.tk-dbg [data-grp][hidden]{display:none!important}',
    '.tk-dbg [data-grp="controls"]{flex-direction:row;align-items:center;',
      'gap:5px;flex:1;min-width:0}',
    '.tk-dbg-grid{display:grid;grid-template-columns:auto auto;gap:3px 9px;',
      'justify-items:center;align-items:end;flex:1;min-width:0}',
    // The note is a third grid row. Empty -- which is almost always -- it still
    // occupied 6px plus a gap at the BOTTOM, which is what pushed everything
    // visible upward and left 2px of margin above against 13px below. Out of
    // flow until it has something to say.
    // Exit sits outside the grid so it can centre against BOTH rows, and the
    // pill's right edge curls around it.
    // Red AT REST, not only on hover: this is the one control that ends the
    // session, and a student should be able to see which one that is without
    // hunting for it with the pointer. It stays the only red thing on the pill,
    // so red still means exactly one thing here -- the error banner is text,
    // not a control.
    //
    // (0,2,0) beats the generic .tk-dbg-btn's (0,1,0), so the rest colour lands
    // without !important games. Hover has to work harder: the generic
    // .tk-dbg-btn:hover:not(:disabled) is (0,3,0) and would repaint it
    // accent-blue, so the exit's own hover rule keeps its :not(:disabled) to
    // reach (0,4,0). Deepening rather than changing hue on hover, since the
    // colour is no longer the thing that changes.
    '.tk-dbg-btn.exit{font-size:16px;padding:4px 4px;align-self:center;',
      'color:#cf222e!important}',
    '.tk-dbg-btn.exit:hover:not(:disabled){color:#a40e26!important}',
    '.tk-dbg-btn.exit:active:not(:disabled){color:#8b0a1f!important}',
    '.tk-dbg-btn{border:0;background:none!important;cursor:pointer;color:#4a5b69;',
      'padding:3px 4px;line-height:1;flex:0 0 auto;font-size:13px;transition:color 90ms ease;',
      'color:#4a5b69!important}',
    '.tk-dbg-btn:hover:not(:disabled){color:#0969da!important}',
    '.tk-dbg-btn:active:not(:disabled){color:#0550ae!important}',
    '.tk-dbg-btn:disabled{opacity:.32;cursor:default;color:#4a5b69!important}',
    // Navigation, so it hovers like every other navigation control. Red on
    // this pill is reserved for the one button that ends the session.
    '.tk-dbg-btn.bp:hover:not(:disabled){color:#0969da!important}',
    // ONCE A BREAKPOINT EXISTS the two jump arrows go red, matching the gutter
    // marker itself (#c0392b, the rgba(192,57,43,.85) inset shadow in
    // pyodide.html) rather than the panel's exit red. Larry's call, and it
    // makes the exit no longer the only red control -- previously a deliberate
    // rule, now deliberately relaxed.
    //
    // SPECIFICITY, not source order: `.tk-dbg-grp.tk-dbg-hasbp .tk-dbg-btn.bp` is
    // (0,4,0) and the hover rule above is ALSO (0,4,0) -- :hover and
    // :not(:disabled) both count in the class column -- so leaving it there
    // would be a tie decided by which came last, which is exactly how the
    // playing-speed accent was silently lost in this branch. The hover pair
    // below is qualified to (0,6,0) so hover always wins.
    '.tk-dbg-grp.tk-dbg-hasbp .tk-dbg-btn.bp{color:#c0392b!important}',
    '.tk-dbg-grp.tk-dbg-hasbp .tk-dbg-btn.bp:hover:not(:disabled){color:#96281b!important}',
    // The circle glyphs read small against the numerals next door.
    '.tk-dbg-btn.bp,.tk-dbg-btn[data-act="bphelp"]{font-size:15px;padding:3px 4px}',
    // A toggle that is ON says so with the accent, never a filled chip -- and
    // for play/pause the glyph swaps too, which is the real signal.
    '.tk-dbg-btn[aria-pressed="true"]{color:#0969da!important}',
    // THE DEFAULT ACTION. Everything else in the row is a small muted glyph;
    // this one is labelled, larger and accent-coloured from rest, so what to
    // click to advance one line is not a guess. Still no background.
    '.tk-dbg-btn.primary{color:#0969da!important;padding:3px 6px}',
    '.tk-dbg-btn.primary .fa{font-size:17px}',
    '.tk-dbg-btn.primary:hover:not(:disabled){color:#0550ae!important}',
    '.tk-dbg-btn.primary:disabled{color:#8794a1!important;opacity:.6}',
    // NAMESPACED, and it has to be. This modifier was called `progress` for
    // about an hour, and Trinket's embed.css carries a bare `.progress` --
    // Foundation 5's progress-bar component -- which gave the group
    // background:#f6f6f6, height:25px, padding:2px and a 10px bottom margin.
    // That was the grey block behind the caption AND the reason this group
    // measured 25px tall where its neighbours measured 34.
    //
    // The panel's own selectors are all .tk-dbg-prefixed and its audit
    // confirmed that; what it did not cover is a BARE MODIFIER class sitting
    // on the element as a second name, where a global rule can reach it
    // without any of our selectors being involved. I enumerated every bare
    // modifier the panel uses against the embed's other stylesheets: only
    // `.fa` (deliberate, Font Awesome) and this one matched anything, so the
    // pre-existing `active`/`primary`/`rate`/`step`/`auto`/`bp` are clean and
    // are left alone. The ones added today are prefixed.
    //
    // The slider now sits in a captioned box like the other three groups, so
    // row 2 reads as two labelled controls instead of one control and a bare
    // track. Its width is column 2 of .tk-dbg-grid, sized by the AUTO MODE box
    // above it -- not a basis set here.
    //
    // min-width:0 on BOTH the group and the box: automatic minimum size
    // applies to grid AND flex items, and a range input's min-content width is
    // ~129px, so without it the slider would push column 2 wider and take the
    // pill with it. This is the trap that cost an hour the first time -- the
    // fix has to go on the WRAPPER, not the input.
    '.tk-dbg-grp.tk-dbg-prog{min-width:0}',
    '.tk-dbg-grp.tk-dbg-prog .tk-dbg-box{min-width:0;padding:0 5px;height:25px}',
    '.tk-dbg-slider{width:100%;min-width:0;flex:none;margin:0;accent-color:#0969da;',
      'height:14px}',

    // Messages, at the top of the variables window. Wraps -- these are
    // sentences, and this window can grow where the pill cannot.
    '.tk-dbg-vnote{font-size:11px;line-height:1.4;color:#59636e;',
      'padding:1px 3px 4px;max-width:236px;white-space:normal;',
      'overflow-wrap:break-word}',
    '.tk-dbg-recording{font-size:14px;font-weight:600;color:#0969da;white-space:nowrap;letter-spacing:.01em}',
    // Centred in the pill rather than pinned left: in the launch state it is
    // the only thing in the body, and after an edit-exit it is the one thing
    // the student is meant to press.
    '.tk-dbg [data-grp="launch"]{flex:1;justify-content:center}',
    // !important for the Foundation button:hover/:focus{color:#fff} reason
    // documented at the top of this block -- without it the phrase goes white
    // on the white pill the moment it is clicked.
    // The phrase IS the control now, so it needs a real hit area rather than
    // the 14px band the text alone occupies -- padding here is the click
    // target, not decoration.
    '.tk-dbg-launch{display:inline-flex;align-items:center;justify-content:center;',
      'border:0;cursor:pointer;padding:7px 14px;line-height:1;border-radius:999px;',
      'color:#0969da!important}',
    '.tk-dbg-launch:hover,.tk-dbg-launch:focus,.tk-dbg-launch:active',
      '{color:#0550ae!important}',
    // Beats .tk-dbg-recording's own colour (0,2,0 vs 0,1,0) so the glyph and
    // the phrase move together on hover instead of only the glyph.
    '.tk-dbg-launch .tk-dbg-recording{color:inherit}',
    '.tk-dbg-sep{width:1px;align-self:stretch;background:#c3d9ef;margin:5px 3px;flex:0 0 auto}',
    // A hairline round-rect says "these three are one subject" without adding
    // a fill: previous breakpoint, next breakpoint, and what a breakpoint is.
    // Three labelled groups. The caption is what lets the icons stay pure: two
    // different play buttons are unambiguous when one sits under STEP MODE and
    // the other under AUTO MODE, so neither needs a word inside it.
    '.tk-dbg-grp{display:flex;flex-direction:column;align-items:center;gap:1px;flex:0 0 auto}',
    // #59636e, the grey .tk-dbg-vnote already uses: 6.11:1 on white and
    // 5.46:1 on the changed-row tint. #8794a1 was 3.10:1, under the 4.5:1 AA
    // bar at 7.5px.
    '.tk-dbg-cap{font-size:7.5px;font-weight:700;letter-spacing:.09em;color:#59636e;',
      'line-height:1;white-space:nowrap;text-transform:uppercase}',
    '.tk-dbg-box{display:flex;align-items:center;justify-content:center;gap:0;',
      'border:1px solid #dfe4ea;border-radius:999px;padding:0 3px;min-height:25px}',
    '.tk-dbg-grp.active .tk-dbg-box{border-color:#0969da;background:#f2f8fe}',
    // The transport is the busiest box and has the least room: five numeric
    // rates need every pixel, so this box runs tighter than the others rather
    // than looser. Measured fit is 186px of content in a 186px grid.
    '.tk-dbg-grp.auto .tk-dbg-box{gap:2px;padding:0 3px}',
    '.tk-dbg-grp.active .tk-dbg-cap{color:#0969da}',
    // A speed multiplier riding the glyph: 2 and 5 read at this size where a
    // second chevron would not. !important on the colour for the same
    // Foundation :focus reason as every other control here; tabular-nums so
    // the accent moving between 2 and 5 cannot shift the row's width.
    '.tk-dbg-btn.rate{display:inline-flex;align-items:center;justify-content:center;',
      'font-size:11px;font-weight:700;padding:2px 2px;line-height:1;',
      'font-variant-numeric:tabular-nums;color:#4a5b69!important}',
    // THE RUNNING RATE. This has to be more specific than a bare
    // [aria-pressed="true"], not merely later: `.tk-dbg-btn.rate` and
    // `.tk-dbg-btn[aria-pressed="true"]` are BOTH (0,2,0), both !important, and
    // the .rate block is further down the sheet -- so the generic accent rule
    // lost the tie and the driving rate stayed muted. Measured in the embed:
    // aria-pressed="true" with computed colour rgb(74,91,105). That silently
    // cost the whole point of putting numerals here, which was to make the
    // speed readable while it plays, since nobody hovers a running control.
    // (0,3,0) settles it wherever the rule sits.
    '.tk-dbg-btn.rate[aria-pressed="true"]{color:#0969da!important}',
    '.tk-dbg-btn.rate:hover:not(:disabled){color:#0969da!important}',
    '.tk-dbg-btn.rate:active:not(:disabled){color:#0550ae!important}',
    '.tk-dbg-btn.frac{padding:2px 3px}',
    '.tk-dbg-frac{display:inline-flex;flex-direction:column;align-items:center;',
      'line-height:1;font-size:8px;font-weight:700;font-variant-numeric:tabular-nums}',
    '.tk-dbg-frac i{font-style:normal;display:block;padding:0 1px}',
    // The fraction's rule. currentColor so it follows the button through rest,
    // hover, active and aria-pressed without needing a rule for each.
    '.tk-dbg-frac i:last-child{border-top:1px solid currentColor;margin-top:1px;',
      'padding-top:1px}',

    '.tk-dbg-row.top{align-items:flex-end;gap:8px}',
    '.tk-dbg-row.two{align-items:flex-end;gap:7px}',
    '.tk-dbg :focus-visible{outline:2px solid #0969da;outline-offset:1px}',
    '.tk-dbg-help{position:absolute;top:calc(100% + 6px);right:0;width:236px;background:#fff;',
      'border-radius:8px;padding:9px 11px;font-size:11.5px;line-height:1.45;color:#1f2328;',
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 6px 20px rgba(31,35,40,.2);',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    '.tk-dbg-help[hidden]{display:none}',
    // Attached: hung off the dock. Detached: absolute in the layer with its
    // own left/top, set in JS.
    // .attached is positioned in JS from the dock's rect; see placeVars().
    '.tk-dbg-vgrip{display:flex;align-items:center;gap:2px;padding:1px 2px 3px;',
      'cursor:grab;border:0;background:none;width:100%}',
    '.tk-dbg-vgrip.dragging{cursor:grabbing}',
    '.tk-dbg-vgrip span{display:flex;flex-direction:column;gap:2px}',
    '.tk-dbg-vgrip i{width:3px;height:3px;border-radius:50%;background:#7d8790;display:block;',
      'transition:background 90ms ease}',
    '.tk-dbg-vgrip:hover i{background:#0969da}',
    // The error banner. Red is otherwise reserved on this panel for the one
    // control that ends the session -- this is text rather than a control, and
    // error-red is a strong enough convention to be worth the second use.
    // NOT nowrap: an error message is a sentence, and "unindent does not match
    // any outer indentation level" on one line would drag the window far wider
    // than the pill. The line number stays bold; the message sits under it at a
    // notch smaller and normal weight, so the two read as heading and detail.
    '.tk-dbg-verr{font-size:11.5px;color:#cf222e;padding:1px 3px 5px;',
      'line-height:1.35;max-width:236px}',
    '.tk-dbg-verr b{font-weight:700;display:block}',
    '.tk-dbg-verr span{display:block;font-weight:400;font-size:11px;',
      'white-space:normal;overflow-wrap:break-word;margin-top:1px}',
    // The edit-exit message, in the slot the variable rows normally fill. Set
    // on the element itself, never only on the wrapper: Foundation styles bare
    // block text and an explicit rule on the element beats inheritance.
    '.tk-dbg-vmsg{font-size:11.5px;line-height:1.45;color:#1f2328;',
      'padding:1px 3px 4px;max-width:186px}',
    '.tk-dbg-help b{font-weight:600}',
    '.tk-dbg-help .dot{display:inline-block;width:9px;height:9px;border-radius:20px 0 0 20px;',
      'background:#cf222e;vertical-align:-1px;margin:0 2px}',
    '.tk-dbg-help p{margin:0 0 7px;font-size:11.5px;line-height:1.45;color:#1f2328}',
    '.tk-dbg-help p:last-child{margin:0;color:#59636e}',
    // Content-sized rather than pill-width: `x = 3 (int)` needs a fraction of
    // 352px, and a wide box with the name pinned left and the value pinned
    // right made the two hard to read as one statement.
    '.tk-dbg-vars{position:absolute;width:max-content;',
      'min-width:132px;max-width:100%;min-height:34px;background:#fff;border-radius:8px;',
      // resize needs a non-visible overflow, which it already has. The native
      // handle is the bottom-right CORNER only -- browsers give no edge grips
      // without hand-built ones, which is not worth the code here.
      'resize:both;',
      'box-shadow:0 0 0 1px rgba(31,35,40,.14), 0 6px 20px rgba(31,35,40,.18);',
      'padding:5px 6px;overflow:auto;',
      // 168px was a hard cap, so the resize grip could never grow the box
      // past about six rows. A generous ceiling instead: short lists stay
      // short (height is auto), long ones scroll, and dragging works up to
      // most of the viewport.
      'max-height:70vh;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    '.tk-dbg-vars[hidden]{display:none}',
    // x, a deliberate gap, then the up-arrow: the two sit side by side and one
    // of them is destructive, so they do not share an edge.
    '.tk-dbg-vrow{display:grid;grid-template-columns:14px 4px 14px 1fr;gap:0 2px;',
      'align-items:center;padding:2px 6px 2px 3px;border-top:1px solid #f1f4f7;border-radius:4px}',

    '.tk-dbg-stmt{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:4px;',
      'cursor:default}',
    '.tk-dbg-vn{color:#1a7f37}',
    '.tk-dbg-vv{color:#1f2328;font-variant-numeric:tabular-nums}',
    '.tk-dbg-vt{color:#59636e}',   // 6.11:1; #8794a1 was 3.10:1 at 11.5px
    // The variable this step just defined or changed. A row tint, not a
    // control fill -- this one is a table row and wants to be found at a
    // glance while stepping.
    '.tk-dbg-vrow.changed{background:#eaf3fd}',
    '.tk-dbg-vrow.changed .tk-dbg-vv{color:#0550ae;font-weight:600}',
    '.tk-dbg-vrow.changed .tk-dbg-vn{font-weight:600}',
    // Same no-fill rule as the pill: muted at rest, colour on hover.
    // #7d8790, not the #c3cbd3 this and the grip dots above used to carry.
    // These are CONTROLS, not decoration: rm/up are bare <svg> glyphs with
    // border:0 and background:none, so the glyph is the only thing identifying
    // them, and the grip is the drag handle for the whole window. #c3cbd3
    // measures 1.64:1 on white and 1.45:1 on the changed-row tint #eaf3fd,
    // against the 3:1 a UI component needs -- invisible until hovered, and
    // hovering requires already knowing where it is. #7d8790 is 3.66:1 and
    // 3.24:1, clearing both grounds. NOT #8794a1, which passes on white
    // (3.10:1) but fails on the tinted rows (2.74:1) -- exactly the rows the
    // student is looking at. The !important stays: it is what beats
    // Foundation's button colour.
    '.tk-dbg-vbtn{border:0;background:none!important;cursor:pointer;padding:1px;line-height:1;',
      'color:#7d8790!important;font-size:11px;transition:color 90ms ease}',
    '.tk-dbg-vbtn.rm:hover{color:#cf222e!important}',
    '.tk-dbg-vbtn.up:hover{color:#1a7f37!important}',
    // Promotion is sticky, so the control that did it says so permanently
    // rather than only while the pointer is on it.
    '.tk-dbg-vbtn.up.on{color:#1a7f37!important}',
    '.tk-dbg-vars .empty{font-size:11px;color:#8794a1;padding:3px 2px;white-space:nowrap}',
    // The deferred-recording offer. The question is deliberately plain text
    // at note weight -- it is a sentence, not a heading -- and the button is
    // the only filled control anywhere in this panel. That is on purpose: it
    // is the one place the panel asks the student to commit to re-running
    // their program, and an accent glyph among accent glyphs would not read
    // as a commitment. It sits in the variables window, which is where the
    // message it answers already is.
    //
    // Every colour carries !important. Foundation's `button:hover,
    // button:focus{color:#fff}` is (0,1,1) and would paint the label white on
    // blue-white, and the .tk-dbg-vars button reset above it strips
    // backgrounds with !important -- so the background needs one too, or this
    // button renders transparent with white text on white.
    '.tk-dbg-vask{font-size:11.5px;line-height:1.4;color:#1f2328;',
      'padding:4px 3px 3px;max-width:200px}',
    // DESCENDANT-QUALIFIED, and that is the whole point. !important only picks
    // the cascade BUCKET; inside the bucket specificity still decides. The
    // `.tk-dbg-vars button` reset above is (0,1,1) and a bare `.tk-dbg-vgo` is
    // (0,1,0), so the reset's background:none!important won and this button
    // rendered a white label on a transparent background over the window's
    // white -- invisible at rest, on hover, on focus and while pressed. The
    // colour won, which is what made it invisible rather than merely wrong.
    //
    // `.tk-dbg-vars .tk-dbg-vgo` is (0,2,0), which beats (0,1,1) on the class
    // column; the hover pair at (0,3,0) beats the reset's (0,2,1) the same
    // way. NOT `button.tk-dbg-vgo` -- that is (0,1,1), a TIE decided by source
    // order, and ties are bugs in this file.
    '.tk-dbg-vars .tk-dbg-vgo{display:block;margin:0 3px 5px!important;padding:3px 9px;',
      'border:0;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;',
      'font-family:inherit;background:#0969da!important;color:#fff!important;',
      'transition:background 90ms ease}',
    '.tk-dbg-vars .tk-dbg-vgo:hover,.tk-dbg-vars .tk-dbg-vgo:focus',
      '{background:#0550ae!important;color:#fff!important}',
    '.tk-dbg-vars .tk-dbg-vgo:active{background:#033d8a!important;color:#fff!important}',
    '.tk-dbg-showall{display:block;width:100%;text-align:left;border:0;cursor:pointer;',
      'font-size:10.5px;color:#0969da!important;padding:3px 2px 1px 24px;',
      'border-top:1px solid #f1f4f7;margin-top:2px}',
    '.tk-dbg-showall:hover{color:#0550ae!important;text-decoration:underline}',
    // The whole injected subtree, not just the pill: the variables window and
    // the help popover hang off $layer, not off .tk-dbg, so they kept all four
    // of their transitions under prefers-reduced-motion.
    // The thinking dots.
    '.tk-dbg-dots{display:inline-block;width:12px;text-align:left}',
    '.tk-dbg-dots i{font-style:normal;opacity:.25;animation:tk-dbg-blink 1.2s infinite}',
    '.tk-dbg-dots i:nth-child(2){animation-delay:.2s}',
    '.tk-dbg-dots i:nth-child(3){animation-delay:.4s}',
    '@keyframes tk-dbg-blink{0%,60%,100%{opacity:.25}30%{opacity:1}}',
    // animation:none as well as transition:none -- a keyframe animation is not
    // a transition and would keep running under prefers-reduced-motion.
    '@media (prefers-reduced-motion: reduce){.tk-dbg-layer,.tk-dbg-layer *',
      '{transition:none!important;animation:none!important}}',
    // All three surfaces carry their only edge in box-shadow, which
    // forced-colors zeroes -- so in Windows High Contrast the pill, the
    // variables window and the help popover lost their outline entirely and
    // ran into the page. .tk-dbg-box already declares a real border, which
    // forced-colors re-colours on its own.
    '@media (forced-colors:active){.tk-dbg,.tk-dbg-vars,.tk-dbg-help{border:1px solid CanvasText}}'
  ].join('');

  function injectCss() {
    if (document.getElementById('tk-dbg-css')) return;
    var s = document.createElement('style');
    s.id = 'tk-dbg-css';
    s.appendChild(document.createTextNode(CSS));
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------
  function btn(id, icon, title, cls) {
    return '<button type="button" class="tk-dbg-btn' + (cls ? ' ' + cls : '') + '"'
         + ' data-act="' + id + '" title="' + title + '" aria-label="' + title + '">'
         + '<i class="fa ' + icon + '" aria-hidden="true"></i></button>';
  }

  // A rate button carries a NUMERAL, not a glyph. There is no established
  // glyph for slow motion -- players use numeric multipliers (YouTube's
  // 0.25x/0.5x), a word ("Slower"), or a settings menu, and none of that is a
  // shape. A numeral also makes the running speed readable at a glance, which
  // no chevron ever did: nobody hovers a control that is already playing.
  function rate(id, label, title) {
    return '<button type="button" class="tk-dbg-btn rate" data-act="' + id + '"'
         + ' title="' + title + '" aria-label="' + title + '">' + label + '</button>';
  }

  // Slow rates are true fractions, numerator over denominator across a
  // horizontal rule. That is the right typography for 1/5, and it spends the
  // box's VERTICAL space rather than its scarce horizontal space: measured in
  // a replica of the pill, the inline "1/5x" form wants 124px against the 89px
  // the AUTO column gets, while the stacked form fits. The full phrase lives
  // on aria-label and the glyph is aria-hidden, so a screen reader says "play
  // at one line every five seconds" rather than "one five".
  function frac(id, num, den, title) {
    return '<button type="button" class="tk-dbg-btn rate frac" data-act="' + id + '"'
         + ' title="' + title + '" aria-label="' + title + '">'
         + '<span class="tk-dbg-frac" aria-hidden="true">'
         + '<i>' + num + '</i><i>' + den + '</i></span></button>';
  }

  var MARKUP =
      '<button type="button" class="tk-dbg-grip" data-grip="1"'
    +   ' title="Drag the debugger" aria-label="Move the debugger; arrow keys also move it">'
    +   '<span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span>'
    + '</button>'
    + '<button type="button" class="tk-dbg-toggle" data-act="toggle" aria-expanded="false"'
    +   ' title="Step through this program line by line">'
    +   '<span class="w">DEBUG</span>'
    +   '<svg class="tk-dbg-bug" width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">'
    +     '<g fill="currentColor">'
    +       '<ellipse cx="8" cy="9.5" rx="3.4" ry="4.1"/><circle cx="8" cy="4.1" r="2.15"/>'
    +       '<path d="M8.7 1.15l1.9-1.05.5.9-1.9 1.05zM5.4 1.05l.5-.9 1.9 1.05-.5.9z'
    +         'M1.15 7.15l3.15.6-.2 1-3.15-.6zM11.9 7.75l3.15-.6.2 1-3.15.6z'
    +         'M1.5 12.4l2.85-1.45.5.9-2.85 1.45zM11.65 10.95l2.85 1.45-.5.9-2.85-1.45z"/>'
    +     '</g></svg>'
    +   '<span class="tk-dbg-live" data-el="live" hidden'
    +     ' title="Still stepping - the output below is the recording, not a live run">'
    +   '</span>'
    + '</button>'
    + '<span class="tk-dbg-body">'
    +   '<span data-grp="launch">'
          // Glyph AND phrase inside one button, centred. The words used to sit
          // outside the button, so clicking the only text in the pill did
          // nothing -- and after an edit closes the debugger this is the whole
          // affordance, so the phrase has to be the target.
    +     '<button type="button" class="tk-dbg-launch" data-act="start"'
    +       ' title="Record this program and step through it">'
    +       '<span class="tk-dbg-recording" data-el="launchlabel">step through</span>'
    +     '</button>'
    +   '</span>'
    +   '<span data-grp="recording" hidden>'
    +     '<span class="tk-dbg-recording" data-el="busy">Recording&hellip;</span>'
    +     btn('cancel', 'fa-times', 'Cancel')
    +   '</span>'
    +   '<span data-grp="controls" hidden>'
    +     '<span class="tk-dbg-grid">'
    +       '<span class="tk-dbg-grp step"><span class="tk-dbg-cap">Step mode</span>'
    +         '<span class="tk-dbg-box">'
    +           btn('first', 'fa-fast-backward', 'Back to the first step')
    +           btn('back', 'fa-step-backward', 'Back one line')
    +           btn('fwd', 'fa-step-forward', 'Run the next line', 'primary')
    +           btn('last', 'fa-fast-forward', 'Forward to the last step')
    +         '</span>'
    +       '</span>'
    +       '<span class="tk-dbg-grp auto"><span class="tk-dbg-cap">Auto mode</span>'
    +         '<span class="tk-dbg-box">'
    +           frac('slow5', '1', '5', 'Play at one line every 5 seconds')
    +           frac('slow2', '1', '2', 'Play at one line every 2 seconds')
    +           '<button type="button" class="tk-dbg-btn" data-act="play" aria-pressed="false"'
    +             ' title="Play at 1 line per second, or pause" aria-label="Play or pause">'
    +             '<i class="fa fa-play" data-el="playicon" aria-hidden="true"></i></button>'
    +           rate('ff2', '2', 'Play at 2 lines per second')
    +           rate('ff5', '5', 'Play at 5 lines per second')
    +         '</span>'
    +       '</span>'
    +       '<span class="tk-dbg-grp tk-dbg-bpgrp"><span class="tk-dbg-cap">Breakpoints</span>'
    +         '<span class="tk-dbg-box">'
    +           btn('prevbp', 'fa-chevron-circle-left', 'Previous breakpoint', 'bp')
    +           btn('nextbp', 'fa-chevron-circle-right', 'Next breakpoint', 'bp')
    +           btn('bphelp', 'fa-question-circle-o', 'What is a breakpoint?')
    +         '</span>'
    +       '</span>'
    +       '<span class="tk-dbg-grp tk-dbg-prog"><span class="tk-dbg-cap">Progress</span>'
    +         '<span class="tk-dbg-box">'
    +           '<input type="range" class="tk-dbg-slider" data-act="slider" min="0" max="0" value="0"'
    +             ' aria-label="Step position">'
    +         '</span>'
    +       '</span>'
    +     '</span>'
    +     '<button type="button" class="tk-dbg-btn exit" data-act="exit"'
    +       ' title="Leave step-through" aria-label="Leave step-through">'
    +       '<i class="fa fa-times" aria-hidden="true"></i></button>'
    +   '</span>'
    // A direct child of the BODY, outside every [data-grp]. Inside the controls
    // group it was paintable only while replaying, so any message written in
    // another state went into a display:none box -- the ~30s "the program is
    // still running" give-up among them, which is the single moment a student
    // most needs telling why nothing happened. (First attempt anchored this on
    // the exit button, which is itself inside the controls group, so it moved
    // out of the grid and no further; verified by walking the ancestry in the
    // live embed.)
    + '</span>';

  function mount() {
    if (mounted) return;
    injectCss();
    $layer = document.createElement('div');
    $layer.className = 'tk-dbg-layer';
    $dock = document.createElement('div');
    $dock.className = 'tk-dbg-dock';
    $pill = document.createElement('div');
    $pill.className = 'tk-dbg';
    $pill.setAttribute('role', 'group');
    $pill.setAttribute('aria-label', 'Step-through debugger');
    $pill.innerHTML = MARKUP;
    $pill.hidden = true;
    $dock.appendChild($pill);
    $help = document.createElement('div');
    $help.className = 'tk-dbg-help';
    $help.setAttribute('role', 'dialog');
    $help.setAttribute('aria-label', 'How to add a breakpoint');
    $help.hidden = true;
    $help.innerHTML =
        '<p><b>Set a breakpoint</b></p>'
      + '<p>Click the grey margin left of a line number. A red marker'
      + ' <span class="dot"></span> appears, and the two circled arrows jump'
      + ' to it \u2014 forwards or back.</p>'
      // Says RESUME, not restart. startPlay rewinds in exactly one case --
      // parked at the very end -- and debugAutoStep is strictly +1 forward, so
      // a breakpoint BEHIND the playhead can never be reached. This popover
      // auto-opens from the breakpoint arrows when no breakpoints are set,
      // which is precisely the moment a student who has been stepping forward
      // asks what they are; telling them play "runs from the first line" sends
      // them to mark a line they have already passed, press play, and watch it
      // run silently to the end.
      + '<p><b>Auto mode stops there.</b> Press play and the recording carries'
      + ' on from the line you are on, pausing when it reaches a line you'
      + ' marked. Press play again to continue to the next one. A breakpoint'
      + ' you have already gone past is not revisited — step back, or press'
      + ' the jump-to-first button, to get behind it again. At the very end,'
      + ' play starts over from the top.</p>'
      + '<p>Stepping by hand ignores breakpoints \u2014 it already stops on every'
      + ' line. Add and remove them as you go; you do not need to record again.</p>';
    $dock.appendChild($help);
    $vars = document.createElement('div');
    $vars.className = 'tk-dbg-vars';
    $vars.setAttribute('aria-label', 'Variables so far');
    $vars.classList.add('attached');
    $vars.hidden = true;
    // In the LAYER, not the dock: a child of the dock cannot outlive the
    // dock's position, and the point is to move it independently.
    $layer.appendChild($dock);
    $layer.appendChild($vars);
    // THE GRIP IS BUILT ONCE AND NEVER REBUILT, and that is the whole reason
    // this window can be dragged while auto mode is running.
    //
    // It used to be part of the string paintVars() wrote into
    // $vars.innerHTML, so every repaint destroyed and recreated it. A drag is
    // a gesture that spans repaints: press down, and the grip node carrying
    // the pointer capture, the pointermove listener and the drag's `down`
    // state was thrown away by the next paint. Stepping by hand hid it,
    // because a single press repaints once and the gesture is over before it
    // matters -- but autoplay repaints once per step, so the drag died within
    // a tick, every time. The pill's grip is static markup and never had the
    // problem, which is exactly why one dragged and the other did not.
    //
    // Wiring it here also lets draggable() be called ONCE rather than on
    // every pointerdown, which had been stacking a fresh set of listeners on
    // the node each press, and gives the grip its keyboard for free.
    $vars.innerHTML = VGRIP;
    $vgrip = $vars.querySelector('[data-vgrip]');
    draggable($vars, '[data-vgrip]', $vars, detachVars);

    // SLICE 3, the arrow-key adjudication, variables-window half: the grip's
    // keyboard now comes from draggable() above, wired once with the grip
    // itself. It calls stopPropagation, which is what settles the claim --
    // while this grip has focus the arrows move the window and never reach
    // pyodide.js's stepping handler. This used to need its own delegated
    // listener because the grip node did not survive a repaint.

    $vars.addEventListener('click', function(e) {
      if (e.target.closest('[data-vgrip]')) return;   // that is the drag handle
      // The deferred-recording button. It lives in the variables window
      // rather than the pill because that is where the message it answers is,
      // and because the pill is full by design.
      var go = e.target.closest('[data-act="deferstart"]');
      if (go) {
        stopPlay();
        // LEAVE REPLAY FIRST. The offer is shown from inside a replay, and
        // armRecording refuses outright while s.replaying is true -- so the
        // button did nothing at all, silently, with no console error to show
        // for it. runStepThrough would have exited replay itself, but the
        // panel's own guard fires before it ever gets there. Found by pressing
        // the button, not by reading it.
        try { ctx.actions.exit(); } catch (e) {}
        note('Recording again, starting from your breakpoint\u2026');
        // Threaded as an ARGUMENT, never a module flag. As a flag it survived
        // every exit armRecording has that is not "the recording started" --
        // a cancel while queued, a collapsed pill, a getState throw, a
        // recording already in flight, and the ~30 s give-up -- so a later
        // ordinary launch silently became a deferred one. Worse, the
        // already-in-flight guard made it self-perpetuating.
        armRecording(0, true);
        return;
      }
      var b = e.target.closest('[data-vact]');
      if (!b) return;
      var nm = b.getAttribute('data-var');
      if (b.getAttribute('data-vact') === 'showall') {
        dropped = Object.create(null);
        paintVars();
        return;
      }
      if (b.getAttribute('data-vact') === 'rm') {
        dropped[nm] = true;
        var at = lifted.indexOf(nm);
        if (at >= 0) lifted.splice(at, 1);
      } else {
        var was = lifted.indexOf(nm);
        if (was >= 0) lifted.splice(was, 1);
        lifted.unshift(nm);
      }
      paintVars();
    });
    layerHost().appendChild($layer);
    wire();
    mounted = true;
  }

  var draggedSinceDown = false;

  // Autoplay controls no execution -- the recording is already a finished
  // array -- so it belongs in the panel rather than in pyodide.js. Five
  // discrete detents rather than a continuous slider: these are the five
  // speeds worth having, and a continuous control makes 1/sec fiddly to hit.
  //
  // ONE DIRECTION, and monotonic: slow on the left, fast on the right. Auto
  // mode used to run backwards, which asked one row to carry two axes (left
  // meant direction, outer meant rate) and forced a second vocabulary for
  // "backwards" -- chevrons meaning rewind-at-speed sitting next to STEP
  // MODE's transport glyphs, where the double triangle means jump-to-first.
  // Every video player a student has used reads the double triangle as
  // rewind, so the two rows disagreed about the same shape. Stepping back one
  // line is what backwards is actually for, and STEP MODE already does it;
  // watching a loop turn SLOWLY is what the freed left-hand buttons now do.
  var TRANSPORT = {
      slow5 : { rate: 1 / 5 }   // one line every five seconds
    , slow2 : { rate: 1 / 2 }   // one line every two seconds
    , play  : { rate: 1 }
    , ff2   : { rate: 2 }
    , ff5   : { rate: 5 }
  };
  var mode = 'step';       // 'step' or 'auto' -- whichever was last driven
  var playAct = null;      // which transport button is driving, or null
  var playTimer = null;
  // The index the timer last produced, and a re-entrancy flag for the sync()
  // the timer's own step triggers. Together they let sync() tell "the playhead
  // moved because I moved it" from "something else moved it" -- the in-tab
  // fwd/back/first/last buttons, the in-tab slider and the arrow keys all go
  // straight to debugStepTo and know nothing about this timer, so without this
  // the two fought over the index and the student's press was undone a
  // fraction of a second later.
  var playLastIdx = null;
  var inTick = false;

  function playing() { return playTimer !== null; }

  function stopPlay() {
    if (playTimer === null) return;
    clearInterval(playTimer);
    playTimer = null;
    playAct = null;
    playLastIdx = null;
    paintPlay();
  }

  function startPlay(act) {
    if (!ctx || !ctx.actions) return;
    var t = TRANSPORT[act];
    if (!t) return;
    if (playTimer !== null) { clearInterval(playTimer); playTimer = null; }
    var s0 = {};
    try { s0 = ctx.getState() || {}; } catch (e) { return; }
    if (!s0.replaying) return;
    // Nowhere to go. A recording of a single line (or of a program that died
    // on its first statement) has total 0, and arming the timer anyway made
    // every AUTO MODE button light up, swap the centre glyph to pause and hold
    // that state for a whole interval -- five seconds on the slowest rate --
    // before the first tick discovered there was nothing to step and stopped.
    // A play state that plays nothing is worse than a dead button.
    if (!(s0.total > 0)) return;
    // Parked at the end: restart from the top, so the press does something
    // rather than nothing -- the same thing a player's play button does once
    // the video has finished.
    if (s0.idx >= s0.total) {
      try { ctx.actions.first(); } catch (e) {}
      try { s0 = ctx.getState() || s0; } catch (e) {}   // idx moved; re-read
    }
    // Auto mode advances one step and THEN tests where it landed, so it can
    // never pause on the step it departs from. That is deliberate -- it is
    // what stops play being a dead button on the breakpoint the student is
    // parked on. But it means a breakpoint whose only recorded execution IS
    // that step (line 1 of the program, most often, since replay opens at step
    // 0) stops nothing at all: the recording plays to the end, in silence,
    // while the help popover two inches away promises "Auto mode stops there".
    //
    // Play anyway -- running to the end is what was asked for -- but say so.
    if (s0.hasBreakpoints && s0.atBreakpoint && !s0.bpAhead) {
      note(s0.line
        ? 'Playing past the breakpoint on line ' + s0.line + '. That line does not run again.'
        : 'Playing past this breakpoint. It does not come round again.');
    }
    playAct = act;
    playLastIdx = (typeof s0.idx === 'number') ? s0.idx : null;
    playTimer = setInterval(function() {
      // One primitive, and pyodide.js decides why we stopped: 'moved', 'end' or
      // 'breakpoint'. Auto mode no longer owns the end-of-recording test, and
      // it never sees the breakpoint table.
      //
      // Stops at whichever end it reaches rather than wrapping: at five lines a
      // second a 5,000-step recording still takes sixteen minutes, so auto mode
      // is for watching a loop turn, not traversing a program.
      var r = 'end';
      inTick = true;
      try {
        // No fallback. There used to be a legacyTick() here "for a pyodide.js
        // that predates actions.autoStep" -- but this file is new in the same
        // diff as the handover that provides it, so no such pyodide.js has
        // ever existed. Worse, the fallback stepped without ever testing for a
        // breakpoint, so if it HAD been reachable it would have silently run
        // straight past every breakpoint: a fallback that hides the exact
        // divergence it exists to survive. A missing action now throws into
        // the catch below, which stops the timer visibly.
        r = ctx.actions.autoStep();
      } catch (e) { inTick = false; stopPlay(); return; }
      inTick = false;
      try { playLastIdx = (ctx.getState() || {}).idx; } catch (e) { playLastIdx = null; }
      if (r === 'moved') return;
      stopPlay();
      if (r === 'breakpoint') {
        // Landing on a breakpoint hands control back, so the highlight belongs
        // to step mode now -- the student's next press is almost always a step.
        mode = 'step';
        var s = {};
        try { s = ctx.getState() || {}; } catch (e) {}
        note(s.line ? 'Paused at the breakpoint on line ' + s.line + '.'
                    : 'Paused at a breakpoint.', s.idx);
        paintMode();
      }
    }, (1 / t.rate) * 1000);
    paintPlay();
  }

  function paintPlay() {
    if (!mounted) return;
    // Whichever button is driving reads as pressed; the centre one also swaps
    // its glyph, since that is the one a student reads as "playing".
    for (var act in TRANSPORT) {
      var b = $pill.querySelector('[data-act="' + act + '"]');
      if (b) b.setAttribute('aria-pressed', String(playAct === act));
    }
    var i = el('playicon');
    // Pause whenever ANYTHING in auto mode is running, not only when the centre
    // button started it: a rate running at 2 with a play glyph showing is a lie
    // about what the button will do. The driving button also carries the accent
    // via aria-pressed, which is what makes the CURRENT SPEED visible while
    // playing -- the old chevrons conveyed rate by shape alone, and nobody
    // hovers a running control to read a tooltip.
    if (i) i.className = 'fa fa-' + (playAct !== null ? 'pause' : 'play');
    paintMode();
  }

  // Exactly one box is highlighted, so which mode a press will act in is never
  // a guess. Pressing a control in the other box moves the highlight.
  function paintMode() {
    if (!mounted) return;
    var groups = $pill.querySelectorAll('.tk-dbg-grp');
    for (var k = 0; k < groups.length; k++) {
      var isAuto = groups[k].classList.contains('auto');
      var isStep = groups[k].classList.contains('step');
      groups[k].classList.toggle('active',
        (isAuto && mode === 'auto') || (isStep && mode === 'step'));
    }
  }

  // Opening the pill IS the request to step through -- the student should not
  // have to find a second button after it expands. Only when nothing is in
  // flight: re-expanding mid-replay must not throw the recording away, and
  // re-expanding after a deliberate exit leaves the launch button to click.
  function setExpanded(on, alsoRecord) {
    // Coming home on collapse means a window dragged somewhere unhelpful is
    // always one collapse away from being findable again.
    if (!on) {
      hideHelp();
      varsPlaced = false;
      editExited = false;   // collapsing dismisses the message
      // Collapsing pauses. The autoplay timer used to keep stepping behind a
      // collapsed pill, with no pause control reachable anywhere -- the only
      // way to stop it was to expand again and find the button. Covers all
      // three routes in: the grip tap, the DEBUG toggle and the exit button.
      stopPlay();
      if ($vars) $vars.hidden = true;
    }
    expanded = on;
    $pill.classList.toggle('open', on);
    var t = $pill.querySelector('[data-act="toggle"]');
    if (t) t.setAttribute('aria-expanded', String(on));
    place();
    paintVars();   // collapse hides it; re-expanding must bring it straight back
    // Repaint from live state as well, because expansion changes what some of
    // it MEANS: the small accent dot that says "still in a replay" is painted
    // on `s.replaying && !expanded`, so collapsing a paused replay left the
    // dot off and the pill looked finished. sync() cannot recurse here -- it
    // calls place() and paintVars(), never setExpanded().
    if (ctx && mounted) sync();
    if (!on || !alsoRecord || !ctx || !ctx.actions) return;
    // Deferred one tick so the expand animation and the (blocking, main-thread)
    // recording do not fight over the same frame. setTimeout, not
    // requestAnimationFrame: rAF is suspended while the tab is hidden or
    // occluded, so a trinket opened in a background tab would expand the pill
    // and then never record.
    setTimeout(function() { armRecording(0, false); }, 0);
  }

  // runStepThrough() refuses outright while a normal Run, the REPL or a worker
  // run is in flight, so a student who clicks DEBUG mid-run would get an open
  // pill and nothing else. Wait for the runner to go quiet instead, then
  // record -- and give up if they close the pill or start something else.
  function armRecording(tries, defer) {
    // A press is a fresh request, so it outranks a cancel from the last one.
    if (!tries) armCancelled = false;
    // The student pressed cancel while this was queued. Nothing is recording
    // yet, so there is nothing for actions.cancel() to flag -- the only way to
    // stop it is to refuse to re-arm here.
    if (armCancelled) { armCancelled = false; armWaiting = false; sync(); return; }
    if (!expanded || !ctx || !ctx.actions) { armWaiting = false; return; }
    var s = {};
    try { s = ctx.getState() || {}; } catch (e) { armWaiting = false; return; }
    // Something else got there first. Clearing the flag matters: left true
    // with no timer pending, the next ordinary Run made the pill claim it was
    // waiting to record, and offered a cancel button for a queue of nothing.
    if (s.recording || s.replaying) { armWaiting = false; return; }
    if (s.busy) {
      if (tries < 150) {
        armWaiting = true;
        setTimeout(function() { armRecording(tries + 1, defer); }, 200);
        sync();
      } else {
        // Gave up after ~30s. Say so rather than sitting there: the launch
        // button comes back and the student can try again.
        armWaiting = false;
        note('The program is still running. Press again once it stops.');
        sync();
      }
      return;
    }
    armWaiting = false;
    // A new recording is a fresh start: anything hidden belonged to the old
    // one, and the highlight starts on step mode rather than inheriting
    // whichever half happened to drive the previous recording.
    dropped = Object.create(null);
    lifted = [];
    mode = 'step';
    editExited = false;   // the message has been answered by re-recording
    try {
      if (defer && ctx.actions.startDeferred) ctx.actions.startDeferred();
      else ctx.actions.start();
    } catch (e) {}
    sync();
  }

  function hideHelp() {
    if (!$help || $help.hidden) return;
    $help.hidden = true;
    paintVars();                       // bring the list back
  }

  function toggleHelp() {
    if (!$help) return;
    // hideHelp(), not a bare `$help.hidden = true`: hideHelp is the only
    // routine that pairs the hide with the paintVars() that brings the
    // variables window BACK. showHelp() hid it so the two would not overlap,
    // and closing the popover with the same "?" button left it hidden -- no
    // variables, no error banner, no notes, on the one surface every message
    // in this panel renders on. This branch returns before the handler's own
    // hideHelp() and before sync(), so nothing else rescued it.
    if (!$help.hidden) { hideHelp(); return; }
    showHelp();
  }

  function showHelp() {
    if (!$help) return;
    $help.hidden = false;
    if ($vars) $vars.hidden = true;   // they would sit on top of each other
  }

  var VGRIP = '<button type="button" class="tk-dbg-vgrip" data-vgrip="1"'
            + ' title="Drag this window" aria-label="Move the variables window;'
            + ' arrow keys also move it">'
            + '<span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span>'
            + '</button>';

  var RM = '<svg width="9" height="9" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor"'
         + ' d="M13 4.2L11.8 3 8 6.8 4.2 3 3 4.2 6.8 8 3 11.8 4.2 13 8 9.2 11.8 13 13 11.8 9.2 8z"/></svg>';
  var UP = '<svg width="9" height="9" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor"'
         + ' d="M8 1l6 7H9.5v7h-3V8H2z"/></svg>';

  // Opt-OUT, not opt-in: every variable the student defines appears here by
  // itself, in the order it came into existence, and grows as they step. A
  // list you have to go and build is a list nobody builds.
  var VAL_CHARS = 34;   // displayed; the tooltip carries what the recorder kept

  function clipVal(v) {
    return v.length > VAL_CHARS ? v.slice(0, VAL_CHARS - 1) + '\u2026' : v;
  }

  // Renders the variables window with whatever there is to show, or hides it
  // when there is nothing at all. Needed because an error banner has to appear
  // even in the states that used to hide the window outright -- a syntax error
  // records zero steps, so there is no model and no rows, and that is exactly
  // when the student most needs telling why.
  function varsHtml(inner) {
    // The other half of the interlock showHelp() opens. Without it, ANY sync
    // while the popover is up repaints the variables window over it -- and the
    // most likely sync is the gutter click the popover is at that moment
    // telling the student to make (debugToggleBreakpoint -> debugPanelSync).
    // The popover stays authoritative until hideHelp(), which repaints.
    if ($help && !$help.hidden) { $vars.hidden = true; return; }
    if (!inner) { $vars.hidden = true; return; }
    // Everything AFTER the grip, leaving the grip node itself in place. Not a
    // wrapper div around the content: the rows are siblings of the grip, and
    // nesting them would change which of them matches structural selectors.
    // (There WAS a `.tk-dbg-vrow:first-child{border-top:0}` rule here that
    // nesting would have activated -- but it had never matched anything,
    // because the grip has always been the first child, so it is deleted
    // rather than preserved by an argument about a rule that did nothing.)
    while ($vgrip.nextSibling) $vars.removeChild($vgrip.nextSibling);
    $vgrip.insertAdjacentHTML('afterend', inner);
    $vars.hidden = false;
    placeVars();
  }

  // Everything the panel has to say, composed in one place and rendered at the
  // top of the variables window. Order is worst-first: the error outranks a
  // note, and both outrank the values.
  function saysHtml(s) {
    var out = '';
    // Bold and red, and shown for the WHOLE replay rather than only at the last
    // step -- the run ends badly whichever step you are looking at.
    if (s.hasError) {
      out += '<div class="tk-dbg-verr">'
          + '<b>' + (s.errorLine ? 'Error on line ' + s.errorLine : 'Error')
          + '</b>'
          // WHAT is wrong, not only where. Where alone sends a student to the
          // right line to stare at it; the message is the half that tells them
          // what to change.
          + (s.errorMsg ? '<span>' + escHtml(s.errorMsg) + '</span>' : '')
          + '</div>';
    }
    // Parked on the synthetic <end> step: the program ran to completion and
    // there is nothing further to step to. Derived from state rather than from
    // autoplay's return value, so it is equally true when the student walks
    // there by hand or presses jump-to-last -- and it cannot be left stale,
    // because stepping back clears it on the next paint.
    //
    // Suppressed when the recording carries an error: it did not reach the end
    // SUCCESSFULLY, and the red banner above is the fact that matters.
    //
    // Suppressed on a TRUNCATED recording for the same reason, and this one is
    // a lie rather than an omission: truncation leaves no error behind (the
    // tracer raises _TrinketStopRecording, which the exec wrapper swallows
    // ahead of the BaseException catch), so the last step is a perfectly
    // ordinary <end> and this line claimed the program "reached the end &
    // stopped" directly above the recorder's own "recording stopped after
    // 5000 steps". The student's loop did not finish; the recorder gave up.
    if (s.atEnd && !s.hasError && !s.truncated) {
      out += '<div class="tk-dbg-vnote">Reached the end and stopped.</div>';
    }
    // s.note is the recorder's own persistent note (truncation, "your
    // breakpoint was not reached"); transientNote is the panel's own, and the
    // two are different sentences about different things, so both can show.
    var msgs = [];
    // The host now always includes 'ends with an error' in its note, because
    // it cannot know whether this panel is expanded enough to be showing the
    // red banner. When the banner IS above, drop the clause rather than say it
    // twice -- and drop the separator with it, so an error-only note does not
    // leave a stray middle dot.
    // No string surgery on s.note any more: the host keeps the "ends with an
    // error" clause in its own slot, which the panel simply never reads.
    var note = s.note || '';
    // ARRIVAL EXPLAINERS vs THE LIVE POSITION. The truncation explainer, the
    // deferred-playback note and the breakpoint status all answer "what IS
    // this recording", which is a question you have on arrival and never
    // again. Once the student is stepping they want to know where they are --
    // so at step 0 the note area explains the recording, and from step 1 on it
    // reads the position instead. Larry: "Once the debugging starts, this
    // message is no longer needed."
    //
    // The flash is exempt: it answers a press and has to appear whenever it
    // fires, whatever the index. It is a separate slot in getState for exactly
    // that reason.
    if (s.flash) msgs.push(s.flash);
    // Three clauses, and each one exists because the fallback was empty in
    // some state:
    //
    //  1. ON ARRIVAL the explainer wins. `!s.replaying` is in the test as well
    //     as `idx === 0` because the condition means "there is no position to
    //     report yet", and OUTSIDE a replay there is no position at all --
    //     which is the state every bail message is delivered in.
    //  2. Otherwise the live position, which is what stepping wants.
    //  3. Otherwise the explainer again, because at the synthetic <end> step
    //     there is no line to report AND "Reached the end and stopped." is
    //     suppressed on a truncated run -- so a student who pressed
    //     jump-to-last on a recording that stopped 1,167 iterations short saw
    //     nothing at all telling them why. Arrival at the end is a second
    //     thing that needs explaining, not a position.
    var pos = aboutToRun(s);
    if ((!s.replaying || s.idx === 0) && note) msgs.push(note);
    else if (pos) msgs.push(pos);
    else if (note) msgs.push(note);
    if (noteStillTrue(s)) msgs.push(transientNote);
    for (var i = 0; i < msgs.length; i++) {
      out += '<div class="tk-dbg-vnote">' + escHtml(msgs[i]) + '</div>';
    }
    // THE OFFER. The recording ran out of budget before it reached the line
    // the student marked, so the one thing they wanted to look at is the one
    // thing they cannot. Offer the re-record rather than leaving them to work
    // out that a shorter loop would have helped.
    //
    // A question and then a button, in that order, because the button commits
    // them to a second run of their program and the question is what makes
    // that a choice rather than a surprise. getState() only sets canDefer on
    // the evidence -- truncated, marked line never reached, and not already a
    // deferred attempt -- so this cannot nag.
    if (s.canDefer) {
      out += '<div class="tk-dbg-vask">'
           + (s.deferLine
                ? 'Record from line ' + s.deferLine + ' instead?'
                : 'Record from your breakpoint instead?')
           + '</div>'
           + '<button type="button" class="tk-dbg-vgo" data-act="deferstart">'
           + 'Start recording there</button>';
    }
    return out;
  }

  function paintVars() {
    if (!mounted || !ctx || !ctx.getVarModel) return;
    var s = {};
    try { s = ctx.getState() || {}; } catch (e) { s = {}; }
    var err = saysHtml(s);

    if (!expanded) { $vars.hidden = true; return; }
    if (!s.replaying) {
      // Not replaying, but there may still be plenty to say: the edit-exit
      // line, the ~30s "still running" give-up, a VPython or console bail.
      if (editExited) {
        err += '<div class="tk-dbg-vmsg">'
             + 'The step-through debugger closed so you can edit the code.</div>';
      }
      varsHtml(err);
      return;
    }

    var model = null, now = [], prev = [];
    try {
      model = ctx.getVarModel();
      now   = ctx.getVars(s.idx) || [];
      prev  = s.idx > 0 ? (ctx.getVars(s.idx - 1) || []) : [];
    } catch (e) { varsHtml(err); return; }
    if (!model) { varsHtml(err); return; }

    var vals = Object.create(null), was = Object.create(null);
    var types = Object.create(null), i;
    for (i = 0; i < now.length; i++) {
      vals[now[i].name] = now[i].repr;
      types[now[i].name] = now[i].type;
    }
    for (i = 0; i < prev.length; i++) was[prev[i].name] = prev[i].repr;

    // Count what the student has hidden, so it can be offered back. Dismissing
    // a variable used to be irreversible for the whole page session: no reset,
    // no message, no way back -- and silently losing the variable you are
    // debugging is the worst failure this panel could have.
    var hidden = 0;
    var names = [];
    for (i = 0; i < model.order.length; i++) {
      var nm = model.order[i];
      if (model.fromImport[nm]) continue;          // library furniture
      if (dropped[nm]) { hidden++; continue; }     // dismissed by the student
      if (model.firstStep[nm] > s.idx) continue;   // not defined yet at this step
      names.push(nm);
    }
    // Promoted names float to the top, most recently promoted first.
    names.sort(function (a, b) {
      var la = lifted.indexOf(a), lb = lifted.indexOf(b);
      if (la === lb) return 0;
      if (la < 0) return 1;
      if (lb < 0) return -1;
      return la - lb;
    });

    if (!names.length && !hidden) { varsHtml(err); return; }

    var html = '';
    {
      for (i = 0; i < names.length; i++) {
        var n2 = names[i];
        var v = n2 in vals ? vals[n2] : null;
        // Newly defined counts as changed too -- the first assignment is the
        // most recent update there has been.
        var changed = v !== null && (was[n2] === undefined || was[n2] !== v);
        var ty = n2 in types ? types[n2] : null;
        var shown = v === null ? null : clipVal(v);
        var stmt = v === null
          // NOT "not defined yet": names first defined after this step are
          // already filtered out above (firstStep[nm] > s.idx). Reaching here
          // means the name was deleted, or belongs to another stack frame.
          ? escHtml(n2) + ' <span class="tk-dbg-vt">not available at this step</span>'
          : '<span class="tk-dbg-vn">' + escHtml(n2) + '</span> = '
              + '<span class="tk-dbg-vv">' + escHtml(shown) + '</span>'
              + (ty ? ' <span class="tk-dbg-vt">(' + escHtml(ty) + ')</span>' : '');
        html += '<div class="tk-dbg-vrow' + (changed ? ' changed' : '') + '">'
          + '<button type="button" class="tk-dbg-vbtn rm" data-vact="rm" data-var="' + escAttr(n2)
          + '" title="Remove ' + escAttr(n2) + ' from this list" aria-label="Remove ' + escAttr(n2) + '">' + RM + '</button>'
          + '<span></span>'
          + '<button type="button" class="tk-dbg-vbtn up' + (lifted.indexOf(n2) >= 0 ? ' on' : '')
          + '" data-vact="up" data-var="' + escAttr(n2) + '" aria-pressed="'
          + (lifted.indexOf(n2) >= 0) + '" title="'
          + (lifted.indexOf(n2) >= 0 ? escAttr(n2) + ' is pinned to the top' : 'Move ' + escAttr(n2) + ' to the top')
          + '">' + UP + '</button>'
          + '<span class="tk-dbg-stmt" title="'
          + escAttr(v === null ? n2 + ' is not defined at this step'
                    : n2 + ' = ' + v + (v.length > VAL_CHARS ? '' : '')) + '">'
          + stmt + '</span>'
          + '</div>';
      }
    }
    if (hidden) {
      html += '<button type="button" class="tk-dbg-showall" data-vact="showall">'
            + hidden + ' hidden \u2014 show all</button>';
    }
    varsHtml(err + html);
  }

  // Attached: CSS hangs it off the dock and there is nothing to compute.
  // Detached: it keeps whatever coordinates the student dragged it to, clamped
  // into the layer so a resize or a window change cannot strand it offscreen.
  function placeVars() {
    if (!$vars || $vars.hidden) return;
    var b = $layer.getBoundingClientRect();
    if (!varsPlaced) {
      $vars.classList.add('attached');
      var dr = $dock.getBoundingClientRect();
      if (!dr.width) return;
      $vars.style.left = Math.round(dr.left - b.left) + 'px';
      $vars.style.top = Math.round(dr.bottom - b.top + 6) + 'px';
      return;
    }
    $vars.classList.remove('attached');
    var x = parseFloat($vars.style.left) || 0, y = parseFloat($vars.style.top) || 0;
    $vars.style.left = Math.max(4, Math.min(x, b.width - $vars.offsetWidth - 4)) + 'px';
    $vars.style.top = Math.max(4, Math.min(y, b.height - 28)) + 'px';
  }

  // Detaching happens on the first drag: freeze where it currently sits, in
  // layer coordinates, then let the pointer take over from there.
  function detachVars() {
    if (varsPlaced) return;
    var vr = $vars.getBoundingClientRect(), b = $layer.getBoundingClientRect();
    varsPlaced = true;
    $vars.classList.remove('attached');
    $vars.style.left = Math.round(vr.left - b.left) + 'px';
    $vars.style.top = Math.round(vr.top - b.top) + 'px';
  }

  // "About to execute line 8 for the 43rd time." -- or just "About to execute
  // line 8." until the program has actually repeated a line. Composed in ONE
  // place because it renders on two surfaces (the variables window and the
  // slider's tooltip) and they must not drift apart.
  function aboutToRun(s) {
    if (s.line == null || !s.lineVisit) return '';
    return 'About to execute line ' + s.line
         + (s.visitOrdinals ? ' for the ' + ordinal(s.lineVisit) + ' time.' : '.');
  }

  // 1,000 not 1000. The panel's own copy of the host's debugThousands: these
  // numbers are read inside sentences, and a bare 2500 in prose is the same
  // wart as a sentence opening with a digit. Deliberately NOT toLocaleString,
  // whose separator is locale-dependent -- a de-DE reader would get "2.500th".
  function commas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st, 2,500th. The teens are
  // the exception that catches naive implementations -- and the suffix is
  // chosen from the RAW number before the commas go in, or 2,500 % 10 would be
  // read off a string.
  function ordinal(n) {
    var rem100 = n % 100, suffix = 'th';
    if (rem100 < 11 || rem100 > 13) {
      switch (n % 10) {
        case 1: suffix = 'st'; break;
        case 2: suffix = 'nd'; break;
        case 3: suffix = 'rd'; break;
      }
    }
    return commas(n) + suffix;
  }

  function escHtml(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(t) { return escHtml(t).replace(/"/g, '&quot;'); }

  function el(name) { return $pill.querySelector('[data-el="' + name + '"]'); }
  function grp(name) { return $pill.querySelector('[data-grp="' + name + '"]'); }

  // ---------------------------------------------------------------------
  // Default position: the empty span of the file-tab bar
  // ---------------------------------------------------------------------
  //
  // Docked there by arithmetic rather than by parentage. Recomputed until the
  // student drags it, after which their position wins -- including across runs.
  function place() {
    if (placed || !$pill || $pill.hidden) return;
    var editor = document.querySelector('#editor');
    var nav = document.querySelector('#editor .tab-nav');
    var host = $layer.getBoundingClientRect();
    if (!editor || !nav || !host.width) return;
    var nr = nav.getBoundingClientRect();
    if (!nr.width) {
      if (placeTries++ < 40) setTimeout(place, 16);
      return;
    }

    // Line the pill up under the Run button, which is what was actually asked
    // for -- the row below Run, starting where Run starts.
    //
    // Not the last file tab (an earlier pass), and emphatically not
    // `.scrollable-content`: that <dl> runs wider than the bar and is clipped
    // by .tab-nav's overflow:hidden, so its rect reports an un-clipped right
    // edge past the editor pane entirely, which put the pill over the output.
    var run = document.querySelector('a.run-it');
    var rr = run ? run.getBoundingClientRect() : null;
    var strip = nav.querySelector('.scrollable-content');
    var tabsEls = strip ? strip.children : null;
    var lastTab = tabsEls && tabsEls.length ? tabsEls[tabsEls.length - 1] : null;
    // Prefer Run's left edge -- but never overlap the file tabs, which would
    // make them unclickable. On a narrow window the toolbar compresses and Run
    // slides left of the tabs, so take whichever is further right.
    var tabRight = lastTab ? lastTab.getBoundingClientRect().right + 8 : null;
    var underRun = !!(rr && rr.width);
    var anchor = underRun ? rr.left
               : (tabRight !== null ? tabRight : nr.left + 120);
    if (tabRight !== null && anchor < tabRight) anchor = tabRight;

    // And keep the whole pill inside the EDITOR pane. Clamping to the layer
    // (the whole embed) is not enough: the layer spans the output pane too,
    // so a wide expanded panel sat over the Variables table quite happily.
    var opts = nav.querySelector('.right-options');
    var or_ = opts ? opts.getBoundingClientRect() : null;
    var rightBound = (or_ && or_.width ? or_.left : editor.getBoundingClientRect().right) - 8;

    var left = anchor - host.left;
    // The expanded pill is 412px. On a narrow window the editor pane is
    // narrower than that, and clamping into the pane would shove it hard left
    // and still overflow -- so when it cannot fit the pane, clamp to the whole
    // embed instead. It is draggable either way.
    if ($dock.offsetWidth > rightBound - nr.left) rightBound = host.left + host.width - 6;
    var maxLeft = rightBound - host.left - $dock.offsetWidth;
    var x = Math.max(6, Math.min(left, maxLeft));
    var y = Math.max(2, nr.top - host.top + 2);
    $dock.style.left = x + 'px';
    $dock.style.top = y + 'px';

    // Keep recomputing until two consecutive passes agree. The first call
    // happens inside initialize(), while the toolbar and the off-canvas column
    // are still settling -- a one-shot placement there reads a Run button that
    // has not reached its final x yet, and nothing later moves the pill,
    // because sync() only fires when the DEBUGGER's state changes. Converges
    // in two or three frames; bounded so a permanently unstable layout cannot
    // spin.
    var key = x + ',' + y;
    if (key !== placeLast && placeTries++ < 40) {
      placeLast = key;
      setTimeout(place, 16);   // not rAF: see armRecording
    }
    placeVars();   // attached, it hangs off the dock, so it moves when this does
  }

  // ---------------------------------------------------------------------
  // Paint from the debugger's own state -- this file owns no debugger state
  // ---------------------------------------------------------------------
  function sync() {
    if (!ctx || !mounted) return;
    // If the debugger left replay by any route, the timer has nothing to step.
    // And if the playhead moved without the timer moving it, something else is
    // driving -- an in-tab transport button, the in-tab slider, an arrow key --
    // so hand over rather than fight: two things stepping the same index means
    // the student's press is silently undone on the next tick.
    if (playing()) {
      var q = {};
      try { q = ctx.getState() || {}; } catch (e) { q = {}; }
      if (!q.replaying) stopPlay();
      else if (!inTick && playLastIdx !== null
               && typeof q.idx === 'number' && q.idx !== playLastIdx) stopPlay();
    }
    var avail = false;
    try { avail = !!ctx.isAvailable(); } catch (e) { avail = false; }
    // An edit can drop the program below two runnable lines (or make it
    // VPython), which turns isAvailable() false -- and onEditorChange() has
    // just set editExited to promise the student an explanation. Hiding here
    // would eat that promise, so keep the pill until the message is answered:
    // collapsing, or the next recording, clears editExited.
    var show = avail || editExited;
    $pill.hidden = !show;
    if (!show) { hideHelp(); if ($vars) $vars.hidden = true; return; }

    var s;
    try { s = ctx.getState() || {}; } catch (e) { return; }

    // Entering a recording by ANY route answers the edit-exit message, so this
    // is the one place that clears it -- not armRecording, which only covers
    // the open-and-record click. Miss this and pressing Run while replaying
    // takes the student out of replay and then tells them they left "so you
    // can edit the code", which is not what they did.
    if (s.recording || s.replaying) editExited = false;

    // A new recording is a fresh start, and this is the rising edge every
    // route reaches -- runStepThrough calls debugPanelSync() the moment it
    // sets debugRecording. Doing it in armRecording only covered the panel's
    // own launch click, so a recording started from the in-tab "Step through"
    // inherited the previous run's dismissed variables, its pinned ones, and
    // whichever mode box happened to be lit. Same shape as the editExited
    // line above it, deliberately.
    if (s.recording && !wasRecording) { dropped = Object.create(null); lifted = []; mode = 'step'; }
    // ...and on the FALLING edge, drop whatever the panel was saying about the
    // recording in flight ("recording again, from your breakpoint..."). By now
    // it has either opened a replay or the host has posted its own answer, and
    // the in-flight message sitting beside that answer reads as a contradiction.
    // The replay case is covered by the s.replaying edge below, but a recording
    // that ends WITHOUT a replay -- a deferred attempt whose line never ran --
    // has no falling replay edge to ride.
    if (wasRecording && !s.recording) { transientNote = ''; noteIdx = null; }
    wasRecording = !!s.recording;

    // Every transient note the panel writes during a replay is about THAT
    // replay -- "paused at the breakpoint on line 4", "playing past the
    // breakpoint on line 4". The moment the replay ends, by the exit button or
    // by an edit or by a fresh Run, they are about a recording that no longer
    // exists, and the 6 s timer is far too long to cover it: the edit-exit
    // message appeared with the old pause note still sitting on top of it.
    // Cleared on the falling edge here rather than in each of the routes out,
    // because there are several and a new one would forget.
    if (wasReplaying && !s.replaying) { transientNote = ''; noteIdx = null; }
    wasReplaying = !!s.replaying;

    var live = el('live');
    if (live) live.hidden = !(s.replaying && !expanded);

    // Three states, not two: recording, waiting for the runner to go quiet
    // before it can start recording, and idle. The middle one used to render
    // as "Recording..." with nothing happening, which is indistinguishable
    // from a recording that has hung.
    // "step through" for a first recording; "Restart Debugger" once one has
    // been closed by an edit, because by then the student is not discovering
    // the feature -- they are getting back to where they were.
    var ll = el('launchlabel');
    // Title case on both, so the two states of one control agree with each
    // other: "Step Through" / "Restart Debugger".
    if (ll) ll.textContent = editExited ? 'Restart Debugger' : 'Step Through';

    var waiting = !s.recording && !s.replaying && s.busy && expanded && armWaiting;
    grp('launch').hidden     = s.recording || s.replaying || waiting;
    grp('recording').hidden  = !(s.recording || waiting);
    var busyEl = el('busy');
    if (busyEl) {
      // Three animated dots rather than a static ellipsis. A deferred
      // re-record coasts the whole program before it records anything, which
      // on a long loop is seconds of a pill that looks frozen -- Larry waited
      // through one and asked for "some sort of thinking..." A CSS animation
      // is right here because it is decoration: nothing about the recording
      // depends on it ticking, so the hidden-tab rule that bans rAF for STATE
      // does not apply. The reduced-motion block below stops it.
      busyEl.innerHTML = (s.recording ? 'Recording' : 'Waiting for the run')
        + '<span class="tk-dbg-dots"><i>.</i><i>.</i><i>.</i></span>';
    }
    grp('controls').hidden   = !s.replaying;
    if (!s.replaying) hideHelp();

    if (s.replaying) {
      paintPlay();
      var slider = $pill.querySelector('[data-act="slider"]');
      slider.max = s.total;
      slider.value = s.idx;
      // No "drag to scrub" / "drag to go back". A slider already looks like a
      // slider; the tooltip's job is the information the pill has nowhere else
      // to put, not instructions for using a range input.
      slider.title = s.atEnd
        ? 'The end of the recording'
        : 'Step ' + commas(s.idx + 1) + ' of ' + commas(s.total)
          // "about to", not "executing": a line event fires BEFORE its line
          // runs, which is also why the variables read as they do on entry.
          // The visit count makes a loop legible -- the same line at step 40
          // and step 900 is the difference between the 8th pass and the 180th,
          // and nothing else on the pill says which.
          + (aboutToRun(s) ? '\n\n' + aboutToRun(s) : '');
      var atStart = s.idx <= 0, atEnd = s.idx >= s.total;
      $pill.querySelector('[data-act="first"]').disabled = atStart;
      $pill.querySelector('[data-act="back"]').disabled = atStart;
      $pill.querySelector('[data-act="fwd"]').disabled = atEnd;
      $pill.querySelector('[data-act="last"]').disabled = atEnd;
      // Deliberately NOT disabled with no breakpoints set: a dead control
      // teaches nothing, and clicking one is the moment the student is asking
      // what breakpoints are. The handler answers with the hint instead.
      $pill.querySelector('[data-act="prevbp"]').disabled = false;
      $pill.querySelector('[data-act="nextbp"]').disabled = false;
      // The jump arrows go red once there is somewhere to jump to. Read live
      // from state, so a gutter click recolours them immediately --
      // debugToggleBreakpoint ends in debugPanelSync(), which lands here.
      // Note this is the BREAKPOINTS group specifically: `.active` is the
      // mode highlight and this box deliberately never takes it, so the two
      // cannot be confused.
      var bpGrp = $pill.querySelector('.tk-dbg-grp.tk-dbg-bpgrp');
      if (bpGrp) bpGrp.classList.toggle('tk-dbg-hasbp', !!s.hasBreakpoints);
    }
    place();
    paintVars();
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function wire() {
    $pill.addEventListener('click', function(e) {
      // CONSUME draggedSinceDown here. It is set by the grip's pointermove and
      // exists to swallow the click that ends a drag -- but it was cleared in
      // exactly one place, the grip's own pointerdown, so after dragging the
      // COLLAPSED pill anywhere, clicking DEBUG did nothing at all, silently
      // and for ever. The pill's only entry point was dead after an ordinary
      // "move it out of my way" gesture, and the sole recovery was pressing the
      // grip again without moving it, which nobody would guess.
      //
      // Consumed here rather than cleared in the drag's end(): pointerup fires
      // BEFORE click, so clearing it there would let the drag's own trailing
      // click open the pill -- precisely what the flag exists to prevent.
      var wasDrag = draggedSinceDown;
      draggedSinceDown = false;
      // Collapsed, the whole pill is the target -- including the grip, so long
      // as the pointer did not actually travel (that is a drag, not a click).
      if (!expanded) {
        if (!wasDrag) setExpanded(true, true);
        return;
      }
      // Expanded, the grip is a toggle as well: tap collapses, drag moves.
      if (e.target.closest('[data-grip]')) {
        if (!wasDrag) setExpanded(false);
        return;
      }
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled || b.tagName === 'INPUT') return;
      var act = b.getAttribute('data-act');
      if (act === 'toggle') {
        setExpanded(!expanded);
        return;
      }
      if (act === 'bphelp') { toggleHelp(); return; }
      if (act === 'prevbp' || act === 'nextbp') {
        var st = {};
        try { st = ctx.getState() || {}; } catch (e) { st = {}; }
        if (!st.hasBreakpoints) {
          // This return jumps the whole rest of the handler, including the
          // stopPlay() below -- so the student who pressed a breakpoint arrow
          // to find out what breakpoints ARE got the help popover while the
          // autoplay timer kept stepping the recording underneath it. Stop
          // first, then explain.
          //
          // `mode` is deliberately NOT touched, for the reason the slider
          // handler gives below: nothing moved the playhead, so lighting STEP
          // would claim a step that did not happen. `mode` is a paint value
          // only (paintMode toggles one class), so leaving it is cosmetic;
          // stopPlay() repaints the transport glyphs, which is the part the
          // student can actually see is wrong.
          stopPlay();
          showHelp();
          return;
        }
      }
      hideHelp();
      // Any transport button: pressing the one already driving pauses; pressing
      // another switches speed without stopping first.
      if (TRANSPORT[act]) {
        mode = 'auto';
        // The centre button is the master: while anything is playing it shows a
        // pause glyph and pausing is what it does. The flanking buttons switch
        // speed, and pressing the one already driving pauses.
        if (act === 'play' && playAct !== null) stopPlay();
        else if (playAct === act) stopPlay();
        else startPlay(act);
        return;
      }
      // Breakpoint jumps belong in this list too: they move the playhead
      // discretely and they stop autoplay, which is exactly what step mode
      // means. Leaving them out left AUTO lit while the student was plainly
      // stepping, with the accented primary action sitting in the unlit box.
      if (act === 'first' || act === 'back' || act === 'fwd' || act === 'last'
          || act === 'prevbp' || act === 'nextbp') {
        mode = 'step';
      }

      var a = ctx && ctx.actions;
      if (!a) return;
      // Manual navigation pauses: stepping by hand while the timer also steps
      // would have the two fighting over the index.
      if (act !== 'start') stopPlay();
      try {
        switch (act) {
          // Through armRecording rather than straight to a.start(), so the
          // launch button gets what the open-and-record click already had: the
          // 200ms wait while the runner is busy (a bare start() returns
          // silently and looks like a dead button), plus the fresh-start reset
          // of dismissed and promoted variables from the previous recording.
          case 'start':  armRecording(0, false);  break;
          // Two different cancels, because the pill shows this button in two
          // different states. While it reads "Waiting for the run..." nothing
          // is recording yet, so actions.cancel() only sets a flag that the
          // recording will read when it starts -- and it DOES start, up to 30 s
          // later, because armRecording's pending setTimeout is still queued.
          // The button advertised a cancellation it could not perform.
          case 'cancel':
            var cs = {};
            try { cs = ctx.getState() || {}; } catch (e) {}
            if (armWaiting && !cs.recording) { armCancelled = true; armWaiting = false; }
            else a.cancel();
            break;
          case 'first':  a.first();      break;
          case 'back':   a.step(-1);     break;
          case 'fwd':    a.step(1);      break;
          case 'last':   a.last();       break;
          case 'prevbp': a.jumpBp(-1);   break;
          case 'nextbp': a.jumpBp(1);    break;
          // Leaving replay leaves BOTH halves, so the highlight must not stay
          // on auto: the next recording starts in step mode.
          case 'exit':   a.exit(); mode = 'step'; setExpanded(false); break;
        }
      } catch (err) { /* never let the panel break the debugger */ }
      sync();
    });

    var slider = $pill.querySelector('[data-act="slider"]');
    slider.addEventListener('input', function() {
      if (!ctx || !ctx.actions) return;
      // Deliberately does NOT touch `mode`. A scrub is a seek, not a mode --
      // and the slider occupies the grid cell UNDER THE "AUTO MODE" CAPTION, so
      // setting step here lit the box on the opposite side of the panel from the
      // control being dragged. Leaving mode alone keeps the highlight truthful
      // (you are still in whichever half you were in, now paused). It still
      // stops autoplay: the timer and the drag would fight over the index.
      stopPlay();
      try { ctx.actions.stepTo(parseInt(this.value, 10) || 0); } catch (e) {}
    });


    dragging();
  }

  // Pointer drag by the grip, plus arrow keys while the grip has focus. The
  // grip is a <button> so it is reachable by Tab, and its own arrow keys are
  // stopped from bubbling -- otherwise they would reach the debugger's
  // document-level stepping handler and step the recording instead of moving
  // the panel. (Adjudicating those keys against Ace is slice 3.)
  // Pointer drag by a grip, shared by the pill's dock and the variables
  // window. `onFirstMove` lets the variables window detach itself the moment a
  // real drag starts rather than on mousedown, so a tap still means "click".
  function draggable(target, gripSel, root, onFirstMove) {
    var grip = root.querySelector(gripSel);
    if (!grip) return;
    var down = null;
    function bounds() { return $layer.getBoundingClientRect(); }
    function put(left, top) {
      var b = bounds();
      target.style.left = Math.max(4, Math.min(left, b.width - target.offsetWidth - 4)) + 'px';
      target.style.top = Math.max(4, Math.min(top, b.height - target.offsetHeight - 4)) + 'px';
    }
    grip.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var r = target.getBoundingClientRect(), b = bounds();
      down = { dx: e.clientX - r.left, dy: e.clientY - r.top, bx: b.left, by: b.top,
               sx: e.clientX, sy: e.clientY, moved: false };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      grip.classList.add('dragging');
    });
    grip.addEventListener('pointermove', function (e) {
      if (!down) return;
      if (!down.moved && (Math.abs(e.clientX - down.sx) > 4 || Math.abs(e.clientY - down.sy) > 4)) {
        down.moved = true;
        if (onFirstMove) onFirstMove();
        var r = target.getBoundingClientRect(), b = bounds();
        down.dx = down.sx - r.left; down.dy = down.sy - r.top; down.bx = b.left; down.by = b.top;
      }
      if (down.moved) put(e.clientX - down.bx - down.dx, e.clientY - down.by - down.dy);
    });
    function end() { if (down) grip.classList.remove('dragging'); down = null; }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('keydown', function (e) {
      var map = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };
      var d = map[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      if (onFirstMove) onFirstMove();
      put((parseFloat(target.style.left) || 0) + d[0], (parseFloat(target.style.top) || 0) + d[1]);
    });
  }

  // Re-apply the dock clamp against the pill's CURRENT size. put() below
  // clamps too, but against whatever the pill measures at drag time -- 72x32
  // while collapsed -- and then latches `placed`, after which place() returns
  // on its first line and every re-clamp route dies with it. So a drag to the
  // right edge while collapsed, followed by an expand, put the pill's right
  // edge about 220px past the embed: the transport row, both jumps, the slider
  // and the exit all off-screen. Self-recoverable by dragging again, which is
  // the only reason it is not worse than it is.
  //
  // The unplaced path never had this bug -- it reads live offsetWidth and
  // re-runs on transitionend -- so this is the placed branch getting the
  // equivalent it was missing.
  function clampDock() {
    if (!mounted || !$dock || !$pill) return;
    var b = $layer.getBoundingClientRect();
    if (!b.width || !b.height) return;      // occluded: nothing meaningful to clamp to
    var left = parseFloat($dock.style.left), top = parseFloat($dock.style.top);
    if (isNaN(left) || isNaN(top)) return;  // still auto-docked; place() owns it
    $dock.style.left = Math.max(4, Math.min(left, b.width  - $pill.offsetWidth  - 4)) + 'px';
    $dock.style.top  = Math.max(4, Math.min(top,  b.height - $pill.offsetHeight - 4)) + 'px';
  }

  function dragging() {
    var grip = $pill.querySelector('[data-grip]');
    var down = null;

    function bounds() { return $layer.getBoundingClientRect(); }
    function put(left, top) {
      var b = bounds();
      $dock.style.left = Math.max(4, Math.min(left, b.width - $pill.offsetWidth - 4)) + 'px';
      $dock.style.top  = Math.max(4, Math.min(top,  b.height - $pill.offsetHeight - 4)) + 'px';
      if (draggedSinceDown) placed = true;
      placeVars();
    }

    grip.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      draggedSinceDown = false;
      var pr = $dock.getBoundingClientRect(), b = bounds();
      down = { dx: e.clientX - pr.left, dy: e.clientY - pr.top, bx: b.left, by: b.top,
               sx: e.clientX, sy: e.clientY };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      $pill.classList.add('dragging');
    });
    grip.addEventListener('pointermove', function(e) {
      if (!down) return;
      // 4px of slop: a click always jitters a pixel or two, and treating that
      // as a drag would make the collapsed pill impossible to open by its grip.
      if (Math.abs(e.clientX - down.sx) > 4 || Math.abs(e.clientY - down.sy) > 4) {
        draggedSinceDown = true;
      }
      put(e.clientX - down.bx - down.dx, e.clientY - down.by - down.dy);
    });
    function end() {
      down = null;
      $pill.classList.remove('dragging');
      // Belt and braces for the clamped-edge case. In an ordinary drag the pill
      // follows the pointer, so the release lands ON the pill and its click
      // handler consumes draggedSinceDown. But once put() clamps the pill
      // against the layer edge the pointer keeps going and the release can land
      // OFF it, so no pill click ever runs and the flag would survive to
      // swallow the student's next real click.
      //
      // DEFERRED, because pointerup fires BEFORE the click that ends the drag
      // and that click must still be swallowed. setTimeout and not rAF:
      // requestAnimationFrame does not tick in a hidden or occluded tab, which
      // would strand the flag exactly where it is hardest to notice.
      setTimeout(function() { draggedSinceDown = false; }, 0);
    }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);

    grip.addEventListener('keydown', function(e) {
      var map = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };
      var d = map[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      put((parseFloat($dock.style.left) || 0) + d[0], (parseFloat($dock.style.top) || 0) + d[1]);
    });
  }

  // ---------------------------------------------------------------------
  // The hooks pyodide.js calls
  // ---------------------------------------------------------------------
  window.trinketDebugPanel = {
    init: function(handover) {
      ctx = handover;
      mount();
      sync();
      // Reposition with the layout while the student has not moved it. Passive
      // and cheap: place() returns immediately once `placed` is true.
        window.addEventListener('resize', place);
      window.addEventListener('resize', placeVars);
      // The pill's width/height are transitioned, so anything measured against
      // it has to be re-measured once the transition lands.
      $pill.addEventListener('transitionend', function (e) {
        if (e.propertyName === 'width' || e.propertyName === 'height') {
          place();       // no-ops once the student has dragged it
          clampDock();   // ...which is exactly when this one is needed
          placeVars();
        }
      });
    },
    // Called wherever the debugger's own state changes.
    sync: sync,
    // A normal Run also answers the edit-exit message: the student has moved on
    // from editing and is looking at output. sync() alone could not clear it --
    // showResult calls exitReplay(true), which returns at its own first line
    // because debugRec is already null, so the panel is never told; and sync's
    // own clear only fires while recording or replaying, neither of which a
    // plain Run is. Without this the message and the "Restart Debugger" label
    // sat there run after run, describing an edit several runs old, with no
    // control to dismiss it.
    afterRun: function() { editExited = false; stopPlay(); sync(); },
    // Editing invalidates the recording's line numbers, so a marching
    // highlight would be walking over code that no longer means anything.
    // wasReplaying is passed by pyodide.js, which has already called
    // exitReplay() by the time this runs -- so the panel cannot work out for
    // itself that there was anything to lose.
    onEditorChange: function(wasReplaying) {
      if (wasReplaying) editExited = true;
      stopPlay();
      sync();
    }
  };

})(window, document);
