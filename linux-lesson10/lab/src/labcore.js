/* Проверка заданий: общая часть для страницы, режима преподавателя и сборки. */
(function (BS) {
  'use strict';
  const LU = BS.labUtil;
  const LABDIR = '/home/student/lab10';
  const VISIBLE_TESTS = 2;

  function addFixtures(vfs) {
    vfs.mkdir(LABDIR, true);
    for (const [rel, content] of Object.entries(BS.FIXTURES)) {
      const abs = BS.VFS.normalize(rel, LABDIR);
      vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')), true);
      if (!vfs.get(abs)) vfs.writeFile(abs, content, BS.FIXTURE_MODES[rel]);
    }
    return vfs;
  }
  function freshFS() { return addFixtures(BS.defaultFS()); }

  function capture() {
    let out = '';
    const w = { write: (s) => { out += s; }, tty: false };
    return { w, get: () => out };
  }

  /* Запуск скрипта задания в «чистой» песочнице */
  function runIsolated(file, code, args, stdin, ms) {
    const vfs = freshFS();
    const abs = LABDIR + '/' + file;
    vfs.writeFile(abs, code, 0o755);
    const sh = new BS.Shell({ fs: vfs, cwd: LABDIR, limits: BS.Shell.makeLimits(ms || 3000) });
    sh.hints = true;
    const c = capture();
    const io = { in: new BS.io.InStream(stdin || '', false), out: c.w, err: c.w };
    let status, timeout = false;
    try { status = sh.runScriptFile(abs, code, file, args || [], io, 'bash'); }
    catch (e) {
      if (e instanceof BS.sig.FatalError) { timeout = true; status = 124; }
      else { c.w.write('[внутренняя ошибка симулятора: ' + (e && e.message) + ']\n'); status = 125; }
    }
    return { out: c.get(), code: status, timeout };
  }

  function checkReqs(task, code) {
    const src = LU.stripComments(code);
    return (task.req || []).map(([re, msg]) => ({ ok: new RegExp(re).test(src), msg }));
  }

  /* expected: [{out (или null), h, code}] */
  function checkScript(task, code, expected) {
    const tests = [];
    let allOk = true;
    (task.tests || []).forEach((t, i) => {
      const exp = expected && expected[i];
      const r = runIsolated(task.file, code, t.args || [], t.stdin || '');
      const got = LU.normOut(r.out);
      const outOk = exp ? LU.hash(got) === exp.h : false;
      const codeOk = !t.code || (exp && r.code === exp.code);
      const ok = outOk && codeOk;
      if (!ok) allOk = false;
      tests.push({
        i, ok, outOk, codeOk, timeout: r.timeout,
        args: t.args || [], stdin: t.stdin || '',
        got, gotCode: r.code,
        expected: i < VISIBLE_TESTS && exp ? exp.out : null,
        expCode: t.code && exp ? exp.code : null,
        hidden: i >= VISIBLE_TESTS,
      });
    });
    const reqs = checkReqs(task, code);
    const reqOk = reqs.every(r => r.ok);
    const empty = LU.stripComments(code).trim() === '';
    return { ok: allOk && reqOk && !empty, tests, reqs, empty };
  }

  function checkQuiz(task, answer, expHash) {
    if (answer == null || answer === '') return { ok: false };
    const val = task.type === 'choice' ? String(answer) : LU.normQuiz(answer);
    return { ok: LU.answerHash(task.id, val) === expHash };
  }

  /* ctx: {fs, aliases, history, execLog, answers} */
  function checkTerminal(task, ctx) {
    const full = Object.assign({}, ctx);
    full.runScript = (abs) => {
      const vfs = ctx.fs.clone();
      const sh = new BS.Shell({ fs: vfs, cwd: LABDIR, limits: BS.Shell.makeLimits(2000) });
      const c = capture();
      try {
        const n = vfs.get(abs);
        sh.runScriptFile(abs, n.x, abs.split('/').pop(), [], { in: new BS.io.InStream('', false), out: c.w, err: c.w }, 'bash');
      } catch (e) { c.w.write('[ошибка]'); }
      return { out: c.get() };
    };
    let items;
    try { items = task.check(full); } catch (e) { items = [{ ok: false, label: 'ошибка проверки: ' + e.message }]; }
    return { ok: items.every(x => x.ok), items };
  }

  /* Баллы за задание по его состоянию */
  function taskScore(task, st) {
    if (!st || !st.passed) return 0;
    if (task.type === 'choice' || task.type === 'output') {
      const k = Math.max(0, 1 - 0.5 * (st.wrong || 0));
      return Math.round(task.points * k * 10) / 10;
    }
    return task.points;
  }

  BS.labCore = { LABDIR, VISIBLE_TESTS, addFixtures, freshFS, runIsolated, checkScript, checkQuiz, checkTerminal, checkReqs, taskScore };
})(globalThis.BS = globalThis.BS || {});
