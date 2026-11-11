/* Общие функции: запуск скрипта в симуляторе и в настоящем bash. */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
for (const f of ['vfs.js', 'parser.js', 'arith.js', 'shell.js', 'commands.js', 'awk.js']) require(path.join(SRC, f));
const BS = globalThis.BS;

const CWD = '/home/student/lab10';

/* fixtures: {relPath: content} ; modes: {relPath: 0o755} */
function runSim(script, opts) {
  opts = opts || {};
  const vfs = BS.defaultFS();
  const sh = new BS.Shell({ fs: vfs, cwd: CWD, limits: BS.Shell.makeLimits(opts.ms || 5000) });
  for (const [rel, content] of Object.entries(opts.fixtures || {})) {
    const abs = BS.VFS.normalize(rel, CWD);
    const dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
    vfs.mkdir(dir, true);
    vfs.writeFile(abs, content, (opts.modes || {})[rel]);
  }
  const name = opts.name || 'script.sh';
  vfs.writeFile(BS.VFS.normalize(name, CWD), script, 0o755);
  let out = '';
  const w = { write: (s) => { out += s; }, tty: false };
  const io = { in: new BS.io.InStream(opts.stdin || '', false), out: w, err: w };
  let code;
  try {
    code = sh.runScriptFile(BS.VFS.normalize(name, CWD), script, name, opts.args || [], io, 'bash');
  } catch (e) {
    if (e instanceof BS.sig.FatalError) { out += '[TIMEOUT]\n'; code = -1; }
    else throw e;
  }
  return { out, code, vfs };
}

function runReal(script, opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab10-'));
  try {
    for (const [rel, content] of Object.entries(opts.fixtures || {})) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      if ((opts.modes || {})[rel]) fs.chmodSync(p, (opts.modes || {})[rel]);
    }
    const name = opts.name || 'script.sh';
    fs.writeFileSync(path.join(dir, name), script);
    const args = (opts.args || []).map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ');
    const r = cp.spawnSync('bash', ['-c', 'cd "$1" && exec bash ' + name + ' ' + args + ' 2>&1', '_', dir], {
      input: opts.stdin || '',
      env: { HOME: '/home/student', USER: 'student', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'dumb' },
      encoding: 'utf8',
      timeout: 10000,
    });
    return { out: r.stdout, code: r.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { BS, runSim, runReal, CWD };
