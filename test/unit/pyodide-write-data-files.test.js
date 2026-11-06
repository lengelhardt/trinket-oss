'use strict';

// #373: only .py files reached the Pyodide filesystem, so
// np.loadtxt('data.txt') / open('data.txt') raised FileNotFoundError for a
// trinket that shipped the data file. Both runtimes must write every file.
// Imports stay .py-only: loadImportsFromFiles / loadImportsFromSources are
// asserted below so the widening cannot leak into the import scan.
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const { writeSecondaryFiles } = require('../../public/js/embed/pyodide-worker.js');

function fakeFS() {
  const written = {};
  return { written, writeFile: (name, body) => { written[name] = body; } };
}

const FILES = {
  'main.py': 'print(1)',
  'helper.py': 'X = 1',
  'linear_data.txt': '1 2\n3 4\n',
  'table.csv': 'a,b\n1,2\n',
};

describe('main thread: syncFilesToFS writes every file (#373)', () => {
  // pyodide.js is a classic browser script with no exports, so lift the one
  // function out of its source and run it against a fake global `pyodide`.
  const src = read('public/js/embed/pyodide.js');
  const start = src.indexOf('function syncFilesToFS(');
  const end = src.indexOf('\n}\n', start) + 3;
  const run = (files, main) => {
    const FS = fakeFS();
    const sandbox = { pyodide: { FS } };
    vm.createContext(sandbox);
    vm.runInContext(src.slice(start, end) + '\nthis.out = syncFilesToFS(' +
      JSON.stringify(files) + ',' + JSON.stringify(main) + ');', sandbox);
    return { prog: sandbox.out, written: FS.written };
  };

  it('writes .py and non-.py files, and returns the main program', () => {
    const { prog, written } = run(FILES, 'main.py');
    expect(prog).toBe('print(1)');
    expect(written).toEqual({
      'helper.py': 'X = 1',
      'linear_data.txt': '1 2\n3 4\n',
      'table.csv': 'a,b\n1,2\n',
    });
  });

  it('does not write the main file', () => {
    expect(run(FILES, 'main.py').written['main.py']).toBeUndefined();
  });
});

describe('worker: writeSecondaryFiles writes every file (#373)', () => {
  it('writes .py and non-.py files', () => {
    const FS = fakeFS();
    writeSecondaryFiles(FS, FILES);
    expect(FS.written['linear_data.txt']).toBe('1 2\n3 4\n');
    expect(FS.written['table.csv']).toBe('a,b\n1,2\n');
    expect(FS.written['helper.py']).toBe('X = 1');
  });

  it('tolerates missing files and a throwing write', () => {
    expect(() => writeSecondaryFiles(fakeFS(), undefined)).not.toThrow();
    const FS = { writeFile: () => { throw new Error('EEXIST'); } };
    expect(() => writeSecondaryFiles(FS, FILES)).not.toThrow();
  });

  it('run() calls it, so the helper is actually reachable', () => {
    expect(read('public/js/embed/pyodide-worker.js'))
      .toMatch(/writeSecondaryFiles\(pyodide\.FS, msg\.files\)/);
  });
});

describe('import scanning stays .py-only (#373)', () => {
  it('loadImportsFromFiles and loadImportsFromSources still filter on .py', () => {
    expect(read('public/js/embed/pyodide.js'))
      .toMatch(/filter\(function\(k\) \{ return \/\\\.py\$\/\.test\(k\); \}\)/);
    expect(read('public/js/embed/pyodide-worker.js'))
      .toMatch(/if \(!\/\\\.py\$\/\.test\(name\)\) continue;/);
  });
});
