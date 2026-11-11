/* Сборка лабораторной: ожидаемые ответы из настоящего bash + один HTML-файл. */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const SRC = path.join(__dirname, 'src');
const MODULES = ['vfs.js', 'parser.js', 'arith.js', 'shell.js', 'commands.js', 'awk.js', 'tasks.js', 'labcore.js'];
for (const f of MODULES) require(path.join(SRC, f));
const BS = globalThis.BS;
const LU = BS.labUtil, LC = BS.labCore;

const errors = [];
const fail = (m) => { errors.push(m); console.log('  ✗ ' + m); };

function realBash(file, code, args, stdin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab10b-'));
  try {
    for (const [rel, content] of Object.entries(BS.FIXTURES)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      fs.chmodSync(p, BS.FIXTURE_MODES[rel] || 0o644);
    }
    fs.writeFileSync(path.join(dir, file), code, { mode: 0o755 });
    const q = args.map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ');
    const r = cp.spawnSync('bash', ['-c', 'cd "$1" && exec bash ' + file + ' ' + q + ' 2>&1', '_', dir], {
      input: stdin, encoding: 'utf8', timeout: 10000,
      env: { HOME: '/home/student', USER: 'student', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
    return { out: r.stdout, code: r.status };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const expected = { tests: {}, quiz: {} };
const quizAns = JSON.parse(fs.readFileSync(path.join(__dirname, 'solutions', 'quiz.json'), 'utf8'));

console.log('== Задания-скрипты');
for (const t of BS.TASKS.filter(x => x.type === 'script')) {
  const sol = fs.readFileSync(path.join(__dirname, 'solutions', t.id + '.sh'), 'utf8');
  const exp = [];
  t.tests.forEach((tc, i) => {
    const real = realBash(t.file, sol, tc.args || [], tc.stdin || '');
    const sim = LC.runIsolated(t.file, sol, tc.args || [], tc.stdin || '');
    if (sim.out !== real.out || sim.code !== real.code) fail(t.id + ' тест ' + (i + 1) + ': симулятор ≠ bash\n    bash: ' + JSON.stringify(real.out) + ' (' + real.code + ')\n    sim:  ' + JSON.stringify(sim.out) + ' (' + sim.code + ')');
    const n = LU.normOut(real.out);
    exp.push({ out: i < LC.VISIBLE_TESTS ? n : null, h: LU.hash(n), code: real.code });
  });
  expected.tests[t.id] = exp;
  const res = LC.checkScript(t, sol, exp);
  if (!res.ok) fail(t.id + ': эталон не проходит проверку ' + JSON.stringify(res.reqs.filter(r => !r.ok)) + JSON.stringify(res.tests.filter(x => !x.ok).map(x => x.i)));
  const st = LC.checkScript(t, t.starter, exp);
  if (st.ok) fail(t.id + ': заготовка проходит проверку!');
  console.log('  ' + (res.ok ? '✓' : '✗') + ' ' + t.id + ' ' + t.file + ' — тестов: ' + t.tests.length);
}

console.log('== Разминка');
for (const t of BS.TASKS.filter(x => x.type === 'choice' || x.type === 'output')) {
  let val;
  if (t.type === 'choice') val = String(quizAns[t.id]);
  else {
    const real = realBash('q.sh', t.code + '\n', [], '');
    const sim = LC.runIsolated('q.sh', t.code + '\n', [], '');
    if (real.out !== sim.out) fail(t.id + ': симулятор ≠ bash');
    val = LU.normQuiz(real.out);
    t._answer = val;
  }
  expected.quiz[t.id] = LU.answerHash(t.id, val);
  console.log('  ✓ ' + t.id + ' → ' + JSON.stringify(t.type === 'choice' ? t.options[quizAns[t.id]] : val));
}

console.log('== Терминальные задания');
{
  const vfs = LC.freshFS();
  const execLog = [];
  const sh = new BS.Shell({ fs: vfs, interactive: true, execLog, history: [] });
  sh.hints = true;
  let out = '';
  const w = { write: (s) => { out += s; }, tty: true };
  sh.host = { openEditor() {}, prompt() { return null; } };
  const cmds = fs.readFileSync(path.join(__dirname, 'solutions', 'terminal_session.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  for (const c of cmds) {
    sh.history.push(c);
    sh.resetLimits(3000);
    sh.runText(c, { in: new BS.io.InStream('', true), out: w, err: w }, { interactive: true });
  }
  const answers = { T1: { a: '8', b: '/usr/bin/zsh' } };
  for (const t of BS.TASKS.filter(x => x.type === 'terminal')) {
    const r = LC.checkTerminal(t, { fs: vfs, aliases: sh.aliases, history: sh.history, execLog, answers: answers[t.id] || {} });
    if (!r.ok) fail(t.id + ': ' + JSON.stringify(r.items.filter(x => !x.ok)));
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + t.id + ' ' + t.title);
  }
  if (process.env.SHOW_TERM) console.log(out);
}

let core = 0, bonus = 0, minutes = 0;
for (const t of BS.TASKS) { if (t.core) { core += t.points; minutes += t.minutes; } else bonus += t.points; }
console.log('== Баллы: основные ' + core + ', бонусные ' + bonus + ', время основных ≈ ' + minutes + ' мин, заданий: ' + BS.TASKS.length);
if (core !== 100) fail('сумма основных баллов должна быть 100');

if (errors.length) { console.log('\nОШИБОК: ' + errors.length); process.exit(1); }

/* ---------- Сборка HTML ---------- */
const tpl = path.join(SRC, 'template.html');
if (!fs.existsSync(tpl)) { console.log('template.html ещё нет — сборка HTML пропущена'); process.exit(0); }
const js = MODULES.concat(['app.js']).map(f => '/* ===== ' + f + ' ===== */\n' + fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
const data = '(globalThis.BS = globalThis.BS || {}).EXPECTED = ' + JSON.stringify(expected) + ';\n';
const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(tpl, 'utf8')
  .replace('/*CSS*/', () => css)
  .replace('/*JS*/', () => safe(data + js));
const outDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'lab10_bash.html');
fs.writeFileSync(outFile, html);
console.log('Собрано: ' + outFile + ' (' + Math.round(html.length / 1024) + ' КБ)');
