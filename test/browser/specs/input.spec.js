const { test, expect } = require('@playwright/test');

// RUNTIME PINNED. These tests were written against the in-window Pyodide and
// assert its behaviour (cooperative stop, synchronous console.input(), the REPL
// on the main thread). A dev box may enable features.workerRuntime in its
// untracked local.yaml, which would silently route them off-thread and change
// what they are testing. #108's own behaviour is covered by worker-runtime.spec.js.

// input() used to raise `OSError: [Errno 29] I/O error` in Pyodide because the
// runner configured stdout/stderr but never stdin — breaking every intro-course
// trinket that reads input (reported by a Billerica HS teacher). The fix
// overrides the input() builtin to read from a browser prompt. This exercises it
// end-to-end: a program that reads input() must pop a dialog and use the answer,
// with no I/O error.
test.describe('Pyodide input()', () => {
  test('input() reads from the prompt dialog instead of raising an I/O error', async ({ page }) => {
    // Answer every prompt() dialog with a known value.
    page.on('dialog', (dialog) => dialog.accept('Ada'));

    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor')).toBeVisible();

    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'name = input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();

    // Pyodide downloads + boots on first Run (slow); stdout lands in the runner.
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        if (!out) return '';
        let t = out.innerText || '';
        for (const f of out.querySelectorAll('iframe')) {
          try { t += '\n' + (f.contentDocument?.body?.innerText || ''); } catch (e) {}
        }
        return t;
      });
      expect(text).toContain('hi Ada');          // input() returned the dialog's value
      expect(text).not.toContain('I/O error');   // the old OSError [Errno 29] is gone
    }).toPass({ timeout: 90_000 });
  });

  test('the input() prompt is echoed to the console BEFORE the dialog opens', async ({ page }) => {
    // When the prompt dialog appears, the prompt text must already be visible in
    // the console (the old bug: print(prompt, end="") was buffered, so nothing
    // showed until after the dialog was dismissed).
    //
    // Note on technique: we can't read DOM state from inside the page.on('dialog')
    // handler via page.evaluate() — a native window.prompt() blocks the page's JS
    // thread for as long as the dialog is open, and Playwright's evaluate() (a CDP
    // Runtime.evaluate call) queues behind that block, so it never resolves until
    // *after* the dialog is dismissed (confirmed via isolated repro; this is a
    // Playwright/Chromium limitation, not app behavior). Instead we install a
    // window.prompt override via addInitScript that captures the console text
    // synchronously, in-page, at the exact moment prompt() is called — before the
    // real dialog blocks anything — then read the captured value back afterward.
    await page.addInitScript(() => {
      const nativePrompt = window.prompt;
      window.prompt = function(...args) {
        const out = document.querySelector('#outputContainer');
        window.__consoleTextAtPromptCall = out ? (out.innerText || '') : '';
        return nativePrompt.apply(window, args);
      };
    });
    page.on('dialog', (dialog) => dialog.accept('Ada'));

    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'name = input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();

    await expect(async () => {
      const consoleTextAtPromptCall = await page.evaluate(() => window.__consoleTextAtPromptCall);
      expect(consoleTextAtPromptCall).not.toBeUndefined();
      expect(consoleTextAtPromptCall).toContain('your name?'); // echoed before the modal
    }).toPass({ timeout: 90_000 });
  });
});

test.describe('Pyodide console.input()', () => {
  // Types into the inline jqconsole field (NOT a window.prompt dialog).
  async function answerInlineConsole(page, value) {
    await expect(page.locator('#console-output.console-active')).toBeVisible({ timeout: 90_000 });
    await page.locator('#console-output').click();
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  }

  test('await console.input() reads inline from the console', async ({ page }) => {
    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'import console\nname = await console.input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();

    await answerInlineConsole(page, 'Ada');

    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      expect(text).toContain('your name?'); // prompt echoed inline
      expect(text).toContain('hi Ada');     // value returned
      expect(text).not.toContain('I/O error');
    }).toPass({ timeout: 90_000 });
  });

  test('console.input() works WITHOUT await (source is transformed)', async ({ page }) => {
    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'import console\nname = console.input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();
    await answerInlineConsole(page, 'Ada');
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      expect(text).toContain('hi Ada');
      expect(text).not.toContain('SyntaxError'); // proves the await was inserted
      expect(text).not.toContain('coroutine');   // not left un-awaited
    }).toPass({ timeout: 90_000 });
  });

  test('a program that does not import console is unaffected', async ({ page }) => {
    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'print("no console here")\nprint(sum(range(5)))', 1);
    });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      expect(text).toContain('no console here');
      expect(text).toContain('10');
    }).toPass({ timeout: 90_000 });
  });
});

const JSZip = require('jszip');

// Review finding #1: a trinket that ships its OWN console.py shadows the
// inline-input module (syncFilesToFS writes the user file over ours every run).
// usesConsole() still matches `import console`, so userShadowsConsole() MUST
// detect the user file and SKIP the async transform — otherwise the transform
// inserts `await` before console.input(), which here is an ordinary
// (non-coroutine) function, a hard error. This drives the real import endpoint
// to build a two-file trinket (main.py + console.py) and asserts the user's
// module runs untransformed. Runs authenticated (global-setup).
test.describe('Pyodide console.py shadow guard (#1)', () => {
  test("a trinket's own console.py is used and the transform is skipped", async ({ page, request }) => {
    const shortCode = 'shadow' + Date.now().toString(36);
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ trinkets: [{ shortCode, lang: 'python3' }] }));
    const dir = `python3/Shadow_${shortCode}/`;
    zip.file(dir + 'metadata.json', JSON.stringify({
      name: 'Shadow console', description: 'ships its own console.py', lang: 'python3', settings: {},
    }));
    // The user's own console module: console.input is a PLAIN function, NOT a
    // coroutine. If the async transform wrongly fired, `await console.input(...)`
    // would raise "object str can't be used in 'await' expression".
    zip.file(dir + 'console.py', 'def input(prompt=""):\n    return "SHADOWED"\n');
    zip.file(dir + 'main.py', 'import console\nprint("got", console.input("x"))\n');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await request.post('/api/imports/trinkets', {
      multipart: { file: { name: 'shadow.zip', mimeType: 'application/zip', buffer } },
    });
    expect(res.ok(), `import failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    const newShortCode = (await res.json()).data.mapping[shortCode];
    expect(newShortCode, 'import returned a new shortCode').toBeTruthy();

    const resp = await page.goto(`/embed/python3/${newShortCode}?runtime=main`);
    expect(resp.status()).toBe(200);
    // A two-file trinket renders one ACE editor per file, so scope to the first.
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.locator('.run-it').first().click();

    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      expect(text).toContain('got SHADOWED');                  // the user's console.py ran
      expect(text).not.toContain("can't be used in 'await'");  // transform did NOT fire
      expect(text).not.toContain('coroutine');
    }).toPass({ timeout: 90_000 });
  });
});
