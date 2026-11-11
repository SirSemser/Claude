/* Интерфейс лабораторной работы. */
(function (BS) {
  'use strict';
  if (typeof document === 'undefined') return;
  const LAB = BS.LAB, TASKS = BS.TASKS, LC = BS.labCore, LU = BS.labUtil;
  const LABDIR = LC.LABDIR, HOME = '/home/student';
  const STORE_KEY = 'lab10-bash-state-v1';
  const VERSION = '1.0';
  const esc = LU.esc;
  const $ = (s, r) => (r || document).querySelector(s);
  const byId = (id) => document.getElementById(id);
  const taskById = (id) => TASKS.find(t => t.id === id);

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const t = byId('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s);
  }
  function fmtDate(ms) { const d = new Date(ms); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function plural(n, a, b, c) { const m = Math.abs(n) % 100, k = m % 10; if (m > 10 && m < 20) return c; if (k > 1 && k < 5) return b; if (k === 1) return a; return c; }
  const ptsWord = (n) => plural(Math.round(n), 'балл', 'балла', 'баллов');

  /* ================= Состояние ================= */
  let storageOk = true;
  function loadState() {
    try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; }
    catch (e) { storageOk = false; return null; }
  }
  let state = null;
  let saveTimer = null;
  let dirtySinceDownload = false;
  function saveNow() {
    if (!state) return;
    state.updatedAt = Date.now();
    state.term = snapshotTerm();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { storageOk = false; }
  }
  function save() { dirtySinceDownload = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function tstate(id) { if (!state.tasks[id]) state.tasks[id] = { attempts: 0, wrong: 0, passed: false }; return state.tasks[id]; }

  /* ================= Терминал ================= */
  let termFS = null, termSh = null, execLog = null, history = null;
  let pendingEditor = null;
  let liveOut = null;
  const host = {
    prompt(text) {
      const tail = liveOut ? liveOut.get().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').slice(-6).join('\n') : '';
      const msg = 'Скрипт ждёт ввод с клавиатуры (команда read).\n\n' + (tail ? tail : '') + (text && !tail.endsWith(text) ? text : '');
      const r = window.prompt(msg.trim() || 'Введите строку:', '');
      return r;
    },
    openEditor(abs, shown, cmd) { pendingEditor = { abs, shown, cmd }; },
  };
  function snapshotTerm() {
    if (!termSh) return state && state.term;
    return { fs: termFS.toJSON(), cwd: termSh.cwd, aliases: Array.from(termSh.aliases.entries()), history: history.slice(-500), execLog: execLog.slice(-300) };
  }
  function makeShell(cwd, aliases) {
    const sh = new BS.Shell({ fs: termFS, cwd: cwd || LABDIR, interactive: true, history, execLog, host });
    sh.hints = true;
    sh.termWidth = termCols();
    if (aliases) sh.aliases = new Map(aliases);
    else {
      const sink = { write() {}, tty: false };
      try { sh.sourceFile(HOME + '/.bashrc', [], { in: new BS.io.InStream('', false), out: sink, err: sink }); } catch (e) { /* ignore */ }
      const last = execLog[execLog.length - 1];
      if (last && last.how === 'source' && last.path === HOME + '/.bashrc') execLog.pop();
    }
    return sh;
  }
  function initTerminal() {
    const saved = state.term;
    if (saved && saved.fs) {
      termFS = BS.VFS.fromJSON(saved.fs);
      history = saved.history || [];
      execLog = saved.execLog || [];
      termSh = makeShell(saved.cwd, saved.aliases);
    } else {
      termFS = LC.freshFS();
      history = []; execLog = [];
      termSh = makeShell(LABDIR, null);
    }
  }
  let charW = 9;
  function termCols() {
    const t = byId('term');
    if (!t || !t.clientWidth) return 80;
    return Math.max(30, Math.floor((t.clientWidth - 24) / charW));
  }
  function measureChar() {
    const s = el('span', { style: 'font: var(--fs)/1 var(--mono); position:absolute; visibility:hidden; white-space:pre' }, 'MMMMMMMMMM');
    document.body.append(s); charW = s.getBoundingClientRect().width / 10 || 9; s.remove();
    if (termSh) termSh.termWidth = termCols();
  }

  /* ---------- ANSI → HTML ---------- */
  function ansiAppend(container, text) {
    let st = { b: false, i: false, u: false, fg: null, bg: null };
    const re = /\x1b\[([0-9;?]*)([A-Za-z])/g;
    let last = 0, m;
    const flush = (chunk) => {
      if (!chunk) return;
      chunk = chunk.replace(/[\x07\r]/g, '');
      if (!chunk) return;
      const cls = [];
      if (st.b) cls.push('a-b'); if (st.i) cls.push('a-i'); if (st.u) cls.push('a-u');
      if (st.fg) cls.push('a-' + st.fg); if (st.bg) cls.push('a-' + st.bg);
      if (cls.length) container.append(el('span', { class: cls.join(' ') }, chunk));
      else container.append(document.createTextNode(chunk));
    };
    while ((m = re.exec(text))) {
      flush(text.slice(last, m.index));
      last = re.lastIndex;
      if (m[2] === 'J' && m[1] === '2') { container.textContent = ''; continue; }
      if (m[2] !== 'm') continue;
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (const c of codes) {
        if (c === 0) st = { b: false, i: false, u: false, fg: null, bg: null };
        else if (c === 1) st.b = true; else if (c === 3) st.i = true; else if (c === 4) st.u = true;
        else if (c === 22) st.b = false; else if (c === 23) st.i = false; else if (c === 24) st.u = false;
        else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) st.fg = c;
        else if (c === 39) st.fg = null;
        else if (c >= 40 && c <= 47) st.bg = c;
        else if (c === 49) st.bg = null;
      }
    }
    flush(text.slice(last));
  }

  function clipLines(text) {
    const lines = text.split('\n');
    if (lines.length <= 700) return text;
    return lines.slice(0, 300).join('\n') + '\n\x1b[90m… пропущено строк: ' + (lines.length - 500) + ' …\x1b[0m\n' + lines.slice(-200).join('\n');
  }
  function makeSink(tty) {
    let buf = '';
    const limit = 120000;
    const w = { tty, write(s) { buf += s; if (buf.length > limit) throw new BS.sig.FatalError('output'); } };
    return { w, get: () => buf };
  }

  class Term {
    constructor() {
      this.box = byId('term'); this.out = byId('termOut'); this.inp = byId('termIn'); this.pr = byId('termPrompt');
      this.buf = ''; this.hpos = null; this.draft = '';
      this.inp.addEventListener('keydown', (e) => this.key(e));
      this.inp.addEventListener('paste', (e) => {
        const t = (e.clipboardData || window.clipboardData).getData('text');
        if (t && /\n/.test(t)) {
          e.preventDefault();
          const lines = t.replace(/\r/g, '').split('\n');
          const first = this.inp.value + lines.shift();
          this.inp.value = '';
          this.submit(first);
          lines.forEach((l, i) => { if (i < lines.length - 1 || l) this.submit(l); });
        }
      });
      this.box.addEventListener('mouseup', () => { if (!window.getSelection().toString()) this.inp.focus(); });
      this.renderPrompt();
    }
    promptHtml() {
      if (this.buf) return '> ';
      const cwd = termSh.cwd === HOME ? '~' : termSh.cwd.startsWith(HOME + '/') ? '~' + termSh.cwd.slice(HOME.length) : termSh.cwd;
      return '<span class="p-user">student@lab10-pc</span>:<span class="p-path">' + esc(cwd) + '</span>$ ';
    }
    renderPrompt() { this.pr.innerHTML = this.promptHtml(); }
    pre() { if (this.pendingNl) { this.out.append(document.createTextNode('\n')); this.pendingNl = false; } }
    print(text) {
      if (!text) return;
      text = clipLines(text);
      const nl = text.endsWith('\n');
      if (nl) text = text.slice(0, -1);
      if (/\x1b\[2J/.test(text)) this.pendingNl = false;
      this.pre();
      ansiAppend(this.out, text);
      this.pendingNl = nl;
      if (!nl && text && !/\x1b\[2J\x1b\[H$/.test(text)) this.pendingNl = true;
      this.trim(); this.scroll();
    }
    printHtml(html) {
      const nl = html.endsWith('\n');
      if (nl) html = html.slice(0, -1);
      this.pre();
      this.out.append(el('span', { html }));
      this.pendingNl = nl;
      this.scroll();
    }
    trim() { while (this.out.childNodes.length > 4000) this.out.removeChild(this.out.firstChild); }
    scroll() { this.box.scrollTop = this.box.scrollHeight; }
    clear() { this.out.textContent = ''; this.pendingNl = false; }
    focus() { this.inp.focus(); }
    key(e) {
      if (e.key === 'Enter') { e.preventDefault(); const v = this.inp.value; this.inp.value = ''; this.submit(v); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!history.length) return;
        if (this.hpos == null) { this.draft = this.inp.value; this.hpos = history.length; }
        this.hpos += e.key === 'ArrowUp' ? -1 : 1;
        if (this.hpos < 0) this.hpos = 0;
        if (this.hpos >= history.length) { this.hpos = null; this.inp.value = this.draft; }
        else this.inp.value = history[this.hpos].split('\n')[0];
        setTimeout(() => this.inp.setSelectionRange(this.inp.value.length, this.inp.value.length), 0);
        return;
      }
      if (e.key === 'Tab') { e.preventDefault(); this.complete(); return; }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L' || e.key === 'д' || e.key === 'Д')) { e.preventDefault(); this.clear(); return; }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C' || e.key === 'с' || e.key === 'С') && !window.getSelection().toString() && this.inp.selectionStart === this.inp.selectionEnd) {
        e.preventDefault();
        this.printHtml(this.promptHtml() + esc(this.inp.value) + '^C\n');
        this.inp.value = ''; this.buf = ''; this.hpos = null; this.renderPrompt();
      }
    }
    submit(line) {
      this.hpos = null;
      this.printHtml(this.promptHtml() + esc(line) + '\n');
      const text = this.buf ? this.buf + '\n' + line : line;
      if (!text.trim()) { this.buf = ''; this.renderPrompt(); return; }
      // проверка завершённости
      try {
        const p = new BS.Parser(text); p.interactive = true; p.parseProgram();
      } catch (e) {
        if (e instanceof BS.ParseError && e.incomplete) { this.buf = text; this.renderPrompt(); return; }
      }
      this.buf = '';
      if (!/^\s/.test(text)) history.push(text);
      this.run(text);
      this.renderPrompt();
      this.afterCommand();
    }
    run(text) {
      termSh.resetLimits(4000);
      termSh.termWidth = termCols();
      const sink = makeSink(true);
      liveOut = sink;
      const io = { in: new BS.io.InStream('', true), out: sink.w, err: sink.w };
      try {
        termSh.runText(text, io, { interactive: true });
      } catch (e) {
        if (e instanceof BS.sig.ExitSig) {
          this.print(sink.get());
          this.print('logout\n\x1b[90m[Сеанс завершён. Открыт новый сеанс bash: алиасы из терминала сброшены, ~/.bashrc прочитан заново.]\x1b[0m\n');
          termSh = makeShell(HOME, null);
          liveOut = null;
          return;
        }
        if (e instanceof BS.sig.FatalError) {
          this.print(sink.get());
          this.print(e.message === 'output' ? '\n\x1b[31m⛔ Слишком много вывода — команда остановлена.\x1b[0m\n' : '\n\x1b[31m⏱ Команда остановлена: выполнялась дольше 4 секунд (возможно, бесконечный цикл).\x1b[0m\n');
          liveOut = null;
          return;
        }
        this.print(sink.get());
        this.print('\x1b[31m[внутренняя ошибка симулятора: ' + (e && e.message) + ']\x1b[0m\n');
        console.error(e);
        liveOut = null;
        return;
      }
      liveOut = null;
      this.print(sink.get());
    }
    afterCommand() {
      syncEditorFromFS();
      save();
      if (pendingEditor) { const p = pendingEditor; pendingEditor = null; openNano(p.abs, p.shown, p.cmd); }
    }
    complete() {
      const v = this.inp.value;
      const pos = this.inp.selectionStart;
      const before = v.slice(0, pos);
      const m = /(\S*)$/.exec(before);
      const word = m[1];
      const prefixText = before.slice(0, before.length - word.length);
      const isCmd = /(^|[;&|]\s*|\$\(\s*)$/.test(prefixText.trimEnd() === '' ? '' : prefixText) && !/\//.test(word);
      let cands = [];
      if (isCmd || prefixText.trim() === '') {
        if (!word.includes('/')) {
          const names = new Set([...Object.keys(BS.BUILTINS), ...Object.keys(BS.COMMANDS), ...termSh.functions.keys(), ...termSh.aliases.keys()]);
          cands = Array.from(names).filter(n => n.startsWith(word)).sort().map(n => ({ text: n, dir: false }));
        }
      }
      if (!cands.length || word.includes('/')) {
        let w = word.replace(/^~(?=\/|$)/, HOME);
        const slash = w.lastIndexOf('/');
        const dirPart = slash >= 0 ? w.slice(0, slash + 1) : '';
        const base = slash >= 0 ? w.slice(slash + 1) : w;
        const abs = BS.VFS.normalize(dirPart || '.', termSh.cwd);
        const node = termFS.get(abs);
        if (node && node.t === 'd') {
          cands = Object.keys(node.c).filter(n => n.startsWith(base) && (base.startsWith('.') || !n.startsWith('.'))).sort()
            .map(n => ({ text: (slash >= 0 ? word.slice(0, word.lastIndexOf('/') + 1) : '') + n, dir: node.c[n].t === 'd', short: n }));
        }
      }
      if (!cands.length) return;
      if (cands.length === 1) {
        const c = cands[0];
        const ins = c.text + (c.dir ? '/' : ' ');
        this.inp.value = prefixText + ins + v.slice(pos);
        const np = (prefixText + ins).length;
        this.inp.setSelectionRange(np, np);
        return;
      }
      let common = cands[0].text;
      for (const c of cands) { let i = 0; while (i < common.length && c.text[i] === common[i]) i++; common = common.slice(0, i); }
      if (common.length > word.length) {
        this.inp.value = prefixText + common + v.slice(pos);
        const np = (prefixText + common).length;
        this.inp.setSelectionRange(np, np);
        return;
      }
      this.printHtml(this.promptHtml() + esc(v) + '\n');
      this.print(cands.slice(0, 120).map(c => (c.short || c.text) + (c.dir ? '/' : '')).join('  ') + '\n');
    }
  }
  let term = null;

  /* ================= nano ================= */
  function openNano(abs, shown, cmd) {
    const node = termFS.get(abs);
    const original = node ? node.x : '';
    let modified = false, asking = false, clip = '';
    const isVim = /^(vi|vim)$/.test(cmd);
    const ta = el('textarea', { spellcheck: 'false', 'aria-label': 'Текст файла' });
    ta.value = original;
    const status = el('span', {}, '');
    const msg = el('div', { class: 'nano-msg' }, node ? '[ Прочитано строк: ' + (original ? original.split('\n').length - (original.endsWith('\n') ? 1 : 0) : 0) + ' ]' : '[ Новый файл ]');
    const keyBtn = (k, label, fn) => el('button', { onclick: (e) => { e.preventDefault(); fn(); ta.focus(); } }, el('kbd', {}, k), label);
    const wrap = el('div', { class: 'nano', role: 'dialog', 'aria-label': 'Редактор nano' },
      el('div', { class: 'nano-top' }, el('span', {}, isVim ? '  vim (упрощённо: работает как nano)' : '  GNU nano 7.2'), el('span', {}, shown), status),
      ta, msg,
      el('div', { class: 'nano-keys' },
        keyBtn('^S', 'Сохранить', () => doSave()),
        keyBtn('^O', 'Записать', () => doSave()),
        keyBtn('^X', 'Выход', () => doExit()),
        keyBtn('^K', 'Вырезать строку', () => cutLine()),
        keyBtn('^U', 'Вставить', () => paste()),
      ));
    document.body.append(wrap);
    ta.focus();
    ta.setSelectionRange(0, 0);
    const setMod = (v) => { modified = v; status.textContent = v ? 'Изменён  ' : ''; };
    ta.addEventListener('input', () => setMod(ta.value !== original || modified));
    function doSave() {
      try {
        const n = termFS.get(abs);
        if (n) { if (!termFS.can(n, 'w')) throw new BS.FsError('EACCES'); n.x = ta.value; n.mt = Date.now(); }
        else termFS.writeFile(abs, ta.value);
        const lines = ta.value === '' ? 0 : ta.value.split('\n').length - (ta.value.endsWith('\n') ? 1 : 0);
        msg.className = 'nano-msg'; msg.textContent = '[ Записано строк: ' + lines + ' ]';
        setMod(false);
        save();
        return true;
      } catch (e) {
        msg.className = 'nano-msg'; msg.textContent = '[ Ошибка записи ' + shown + ': ' + (e.message || e) + ' ]';
        return false;
      }
    }
    function close() {
      wrap.remove();
      syncEditorFromFS();
      if (term) { term.renderPrompt(); term.focus(); }
    }
    function doExit() {
      if (!modified) { close(); return; }
      asking = true;
      msg.className = 'nano-msg ask';
      msg.textContent = 'Сохранить изменённый буфер?   Y — Да    N — Нет    ^C — Отмена';
    }
    function cutLine() {
      const v = ta.value, p = ta.selectionStart;
      const s = v.lastIndexOf('\n', p - 1) + 1;
      let e = v.indexOf('\n', p); e = e < 0 ? v.length : e + 1;
      clip = v.slice(s, e);
      ta.value = v.slice(0, s) + v.slice(e);
      ta.setSelectionRange(s, s);
      setMod(true);
    }
    function paste() {
      if (!clip) return;
      const p = ta.selectionStart;
      ta.value = ta.value.slice(0, p) + clip + ta.value.slice(p);
      ta.setSelectionRange(p + clip.length, p + clip.length);
      setMod(true);
    }
    ta.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (asking) {
        e.preventDefault();
        if (k === 'y' || k === 'д' || k === 'н' && false) { if (doSave()) close(); }
        else if (k === 'n' || k === 'т') close();
        else if ((e.ctrlKey && (k === 'c' || k === 'с')) || k === 'escape') { asking = false; msg.className = 'nano-msg'; msg.textContent = '[ Отменено ]'; }
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (k === 's' || k === 'o' || k === 'ы' || k === 'щ') { e.preventDefault(); doSave(); return; }
        if (k === 'x' || k === 'ч') { e.preventDefault(); doExit(); return; }
        if (k === 'k' || k === 'л') { e.preventDefault(); cutLine(); return; }
        if (k === 'u' || k === 'г') { e.preventDefault(); paste(); return; }
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const p = ta.selectionStart;
        ta.setRangeText('    ', p, ta.selectionEnd, 'end');
        setMod(true);
      }
    });
  }

  /* ================= Редактор кода ================= */
  const KW = 'if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|local|declare|break|continue|exit|select|readonly|export|shift|unset|let';
  const BI = 'echo|printf|read|cd|test|source|alias|unalias|eval|true|false|mapfile|readarray|set';
  const HL_RE = new RegExp([
    '((?:^|(?<=[\\s;]))#.*$)',
    "('[^']*'?)",
    '("(?:\\\\[\\s\\S]|[^"\\\\])*"?)',
    '(\\$\\{[^}\\n]*\\}?|\\$\\(\\(|\\$\\(|\\$[A-Za-z_][A-Za-z0-9_]*|\\$[0-9#@*?$!-])',
    '(\\b(?:' + KW + ')\\b)',
    '(\\b(?:' + BI + ')\\b)',
    '(\\b\\d+\\b)',
    '(\\[\\[|\\]\\]|\\[|\\]|&&|\\|\\||;;|[|<>])',
  ].join('|'), 'gm');
  function highlight(src) {
    let out = '', last = 0, m;
    HL_RE.lastIndex = 0;
    while ((m = HL_RE.exec(src))) {
      if (m[0] === '') { HL_RE.lastIndex++; continue; }
      out += esc(src.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] || m[3] ? 's' : m[4] ? 'v' : m[5] ? 'k' : m[6] ? 'b' : m[7] ? 'n' : 'o';
      out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
      last = HL_RE.lastIndex;
    }
    return out + esc(src.slice(last)) + '\n';
  }
  class Editor {
    constructor() {
      this.ta = byId('code'); this.hl = byId('hl'); this.gut = byId('gutter');
      this.onChange = null; this.onRun = null;
      this.ta.addEventListener('input', () => { this.render(); if (this.onChange) this.onChange(); });
      this.ta.addEventListener('scroll', () => { this.hl.scrollTop = this.ta.scrollTop; this.hl.scrollLeft = this.ta.scrollLeft; this.gut.scrollTop = this.ta.scrollTop; });
      this.ta.addEventListener('keydown', (e) => this.key(e));
    }
    get value() { return this.ta.value; }
    set value(v) { this.ta.value = v; this.render(); this.ta.scrollTop = 0; }
    render() {
      this.hl.innerHTML = highlight(this.ta.value);
      const n = this.ta.value.split('\n').length;
      let g = '';
      for (let i = 1; i <= n; i++) g += i + '\n';
      this.gut.textContent = g;
      this.hl.scrollTop = this.ta.scrollTop; this.gut.scrollTop = this.ta.scrollTop;
    }
    key(e) {
      const ta = this.ta;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (this.onRun) this.onRun(e.shiftKey); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
        if (s !== en || e.shiftKey) {
          const ls = v.lastIndexOf('\n', s - 1) + 1;
          const block = v.slice(ls, en);
          const nb = e.shiftKey ? block.replace(/^( {1,4}|\t)/gm, '') : block.replace(/^/gm, '    ');
          ta.setRangeText(nb, ls, en, 'select');
        } else ta.setRangeText('    ', s, en, 'end');
        this.render(); if (this.onChange) this.onChange();
        return;
      }
      if (e.key === 'Enter') {
        const s = ta.selectionStart, v = ta.value;
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        let line = v.slice(ls, s);
        const closing = /^(\s*)(fi|done|esac|\}|else|elif\b.*|;;)\s*$/.exec(line);
        if (closing && closing[1].length >= 4 && closing[2] !== ';;' && v.slice(s, v.indexOf('\n', s) < 0 ? v.length : v.indexOf('\n', s)).trim() === '') {
          const prevLines = v.slice(0, ls).split('\n');
          let prev = '';
          for (let k = prevLines.length - 2; k >= 0; k--) if (prevLines[k].trim()) { prev = prevLines[k]; break; }
          const prevInd = /^[ \t]*/.exec(prev)[0].length;
          if (closing[1].length >= prevInd || /^(fi|done|esac|\})$/.test(closing[2])) {
            ta.setRangeText(line.replace(/^ {4}/, ''), ls, s, 'end');
            line = line.replace(/^ {4}/, '');
          }
        }
        const s2 = ta.selectionStart;
        let ind = /^[ \t]*/.exec(line)[0];
        if (/(\bthen|\bdo|\belse|\{|\bin|\)\s*)\s*$/.test(line.replace(/(^|\s)#.*$/, '')) && !/^\s*#/.test(line)) ind += '    ';
        e.preventDefault();
        ta.setRangeText('\n' + ind, s2, ta.selectionEnd, 'end');
        this.render(); if (this.onChange) this.onChange();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        let le = v.indexOf('\n', en); if (le < 0) le = v.length;
        const block = v.slice(ls, le);
        const all = block.split('\n').every(l => /^\s*#/.test(l) || !l.trim());
        const nb = all ? block.replace(/^(\s*)# ?/gm, '$1') : block.replace(/^/gm, '# ');
        ta.setRangeText(nb, ls, le, 'select');
        this.render(); if (this.onChange) this.onChange();
      }
    }
  }
  let editor = null;
  let editorTask = null;
  let edSaveTimer = null;
  function fileAbs(t) { return LABDIR + '/' + t.file; }
  function loadEditorFor(t) {
    editorTask = t;
    const abs = fileAbs(t);
    let n = termFS.get(abs);
    if (!n || n.t !== 'f') {
      try { termFS.mkdir(LABDIR, true); termFS.writeFile(abs, t.starter, 0o755); } catch (e) { /* каталог удалён? */ }
      n = termFS.get(abs);
    }
    editor.value = n ? n.x : t.starter;
    byId('editorFile').textContent = '~/lab10/' + t.file;
    byId('editorSaved').textContent = '';
  }
  function editorChanged() {
    if (!editorTask) return;
    byId('editorSaved').textContent = '…';
    clearTimeout(edSaveTimer);
    edSaveTimer = setTimeout(flushEditor, 300);
  }
  function flushEditor() {
    clearTimeout(edSaveTimer);
    if (!editorTask) return;
    const abs = fileAbs(editorTask);
    try {
      const n = termFS.get(abs);
      if (n && n.t === 'f') { if (n.x !== editor.value) { n.x = editor.value; n.mt = Date.now(); } }
      else { termFS.mkdir(LABDIR, true); termFS.writeFile(abs, editor.value, 0o755); }
      byId('editorSaved').textContent = 'сохранено';
      const st = tstate(editorTask.id);
      if (!st.touched && editor.value !== editorTask.starter) { st.touched = true; renderSide(); }
      save();
    } catch (e) { byId('editorSaved').textContent = 'не удалось сохранить: ' + e.message; }
  }
  function syncEditorFromFS() {
    if (!editorTask) return;
    const n = termFS.get(fileAbs(editorTask));
    if (n && n.t === 'f' && n.x !== editor.value) { editor.value = n.x; toast('Файл ' + editorTask.file + ' изменён в терминале — редактор обновлён'); }
  }

  /* ================= Баллы ================= */
  function scores() {
    let core = 0, bonus = 0, done = 0;
    for (const t of TASKS) {
      const s = LC.taskScore(t, state.tasks[t.id]);
      if (t.core) core += s; else bonus += s;
      if (state.tasks[t.id] && state.tasks[t.id].passed) done++;
    }
    return { core: Math.round(core * 10) / 10, bonus: Math.round(bonus * 10) / 10, done };
  }
  function updateHeader() {
    const s = scores();
    byId('score').textContent = s.core + ' / 100';
    byId('bonus').textContent = s.bonus ? ' +' + s.bonus : '';
    byId('progressBar').style.width = Math.min(100, s.core) + '%';
  }
  function tickTimer() {
    if (!state) return;
    const sec = (Date.now() - state.startedAt) / 1000;
    const t = byId('timer');
    t.textContent = fmtDur(sec);
    t.classList.toggle('over', sec > LAB.minutes * 60);
  }

  /* ================= Боковая панель ================= */
  function statusOf(t) {
    const s = state.tasks[t.id];
    if (s && s.passed) return 'pass';
    if (s && (s.attempts || s.touched || s.wrong)) return 'tried';
    return '';
  }
  function renderSide() {
    const side = byId('side');
    side.textContent = '';
    for (const sec of BS.SECTIONS) {
      const list = TASKS.filter(t => t.section === sec.id);
      const done = list.filter(t => state.tasks[t.id] && state.tasks[t.id].passed).length;
      side.append(el('div', { class: 'sec-title' }, el('span', {}, sec.title), el('span', {}, done + '/' + list.length)));
      for (const t of list) {
        const st = statusOf(t);
        side.append(el('button', { class: 'task-item' + (state.active === t.id ? ' active' : ''), onclick: () => openTask(t.id), title: t.title + (t.core ? '' : ' (бонус)') },
          el('span', { class: 'st ' + st }),
          el('span', { class: 'nm' }, el('i', {}, t.id), t.title),
          el('span', { class: 'pt' + (t.core ? '' : ' b') }, (t.core ? '' : '+') + t.points)));
      }
    }
    side.append(el('div', { class: 'legend' }, 'Фиолетовые «+» — бонусные задания для тех, кто успел основные.'));
    side.append(el('div', { class: 'side-foot' },
      el('button', { class: 'btn' + (state.active === 'TERM' ? ' primary' : ''), onclick: () => openTask('TERM') }, 'Свободный терминал'),
      el('button', { class: 'btn', onclick: showDownload }, 'Скачать результат')));
  }

  /* ================= Экран задания ================= */
  function setConsoleTab(tab) {
    byId('tabOut').classList.toggle('on', tab === 'out');
    byId('tabTerm').classList.toggle('on', tab === 'term');
    byId('outView').hidden = tab !== 'out';
    byId('term').hidden = tab !== 'term';
    if (tab === 'term') { term.scroll(); setTimeout(() => term.focus(), 0); }
    state.consoleTab = tab;
  }
  function openTask(id) {
    if (editorTask) flushEditor();
    state.active = id;
    const left = byId('left');
    left.textContent = '';
    left.scrollTop = 0;
    const main = byId('main');
    main.classList.remove('term-only', 'no-editor');
    editorTask = null;
    if (id === 'TERM') {
      main.classList.add('no-editor');
      byId('tabOut').hidden = true;
      setConsoleTab('term');
      left.append(el('div', { class: 'task-head' }, el('span', { class: 'badge' }, '>_'), el('h1', {}, 'Свободный терминал')));
      left.append(el('p', { class: 'note' }, 'Здесь можно пробовать любые команды. Файлы лежат в ~/lab10, скрипты из заданий тоже сохраняются туда. Команда help покажет список доступных команд.'));
      left.append(cheatNode());
      renderSide(); save();
      return;
    }
    const t = taskById(id);
    const st = tstate(id);
    left.append(el('div', { class: 'task-head' }, el('span', { class: 'badge' }, t.id), el('h1', {}, t.title)));
    const meta = el('div', { class: 'meta' },
      el('span', { class: 'chip' + (t.core ? '' : ' b') }, t.core ? t.points + ' ' + ptsWord(t.points) : 'бонус +' + t.points),
      el('span', { class: 'chip' }, '≈ ' + t.minutes + ' мин'));
    if (st.passed) meta.append(el('span', { class: 'chip ok' }, 'засчитано'));
    else if (st.attempts) meta.append(el('span', { class: 'chip warn' }, 'попыток: ' + st.attempts));
    left.append(meta);
    left.append(el('div', { class: 'desc', html: t.desc }));
    const resultBox = el('div', { id: 'resultBox' });

    if (t.type === 'script') {
      main.classList.remove('no-editor');
      byId('tabOut').hidden = false;
      loadEditorFor(t);
      setConsoleTab('out');
      byId('outView').textContent = '';
      byId('outView').append(el('div', { class: 'muted' }, 'Нажмите «▶ Запустить» (или Ctrl+Enter), чтобы выполнить ./' + t.file + '.\nЗапускать скрипт можно и в терминале — вкладка «Терминал».'));
      const argsInp = el('input', { class: 'inp mono', value: st.args != null ? st.args : (t.args || ''), placeholder: 'аргументы через пробел', 'aria-label': 'Аргументы' });
      argsInp.addEventListener('input', () => { st.args = argsInp.value; save(); });
      const stdinInp = el('textarea', { class: 'inp mono', rows: 3, placeholder: 'пусто — read спросит в окне', 'aria-label': 'Стандартный ввод' });
      stdinInp.value = st.stdin != null ? st.stdin : (t.stdin || '');
      stdinInp.addEventListener('input', () => { st.stdin = stdinInp.value; save(); });
      const needsStdin = !!t.stdin;
      const box = el('div', { class: 'box' },
        el('h3', {}, 'Запуск и проверка'),
        el('div', { class: 'runbar' },
          el('label', {}, './' + t.file), argsInp,
          needsStdin ? el('label', {}, 'Ввод (stdin)') : null, needsStdin ? stdinInp : null),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', onclick: () => runScript(t, argsInp.value, needsStdin ? stdinInp.value : '') }, '▶ Запустить'),
          el('button', { class: 'btn primary', onclick: () => checkScriptTask(t) }, '✓ Проверить'),
          el('span', { class: 'kbd' }, 'Ctrl+Enter — запустить, Ctrl+Shift+Enter — проверить')),
        el('p', { class: 'note', style: 'margin:8px 0 0' }, 'Код сохраняется автоматически в ~/lab10/' + t.file + ' — его можно запускать и в терминале. Проверка запускает скрипт на нескольких тестах, в том числе скрытых.'));
      editor.onRun = (check) => check ? checkScriptTask(t) : runScript(t, argsInp.value, needsStdin ? stdinInp.value : '');
      left.append(box);
      left.append(resultBox);
      if (st.lastResult) renderScriptResult(t, st.lastResult, true);
    } else if (t.type === 'terminal') {
      main.classList.add('no-editor');
      byId('tabOut').hidden = true;
      setConsoleTab('term');
      const box = el('div', { class: 'box' }, el('h3', {}, 'Проверка'));
      st.answers = st.answers || {};
      for (const f of t.fields || []) {
        const inp = el('input', { class: 'inp', value: st.answers[f.id] || '', 'aria-label': f.label });
        inp.addEventListener('input', () => { st.answers[f.id] = inp.value; save(); });
        box.append(el('div', { class: 'field' }, el('label', {}, f.label), inp));
      }
      box.append(el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: () => checkTerminalTask(t) }, '✓ Проверить'),
        el('span', { class: 'note' }, 'Выполните команды в терминале справа, затем нажмите «Проверить».')));
      left.append(box);
      left.append(resultBox);
      if (st.lastItems) renderChecklist(st.lastItems, st.passed);
    } else {
      main.classList.add('no-editor');
      byId('tabOut').hidden = true;
      setConsoleTab('term');
      if (t.code) left.append(el('pre', { class: 'quiz-code' }, t.code));
      const box = el('div', { class: 'box' });
      let getAnswer;
      if (t.type === 'choice') {
        const opts = el('div', { class: 'opts', role: 'radiogroup' });
        t.options.forEach((o, i) => {
          const r = el('input', { type: 'radio', name: 'q' + t.id, value: String(i), disabled: st.passed });
          if (String(st.answer) === String(i)) r.checked = true;
          const lab = el('label', { class: 'opt' + (st.passed && String(st.answer) === String(i) ? ' right' : '') }, r, el('span', { html: esc(o).replace(/(#!?\/?\S*|\$\w+|\/etc\/passwd)/g, '<code>$1</code>') }));
          r.addEventListener('change', () => { opts.querySelectorAll('.opt').forEach(x => x.classList.remove('sel')); lab.classList.add('sel'); });
          opts.append(lab);
        });
        box.append(opts);
        getAnswer = () => { const r = opts.querySelector('input:checked'); return r ? r.value : null; };
      } else {
        const ta = el('textarea', { class: 'inp mono', rows: 2, placeholder: 'вывод программы', disabled: st.passed, 'aria-label': 'Ваш ответ' });
        ta.value = st.answer || '';
        box.append(el('div', { class: 'field' }, el('label', {}, 'Ваш ответ (вывод):'), ta));
        getAnswer = () => ta.value;
        box.append(el('p', { class: 'note' }, 'Можно проверить себя в терминале справа, но сначала подумайте сами.'));
      }
      const left2 = Math.max(0, 1 - 0.5 * (st.wrong || 0)) * t.points;
      box.append(el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: st.passed, onclick: () => answerQuiz(t, getAnswer()) }, st.passed ? 'Ответ принят' : 'Ответить'),
        el('span', { class: 'note' }, st.passed ? 'Получено: ' + LC.taskScore(t, st) + ' ' + ptsWord(LC.taskScore(t, st)) : 'Сейчас можно получить: ' + left2 + ' ' + ptsWord(left2) + ' (каждая ошибка −50%)')));
      left.append(box);
      left.append(resultBox);
      if (st.passed) resultBox.append(el('div', { class: 'result ok' }, el('h3', {}, 'Верно!')));
    }
    // навигация
    const idx = TASKS.indexOf(t);
    left.append(el('div', { class: 'nav' },
      idx > 0 ? el('button', { class: 'btn', onclick: () => openTask(TASKS[idx - 1].id) }, '← ' + TASKS[idx - 1].id) : el('span'),
      idx < TASKS.length - 1 ? el('button', { class: 'btn', onclick: () => openTask(TASKS[idx + 1].id) }, TASKS[idx + 1].id + ' →') : el('span')));
    renderSide();
    save();
  }

  /* ---------- запуск ---------- */
  function runScript(t, args, stdin) {
    flushEditor();
    const view = byId('outView');
    setConsoleTab('out');
    view.textContent = '';
    const cmd = './' + t.file + (args.trim() ? ' ' + args.trim() : '');
    view.append(el('div', { class: 'cmdline' }, 'student@lab10-pc:~/lab10$ ' + cmd + (stdin ? '   ← ввод из поля stdin' : '')));
    const sub = termSh.fork();
    sub.cwd = LABDIR; sub.interactive = false; sub.opts.expand_aliases = false; sub.srcName = null; sub.argv0 = 'bash';
    sub.resetLimits(4000);
    const sink = makeSink(true);
    liveOut = sink;
    let code;
    const io = { in: new BS.io.InStream(stdin, stdin === ''), out: sink.w, err: sink.w };
    const pre = el('div');
    try { code = sub.runText(cmd, io, {}); }
    catch (e) {
      if (e instanceof BS.sig.ExitSig) code = e.code;
      else if (e instanceof BS.sig.FatalError) { sink.w.tty = false; try { sink.w.write(''); } catch (x) { } code = null; ansiAppend(pre, clipLines(sink.get())); view.append(pre); view.append(el('div', { class: 'exit bad' }, e.message === 'output' ? '⛔ Слишком много вывода — скрипт остановлен. Возможно, бесконечный цикл: проверьте, что переменная цикла меняется.' : '⏱ Скрипт остановлен: выполнялся дольше 4 секунд (возможно, бесконечный цикл).')); view.scrollTop = view.scrollHeight; liveOut = null; return; }
      else { code = null; console.error(e); sink.w.write('[внутренняя ошибка симулятора: ' + e.message + ']\n'); }
    }
    liveOut = null;
    ansiAppend(pre, clipLines(sink.get()));
    if (!sink.get()) pre.append(el('span', { class: 'muted' }, '(скрипт ничего не вывел)\n'));
    view.append(pre);
    view.append(el('div', { class: 'exit' + (code ? ' bad' : '') }, '[код завершения: ' + code + ']'));
    view.scrollTop = view.scrollHeight;
    const st = tstate(t.id);
    st.runs = (st.runs || 0) + 1;
    if (!st.touched) { st.touched = true; renderSide(); }
    save();
  }

  /* ---------- проверка ---------- */
  function checkScriptTask(t) {
    flushEditor();
    const code = editor.value;
    const st = tstate(t.id);
    const exp = BS.EXPECTED.tests[t.id];
    const res = LC.checkScript(t, code, exp);
    st.attempts = (st.attempts || 0) + 1;
    st.lastCheckAt = Date.now();
    st.lastCode = code;
    const wasPassed = st.passed;
    if (res.ok) { st.passed = true; st.passCode = code; if (!st.firstPassAt) st.firstPassAt = Date.now(); }
    st.lastResult = { ok: res.ok, n: res.tests.filter(x => x.ok).length, total: res.tests.length, tests: res.tests, reqs: res.reqs, empty: res.empty };
    state.events.push({ t: Date.now(), id: t.id, ok: res.ok });
    renderScriptResult(t, st.lastResult, false);
    if (res.ok && !wasPassed) toast('Задание ' + t.id + ' засчитано: +' + t.points + ' ' + ptsWord(t.points));
    updateHeader(); renderSide(); save();
    const meta = $('.meta'); if (meta && res.ok && !meta.querySelector('.chip.ok')) meta.append(el('span', { class: 'chip ok' }, 'засчитано'));
  }
  function argsShow(a) { return a.map(x => /[\s'"$]/.test(x) || x === '' ? "'" + x + "'" : x).join(' '); }
  function diffPre(text, other) {
    const pre = el('pre');
    const a = (text || '').split('\n'), b = (other == null ? null : other.split('\n'));
    a.forEach((line, i) => {
      const bad = b != null && b[i] !== line;
      pre.append(bad ? el('span', { class: 'dl' }, line === '' ? ' ' : line) : document.createTextNode(line));
      if (i < a.length - 1) pre.append('\n');
    });
    if (text === '') pre.append(el('span', { style: 'color:#6b7785' }, '(пусто)'));
    return pre;
  }
  function renderScriptResult(t, r, restored) {
    const box = byId('resultBox');
    if (!box) return;
    box.textContent = '';
    const st = state.tasks[t.id];
    const head = r.ok ? 'Все тесты пройдены — задание засчитано!' : r.empty ? 'Скрипт пустой — напишите решение.' : 'Пройдено тестов: ' + r.n + ' из ' + r.total;
    const res = el('div', { class: 'result ' + (r.ok ? 'ok' : 'bad') }, el('h3', {}, head));
    if (restored) res.append(el('p', { class: 'note', style: 'margin:0 0 6px' }, 'Результат последней проверки' + (st && st.lastCheckAt ? ' (' + fmtDate(st.lastCheckAt).slice(11) + ')' : '')));
    if (st && st.passed && !r.ok) res.append(el('p', { class: 'note', style: 'margin:0 0 6px;color:#1e8a4c' }, 'Ранее задание уже было засчитано — баллы сохраняются.'));
    if (r.reqs && r.reqs.length) {
      const ul = el('ul', { class: 'checks' });
      for (const q of r.reqs) ul.append(el('li', { class: q.ok ? 'ok' : 'bad' }, 'Требование: ' + q.msg));
      res.append(ul);
    }
    for (const x of r.tests || []) {
      const d = el('div', { class: 'test' });
      const inputDesc = (x.args.length ? argsShow(x.args) : '') + (x.stdin ? '  ← ввод: ' + JSON.stringify(x.stdin).slice(1, -1) : '');
      d.append(el('div', { class: 'tt' }, el('b', { class: x.ok ? 'ok' : 'bad' }, x.ok ? '✓' : '✗'), el('span', {}, 'Тест ' + (x.i + 1) + (x.hidden ? ' (скрытый)' : '')), el('span', { class: 'cmd' }, './' + t.file + ' ' + inputDesc)));
      if (!x.ok) {
        if (x.timeout) d.append(el('p', { class: 'note', style: 'margin:4px 0' }, '⏱ Скрипт выполнялся слишком долго — проверьте условие выхода из цикла.'));
        if (x.outOk && !x.codeOk) d.append(el('p', { class: 'note', style: 'margin:4px 0' }, 'Вывод верный, но код завершения ' + x.gotCode + ' (нужен ' + x.expCode + ').'));
        if (!x.outOk) {
          if (x.expected != null) {
            d.append(el('div', { class: 'diff' },
              el('div', {}, el('span', {}, 'Ожидалось'), diffPre(x.expected, null)),
              el('div', {}, el('span', {}, 'Получено'), diffPre(x.got, x.expected))));
          } else {
            d.append(el('div', { class: 'diff one' }, el('div', {}, el('span', {}, 'Получено (сравните с форматом из условия)'), diffPre(x.got, null))));
          }
        }
      }
      res.append(d);
    }
    box.append(res);
  }
  function termCtx(answers) {
    return { fs: termFS, aliases: termSh.aliases, history, execLog, answers: answers || {} };
  }
  function checkTerminalTask(t) {
    const st = tstate(t.id);
    const r = LC.checkTerminal(t, termCtx(st.answers));
    st.attempts = (st.attempts || 0) + 1;
    st.lastCheckAt = Date.now();
    st.lastItems = r.items;
    const was = st.passed;
    if (r.ok) { st.passed = true; st.passItems = r.items; if (!st.firstPassAt) st.firstPassAt = Date.now(); }
    state.events.push({ t: Date.now(), id: t.id, ok: r.ok });
    renderChecklist(r.items, st.passed);
    if (r.ok && !was) toast('Задание ' + t.id + ' засчитано: +' + t.points + ' ' + ptsWord(t.points));
    updateHeader(); renderSide(); save();
  }
  function renderChecklist(items, passed) {
    const box = byId('resultBox');
    if (!box) return;
    box.textContent = '';
    const ok = items.every(x => x.ok);
    const ul = el('ul', { class: 'checks' });
    for (const x of items) ul.append(el('li', { class: x.ok ? 'ok' : 'bad' }, x.label));
    box.append(el('div', { class: 'result ' + (ok ? 'ok' : 'bad') }, el('h3', {}, ok ? 'Всё выполнено — задание засчитано!' : 'Выполнено ' + items.filter(x => x.ok).length + ' из ' + items.length), passed && !ok ? el('p', { class: 'note', style: 'margin:0 0 6px;color:#1e8a4c' }, 'Ранее задание уже было засчитано.') : null, ul));
  }
  function answerQuiz(t, ans) {
    const st = tstate(t.id);
    if (st.passed) return;
    if (ans == null || String(ans).trim() === '') { toast('Сначала выберите или впишите ответ'); return; }
    const r = LC.checkQuiz(t, ans, BS.EXPECTED.quiz[t.id]);
    st.attempts = (st.attempts || 0) + 1;
    st.answer = String(ans);
    state.events.push({ t: Date.now(), id: t.id, ok: r.ok });
    if (r.ok) { st.passed = true; st.firstPassAt = Date.now(); toast('Верно! +' + LC.taskScore(t, st)); }
    else { st.wrong = (st.wrong || 0) + 1; st.answers = st.answers || {}; (st.wrongAnswers = st.wrongAnswers || []).push(String(ans)); }
    updateHeader(); renderSide(); save();
    openTask(t.id);
    if (!r.ok) {
      const box = byId('resultBox');
      box.append(el('div', { class: 'result bad' }, el('h3', {}, 'Неверно'), el('p', { style: 'margin:0' }, t.type === 'output' ? 'Проверьте пробелы и порядок значений. Подсказка: можно выполнить фрагмент в терминале и посмотреть, почему так.' : 'Перечитайте слайды и попробуйте ещё раз.')));
    }
  }

  /* ================= Шпаргалка ================= */
  const CHEAT = [
    ['Алиасы', "alias ll='ls -l'     # создать\nalias               # список\nunalias ll          # удалить\n# навсегда: дописать в ~/.bashrc\nsource ~/.bashrc"],
    ['Скрипт', "#!/bin/bash          # shebang\n# комментарий\nchmod +x s.sh       # право x\n./s.sh арг1 арг2\nbash s.sh           # без права x\nbash -x s.sh        # отладка"],
    ['Переменные', 'name="Ali"          # без пробелов!\necho "Hi, $name" ${name}\necho \'$name\'        # без подстановки\ntoday=$(date +%F)   # вывод команды\nread -p "Имя: " n   # ввод'],
    ['Специальные', '$0 имя скрипта   $1..$9 аргументы\n$# кол-во         $@ все аргументы\n$? код последней команды\n$$ PID            $RANDOM'],
    ['Арифметика', 'echo $(( a + b * 2 ))\n(( i++ ))   let x=x+1\n$(( 17 / 5 )) → 3   $(( 17 % 5 )) → 2\necho "scale=2; 10/3" | bc'],
    ['Условия', 'if [ "$a" -gt 5 ]; then\n    ...\nelif [ -f file ]; then\n    ...\nelse\n    ...\nfi\nЧисла: -eq -ne -lt -le -gt -ge\nСтроки: = != -z -n\nФайлы: -e -f -d -r -w -x -s\n[[ $s == a* && $n -lt 5 ]]   (( n > 5 ))'],
    ['Строки', '${#s}       длина\n${s:0:3}    подстрока\n${s%.*}     убрать .хвост\n${s##*.}    всё после последней .\n${s/a/b}    заменить первое\n${s//a/b}   заменить все\n${s^^} ${s,,}  регистр'],
    ['Циклы', 'for i in 1 2 3; do ...; done\nfor i in {1..10}; do ...; done\nfor ((i=0; i<5; i++)); do ...; done\nfor f in *.txt; do ...; done\nwhile [ $n -gt 0 ]; do ...; done\nwhile read -r line; do ...; done < file\nbreak  continue'],
    ['case', 'case "$x" in\n    start|go) echo "старт" ;;\n    [0-9]*)   echo "число" ;;\n    *)        echo "другое" ;;\nesac'],
    ['Функции', 'greet() {\n    local name=$1\n    echo "Hi, $name"\n    return 0\n}\ngreet Ali\nr=$(greet Ali)   # вывод функции'],
    ['Массивы', 'arr=(red green blue)\n${arr[0]}  ${arr[@]}  ${#arr[@]}\narr+=(white)   ${!arr[@]} — индексы\nfor x in "${arr[@]}"; do ...; done\ndeclare -A m=([k]=v)  ${m[k]}'],
  ];
  function cheatNode() {
    const d = el('div', { class: 'cheat' });
    for (const [h, c] of CHEAT) d.append(el('div', { class: 'cs' }, el('h4', {}, h), el('pre', {}, c)));
    return d;
  }
  function showCheat() {
    const m = modal(true);
    m.box.append(el('h2', {}, 'Шпаргалка по bash'), el('p', { class: 'sub' }, 'Всё, что нужно для заданий урока 10.'), cheatNode(),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: m.close }, 'Закрыть')));
  }

  /* ================= Модальные окна ================= */
  function modal(wide, persistent) {
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
    back.append(box);
    byId('modalRoot').append(back);
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && !persistent) close(); };
    document.addEventListener('keydown', onKey);
    if (!persistent) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    return { back, box, close };
  }

  /* ================= Отчёт ================= */
  const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ә: 'a', ғ: 'g', қ: 'q', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i' };
  function translit(s) { return Array.from(String(s)).map(ch => { const lo = ch.toLowerCase(); if (TR[lo] == null) return ch; const r = TR[lo]; return ch !== lo && r ? r[0].toUpperCase() + r.slice(1) : r; }).join(''); }
  function sanitizeFile(s) { return translit(String(s).trim()).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'student'; }
  function resultPayload() {
    flushEditor();
    saveNow();
    const sc = scores();
    const tasks = {};
    for (const t of TASKS) {
      const st = state.tasks[t.id] || {};
      const o = { passed: !!st.passed, attempts: st.attempts || 0, wrong: st.wrong || 0, score: LC.taskScore(t, st), firstPassAt: st.firstPassAt || null };
      if (t.type === 'script') {
        const n = termFS.get(fileAbs(t));
        o.code = n && n.t === 'f' ? n.x : null;
        o.passCode = st.passCode || null;
        o.lastCode = st.lastCode || null;
        o.lastResult = st.lastResult ? { ok: st.lastResult.ok, n: st.lastResult.n, total: st.lastResult.total } : null;
        o.runs = st.runs || 0;
      } else if (t.type === 'terminal') {
        o.answers = st.answers || {};
        o.passItems = st.passItems || null;
        o.lastItems = st.lastItems || null;
      } else {
        o.answer = st.answer != null ? st.answer : null;
        o.wrongAnswers = st.wrongAnswers || [];
      }
      tasks[t.id] = o;
    }
    const p = {
      lab: LAB.id, version: VERSION,
      student: state.student,
      startedAt: state.startedAt, finishedAt: Date.now(), elapsedSec: Math.round((Date.now() - state.startedAt) / 1000),
      scores: { core: sc.core, bonus: sc.bonus, done: sc.done, total: TASKS.length },
      tasks,
      term: snapshotTerm(),
      events: state.events.slice(-400),
    };
    p.sig = LU.hash(LAB.salt + JSON.stringify(p));
    return p;
  }
  function reportHtml(p) {
    const e = esc;
    const rows = TASKS.map(t => {
      const o = p.tasks[t.id];
      return '<tr><td>' + t.id + '</td><td>' + e(t.title) + (t.core ? '' : ' <span class="b">бонус</span>') + '</td><td class="n">' + o.score + ' / ' + t.points + '</td><td class="n">' + o.attempts + '</td><td>' + (o.passed ? '<span class="ok">✓ засчитано</span>' : o.attempts ? '<span class="bad">не решено</span>' : '—') + '</td></tr>';
    }).join('');
    let details = '';
    for (const t of TASKS) {
      const o = p.tasks[t.id];
      details += '<section><h3>' + t.id + '. ' + e(t.title) + ' — ' + (o.passed ? '<span class="ok">засчитано</span>' : '<span class="bad">не засчитано</span>') + ', ' + o.score + ' из ' + t.points + '</h3>';
      if (t.type === 'script') {
        const code = o.passCode || o.code || '';
        details += '<p class="m">Файл: ~/lab10/' + e(t.file) + '; проверок: ' + o.attempts + '; запусков: ' + (o.runs || 0) + (o.lastResult ? '; последняя проверка: ' + o.lastResult.n + '/' + o.lastResult.total + ' тестов' : '') + '</p>';
        details += '<pre>' + (code ? e(code) : '<i>(файл пуст или удалён)</i>') + '</pre>';
        if (o.passCode && o.code && o.code !== o.passCode) details += '<p class="m">Текущая версия файла отличается от засчитанной:</p><pre>' + e(o.code) + '</pre>';
      } else if (t.type === 'terminal') {
        const items = o.passItems || o.lastItems;
        if (o.answers && Object.keys(o.answers).length) details += '<p class="m">Ответы: ' + Object.entries(o.answers).map(([k, v]) => k + ' = «' + e(v) + '»').join('; ') + '</p>';
        if (items) details += '<ul>' + items.map(x => '<li class="' + (x.ok ? 'ok' : 'bad') + '">' + (x.ok ? '✓ ' : '✗ ') + e(x.label) + '</li>').join('') + '</ul>';
      } else {
        details += '<p class="m">Ответ: <code>' + e(o.answer == null ? '—' : (t.type === 'choice' ? t.options[o.answer] : o.answer)) + '</code>; ошибок: ' + o.wrong + '</p>';
      }
      details += '</section>';
    }
    const hist = (p.term.history || []).slice(-300).map((h, i) => e(h)).join('\n');
    const json = JSON.stringify(p).replace(/</g, '\\u003c');
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Лаб. 10 — ' + e(p.student.name) + '</title><style>' +
      'body{font:15px/1.45 "Segoe UI",Roboto,Arial,sans-serif;color:#17202a;background:#f4f6f8;margin:0;padding:24px}main{max-width:960px;margin:0 auto;background:#fff;border:1px solid #d9dee4;border-radius:12px;padding:24px 28px}' +
      'h1{margin:0 0 4px;font-size:1.5em}h2{margin:28px 0 8px;font-size:1.15em}h3{font-size:1em;margin:18px 0 6px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e7ec;padding:5px 8px;text-align:left}th{font-size:.8em;color:#6b7785;text-transform:uppercase}td.n{text-align:right;white-space:nowrap}' +
      '.ok{color:#1e8a4c}.bad{color:#c2362f}.b{color:#7a4fd0;font-size:.85em}.m{color:#4a5663;margin:2px 0 6px;font-size:.92em}pre{background:#13181e;color:#d6dde5;padding:10px 12px;border-radius:8px;overflow-x:auto;font:13px/1.45 Consolas,"DejaVu Sans Mono",monospace;white-space:pre}' +
      '.score{display:flex;gap:28px;margin:14px 0}.score div{background:#f4f6f8;border-radius:10px;padding:10px 16px}.score b{display:block;font-size:1.6em}ul{list-style:none;padding:0}code{background:#eef1f5;padding:0 4px;border-radius:4px}' +
      '</style></head><body><main>' +
      '<h1>Лабораторная работа №10. Bash Shell Scripting</h1>' +
      '<p class="m">Студент: <b>' + e(p.student.name) + '</b>, группа <b>' + e(p.student.group) + '</b></p>' +
      '<p class="m">Начало: ' + fmtDate(p.startedAt) + ' · Отчёт создан: ' + fmtDate(p.finishedAt) + ' · Время работы: ' + fmtDur(p.elapsedSec) + '</p>' +
      '<div class="score"><div>Основные баллы<b>' + p.scores.core + ' / 100</b></div><div>Бонусные<b>+' + p.scores.bonus + '</b></div><div>Решено заданий<b>' + p.scores.done + ' / ' + p.scores.total + '</b></div></div>' +
      '<p class="m">Преподаватель может перепроверить этот файл в режиме преподавателя (ссылка на стартовом экране лабораторной).</p>' +
      '<h2>Сводка</h2><table><tr><th>№</th><th>Задание</th><th>Баллы</th><th>Попытки</th><th>Статус</th></tr>' + rows + '</table>' +
      '<h2>Решения</h2>' + details +
      '<h2>История команд терминала</h2><pre>' + (hist || '(пусто)') + '</pre>' +
      '</main><script type="application/json" id="lab-result">' + json + '</' + 'script></body></html>';
  }
  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function showDownload() {
    const p = resultPayload();
    const fname = 'Lab10_' + sanitizeFile(p.student.name) + '_' + sanitizeFile(p.student.group) + '.html';
    const m = modal(false);
    const notDone = TASKS.filter(t => t.core && !p.tasks[t.id].passed);
    m.box.append(
      el('h2', {}, 'Сдать работу'),
      el('p', { class: 'sub' }, p.student.name + ', группа ' + p.student.group + ' · время ' + fmtDur(p.elapsedSec)),
      el('div', { class: 'row', style: 'gap:28px;margin-bottom:12px' },
        el('div', {}, el('div', { class: 'note' }, 'Основные'), el('div', { class: 'big-score' }, p.scores.core + ' / 100')),
        el('div', {}, el('div', { class: 'note' }, 'Бонус'), el('div', { class: 'big-score', style: 'color:var(--bonus)' }, '+' + p.scores.bonus))),
      notDone.length ? el('p', { class: 'note' }, 'Не решены основные: ' + notDone.map(t => t.id).join(', ') + '. Можно вернуться и доделать — потом скачайте файл ещё раз.') : el('p', { class: 'note' }, 'Все основные задания решены. Отлично!'),
      el('ol', { class: 'steps' },
        el('li', {}, 'Нажмите «Скачать файл» — сохранится ', el('b', {}, fname), '.'),
        el('li', {}, 'Отправьте этот файл преподавателю (почта, Telegram, Classroom — как договорились).'),
        el('li', {}, 'Работу можно продолжать: прогресс сохраняется в браузере. Перед отправкой скачайте файл заново.')),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: () => { download(fname, reportHtml(resultPayload())); dirtySinceDownload = false; state.downloadedAt = Date.now(); saveNow(); toast('Файл сохранён в «Загрузки»'); } }, 'Скачать файл'),
        el('button', { class: 'btn', onclick: () => { const w = window.open('', '_blank'); if (w) { w.document.write(reportHtml(resultPayload())); w.document.close(); } else toast('Браузер заблокировал новое окно'); } }, 'Открыть отчёт в новой вкладке'),
        el('button', { class: 'btn ghost', onclick: m.close }, 'Вернуться к заданиям')));
  }

  /* ================= Режим преподавателя ================= */
  function parseResultFile(text) {
    const m = /<script type="application\/json" id="lab-result">([\s\S]*?)<\/script>/.exec(text);
    const raw = m ? m[1] : text;
    const p = JSON.parse(raw);
    if (!p || p.lab !== LAB.id) throw new Error('это не файл результата лабораторной №10');
    return p;
  }
  function verifyResult(p) {
    const sigOk = (() => { const c = Object.assign({}, p); const s = c.sig; delete c.sig; return LU.hash(LAB.salt + JSON.stringify(c)) === s; })();
    const vfs = p.term && p.term.fs ? BS.VFS.fromJSON(p.term.fs) : LC.freshFS();
    const ctxBase = { fs: vfs, aliases: new Map((p.term && p.term.aliases) || []), history: (p.term && p.term.history) || [], execLog: (p.term && p.term.execLog) || [] };
    let core = 0, bonus = 0;
    const per = {};
    for (const t of TASKS) {
      const o = p.tasks[t.id] || {};
      let ok = false, note = '';
      if (t.type === 'script') {
        const code = o.passCode || o.code;
        if (code) { const r = LC.checkScript(t, code, BS.EXPECTED.tests[t.id]); ok = r.ok; note = r.tests.filter(x => x.ok).length + '/' + r.tests.length; }
      } else if (t.type === 'terminal') {
        const r = LC.checkTerminal(t, Object.assign({}, ctxBase, { answers: o.answers || {} }));
        ok = r.ok;
        if (!ok && o.passed && o.passItems && o.passItems.every(x => x.ok)) { note = 'засчитано во время работы; в итоговом снимке не подтверждается'; }
      } else {
        ok = !!(o.answer != null && LC.checkQuiz(t, o.answer, BS.EXPECTED.quiz[t.id]).ok);
      }
      let score = 0;
      if (ok) score = (t.type === 'choice' || t.type === 'output') ? Math.round(t.points * Math.max(0, 1 - 0.5 * (o.wrong || 0)) * 10) / 10 : t.points;
      if (t.core) core += score; else bonus += score;
      per[t.id] = { ok, claimed: !!o.passed, score, note };
    }
    const mismatch = TASKS.filter(t => per[t.id].claimed !== per[t.id].ok).map(t => t.id);
    return { sigOk, core: Math.round(core * 10) / 10, bonus: Math.round(bonus * 10) / 10, per, mismatch };
  }
  function showTeacher() {
    const m = modal(true);
    const results = [];
    const tableHost = el('div');
    const detailHost = el('div', { class: 'teacher-detail' });
    const input = el('input', { type: 'file', multiple: true, accept: '.html,.htm,.json', style: 'display:none' });
    const drop = el('div', { class: 'drop' }, 'Перетащите сюда файлы Lab10_*.html от студентов или ', el('button', { class: 'linkbtn', onclick: () => input.click() }, 'выберите файлы'), '.');
    const handle = async (files) => {
      for (const f of files) {
        try {
          const text = await f.text();
          const p = parseResultFile(text);
          const v = verifyResult(p);
          const i = results.findIndex(r => r.p.student.name === p.student.name && r.p.student.group === p.student.group && r.p.startedAt === p.startedAt);
          if (i >= 0) results.splice(i, 1);
          results.push({ p, v, file: f.name });
        } catch (e) { toast(f.name + ': ' + e.message, 4000); }
      }
      renderTable();
    };
    input.addEventListener('change', () => handle(Array.from(input.files)));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(Array.from(e.dataTransfer.files)); });
    function renderTable() {
      tableHost.textContent = '';
      if (!results.length) return;
      results.sort((a, b) => (a.p.student.group + a.p.student.name).localeCompare(b.p.student.group + b.p.student.name, 'ru'));
      const tb = el('table', { class: 'sumtable' }, el('tr', {}, ...['№', 'ФИО', 'Группа', 'Время', 'Основные', 'Бонус', 'Заявлено', 'Проверка'].map(h => el('th', {}, h))));
      results.forEach((r, i) => {
        const tr = el('tr', { class: 'click', onclick: () => renderDetail(r) },
          el('td', {}, String(i + 1)), el('td', {}, r.p.student.name), el('td', {}, r.p.student.group), el('td', {}, fmtDur(r.p.elapsedSec)),
          el('td', { class: 'num' }, el('b', {}, String(r.v.core))), el('td', { class: 'num' }, '+' + r.v.bonus),
          el('td', { class: 'num' }, r.p.scores.core + ' / +' + r.p.scores.bonus),
          el('td', {}, r.v.sigOk ? el('span', { class: 'tag ok' }, 'подпись ✓') : el('span', { class: 'tag bad' }, 'файл изменён'), ' ',
            r.v.mismatch.length ? el('span', { class: 'tag warn', title: 'Задания, где статус в файле не совпал с перепроверкой' }, 'расхождения: ' + r.v.mismatch.join(', ')) : el('span', { class: 'tag ok' }, 'совпадает')));
        tb.append(tr);
      });
      tableHost.append(tb, el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: exportCsv }, 'Скачать таблицу (CSV для Excel)'),
        el('button', { class: 'btn', onclick: () => { results.length = 0; renderTable(); detailHost.textContent = ''; } }, 'Очистить')));
    }
    function exportCsv() {
      const head = ['ФИО', 'Группа', 'Начало', 'Время (мин)', 'Основные', 'Бонус', 'Итого'].concat(TASKS.map(t => t.id));
      const lines = [head.join(';')];
      for (const r of results) {
        lines.push([r.p.student.name, r.p.student.group, fmtDate(r.p.startedAt), Math.round(r.p.elapsedSec / 60), r.v.core, r.v.bonus, Math.round((r.v.core + r.v.bonus) * 10) / 10]
          .concat(TASKS.map(t => r.v.per[t.id].score)).map(x => '"' + String(x).replace(/"/g, '""').replace('.', ',') + '"').join(';'));
      }
      download('Lab10_итоги.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    }
    function renderDetail(r) {
      detailHost.textContent = '';
      detailHost.append(el('h2', { style: 'margin-top:18px' }, r.p.student.name + ' · ' + r.p.student.group));
      detailHost.append(el('p', { class: 'note' }, 'Файл: ' + r.file + ' · начало ' + fmtDate(r.p.startedAt) + ' · время ' + fmtDur(r.p.elapsedSec)));
      const tb = el('table', { class: 'sumtable' }, el('tr', {}, ...['Задание', 'Баллы', 'В файле', 'Перепроверка', 'Попытки', 'Комментарий'].map(h => el('th', {}, h))));
      for (const t of TASKS) {
        const o = r.p.tasks[t.id] || {}, v = r.v.per[t.id];
        tb.append(el('tr', {}, el('td', {}, t.id + ' ' + t.title + (t.core ? '' : ' (бонус)')), el('td', { class: 'num' }, v.score + ' / ' + t.points),
          el('td', {}, o.passed ? '✓' : '—'), el('td', {}, v.ok ? el('span', { class: 'tag ok' }, '✓') : (o.attempts || o.passed ? el('span', { class: 'tag bad' }, '✗') : '—')),
          el('td', { class: 'num' }, String(o.attempts || 0)), el('td', { class: 'note' }, v.note || '')));
      }
      detailHost.append(tb);
      for (const t of TASKS.filter(x => x.type === 'script')) {
        const o = r.p.tasks[t.id] || {};
        const code = o.passCode || o.code;
        if (!code || code === t.starter) continue;
        detailHost.append(el('h3', {}, t.id + ' — ' + t.file), el('pre', {}, code));
      }
      detailHost.append(el('h3', {}, 'История команд терминала'), el('pre', {}, (r.p.term && r.p.term.history || []).slice(-300).join('\n') || '(пусто)'));
      detailHost.scrollIntoView({ behavior: 'smooth' });
    }
    m.box.append(
      el('h2', {}, 'Режим преподавателя'),
      el('p', { class: 'sub' }, 'Загрузите файлы результатов. Каждое решение будет заново запущено на всех тестах — баллы считаются по перепроверке, а не по тому, что записано в файле.'),
      drop, input, tableHost, detailHost,
      el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: m.close }, 'Закрыть')));
  }

  /* ================= Старт ================= */
  function startScreen() {
    const saved = loadState();
    const m = modal(false, true);
    const name = el('input', { class: 'inp', placeholder: 'Фамилия Имя', autocomplete: 'name', 'aria-label': 'Фамилия и имя' });
    const group = el('input', { class: 'inp', placeholder: 'например, ИС-23-1', 'aria-label': 'Группа' });
    const err = el('p', { class: 'note', style: 'color:var(--bad);min-height:1.2em;margin:0' });
    const begin = () => {
      const n = name.value.trim().replace(/\s+/g, ' '), g = group.value.trim();
      if (n.length < 3 || !/\s/.test(n)) { err.textContent = 'Введите фамилию и имя.'; name.focus(); return; }
      if (!g) { err.textContent = 'Введите группу.'; group.focus(); return; }
      state = { v: 1, lab: LAB.id, student: { name: n, group: g }, startedAt: Date.now(), tasks: {}, events: [], active: 'Q1', zoom: 15 };
      m.close();
      launch();
    };
    group.addEventListener('keydown', (e) => { if (e.key === 'Enter') begin(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') group.focus(); });
    m.box.append(el('div', { class: 'start-logo' }, '$_'),
      el('h2', {}, 'Лабораторная работа №10'),
      el('p', { class: 'sub' }, 'Bash Shell Scripting: alias, переменные, условия, строки, циклы, case, функции, массивы. Рекомендуемое время — ' + LAB.minutes + ' минут.'));
    if (!storageOk) m.box.append(el('div', { class: 'warnbox' }, 'Браузер запрещает сохранять прогресс. Не закрывайте и не обновляйте вкладку до конца работы.'));
    if (saved && saved.lab === LAB.id && saved.student) {
      const sc = (() => { state = saved; const s = scores(); state = null; return s; })();
      m.box.append(el('div', { class: 'box' },
        el('h3', {}, 'Найдена начатая работа'),
        el('p', { style: 'margin:0 0 10px' }, el('b', {}, saved.student.name), ', группа ' + saved.student.group + ' · начато ' + fmtDate(saved.startedAt) + ' · ' + sc.core + ' / 100 ' + (sc.bonus ? '+' + sc.bonus : '')),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', onclick: () => { state = saved; m.close(); launch(); } }, 'Продолжить'),
          el('button', { class: 'btn', onclick: () => { if (confirm('Удалить сохранённый прогресс «' + saved.student.name + '» и начать заново?')) { try { localStorage.removeItem(STORE_KEY); } catch (e) { } m.close(); startScreen(); } } }, 'Начать заново'))));
    }
    m.box.append(
      el('ol', { class: 'steps' },
        el('li', {}, 'Введите ФИО и группу.'),
        el('li', {}, 'Решайте задания по порядку: разминка, терминал, скрипты. Справа — редактор и терминал Linux (работают прямо в браузере, ничего устанавливать не нужно).'),
        el('li', {}, 'Кнопка «Проверить» сразу покажет результат. Прогресс сохраняется автоматически.'),
        el('li', {}, 'В конце нажмите «Скачать результат» и отправьте файл преподавателю.')),
      el('div', { class: 'field' }, el('label', {}, 'Фамилия и имя'), name),
      el('div', { class: 'field' }, el('label', {}, 'Группа'), group),
      err,
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: begin }, 'Начать работу'), el('span', { class: 'grow' })),
      el('div', { class: 'row', style: 'justify-content:space-between;margin-top:16px' },
        el('button', { class: 'linkbtn', onclick: importResult }, 'Восстановить работу из файла результата'),
        el('button', { class: 'linkbtn', onclick: showTeacher }, 'Режим преподавателя')));
    setTimeout(() => name.focus(), 50);
  }
  function importResult() {
    const input = el('input', { type: 'file', accept: '.html,.htm,.json' });
    input.addEventListener('change', async () => {
      try {
        const p = parseResultFile(await input.files[0].text());
        const tasks = {};
        for (const t of TASKS) {
          const o = p.tasks[t.id] || {};
          tasks[t.id] = { passed: o.passed, attempts: o.attempts, wrong: o.wrong, firstPassAt: o.firstPassAt, answers: o.answers, answer: o.answer, passCode: o.passCode, passItems: o.passItems, touched: o.attempts > 0 };
        }
        state = { v: 1, lab: LAB.id, student: p.student, startedAt: p.startedAt, tasks, events: p.events || [], active: 'Q1', zoom: 15, term: p.term };
        document.querySelectorAll('.modal-back').forEach(x => x.remove());
        launch();
        toast('Работа восстановлена из файла');
      } catch (e) { alert('Не удалось прочитать файл: ' + e.message); }
    });
    input.click();
  }

  function applyZoom() { document.documentElement.style.setProperty('--fs', (state.zoom || 15) + 'px'); measureChar(); if (editor) editor.render(); }

  function launch() {
    byId('app').hidden = false;
    state.tasks = state.tasks || {};
    state.events = state.events || [];
    initTerminal();
    applyZoom();
    if (!term) {
      term = new Term();
      editor = new Editor();
      editor.onChange = editorChanged;
      byId('tabOut').addEventListener('click', () => setConsoleTab('out'));
      byId('tabTerm').addEventListener('click', () => setConsoleTab('term'));
      byId('btnClear').addEventListener('click', () => { if (byId('term').hidden) byId('outView').textContent = ''; else term.clear(); });
      byId('btnReset').addEventListener('click', () => { if (editorTask && confirm('Вернуть начальную заготовку? Текущий код будет удалён.')) { editor.value = editorTask.starter; flushEditor(); } });
      byId('btnDownload').addEventListener('click', showDownload);
      byId('btnCheat').addEventListener('click', showCheat);
      byId('btnZoomIn').addEventListener('click', () => { state.zoom = Math.min(24, (state.zoom || 15) + 1); applyZoom(); save(); });
      byId('btnZoomOut').addEventListener('click', () => { state.zoom = Math.max(11, (state.zoom || 15) - 1); applyZoom(); save(); });
      window.addEventListener('resize', () => { measureChar(); });
      setInterval(tickTimer, 1000);
      window.addEventListener('beforeunload', (e) => { saveNow(); if (dirtySinceDownload && state && Object.values(state.tasks).some(s => s.passed)) { e.preventDefault(); e.returnValue = ''; } });
    }
    term.clear();
    term.print('\x1b[1mУчебный терминал Linux (bash 5.2)\x1b[0m — работает прямо в браузере.\nВы в папке \x1b[01;34m~/lab10\x1b[0m. Попробуйте: \x1b[33mls\x1b[0m, \x1b[33mcat students.txt\x1b[0m, \x1b[33mhelp\x1b[0m.\n\n');
    if (history.length) term.print('\x1b[90m[сеанс восстановлен: ' + history.length + ' команд в истории — стрелка ↑]\x1b[0m\n');
    term.renderPrompt();
    byId('who').innerHTML = '<b>' + esc(state.student.name) + '</b> · ' + esc(state.student.group);
    updateHeader(); tickTimer();
    openTask(state.active && (state.active === 'TERM' || taskById(state.active)) ? state.active : 'Q1');
    saveNow();
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.key === 'ы' || e.key === 'Ы') && !document.querySelector('.nano')) { e.preventDefault(); if (editorTask) flushEditor(); toast('Всё сохраняется автоматически'); }
  });

  window.addEventListener('DOMContentLoaded', () => {
    try { localStorage.setItem('lab10-probe', '1'); localStorage.removeItem('lab10-probe'); } catch (e) { storageOk = false; }
    if (/[?#&]teacher/.test(location.href)) { byId('app').hidden = true; showTeacher(); return; }
    startScreen();
  });
  BS.app = { get state() { return state; }, openTask, verifyResult, parseResultFile, reportHtml, resultPayload, get termShell() { return termSh; } };
})(globalThis.BS = globalThis.BS || {});
