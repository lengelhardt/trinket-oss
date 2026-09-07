'use strict';
// #108: the client's lifecycle logic — correlation ids, stop, and the promise
// contract. A fake Worker constructor is injected so this stays a node test;
// real execution is covered by the browser spec.
const { createWorkerClient } = require('../../public/js/embed/worker-client.js');

function fakeWorkerFactory() {
  const made = [];
  function FakeWorker() {
    this.posted = [];
    this.terminated = false;
    this.postMessage = (m) => { this.posted.push(m); };
    this.terminate = () => { this.terminated = true; };
    made.push(this);
  }
  return { FakeWorker, made };
}

const tick = () => new Promise(r => setTimeout(r, 0));

// The worker answers `run` with "Python is not ready yet" until Pyodide has
// booted, so the client holds runs until `ready`. Tests that exercise runs must
// therefore boot the fake worker first — that is the real sequence.
async function bootedClient(extra) {
  const h = newClient(extra);
  h.made[0].onmessage({ data: { type: 'ready', v: 1 } });
  await tick();
  return h;
}

function newClient(extra) {
  const { FakeWorker, made } = fakeWorkerFactory();
  const events = { stdout: [], stderr: [], errors: [] };
  const client = createWorkerClient(Object.assign({
    workerUrl: '/js/embed/pyodide-worker.js',
    pyodideUrl: 'https://cdn/pyodide.js',
    WorkerCtor: FakeWorker,
    onStdout: (t) => events.stdout.push(t),
    onStderr: (t) => events.stderr.push(t),
    onError:  (t) => events.errors.push(t)
  }, extra || {}));
  return { client, made, events };
}

describe('createWorkerClient', () => {
  it('sends init on construction', () => {
    const { made } = newClient();
    expect(made[0].posted[0].type).toBe('init');
  });

  it('is not running before a run starts', () => {
    const { client } = newClient();
    expect(client.isRunning()).toBe(false);
  });

  it('posts a run message with a correlation id, and reports running', async () => {
    const { client, made } = await bootedClient();
    client.run('print(1)');
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.source).toBe('print(1)');
    expect(typeof runMsg.id).toBe('string');
    expect(client.isRunning()).toBe(true);
  });

  it('forwards stdout to the callback', async () => {
    const { client, made, events } = await bootedClient();
    client.run('print(1)');
    await tick();
    made[0].onmessage({ data: { type: 'stdout', text: 'hello\n' } });
    expect(events.stdout).toEqual(['hello\n']);
  });

  it('resolves the run promise on done', async () => {
    const { client, made } = await bootedClient();
    const p = client.run('print(1)');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id } });
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('reports an error and still settles the run', async () => {
    const { client, made, events } = await bootedClient();
    const p = client.run('boom');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'error', id, traceback: 'ValueError: x' } });
    await p;
    expect(events.errors).toEqual(['ValueError: x']);
    expect(client.isRunning()).toBe(false);
  });

  it('ignores replies whose id does not match the current run (a stale worker)', async () => {
    const { client, made, events } = await bootedClient();
    client.run('print(1)');
    await tick();
    made[0].onmessage({ data: { type: 'error', id: 'not-the-current-id', traceback: 'stale' } });
    expect(events.errors).toEqual([]);
    expect(client.isRunning()).toBe(true);
  });

  it('stop() terminates the worker and settles the in-flight run', async () => {
    const { client, made } = await bootedClient();
    const p = client.run('while True: pass');
    await tick();
    client.stop();
    expect(made[0].terminated).toBe(true);
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('spawns a replacement worker after stop, so the next run works', async () => {
    const { client, made } = await bootedClient();
    client.run('while True: pass');
    await tick();
    client.stop();
    client.run('print(2)');
    await tick();
    expect(made.length).toBe(2);
    expect(made[1].posted[0].type).toBe('init');
  });

  it('stop() with nothing running is harmless', () => {
    const { client } = newClient();
    expect(() => client.stop()).not.toThrow();
  });

  // discardWorker() is the VPython re-run contract (Task 11): the page throws the
  // interpreter away between runs so the Python namespace, the vpython scene and
  // the page's object registry reset together. It is stop()'s mechanism used with
  // a different intent, and what a caller depends on is that the NEXT run gets a
  // brand new interpreter — not a recycled one carrying `scene = canvas()` from
  // the run before.
  it('discardWorker() terminates the worker and the next run boots a fresh one', async () => {
    const { client, made } = await bootedClient();
    client.run('from vpython import *');
    await tick();
    made[0].onmessage({ data: { type: 'done', id: made[0].posted.find(m => m.type === 'run').id } });
    await tick();

    client.discardWorker();
    expect(made[0].terminated).toBe(true);

    client.run('from vpython import *');
    await tick();
    expect(made.length).toBe(2);
    expect(made[1].posted[0].type).toBe('init');       // a cold boot, not a reuse
    made[1].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    expect(made[1].posted.find(m => m.type === 'run')).toBeTruthy();
  });

  it('discardWorker() with nothing running is harmless', () => {
    const { client } = newClient();
    expect(() => client.discardWorker()).not.toThrow();
  });

  it('discardWorker() reports whether there WAS an interpreter to discard', async () => {
    // The page uses this to decide whether to tell a student their console
    // session just went with it. Saying so when nothing was lost is as wrong as
    // staying silent when something was.
    const { client } = await bootedClient();
    expect(client.discardWorker(), 'a live worker was discarded').toBe(true);
    expect(client.discardWorker(), 'there was nothing left to discard').toBe(false);
  });

  it('does NOT post a run before the worker reports ready', async () => {
    // Booting Pyodide takes seconds; a run posted first is answered
    // "Python is not ready yet". Found by the browser spec, not by unit tests.
    const { client, made } = newClient();
    client.run('print(1)');
    await tick();
    expect(made[0].posted.find(m => m.type === 'run')).toBeUndefined();

    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    expect(made[0].posted.find(m => m.type === 'run')).toBeTruthy();
  });

  it('surfaces a boot failure, which carries no run id', async () => {
    // The worker posts {type:'error', id:null} if Pyodide fails to load. The
    // id check would drop it and the page would wait forever on `ready`.
    const { client, made, events } = newClient();
    const p = client.run('print(1)');
    made[0].onmessage({ data: { type: 'error', id: null, traceback: 'Failed to start Python: boom' } });
    await expect(p).resolves.toBeUndefined();
    expect(events.errors).toEqual(['Failed to start Python: boom']);
    expect(client.isRunning()).toBe(false);
  });

  it('a reply from a REPLACED worker cannot settle the new run', async () => {
    // The dangerous case: stop() then run() again, and the dead worker's last
    // message arrives late. Ids are unique per run, so it must be ignored.
    const { client, made } = await bootedClient();
    client.run('first');
    await tick();
    const firstId = made[0].posted.find(m => m.type === 'run').id;
    client.stop();
    client.run('second');
    await tick();

    made[0].onmessage({ data: { type: 'done', id: firstId } });
    expect(client.isRunning()).toBe(true);
  });
});

describe('worker VPython run extras', () => {
  // The kernel installs the vpython wheel only for runs that ask for it, and
  // tags scene-ops with the generation it was told. Both ride on the run
  // message, so the client has to forward them — python3 runs must stay clean.
  it('forwards vpython/wheelUrl/sceneGeneration onto the run message', async () => {
    const { client, made } = await bootedClient();
    client.run('from vpython import *', null, {
      vpython: true,
      wheelUrl: '/components/vpython-worker/vpython-7.6.5-py3-none-any.whl',
      sceneGeneration: 3
    });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.vpython).toBe(true);
    expect(runMsg.wheelUrl).toBe('/components/vpython-worker/vpython-7.6.5-py3-none-any.whl');
    expect(runMsg.sceneGeneration).toBe(3);
  });

  it('omits the vpython extras entirely on an ordinary run', async () => {
    const { client, made } = await bootedClient();
    client.run('print(1)', null, { graphicWidth: 400 });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect('vpython' in runMsg).toBe(false);
    expect('wheelUrl' in runMsg).toBe(false);
    expect('sceneGeneration' in runMsg).toBe(false);
    expect(runMsg.graphicWidth).toBe(400);   // existing options still work
  });

  it('omits them when vpython is present but false (the router said main/python3)', async () => {
    const { client, made } = await bootedClient();
    client.run('print(1)', null, { vpython: false, wheelUrl: '/w.whl' });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect('vpython' in runMsg).toBe(false);
    expect('wheelUrl' in runMsg).toBe(false);
  });

  it('defaults sceneGeneration to 0 when the page does not pass one', async () => {
    const { client, made } = await bootedClient();
    client.run('from vpython import *', null, { vpython: true, wheelUrl: '/w.whl' });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.sceneGeneration).toBe(0);
  });

  it('routes scene-ops to onSceneOps even after the run has settled', async () => {
    // A vpython scene outlives its run, so ops arrive with no `current`.
    const seen = [];
    const { client, made } = await bootedClient({ onSceneOps: (m) => seen.push(m) });
    const p = client.run('from vpython import *', null, { vpython: true, wheelUrl: '/w.whl' });
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id } });
    await p;
    made[0].onmessage({ data: { type: 'scene-ops', id, generation: 1, ops: '{"cmds":[]}' } });
    expect(seen.length).toBe(1);
    expect(seen[0].generation).toBe(1);
  });
});

describe('input() over the channel', () => {
  it('asks the page for input and posts the reply back', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    let asked = null;
    const client = createWorkerClient({
      workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker,
      onInputRequest: (prompt) => { asked = prompt; return Promise.resolve('Ada'); }
    });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.run('name = input("who? ")');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;

    made[0].onmessage({ data: { type: 'input-request', id, prompt: 'who? ' } });
    await tick();
    await tick();

    expect(asked).toBe('who? ');
    const reply = made[0].posted.find(m => m.type === 'stdin-reply');
    expect(reply).toEqual({ type: 'stdin-reply', id, value: 'Ada' });
  });

  it('does not answer an input request from a stale run', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({
      workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker,
      onInputRequest: () => Promise.resolve('x')
    });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.run('input()');
    await tick();

    made[0].onmessage({ data: { type: 'input-request', id: 'stale', prompt: '?' } });
    await tick();
    await tick();
    expect(made[0].posted.find(m => m.type === 'stdin-reply')).toBeUndefined();
  });

  it('answers with an empty string when the page has no input handler', async () => {
    // Better than hanging the program forever on a prompt nobody can answer.
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.run('input()');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;

    made[0].onmessage({ data: { type: 'input-request', id, prompt: '?' } });
    await tick();
    await tick();
    expect(made[0].posted.find(m => m.type === 'stdin-reply').value).toBe('');
  });
});

describe('variable snapshot over the channel', () => {
  it('requests a snapshot and resolves with the parsed array', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();

    const p = client.snapshot();
    await tick();
    const req = made[0].posted.find(m => m.type === 'snapshot');
    expect(req).toBeTruthy();

    made[0].onmessage({ data: { type: 'snapshot-result', id: req.id, json: '[{"name":"x","value":"42"}]' } });
    await expect(p).resolves.toEqual([{ name: 'x', value: '42' }]);
  });

  it('resolves to an empty array when the worker reports a failure', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    const p = client.snapshot();
    await tick();
    const req = made[0].posted.find(m => m.type === 'snapshot');
    made[0].onmessage({ data: { type: 'snapshot-result', id: req.id, json: null } });
    await expect(p).resolves.toEqual([]);
  });

  it('resolves to an empty array if the worker is gone (stopped)', async () => {
    // Terminating discards the namespace, so a snapshot request after a stop can
    // never be answered. It must not hang the caller.
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.stop();
    await expect(client.snapshot()).resolves.toEqual([]);
  });
});

// #253: the files a program wrote. Same request/response shape as snapshot(),
// and the same guarantee — a terminated worker resolves rather than hangs.
describe('file outputs', () => {
  it('asks the worker for a listing and resolves with its entries', async () => {
    const { client, made } = await bootedClient();
    const p = client.listFiles();
    const sent = made[0].posted.filter(m => m.type === 'fs-list');
    expect(sent.length).toBe(1);
    made[0].onmessage({ data: {
      type: 'fs-list-result', id: sent[0].id,
      entries: [{ name: 'plot.png', size: 19648, isDir: false }]
    } });
    await expect(p).resolves.toEqual([{ name: 'plot.png', size: 19648, isDir: false }]);
  });

  it('reads one file by name and resolves with its bytes', async () => {
    const { client, made } = await bootedClient();
    const p = client.readFile('plot.png');
    const sent = made[0].posted.filter(m => m.type === 'fs-read');
    expect(sent.length).toBe(1);
    expect(sent[0].name).toBe('plot.png');
    const bytes = new Uint8Array([137, 80, 78, 71]);
    made[0].onmessage({ data: { type: 'fs-read-result', id: sent[0].id, name: 'plot.png', bytes } });
    await expect(p).resolves.toBe(bytes);
  });

  it('resolves empty rather than hanging when the worker is gone', async () => {
    const { client } = await bootedClient();
    client.discardWorker();
    await expect(client.listFiles()).resolves.toEqual([]);
    await expect(client.readFile('plot.png')).resolves.toBe(null);
  });

  it('ignores a reply whose id nothing is waiting on', async () => {
    const { client, made } = await bootedClient();
    const p = client.listFiles();
    const id = made[0].posted.filter(m => m.type === 'fs-list')[0].id;
    // A stale reply from a worker we already replaced must not settle this one.
    made[0].onmessage({ data: { type: 'fs-list-result', id: 'fsls-stale', entries: [{ name: 'x' }] } });
    made[0].onmessage({ data: { type: 'fs-list-result', id, entries: [] } });
    await expect(p).resolves.toEqual([]);
  });
});
