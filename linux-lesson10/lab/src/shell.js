/* Ядро учебного bash: подстановки, выполнение, встроенные команды. */
(function (BS) {
  'use strict';
  const { Parser, ParseError, ArithError, VFS } = BS;
  const PU = BS.parserUtil;

  /* ---------- Сигналы управления ---------- */
  class ExitSig { constructor(code) { this.code = code; } }
  class ReturnSig { constructor(code) { this.code = code; } }
  class BreakSig { constructor(n, cont) { this.n = n; this.cont = cont; } }
  class FatalError extends Error { constructor(msg) { super(msg); } }
  class ShellError extends Error {
    constructor(msg, opts) { super(msg); opts = opts || {}; this.fatal = !!opts.fatal; this.status = opts.status || 1; this.noPrefix = !!opts.noPrefix; }
  }

  /* ---------- Потоки ---------- */
  class OutBuf { constructor(tty) { this.s = ''; this.tty = !!tty; } write(x) { this.s += x; } }
  class NullOut { constructor() { this.tty = false; } write() {} }
  class FileOut {
    constructor(node) { this.node = node; this.tty = false; }
    write(x) { if (this.node.t === 'c') return; this.node.x += x; this.node.mt = Date.now(); }
  }
  class InStream {
    constructor(data, interactive) { this.data = data || ''; this.pos = 0; this.interactive = !!interactive; }
    atEOF() { return this.pos >= this.data.length; }
    readUntil(delim) {
      if (this.pos >= this.data.length) return null;
      const i = this.data.indexOf(delim, this.pos);
      let text, found;
      if (i < 0) { text = this.data.slice(this.pos); this.pos = this.data.length; found = false; }
      else { text = this.data.slice(this.pos, i); this.pos = i + 1; found = true; }
      return { text, found };
    }
    readAll() { const s = this.data.slice(this.pos); this.pos = this.data.length; return s; }
  }
  const EMPTY_IN = () => new InStream('', false);

  /* ---------- Переменные ---------- */
  function newVar() { return { v: null, arr: null, map: null, ro: false, ex: false, int: false, lc: false, uc: false }; }
  function cloneVar(o) {
    const n = Object.assign({}, o);
    if (o.arr) n.arr = new Map(o.arr);
    if (o.map) n.map = new Map(o.map);
    return n;
  }
  function sortedKeys(m) { return Array.from(m.keys()).sort((a, b) => a - b); }

  /* ---------- Шаблоны (glob) ---------- */
  const CLASSES = {
    alpha: 'A-Za-z\\u00C0-\\u024F\\u0400-\\u04FF', digit: '0-9', alnum: 'A-Za-z0-9\\u00C0-\\u024F\\u0400-\\u04FF', upper: 'A-Z\\u0400-\\u042F\\u0401',
    lower: 'a-z\\u0430-\\u044F\\u0451', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: ' -~\\u0400-\\u04FF', graph: '!-~\\u0400-\\u04FF', word: 'A-Za-z0-9_',
  };
  function reEsc(c) { return /[\\^$.*+?()[\]{}|\/-]/.test(c) ? '\\' + c : c; }
  /* Разбор скобочного выражения [...] начиная с i (указывает на '['). Возвращает {re, end} или null. */
  function bracket(p, i) {
    let j = i + 1;
    let neg = false;
    if (p[j] === '!' || p[j] === '^') { neg = true; j++; }
    let out = '';
    let first = true;
    while (j < p.length) {
      const c = p[j];
      if (c === ']' && !first) {
        return { re: '[' + (neg ? '^' : '') + out + ']', end: j + 1 };
      }
      first = false;
      if (c === '[' && p[j + 1] === ':') {
        const e = p.indexOf(':]', j + 2);
        if (e > 0) {
          const name = p.slice(j + 2, e);
          if (CLASSES[name]) { out += CLASSES[name]; j = e + 2; continue; }
        }
      }
      if (c === '\\' && j + 1 < p.length) { out += reEsc(p[j + 1]); j += 2; continue; }
      if (c === '-' && out && p[j + 1] && p[j + 1] !== ']') { out += '-'; j++; continue; }
      out += reEsc(c);
      j++;
    }
    return null;
  }
  const globCache = new Map();
  function globToRe(p, shortest) {
    const key = (shortest ? 'S' : 'G') + p;
    let r = globCache.get(key);
    if (r) return r;
    let s = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '\\') { if (i + 1 < p.length) { s += reEsc(p[i + 1]); i++; } else s += '\\\\'; continue; }
      if (c === '*') { s += shortest ? '[\\s\\S]*?' : '[\\s\\S]*'; continue; }
      if (c === '?') { s += '[\\s\\S]'; continue; }
      if (c === '[') { const b = bracket(p, i); if (b) { s += b.re; i = b.end - 1; continue; } s += '\\['; continue; }
      s += reEsc(c);
    }
    r = new RegExp('^(?:' + s + ')$');
    if (globCache.size > 3000) globCache.clear();
    globCache.set(key, r);
    return r;
  }
  function patMatch(str, pat) { return globToRe(pat).test(str); }
  function hasGlob(p) {
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '\\') { i++; continue; }
      if (c === '*' || c === '?') return true;
      if (c === '[' && bracket(p, i)) return true;
    }
    return false;
  }
  function globEscape(s) { return s.replace(/[\\*?[\]]/g, '\\$&'); }
  function unescapeGlob(s) { return s.replace(/\\(.)/g, '$1'); }

  /* POSIX ERE/BRE → RegExp JS */
  function posixToJs(re, basic) {
    let out = '';
    for (let i = 0; i < re.length; i++) {
      const c = re[i];
      if (c === '\\') {
        const n = re[i + 1];
        if (n === undefined) { out += '\\\\'; continue; }
        i++;
        if (basic) {
          if ('(){}|+?'.indexOf(n) >= 0) { out += n; continue; }
        }
        if (n === '<') { out += '\\b(?=\\w)'; continue; }
        if (n === '>') { out += '\\b(?<=\\w)'; continue; }
        out += '\\' + n;
        continue;
      }
      if (c === '[') { const b = bracket(re, i); if (b) { out += b.re; i = b.end - 1; continue; } out += '\\['; continue; }
      if (basic && '(){}|+?'.indexOf(c) >= 0) { out += '\\' + c; continue; }
      if (basic && c === '*' && (out === '' || out === '^')) { out += '\\*'; continue; }
      out += c;
    }
    return out;
  }

  function shQuote(s) {
    if (s === '') return "''";
    if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  /* Escape-последовательности echo -e / printf %b */
  function echoEscapes(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
      const n = s[++i];
      switch (n) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case 'e': case 'E': out += '\x1b'; break;
        case '\\': out += '\\'; break;
        case 'c': return { s: out, stop: true };
        case '0': { const m = /^[0-7]{0,3}/.exec(s.slice(i + 1))[0]; out += String.fromCharCode(parseInt(m || '0', 8)); i += m.length; break; }
        case 'x': { const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)); if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else out += '\\x'; break; }
        case 'u': { const m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i + 1)); if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else out += '\\u'; break; }
        default: out += '\\' + n;
      }
    }
    return { s: out, stop: false };
  }

  const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'time', '{', '}', '!', '[[', ']]', 'coproc']);
  let pidCounter = 2400;

  /* ====================== SHELL ====================== */
  class Shell {
    constructor(o) {
      o = o || {};
      this.fs = o.fs || BS.defaultFS();
      this.user = 'student';
      this.home = '/home/student';
      this.cwd = o.cwd || this.home;
      this.scopes = [new Map()];
      this.funcFrames = [];
      this.functions = new Map();
      this.aliases = new Map();
      this.positional = o.args || [];
      this.argv0 = o.argv0 || 'bash';
      this.srcName = null;
      this.interactive = !!o.interactive;
      this.status = 0;
      this.opts = { xtrace: false, errexit: false, nounset: false, pipefail: false, noglob: false, expand_aliases: !!o.interactive };
      this.history = o.history || [];
      this.limits = o.limits || Shell.makeLimits();
      this.execLog = o.execLog || [];
      this.host = o.host || null;
      this.callDepth = 0;
      this.funcStack = [];
      this.loopDepth = 0;
      this.sourceDepth = 0;
      this.lineno = 0;
      this.errexitOff = 0;
      this.aliasGuard = null;
      this.subLevel = 0;
      this.pid = ++pidCounter;
      this.startTime = Date.now();
      this.curIn = null; this.curErr = null;
      this.lastSubst = null;
      this.parseCache = new Map();
      if (!o.noInit) this.initVars(o.env);
    }
    static makeLimits(ms, steps) {
      return { steps: 0, maxSteps: steps || 2000000, deadline: Date.now() + (ms || 4000), ms: ms || 4000, out: 0, maxOut: 400000 };
    }
    resetLimits(ms) { const l = this.limits; l.steps = 0; l.out = 0; l.ms = ms || l.ms; l.deadline = Date.now() + l.ms; }

    initVars(env) {
      const set = (k, v, ex) => { const o = newVar(); o.v = v; o.ex = !!ex; this.scopes[0].set(k, o); };
      if (env) {
        for (const k of Object.keys(env)) set(k, env[k], true);
      } else {
        set('HOME', this.home, true); set('USER', this.user, true); set('LOGNAME', this.user, true);
        set('SHELL', '/bin/bash', true); set('PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', true);
        set('LANG', 'ru_RU.UTF-8', true); set('TERM', 'xterm-256color', true); set('HOSTNAME', 'lab10-pc', false);
        set('PWD', this.cwd, true); set('OLDPWD', '', true);
      }
      set('IFS', ' \t\n'); set('BASH', '/usr/bin/bash'); set('BASH_VERSION', '5.2.21(1)-release');
      set('PS1', '\\u@\\h:\\w\\$ '); set('PS2', '> '); set('HISTSIZE', '1000'); set('UID', '1000'); set('EUID', '1000');
      set('PPID', String(this.pid - 1)); set('OSTYPE', 'linux-gnu'); set('MACHTYPE', 'x86_64-pc-linux-gnu');
      if (!this.getVarObj('PWD')) set('PWD', this.cwd, true);
      else this.getVarObj('PWD').v = this.cwd;
      if (!this.getVarObj('HOME')) set('HOME', this.home, true);
    }

    /* ---------- лимиты ---------- */
    tick() {
      const l = this.limits;
      l.steps++;
      if ((l.steps & 255) === 0) {
        if (Date.now() > l.deadline) throw new FatalError('timeout');
      }
      if (l.steps > l.maxSteps) throw new FatalError('timeout');
    }

    /* ---------- переменные ---------- */
    getVarObj(name) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const v = this.scopes[i].get(name);
        if (v) return v;
      }
      return null;
    }
    isAssocVar(name) { const o = this.getVarObj(name); return !!(o && o.map); }
    isSetVar(name) {
      const o = this.getVarObj(name);
      if (!o) return false;
      if (o.arr) return o.arr.has(0);
      if (o.map) return o.map.has('0');
      return o.v !== null;
    }
    getParam(name) {
      switch (name) {
        case '?': return String(this.status);
        case '#': return String(this.positional.length);
        case '$': return String(this.rootPid || this.pid);
        case '!': return this.lastBg || '';
        case '0': return this.argv0;
        case '-': return 'hB' + (this.opts.errexit ? 'e' : '') + (this.opts.nounset ? 'u' : '') + (this.opts.xtrace ? 'x' : '') + (this.interactive ? 'i' : '');
        case '_': return this.lastArg || '';
        case '@': case '*': return this.positional.join(name === '*' ? this.ifsFirst() : ' ');
      }
      if (/^[0-9]+$/.test(name)) {
        const n = parseInt(name, 10);
        if (n === 0) return this.argv0;
        return n <= this.positional.length ? this.positional[n - 1] : null;
      }
      switch (name) {
        case 'RANDOM': return String(Math.floor(Math.random() * 32768));
        case 'SECONDS': return String(Math.floor((Date.now() - this.startTime) / 1000));
        case 'LINENO': return String(this.lineno);
        case 'BASHPID': return String(this.pid);
        case 'FUNCNAME': return this.funcStack.length ? this.funcStack[this.funcStack.length - 1] : null;
        case 'EPOCHSECONDS': return String(Math.floor(Date.now() / 1000));
      }
      const o = this.getVarObj(name);
      if (!o) return null;
      if (o.arr) return o.arr.has(0) ? o.arr.get(0) : null;
      if (o.map) return o.map.has('0') ? o.map.get('0') : null;
      return o.v;
    }
    getStr(name) { const v = this.getParam(name); return v == null ? '' : v; }
    ifsFirst() { const i = this.getParam('IFS'); return i == null ? ' ' : i.slice(0, 1); }

    /* Значения массива по порядку индексов */
    arrayValues(name) {
      if (name === '@' || name === '*') return this.positional.slice();
      if (name === 'FUNCNAME') return this.funcStack.slice().reverse();
      const o = this.getVarObj(name);
      if (!o) return [];
      if (o.arr) return sortedKeys(o.arr).map(k => o.arr.get(k));
      if (o.map) return Array.from(o.map.values());
      return o.v == null ? [] : [o.v];
    }
    arrayKeys(name) {
      const o = this.getVarObj(name);
      if (!o) return [];
      if (o.arr) return sortedKeys(o.arr).map(String);
      if (o.map) return Array.from(o.map.keys());
      return o.v == null ? [] : ['0'];
    }
    getElem(name, sub) {
      if (name === 'FUNCNAME') { const a = this.funcStack.slice().reverse(); const i = Number(this.arith(this.expandArithText(sub))); return a[i] == null ? null : a[i]; }
      if (name === 'BASH_REMATCH' || true) {
        const o = this.getVarObj(name);
        if (!o) return null;
        if (o.map) { const k = this.expandStr(sub); return o.map.has(k) ? o.map.get(k) : null; }
        let i = Number(this.arith(this.expandArithText(sub)));
        if (o.arr) {
          if (i < 0) { const ks = sortedKeys(o.arr); if (!ks.length) return null; i = ks[ks.length - 1] + 1 + i; if (i < 0) throw new ShellError(name + ': bad array subscript'); }
          return o.arr.has(i) ? o.arr.get(i) : null;
        }
        return i === 0 || i === -1 ? o.v : null;
      }
    }
    /* Найти или создать переменную для присваивания */
    varForWrite(name) {
      let o = this.getVarObj(name);
      if (!o) { o = newVar(); this.scopes[0].set(name, o); }
      return o;
    }
    checkName(name) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ShellError('`' + name + "': not a valid identifier");
    }
    /* Присваивание: idx — уже вычисленный индекс (число или строка-ключ) либо null */
    setVar(name, idx, value, append) {
      if (/^[0-9@#?$!*-]$/.test(name) || /^[0-9]+$/.test(name)) throw new ShellError('`' + name + "': not a valid identifier");
      const o = this.varForWrite(name);
      if (o.ro) throw new ShellError(name + ': readonly variable');
      if (o.int) {
        const old = idx == null ? (o.arr ? (o.arr.get(0) || '0') : (o.v || '0')) : (o.arr ? (o.arr.get(idx) || '0') : '0');
        value = String(this.arith(append ? '(' + old + ')+(' + (value || 0) + ')' : (value === '' ? '0' : value)));
        append = false;
      }
      if (o.lc) value = value.toLowerCase();
      if (o.uc) value = value.toUpperCase();
      if (idx == null) {
        if (o.arr) { o.arr.set(0, append ? (o.arr.get(0) || '') + value : value); return; }
        if (o.map) { o.map.set('0', append ? (o.map.get('0') || '') + value : value); return; }
        o.v = append ? (o.v || '') + value : value;
        return;
      }
      if (o.map) { const k = String(idx); o.map.set(k, append ? (o.map.get(k) || '') + value : value); return; }
      if (!o.arr) { o.arr = new Map(); if (o.v != null) o.arr.set(0, o.v); o.v = null; }
      let i = Number(idx);
      if (i < 0) { const ks = sortedKeys(o.arr); i = (ks.length ? ks[ks.length - 1] + 1 : 0) + i; if (i < 0) throw new ShellError(name + '[' + idx + ']: bad array subscript'); }
      o.arr.set(i, append ? (o.arr.get(i) || '') + value : value);
    }
    setArray(name, items, append, assocHint) {
      const o = this.varForWrite(name);
      if (o.ro) throw new ShellError(name + ': readonly variable');
      if (assocHint && !o.map) { o.map = new Map(); o.arr = null; o.v = null; }
      if (o.map) {
        if (!append) o.map.clear();
        let pend = null;
        for (const it of items) {
          if (it.key != null) o.map.set(it.key, it.value);
          else if (pend == null) pend = it.value;
          else { o.map.set(pend, it.value); pend = null; }
        }
        if (pend != null) o.map.set(pend, '');
        return;
      }
      if (!o.arr) { o.arr = new Map(); if (o.v != null && append) o.arr.set(0, o.v); o.v = null; }
      if (!append) o.arr.clear();
      let next = 0;
      if (o.arr.size) { const ks = sortedKeys(o.arr); next = ks[ks.length - 1] + 1; }
      for (const it of items) {
        let v = it.value;
        if (o.int) v = String(this.arith(v || '0'));
        if (o.lc) v = v.toLowerCase();
        if (o.uc) v = v.toUpperCase();
        if (it.key != null) { next = Number(this.arith(this.expandArithText(it.key))); }
        o.arr.set(next, v); next++;
      }
    }
    /* Разбор и выполнение слова-присваивания: name=val, name[i]=val, name+=val, name=(...) */
    doAssignWord(raw, scopeMap) {
      const m = PU.ASSIGN_RE.exec(raw);
      const name = m[1];
      const sub = m[2] ? m[2].slice(1, -1) : null;
      const append = m[3] === '+';
      const valRaw = raw.slice(m[0].length);
      if (scopeMap && !scopeMap.has(name)) scopeMap.set(name, newVar());
      if (sub == null && valRaw.startsWith('(') && valRaw.endsWith(')')) {
        const items = this.parseArrayLiteral(valRaw.slice(1, -1));
        this.setArray(name, items, append);
        return;
      }
      const value = this.expandAssignValue(valRaw);
      if (sub != null) {
        const o = this.getVarObj(name);
        const idx = o && o.map ? this.expandStr(sub) : this.arith(this.expandArithText(sub));
        this.setVar(name, typeof idx === 'bigint' ? Number(idx) : idx, value, append);
      } else this.setVar(name, null, value, append);
    }
    parseArrayLiteral(inner) {
      const p = new Parser(inner);
      const items = [];
      for (;;) {
        p.skipNewlines();
        if (p.eof()) break;
        const w = p.readWord(false);
        if (w == null) { p.pos++; continue; }
        const km = /^\[([^\]]*)\]=([\s\S]*)$/.exec(w);
        if (km) items.push({ key: km[1].startsWith('$') || /["']/.test(km[1]) ? this.expandStr(km[1]) : km[1], value: this.expandAssignValue(km[2]), rawKey: true });
        else for (const f of this.expandFields(w)) items.push({ key: null, value: f });
      }
      // ключи для индексных массивов вычисляются арифметически в setArray
      return items;
    }
    expandAssignValue(raw) {
      // тильда в начале и после ':'
      let s = raw;
      if (s.startsWith('~') && (s.length === 1 || s[1] === '/' || s[1] === ':')) s = this.home.replace(/[\\'"$`]/g, '\\$&') + s.slice(1);
      return this.expandStr(s);
    }

    /* ---------- Подстановки ---------- */
    braceExpand(s) {
      const n = s.length;
      for (let i = 0; i < n; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === "'") { i = PU.scanSingle(s, i) - 1; continue; }
        if (c === '"') { i = PU.scanDouble(s, i) - 1; continue; }
        if (c === '`') { i = PU.scanBacktick(s, i) - 1; continue; }
        if (c === '$' && (s[i + 1] === '{' || s[i + 1] === '(')) { i = PU.scanDollar(s, i) - 1; continue; }
        if (c !== '{') continue;
        // ищем парную }
        let depth = 0, j = i, commas = [];
        for (; j < n; j++) {
          const d = s[j];
          if (d === '\\') { j++; continue; }
          if (d === "'") { j = PU.scanSingle(s, j) - 1; continue; }
          if (d === '"') { j = PU.scanDouble(s, j) - 1; continue; }
          if (d === '$' && (s[j + 1] === '{' || s[j + 1] === '(')) { j = PU.scanDollar(s, j) - 1; continue; }
          if (d === '{') depth++;
          else if (d === '}') { depth--; if (depth === 0) break; }
          else if (d === ',' && depth === 1) commas.push(j);
        }
        if (j >= n) return [s];
        const pre = s.slice(0, i), post = s.slice(j + 1), inner = s.slice(i + 1, j);
        let parts = null;
        if (commas.length) {
          parts = [];
          let st = i + 1;
          for (const cpos of commas) { parts.push(s.slice(st, cpos)); st = cpos + 1; }
          parts.push(s.slice(st, j));
        } else {
          let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
          if (m) {
            const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
            let step = m[3] ? Math.abs(parseInt(m[3], 10)) || 1 : 1;
            const width = (/^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2])) ? Math.max(m[1].length, m[2].length) : 0;
            parts = [];
            if (Math.abs(b - a) / step > 100000) throw new ShellError('brace expansion: too many elements');
            for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) {
              let t = String(Math.abs(v));
              if (width) t = t.padStart(width - (v < 0 ? 1 : 0), '0');
              parts.push((v < 0 ? '-' : '') + t);
            }
          } else if ((m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner))) {
            const a = m[1].charCodeAt(0), b = m[2].charCodeAt(0);
            const step = m[3] ? Math.abs(parseInt(m[3], 10)) || 1 : 1;
            parts = [];
            for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) parts.push(String.fromCharCode(v));
          }
        }
        if (!parts) continue;
        const out = [];
        for (const p of parts) for (const r of this.braceExpand(pre + p + post)) out.push(r);
        return out;
      }
      return [s];
    }

    /* Сегменты слова: {t, q (в кавычках), s (подлежит разбиению)} или {brk:true} */
    segments(raw) {
      const segs = [];
      let i = 0;
      const n = raw.length;
      if (raw[0] === '~') {
        const m = /^~([A-Za-z0-9_.-]*)(?=\/|$)/.exec(raw);
        if (m) {
          let h = null;
          if (m[1] === '') h = this.getStr('HOME');
          else if (m[1] === '+') h = this.cwd;
          else if (m[1] === '-') h = this.getStr('OLDPWD');
          else if (m[1] === 'root') h = '/root';
          else if (this.fs.isDir('/home/' + m[1])) h = '/home/' + m[1];
          if (h != null) { segs.push({ t: h, q: true }); i = m[0].length; }
        }
      }
      let lit = '';
      const flush = () => { if (lit) { segs.push({ t: lit, q: false, s: false }); lit = ''; } };
      while (i < n) {
        const c = raw[i];
        if (c === '\\') { flush(); if (i + 1 < n) segs.push({ t: raw[i + 1], q: true }); i += 2; continue; }
        if (c === "'") { flush(); const e = PU.scanSingle(raw, i); segs.push({ t: raw.slice(i + 1, e - 1), q: true }); i = e; continue; }
        if (c === '"') { flush(); i = this.dqSegments(raw, i + 1, segs, false); continue; }
        if (c === '$') {
          if (raw[i + 1] === "'") { flush(); const e = PU.scanAnsiC(raw, i); segs.push({ t: echoEscapes(raw.slice(i + 2, e - 1).replace(/\\'/g, "'")).s, q: true }); i = e; continue; }
          if (raw[i + 1] === '"') { i++; continue; }
          const r = this.expandDollar(raw, i, false);
          if (r) {
            flush();
            if (r.fields) r.fields.forEach((f, k) => { if (k > 0) segs.push({ brk: true }); segs.push({ t: f, q: false, s: true }); });
            else segs.push({ t: r.value, q: false, s: true });
            i = r.end; continue;
          }
        }
        if (c === '`') {
          flush();
          const e = PU.scanBacktick(raw, i);
          segs.push({ t: this.cmdSubst(this.unBacktick(raw.slice(i + 1, e - 1))), q: false, s: true });
          i = e; continue;
        }
        lit += c; i++;
      }
      flush();
      return segs;
    }
    unBacktick(s) { return s.replace(/\\([$`\\])/g, '$1'); }
    /* Содержимое двойных кавычек. heredoc=true — до конца строки, " — обычный символ. */
    dqSegments(raw, i, segs, heredoc) {
      const n = raw.length;
      let lit = '';
      let produced = false, hadAt = false;
      const flush = () => { if (lit) { segs.push({ t: lit, q: true }); lit = ''; produced = true; } };
      while (i < n) {
        const c = raw[i];
        if (c === '"' && !heredoc) { i++; break; }
        if (c === '\\') {
          const nx = raw[i + 1];
          if (nx === '$' || nx === '`' || nx === '\\' || (nx === '"' && !heredoc)) { lit += nx; i += 2; continue; }
          if (nx === '\n') { i += 2; continue; }
          lit += '\\'; i++; continue;
        }
        if (c === '$') {
          const r = this.expandDollar(raw, i, true);
          if (r) {
            flush();
            if (r.fields) {
              hadAt = true;
              r.fields.forEach((f, k) => { if (k > 0) segs.push({ brk: true }); segs.push({ t: f, q: true }); produced = true; });
            } else { segs.push({ t: r.value, q: true }); produced = true; }
            i = r.end; continue;
          }
        }
        if (c === '`') {
          flush();
          const e = PU.scanBacktick(raw, i);
          segs.push({ t: this.cmdSubst(this.unBacktick(raw.slice(i + 1, e - 1))), q: true }); produced = true;
          i = e; continue;
        }
        lit += c; i++;
      }
      flush();
      if (!produced && !hadAt) segs.push({ t: '', q: true });
      return i;
    }
    /* $... начиная с позиции i. Возвращает {value|fields, end} или null (литерал $). */
    expandDollar(raw, i, inDq) {
      const n1 = raw[i + 1];
      if (n1 === '(') {
        if (raw[i + 2] === '(') {
          let e = -1;
          try { e = PU.scanArith(raw, i); } catch (err) { e = -1; }
          if (e > 0) {
            const expr = raw.slice(i + 3, e - 2);
            return { value: String(this.arith(this.expandArithText(expr))), end: e };
          }
        }
        const e = PU.scanCmdSubst(raw, i);
        return { value: this.cmdSubst(raw.slice(i + 2, e - 1)), end: e };
      }
      if (n1 === '{') {
        const e = PU.scanBrace(raw, i);
        const r = this.paramExpand(raw.slice(i + 2, e - 1), inDq);
        r.end = e;
        return r;
      }
      if (n1 === undefined) return null;
      if (n1 === '[') {
        const e = PU.scanOldArith(raw, i);
        return { value: String(this.arith(this.expandArithText(raw.slice(i + 2, e - 1)))), end: e };
      }
      if ('@*#?$!-0123456789_'.indexOf(n1) >= 0) {
        if (n1 === '@' || n1 === '*') {
          const vals = this.positional.slice();
          if (inDq && n1 === '*') return { value: vals.join(this.ifsFirst()), end: i + 2 };
          return { fields: vals, end: i + 2 };
        }
        const v = this.getParam(n1);
        if (v == null && this.opts.nounset && /[1-9]/.test(n1)) throw new ShellError('$' + n1 + ': unbound variable', { fatal: true });
        return { value: v == null ? '' : v, end: i + 2 };
      }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i + 1));
      if (m) {
        const v = this.getParam(m[0]);
        if (v == null && this.opts.nounset) throw new ShellError(m[0] + ': unbound variable', { fatal: true });
        return { value: v == null ? '' : v, end: i + 1 + m[0].length };
      }
      return null;
    }
    expandArithText(s) {
      if (s.indexOf('$') < 0 && s.indexOf('`') < 0 && s.indexOf('"') < 0 && s.indexOf('\\') < 0) return s;
      const segs = [];
      this.dqSegments(s, 0, segs, true);
      return segs.map(x => x.brk ? ' ' : x.t).join('').replace(/"/g, '');
    }
    arith(expr) {
      const env = {
        get: (name, idx) => {
          if (idx == null) { const v = this.getParam(name); if (v == null && this.opts.nounset) throw new ShellError(name + ': unbound variable', { fatal: true }); return v; }
          const o = this.getVarObj(name);
          if (!o) return null;
          if (o.map) return o.map.has(String(idx)) ? o.map.get(String(idx)) : null;
          let k = Number(idx);
          if (o.arr) { if (k < 0) { const ks = sortedKeys(o.arr); k = (ks.length ? ks[ks.length - 1] + 1 : 0) + k; } return o.arr.has(k) ? o.arr.get(k) : null; }
          return k === 0 ? o.v : null;
        },
        set: (name, idx, val) => this.setVar(name, idx == null ? null : (typeof idx === 'bigint' ? Number(idx) : idx), val, false),
        isAssoc: (name) => this.isAssocVar(name),
      };
      try {
        return BS.arith.evaluate(expr, env);
      } catch (e) {
        if (e instanceof ArithError) {
          const tok = e.token != null ? e.token : '';
          throw new ShellError(expr.trim() + ': ' + e.message + ' (error token is "' + tok + '")');
        }
        throw e;
      }
    }

    paramExpand(inner, inDq) {
      if (inner === '') throw new ShellError('${}: bad substitution');
      const bad = () => new ShellError('${' + inner + '}: bad substitution');
      // длина
      if (inner[0] === '#' && inner.length > 1) {
        const rest = inner.slice(1);
        let m = /^([A-Za-z_][A-Za-z0-9_]*)\[([@*])\]$/.exec(rest);
        if (m) return { value: String(this.arrayValues(m[1]).length) };
        if (rest === '@' || rest === '*') return { value: String(this.positional.length) };
        m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/.exec(rest);
        if (m) { const v = this.getElem(m[1], m[2]); return { value: String(v == null ? 0 : Array.from(v).length) }; }
        if (/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$!#\-_])$/.test(rest)) {
          const v = this.getParam(rest);
          if (v == null && this.opts.nounset && rest !== '#') throw new ShellError(rest + ': unbound variable', { fatal: true });
          return { value: String(v == null ? 0 : Array.from(v).length) };
        }
        throw bad();
      }
      // косвенная ссылка / ключи
      if (inner[0] === '!' && inner.length > 1) {
        const rest = inner.slice(1);
        let m = /^([A-Za-z_][A-Za-z0-9_]*)\[([@*])\]$/.exec(rest);
        if (m) {
          const keys = this.arrayKeys(m[1]);
          if (m[2] === '*' && inDq) return { value: keys.join(this.ifsFirst()) };
          return { fields: keys };
        }
        m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[#@*])([\s\S]*)$/.exec(rest);
        if (m) {
          let ref = m[1] === '#' ? this.getStr('#') : this.getStr(m[1]);
          if (m[1] === '@' || m[1] === '*') ref = this.positional.length ? this.positional[this.positional.length - 1] : '';
          if (m[1] === '#') { const n = this.positional.length; ref = n === 0 ? '0' : String(n); }
          if (ref === '') throw new ShellError(m[1] + ': invalid indirect expansion');
          return this.paramExpand(ref + m[2], inDq);
        }
        throw bad();
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!\-0_])/.exec(inner);
      if (!m) throw bad();
      const name = m[1];
      let j = name.length;
      let sub = null;
      if (inner[j] === '[' && /^[A-Za-z_]/.test(name)) {
        let depth = 0, k = j;
        for (; k < inner.length; k++) { if (inner[k] === '[') depth++; else if (inner[k] === ']') { depth--; if (depth === 0) break; } }
        if (k >= inner.length) throw bad();
        sub = inner.slice(j + 1, k);
        j = k + 1;
      }
      const op = inner.slice(j);
      // базовое значение
      let arrMode = false, vals = null, val = null, isSet;
      if (name === '@' || name === '*' || sub === '@' || sub === '*') {
        arrMode = true;
        vals = (name === '@' || name === '*') ? this.positional.slice() : this.arrayValues(name);
        isSet = vals.length > 0;
        if (op === '' || /^[:\-=+?]/.test(op)) {
          // для ${arr[@]:-x} проверяется наличие элементов
        }
      } else if (sub != null) {
        val = this.getElem(name, sub);
        isSet = val != null;
      } else {
        val = this.getParam(name);
        isSet = val != null;
      }
      const joinStar = (name === '*' || sub === '*');
      const result = (list) => {
        if (!arrMode) return { value: list };
        if (joinStar && inDq) return { value: list.join(this.ifsFirst()) };
        return { fields: list };
      };
      if (op === '') {
        if (!isSet && this.opts.nounset && !arrMode) throw new ShellError(name + ': unbound variable', { fatal: true });
        return arrMode ? result(vals) : { value: val == null ? '' : val };
      }
      const mm = /^(:?)([-=+?])([\s\S]*)$/.exec(op);
      if (mm) {
        const colon = mm[1] === ':';
        const empty = arrMode ? (vals.length === 0 || (colon && vals.join('') === '')) : (!isSet || (colon && val === ''));
        const wordRaw = mm[3];
        switch (mm[2]) {
          case '-': return empty ? { value: this.expandStr(wordRaw) } : (arrMode ? result(vals) : { value: val });
          case '+': return empty ? { value: '' } : { value: this.expandStr(wordRaw) };
          case '=': {
            if (!empty) return arrMode ? result(vals) : { value: val };
            if (arrMode || /^[0-9@*#?$!\-_]$/.test(name)) throw new ShellError('$' + name + ': cannot assign in this way');
            const w = this.expandStr(wordRaw);
            if (sub != null) this.setVar(name, this.isAssocVar(name) ? this.expandStr(sub) : Number(this.arith(this.expandArithText(sub))), w, false);
            else this.setVar(name, null, w, false);
            return { value: w };
          }
          case '?': {
            if (!empty) return arrMode ? result(vals) : { value: val };
            const msg = wordRaw === '' ? (colon ? 'parameter null or not set' : 'parameter not set') : this.expandStr(wordRaw);
            throw new ShellError(name + ': ' + msg, { fatal: true });
          }
        }
      }
      // подстрока ${x:off:len}
      if (op[0] === ':') {
        const parts = PU.splitTopLevel(op.slice(1), ':');
        if (parts.length > 2) throw bad();
        let off = Number(this.arith(this.expandArithText(parts[0]) || '0'));
        const hasLen = parts.length === 2;
        let len = hasLen ? Number(this.arith(this.expandArithText(parts[1]) || '0')) : null;
        if (arrMode) {
          let list = vals;
          if (name === '@' || name === '*') list = [this.argv0].concat(vals);
          if (off < 0) off = Math.max(list.length + off, list.length + off < 0 ? -1 : 0);
          if (off < 0) return result([]);
          if (name === '@' || name === '*') { if (off === 0 && !hasLen) list = list; }
          let out = list.slice(off);
          if (name !== '@' && name !== '*') out = list.slice(off);
          if (hasLen) { if (len < 0) throw new ShellError(parts[1] + ': substring expression < 0'); out = out.slice(0, len); }
          return result(out);
        }
        const chars = Array.from(val == null ? '' : val);
        if (off < 0) { off = chars.length + off; if (off < 0) return { value: '' }; }
        if (off > chars.length) return { value: '' };
        let endIdx = chars.length;
        if (hasLen) {
          if (len < 0) { endIdx = chars.length + len; if (endIdx < off) throw new ShellError(parts[1].trim() + ': substring expression < 0'); }
          else endIdx = Math.min(chars.length, off + len);
        }
        return { value: chars.slice(off, endIdx).join('') };
      }
      const apply = (fn) => arrMode ? result(vals.map(fn)) : { value: fn(val == null ? '' : val) };
      // удаление префикса/суффикса
      let pm = /^(##|#|%%|%)([\s\S]*)$/.exec(op);
      if (pm) {
        const pat = this.expandPattern(pm[2]);
        const kind = pm[1];
        return apply((s) => {
          const ch = Array.from(s);
          const L = ch.length;
          if (kind === '#') { for (let k = 0; k <= L; k++) if (patMatch(ch.slice(0, k).join(''), pat)) return ch.slice(k).join(''); }
          else if (kind === '##') { for (let k = L; k >= 0; k--) if (patMatch(ch.slice(0, k).join(''), pat)) return ch.slice(k).join(''); }
          else if (kind === '%') { for (let k = L; k >= 0; k--) if (patMatch(ch.slice(k).join(''), pat)) return ch.slice(0, k).join(''); }
          else { for (let k = 0; k <= L; k++) if (patMatch(ch.slice(k).join(''), pat)) return ch.slice(0, k).join(''); }
          return s;
        });
      }
      // замена
      pm = /^\/([\/#%]?)([\s\S]*)$/.exec(op);
      if (pm) {
        const mode = pm[1];
        let body = pm[2];
        // разделить по первому неэкранированному /
        let k = 0, patRaw = body, repRaw = null;
        for (; k < body.length; k++) {
          if (body[k] === '\\') { k++; continue; }
          if (body[k] === "'") { k = PU.scanSingle(body, k) - 1; continue; }
          if (body[k] === '"') { k = PU.scanDouble(body, k) - 1; continue; }
          if (body[k] === '$' && (body[k + 1] === '{' || body[k + 1] === '(')) { k = PU.scanDollar(body, k) - 1; continue; }
          if (body[k] === '/') { patRaw = body.slice(0, k); repRaw = body.slice(k + 1); break; }
        }
        const pat = this.expandPattern(patRaw);
        const rep = repRaw == null ? '' : this.expandStr(repRaw);
        return apply((s) => {
          if (pat === '') return s;
          const ch = Array.from(s);
          const L = ch.length;
          if (mode === '#') { for (let e = L; e >= 0; e--) if (patMatch(ch.slice(0, e).join(''), pat)) return rep + ch.slice(e).join(''); return s; }
          if (mode === '%') { for (let b = 0; b <= L; b++) if (patMatch(ch.slice(b).join(''), pat)) return ch.slice(0, b).join('') + rep; return s; }
          let out = '', a = 0;
          while (a <= L) {
            let found = -1;
            for (let e = L; e >= a; e--) { if (patMatch(ch.slice(a, e).join(''), pat)) { found = e; break; } }
            if (found >= 0 && !(found === a && pat !== '')) {
              out += rep; a = found;
              if (mode !== '/') { out += ch.slice(a).join(''); return out; }
              continue;
            }
            if (found === a) { // пустое совпадение
              if (a < L) out += ch[a];
              a++;
              continue;
            }
            if (a < L) out += ch[a];
            a++;
          }
          return out;
        });
      }
      // регистр
      pm = /^(\^\^|\^|,,|,|~~|~)([\s\S]*)$/.exec(op);
      if (pm) {
        const k = pm[1];
        return apply((s) => {
          if (k === '^^') return s.toUpperCase();
          if (k === ',,') return s.toLowerCase();
          const ch = Array.from(s);
          if (!ch.length) return s;
          if (k === '^') return ch[0].toUpperCase() + ch.slice(1).join('');
          if (k === ',') return ch[0].toLowerCase() + ch.slice(1).join('');
          return Array.from(s).map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join(k === '~' ? '' : '');
        });
      }
      pm = /^@([QULuEaA])$/.exec(op);
      if (pm) {
        return apply((s) => {
          switch (pm[1]) {
            case 'Q': return shQuote(s) === s && s !== '' ? "'" + s + "'" : shQuote(s);
            case 'U': return s.toUpperCase();
            case 'L': return s.toLowerCase();
            case 'u': return s ? s[0].toUpperCase() + s.slice(1) : s;
            case 'E': return echoEscapes(s).s;
            default: return s;
          }
        });
      }
      throw bad();
    }

    /* Разбиение на поля + glob */
    splitSegs(segs) {
      const ifsV = this.getParam('IFS');
      const ifs = ifsV == null ? ' \t\n' : ifsV;
      const fields = [];
      let cur = null;
      const start = () => { if (!cur) cur = { str: '', pat: '', glob: false }; };
      const end = () => { if (cur) { fields.push(cur); cur = null; } };
      for (const sg of segs) {
        if (sg.brk) { end(); continue; }
        if (sg.q) { start(); cur.str += sg.t; cur.pat += globEscape(sg.t); continue; }
        if (!sg.s || ifs === '') {
          if (sg.t === '' && !sg.s) continue;
          if (sg.t === '' && sg.s) continue;
          start(); cur.str += sg.t; cur.pat += sg.t; if (/[*?[]/.test(sg.t)) cur.glob = true; continue;
        }
        const t = sg.t;
        for (let k = 0; k < t.length; k++) {
          const ch = t[k];
          if (ifs.indexOf(ch) >= 0) {
            const ws = ch === ' ' || ch === '\t' || ch === '\n';
            if (ws) { end(); continue; }
            // не-пробельный разделитель
            if (cur) end(); else fields.push({ str: '', pat: '', glob: false });
            // пропустить пробельные IFS после
            while (k + 1 < t.length && ' \t\n'.indexOf(t[k + 1]) >= 0 && ifs.indexOf(t[k + 1]) >= 0) k++;
            continue;
          }
          start(); cur.str += ch; cur.pat += ch; if (ch === '*' || ch === '?' || ch === '[') cur.glob = true;
        }
      }
      end();
      return fields;
    }
    expandFields(raw) {
      const out = [];
      for (const w of this.braceExpand(raw)) {
        const fields = this.splitSegs(this.segments(w));
        for (const f of fields) {
          if (f.glob && !this.opts.noglob && hasGlob(f.pat)) {
            const m = this.glob(f.pat);
            if (m.length) { for (const x of m) out.push(x); continue; }
          }
          out.push(f.str);
        }
      }
      return out;
    }
    expandStr(raw) {
      if (raw === '') return '';
      return this.segments(raw).map(s => s.brk ? ' ' : s.t).join('');
    }
    expandPattern(raw) {
      return this.segments(raw).map(s => s.brk ? ' ' : (s.q ? globEscape(s.t) : s.t)).join('');
    }
    expandRegex(raw) {
      return this.segments(raw).map(s => s.brk ? ' ' : (s.q ? s.t.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&') : s.t)).join('');
    }
    expandHeredoc(body) {
      const segs = [];
      this.dqSegments(body, 0, segs, true);
      return segs.map(s => s.brk ? ' ' : s.t).join('');
    }
    glob(pat) {
      const abs = pat.startsWith('/');
      const parts = pat.split('/');
      let bases = [{ path: abs ? '/' : this.cwd, shown: abs ? '/' : '' }];
      const start = abs ? 1 : 0;
      for (let pi = start; pi < parts.length; pi++) {
        const part = parts[pi];
        const last = pi === parts.length - 1;
        if (part === '') { if (last) bases = bases.map(b => ({ path: b.path, shown: b.shown.endsWith('/') ? b.shown : b.shown + '/' })); continue; }
        const next = [];
        for (const b of bases) {
          const node = this.fs.get(b.path);
          if (!node || node.t !== 'd') continue;
          if (hasGlob(part)) {
            const re = globToRe(part);
            const names = Object.keys(node.c).sort(BS.cmpNames);
            const all = part.startsWith('.') || part.startsWith('\\.') ? ['.', '..'].concat(names) : names;
            for (const nm of all) {
              if (nm.startsWith('.') && !(part.startsWith('.') || part.startsWith('\\.'))) continue;
              if (!re.test(nm)) continue;
              const child = nm === '.' || nm === '..' ? null : node.c[nm];
              if (!last && child && child.t !== 'd') continue;
              next.push({ path: VFS.normalize(nm, b.path), shown: (b.shown && !b.shown.endsWith('/') ? b.shown + '/' : b.shown) + nm });
            }
          } else {
            const nm = unescapeGlob(part);
            const p = VFS.normalize(nm, b.path);
            if (nm === '.' || nm === '..' || this.fs.exists(p)) next.push({ path: p, shown: (b.shown && !b.shown.endsWith('/') ? b.shown + '/' : b.shown) + nm });
          }
        }
        bases = next;
        if (!bases.length) break;
      }
      return bases.map(b => b.shown).sort(BS.cmpNames);
    }

    /* Подстановка команды $( ) */
    parseCached(text) {
      let ast = this.parseCache.get(text);
      if (!ast) {
        try { ast = new Parser(text).parseProgram(); }
        catch (e) { if (e instanceof ParseError) throw new ShellError(e.message.replace('unexpected end of file', "unexpected EOF while looking for matching `)'")); throw e; }
        if (this.parseCache.size > 500) this.parseCache.clear();
        this.parseCache.set(text, ast);
      }
      return ast;
    }
    cmdSubst(text) {
      const ast = this.parseCached(text);
      const sub = this.fork();
      sub.traceLevel = (this.traceLevel || 1) + 1;
      const out = new OutBuf(false);
      const io = { in: this.curIn || EMPTY_IN(), out, err: this.curErr || new NullOut() };
      let st = 0;
      try { st = sub.run(ast, io); }
      catch (e) {
        if (e instanceof ExitSig) st = e.code;
        else if (e instanceof ShellError) { sub.reportError(e, io); st = e.status; }
        else if (e instanceof BreakSig || e instanceof ReturnSig) st = 0;
        else throw e;
      }
      this.lastSubst = st;
      this.status = st;
      return out.s.replace(/\n+$/, '');
    }

    /* ---------- Процессы ---------- */
    fork() {
      const c = Object.create(Shell.prototype);
      Object.assign(c, this);
      c.scopes = this.scopes.map(m => { const n = new Map(); for (const [k, v] of m) n.set(k, cloneVar(v)); return n; });
      c.functions = new Map(this.functions);
      c.aliases = new Map(this.aliases);
      c.positional = this.positional.slice();
      c.opts = Object.assign({}, this.opts);
      c.funcStack = this.funcStack.slice();
      c.subLevel = this.subLevel + 1;
      c.rootPid = this.rootPid || this.pid;
      c.pid = ++pidCounter;
      return c;
    }
    spawn(argv0, args) {
      const env = {};
      for (let i = 0; i < this.scopes.length; i++) for (const [k, v] of this.scopes[i]) if (v.ex && v.v != null) env[k] = v.v;
      env.PWD = this.cwd;
      const c = new Shell({ fs: this.fs, cwd: this.cwd, env, limits: this.limits, execLog: this.execLog, host: this.host, argv0, args, history: [] });
      c.interactive = false;
      c.opts.expand_aliases = false;
      c.ttyStdin = this.ttyStdin;
      return c;
    }

    errPrefix() {
      if (this.interactive && !this.srcName) return 'bash: ';
      return (this.srcName || this.argv0) + ': line ' + this.lineno + ': ';
    }
    errMsg(io, msg) { (io || {}).err && io.err.write(this.errPrefix() + msg + '\n'); }
    reportError(e, io) {
      const err = (io && io.err) || this.curErr;
      if (!err) return;
      err.write((e.noPrefix ? '' : this.errPrefix()) + e.message + '\n');
    }

    /* Выполнение текста программы по командам верхнего уровня */
    runText(src, io, o) {
      o = o || {};
      const p = new Parser(src);
      p.interactive = !!o.interactive;
      let status = 0;
      for (;;) {
        let node;
        try { node = p.parseNextTopLevel(); }
        catch (e) {
          if (!(e instanceof ParseError)) throw e;
          this.lineno = p.lineOf(e.pos);
          if (e.message.indexOf('unexpected end of file') >= 0) this.lineno = (src.match(/\n/g) || []).length + (src.endsWith('\n') ? 1 : 1);
          const pre = this.interactive && !this.srcName ? 'bash: ' : this.errPrefix();
          io.err.write(pre + e.message + '\n');
          if (e.token && !(this.interactive && !this.srcName)) {
            const lines = src.split('\n');
            io.err.write(pre + '`' + (lines[this.lineno - 1] || '').trim() + "'\n");
          }
          status = 2; this.status = 2;
          break;
        }
        if (!node) break;
        this.lineno = node.line;
        try {
          status = this.run(node, io);
        } catch (e) {
          if (e instanceof ShellError) {
            this.reportError(e, io);
            status = e.status; this.status = status;
            if (e.fatal && !this.interactive) throw new ExitSig(status);
            continue;
          }
          if (e instanceof ReturnSig) {
            if (this.sourceDepth > 0 || this.funcStack.length) throw e;
            this.errMsg(io, "return: can only `return' from a function or sourced script");
            status = 1; this.status = 1; continue;
          }
          if (e instanceof BreakSig) { continue; }
          throw e;
        }
      }
      return status;
    }
    evalText(text, io, guard) {
      let ast;
      try { ast = new Parser(text).parseProgram(); }
      catch (e) {
        if (e instanceof ParseError) { this.errMsg(io, e.message); return 2; }
        throw e;
      }
      const saved = this.aliasGuard;
      if (guard) this.aliasGuard = guard;
      try { return this.run(ast, io); } finally { this.aliasGuard = saved; }
    }

    run(node, io) {
      let st;
      switch (node.type) {
        case 'list': {
          st = 0;
          for (const it of node.items) st = this.run(it.node, io);
          return st;
        }
        case 'andor': {
          this.errexitOff++;
          let l;
          try { l = this.run(node.left, io); } finally { this.errexitOff--; }
          if (node.op === '&&' ? l === 0 : l !== 0) return this.run(node.right, io);
          return l;
        }
        case 'pipeline': st = this.execPipeline(node, io); break;
        case 'cmd': st = this.execCmd(node, io); break;
        default:
          st = node.redirs && node.redirs.length ? this.withRedirs(node.redirs, io, (io2) => this.execCompound(node, io2)) : this.execCompound(node, io);
          this.status = st;
          return st;
      }
      this.status = st;
      if (st !== 0 && this.opts.errexit && this.errexitOff === 0) throw new ExitSig(st);
      return st;
    }
    execCompound(node, io) {
      switch (node.type) {
        case 'if': {
          for (const c of node.clauses) {
            this.errexitOff++;
            let cs;
            try { cs = this.run(c.cond, io); } finally { this.errexitOff--; }
            if (cs === 0) return this.run(c.body, io);
          }
          if (node.elseBody) return this.run(node.elseBody, io);
          return 0;
        }
        case 'for': {
          let words;
          if (node.words == null) words = this.positional.slice();
          else { words = []; for (const w of node.words) for (const f of this.expandFields(w)) words.push(f); }
          let st = 0;
          this.loopDepth++;
          try {
            for (const w of words) {
              this.tick();
              if (this.opts.xtrace) io.err.write(this.tracePfx() + 'for ' + node.name + ' in ' + (node.words == null ? '"$@"' : node.words.join(' ')) + '\n');
              this.setVar(node.name, null, w, false);
              try { st = this.run(node.body, io); }
              catch (e) {
                if (e instanceof BreakSig) { if (e.n > 1) { e.n--; throw e; } if (e.cont) continue; st = 0; break; }
                throw e;
              }
            }
          } finally { this.loopDepth--; }
          return st;
        }
        case 'forarith': {
          let st = 0;
          this.loopDepth++;
          try {
            const tr = (e) => { if (this.opts.xtrace) io.err.write(this.tracePfx() + '(( ' + this.expandArithText(e).trim() + ' ))\n'); };
            if (node.init.trim()) { tr(node.init); this.arith(this.expandArithText(node.init)); }
            for (;;) {
              this.tick();
              if (node.cond.trim()) tr(node.cond);
              if (node.cond.trim() && this.arith(this.expandArithText(node.cond)) === 0n) break;
              try { st = this.run(node.body, io); }
              catch (e) {
                if (e instanceof BreakSig) { if (e.n > 1) { e.n--; throw e; } if (!e.cont) { st = 0; break; } }
                else throw e;
              }
              if (node.step.trim()) { tr(node.step); this.arith(this.expandArithText(node.step)); }
            }
          } finally { this.loopDepth--; }
          return st;
        }
        case 'while': {
          let st = 0;
          this.loopDepth++;
          try {
            for (;;) {
              this.tick();
              this.errexitOff++;
              let c;
              try { c = this.run(node.cond, io); } finally { this.errexitOff--; }
              if (node.until ? c === 0 : c !== 0) break;
              try { st = this.run(node.body, io); }
              catch (e) {
                if (e instanceof BreakSig) { if (e.n > 1) { e.n--; throw e; } if (e.cont) continue; st = 0; break; }
                throw e;
              }
            }
          } finally { this.loopDepth--; }
          return st;
        }
        case 'case': {
          this.curIn = io.in; this.curErr = io.err;
          if (this.opts.xtrace) io.err.write(this.tracePfx() + 'case ' + node.word + ' in\n');
          const val = this.expandStr(node.word);
          for (let i = 0; i < node.items.length; i++) {
            const it = node.items[i];
            let hit = false;
            for (const p of it.patterns) { if (patMatch(val, this.expandPattern(p))) { hit = true; break; } }
            if (!hit) continue;
            let st = this.run(it.body, io);
            let j = i;
            while (node.items[j].term === ';&' && j + 1 < node.items.length) { j++; st = this.run(node.items[j].body, io); }
            if (node.items[j].term === ';;&') { i = j; continue; }
            return st;
          }
          return 0;
        }
        case 'group': return this.run(node.body, io);
        case 'subshell': {
          const sub = this.fork();
          try { return sub.run(node.body, io); }
          catch (e) {
            if (e instanceof ExitSig) return e.code;
            if (e instanceof ShellError) { sub.reportError(e, io); return e.status; }
            throw e;
          }
        }
        case 'funcdef': {
          if (KEYWORDS.has(node.name) || /^[0-9]/.test(node.name) || /[$`'"\\=]/.test(node.name)) { this.errMsg(io, '`' + node.name + "': not a valid identifier"); return 1; }
          this.functions.set(node.name, { body: node.body, text: node.text });
          return 0;
        }
        case 'arith': {
          this.curIn = io.in; this.curErr = io.err;
          if (this.opts.xtrace) io.err.write(this.tracePfx() + '(( ' + this.expandArithText(node.expr).trim() + ' ))\n');
          return this.arith(this.expandArithText(node.expr)) !== 0n ? 0 : 1;
        }
        case 'cond': {
          this.curIn = io.in; this.curErr = io.err;
          try { return this.evalCond(node.expr, io) ? 0 : 1; }
          catch (e) { if (e && e.condStatus) return e.condStatus; throw e; }
        }
      }
      throw new FatalError('unknown node ' + node.type);
    }

    evalCond(e, io) {
      switch (e.op) {
        case 'and': return this.evalCond(e.l, io) && this.evalCond(e.r, io);
        case 'or': return this.evalCond(e.l, io) || this.evalCond(e.r, io);
        case 'not': return !this.evalCond(e.e, io);
        case 'str': { const v = this.expandStr(e.w); if (this.opts.xtrace) this.curErr.write(this.tracePfx() + '[[ -n ' + shQuote(v) + ' ]]\n'); return v !== ''; }
        case 'unary': {
          const a = this.expandStr(e.a);
          if (this.opts.xtrace) this.curErr.write(this.tracePfx() + '[[ ' + e.o + ' ' + shQuote(a) + ' ]]\n');
          if (e.o === '-z') return a === '';
          if (e.o === '-n') return a !== '';
          if (e.o === '-v') { const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(a); if (!m) return false; if (m[2] != null) return this.getElem(m[1], m[2]) != null; return this.isSetVar(m[1]); }
          return this.fileTest(e.o, a);
        }
        case 'bin': {
          const l = this.expandStr(e.l);
          if (this.opts.xtrace) this.curErr.write(this.tracePfx() + '[[ ' + shQuote(l) + ' ' + e.o + ' ' + (e.o === '=~' ? this.expandRegex(e.r) : (e.o === '==' || e.o === '=' || e.o === '!=') ? this.expandPattern(e.r) : shQuote(this.expandStr(e.r))) + ' ]]\n');
          switch (e.o) {
            case '==': case '=': return patMatch(l, this.expandPattern(e.r));
            case '!=': return !patMatch(l, this.expandPattern(e.r));
            case '<': return l < this.expandStr(e.r);
            case '>': return l > this.expandStr(e.r);
            case '=~': {
              const src = this.expandRegex(e.r);
              let re;
              try { re = new RegExp(posixToJs(src, false)); }
              catch (err) { const x = new Error('regex'); x.condStatus = 2; throw x; }
              const m = re.exec(l);
              const o = this.varForWrite('BASH_REMATCH');
              o.v = null; o.map = null; o.arr = new Map();
              if (!m) return false;
              m.forEach((g, k) => o.arr.set(k, g == null ? '' : g));
              return true;
            }
            case '-eq': case '-ne': case '-lt': case '-le': case '-gt': case '-ge': {
              const a = this.arith(this.expandArithText(e.l) || '0'), b = this.arith(this.expandArithText(e.r) || '0');
              return { '-eq': a === b, '-ne': a !== b, '-lt': a < b, '-le': a <= b, '-gt': a > b, '-ge': a >= b }[e.o];
            }
            case '-nt': case '-ot': case '-ef': {
              const r = this.expandStr(e.r);
              const A = this.fs.get(this.resolve(l)), B = this.fs.get(this.resolve(r));
              if (e.o === '-ef') return !!A && A === B;
              if (e.o === '-nt') return !!A && (!B || A.mt > B.mt);
              return !!B && (!A || A.mt < B.mt);
            }
          }
        }
      }
      return false;
    }
    resolve(p) { return VFS.normalize(p, this.cwd); }
    fileTest(op, path) {
      if (path === '') return false;
      const n = this.fs.get(this.resolve(path));
      switch (op) {
        case '-e': case '-a': return !!n;
        case '-f': return !!n && n.t === 'f';
        case '-d': return !!n && n.t === 'd';
        case '-s': return !!n && (n.t === 'd' || (n.x || '').length > 0);
        case '-r': return !!n && this.fs.can(n, 'r');
        case '-w': return !!n && this.fs.can(n, 'w');
        case '-x': return !!n && this.fs.can(n, 'x');
        case '-c': return !!n && n.t === 'c';
        case '-O': return !!n && n.o === this.user;
        case '-G': return !!n && n.o === this.user;
        case '-L': case '-h': case '-b': case '-p': case '-S': case '-t': case '-u': case '-g': case '-k': case '-N': return false;
      }
      return false;
    }

    execPipeline(node, io) {
      const n = node.cmds.length;
      let st;
      if (n === 1) st = this.run(node.cmds[0], io);
      else {
        let input = io.in;
        const sts = [];
        for (let i = 0; i < n; i++) {
          const last = i === n - 1;
          const out = last ? io.out : new OutBuf(false);
          const err = (!last && node.errPipe[i]) ? out : io.err;
          const sub = this.fork();
          sub.errexitOff = 0;
          try { st = sub.run(node.cmds[i], { in: input, out, err }); }
          catch (e) {
            if (e instanceof ExitSig) st = e.code;
            else if (e instanceof ShellError) { sub.reportError(e, { err }); st = e.status; }
            else if (e instanceof BreakSig || e instanceof ReturnSig) st = 0;
            else throw e;
          }
          sts.push(st);
          if (!last) input = new InStream(out.s, false);
        }
        if (this.opts.pipefail) { st = 0; for (const s of sts) if (s !== 0) st = s; }
      }
      if (node.bang) st = st === 0 ? 1 : 0;
      return st;
    }

    expandArgs(words) {
      const argv = [];
      const decl = words.length && PU.DECL.has(words[0]);
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (decl && i > 0 && PU.ASSIGN_RE.test(w)) { argv.push({ assignRaw: w }); continue; }
        for (const f of this.expandFields(w)) argv.push(f);
      }
      return argv;
    }

    execCmd(node, io) {
      this.lineno = node.line;
      this.tick();
      // алиасы
      if (this.opts.expand_aliases && node.words.length && node.w0s >= 0) {
        const w0 = node.words[0];
        if (this.aliases.has(w0) && PU.isLiteral(w0) && !(this.aliasGuard && this.aliasGuard.has(w0))) {
          const text = node.text.slice(0, node.w0s) + this.aliases.get(w0) + node.text.slice(node.w0e);
          const guard = new Set(this.aliasGuard || []); guard.add(w0);
          return this.evalText(text, io, guard);
        }
      }
      this.curIn = io.in; this.curErr = io.err;
      this.lastSubst = null;
      const argv = this.expandArgs(node.words);
      if (argv.length === 0) {
        for (const a of node.assigns) {
          if (this.opts.xtrace) io.err.write(this.tracePfx() + this.traceAssign(a) + '\n');
          this.doAssignWord(a);
        }
        let st = this.lastSubst != null ? this.lastSubst : 0;
        if (node.redirs.length) { const r = this.withRedirs(node.redirs, io, () => 0); if (r !== 0) st = r; }
        return st;
      }
      const name = argv[0];
      if (typeof name !== 'string') return 1;
      this.lastArg = typeof argv[argv.length - 1] === 'string' ? argv[argv.length - 1] : '';
      if (this.opts.xtrace) {
        const pre = node.assigns.map(a => this.traceAssign(a));
        io.err.write(this.tracePfx() + pre.concat(argv.map(a => typeof a === 'string' ? shQuote(a) : this.traceAssign(a.assignRaw))).join(' ') + '\n');
      }
      const run = (io2) => {
        if (node.assigns.length) {
          const frame = new Map();
          this.scopes.push(frame);
          try {
            for (const a of node.assigns) { this.doAssignWord(a, frame); const v = frame.get(PU.ASSIGN_RE.exec(a)[1]); if (v) v.ex = true; }
            return this.invoke(argv, io2);
          } finally { const k = this.scopes.indexOf(frame); if (k >= 0) this.scopes.splice(k, 1); }
        }
        return this.invoke(argv, io2);
      };
      if (node.redirs.length) return this.withRedirs(node.redirs, io, run);
      return run(io);
    }
    traceAssign(a) {
      const m = PU.ASSIGN_RE.exec(a);
      const v = a.slice(m[0].length);
      if (!m[2] && v.startsWith('(') && v.endsWith(')')) return a;
      try { return m[0] + shQuote(this.expandStr(v)); } catch (e) { return a; }
    }
    tracePfx() { return '+'.repeat(this.traceLevel || 1) + ' '; }

    invoke(argv, io, noFunc) {
      const name = argv[0];
      if (!noFunc && this.functions.has(name)) return this.callFunction(name, argv.slice(1), io);
      const b = BUILTINS[name];
      if (b) {
        this.curIn = io.in; this.curErr = io.err;
        return b.call(this, argv, io);
      }
      if (name.indexOf('/') >= 0) return this.execFile(name, argv, io);
      const c = BS.COMMANDS && BS.COMMANDS[name];
      if (c) {
        (this.hashed || (this.hashed = new Set())).add(name);
        const strArgs = argv.map(a => typeof a === 'string' ? a : a.assignRaw);
        return c(this, strArgs, io);
      }
      const p = this.findInPath(name);
      if (p) return this.execFile(p, argv, io);
      this.errMsg(io, name + ': command not found');
      this.hintNotFound(argv, io);
      return 127;
    }
    hintNotFound(argv, io) {
      const name = argv[0];
      if (!this.hints) return;
      let h = null;
      if (argv[1] === '=' || (argv[1] && argv[1].startsWith('=')) || name.endsWith('=')) h = 'в присваивании не должно быть пробелов вокруг «=»: имя=значение';
      else if (/^\[[^\s]/.test(name) || /^\[\[[^\s]/.test(name)) h = 'после «[» и перед «]» обязательно нужны пробелы: [ "$a" -gt 5 ]';
      else if (/^(if|while|until)\[/.test(name)) h = 'после if/while ставится пробел: if [ ... ]';
      else if (/\]$/.test(name)) h = 'перед «]» нужен пробел';
      else if (/^\.\//.test(name) === false && this.fs.exists(this.resolve(name)) && this.fs.isFile(this.resolve(name))) h = 'чтобы запустить файл из текущей папки, пишите ./' + name + '  (или bash ' + name + ')';
      else if (name === 'cls') h = 'в Linux экран очищается командой clear';
      else if (name === 'dir') h = 'в Linux содержимое папки показывает ls';
      else if (/^[А-Яа-яЁё]/.test(name)) h = 'похоже, включена русская раскладка клавиатуры';
      if (h) io.err.write('\x1b[33m💡 Подсказка: ' + h + '\x1b[0m\n');
    }
    findInPath(name) {
      const path = this.getStr('PATH').split(':');
      for (const d of path) {
        if (!d) continue;
        const p = VFS.normalize(name, d);
        const n = this.fs.get(p);
        if (n && n.t === 'f' && this.fs.can(n, 'x') && !n.x.startsWith('\x7fELF')) return p;
      }
      return null;
    }
    callFunction(name, args, io) {
      if (this.callDepth >= 300) throw new ShellError(name + ': maximum function nesting level exceeded (300)', { fatal: true });
      const fn = this.functions.get(name);
      const savedPos = this.positional;
      this.positional = args.map(a => typeof a === 'string' ? a : a.assignRaw);
      const frame = new Map();
      this.scopes.push(frame);
      this.funcFrames.push(frame);
      this.funcStack.push(name);
      this.callDepth++;
      const savedLoop = this.loopDepth;
      this.loopDepth = 0;
      let st;
      try { st = this.run(fn.body, io); }
      catch (e) { if (e instanceof ReturnSig) st = e.code; else throw e; }
      finally {
        this.loopDepth = savedLoop;
        this.callDepth--;
        this.funcStack.pop();
        this.funcFrames.pop();
        const k = this.scopes.lastIndexOf(frame);
        if (k >= 0) this.scopes.splice(k, 1);
        this.positional = savedPos;
      }
      this.status = st;
      return st;
    }
    execFile(path, argv, io, how) {
      const abs = this.resolve(path);
      const n = this.fs.get(abs);
      const pre = this.interactive && !this.srcName ? 'bash: ' : this.errPrefix();
      if (!n) {
        io.err.write(pre + path + ': No such file or directory\n');
        if (this.hints && this.interactive) {
          const base = path.split('/').pop();
          if (this.fs.exists(VFS.normalize(base, this.cwd)) === false) io.err.write('\x1b[33m💡 Подсказка: проверьте текущую папку (pwd) и имя файла (ls)\x1b[0m\n');
        }
        return 127;
      }
      if (n.t === 'd') { io.err.write(pre + path + ': Is a directory\n'); return 126; }
      if (!this.fs.can(n, 'x')) {
        io.err.write(pre + path + ': Permission denied\n');
        if (this.hints) io.err.write('\x1b[33m💡 Подсказка: файл не исполняемый — выполните chmod +x ' + path.split('/').pop() + '  (или запустите: bash ' + path + ')\x1b[0m\n');
        return 126;
      }
      const content = n.x;
      if (content.startsWith('\x7fELF')) {
        const base = abs.split('/').pop();
        const c = BS.COMMANDS[base] || BUILTINS[base];
        if (c) return BS.COMMANDS[base] ? c(this, [base].concat(argv.slice(1).map(String)), io) : c.call(this, [base].concat(argv.slice(1)), io);
        io.err.write(pre + path + ': cannot execute binary file\n'); return 126;
      }
      if (content.startsWith('#!')) {
        const line = content.split('\n')[0].slice(2).trim();
        const parts = line.split(/\s+/);
        const interp = parts[0];
        const ip = this.fs.get(VFS.normalize(interp, '/'));
        if (!interp.startsWith('/') || !ip) {
          io.err.write(pre + path + ': cannot execute: required file not found\n');
          if (this.hints) io.err.write('\x1b[33m💡 Подсказка: проверьте первую строку (shebang). Правильно: #!/bin/bash\x1b[0m\n');
          return 127;
        }
        const ib = interp.split('/').pop();
        const real = ib === 'env' ? (parts[1] || '') : ib;
        if (['bash', 'sh', 'dash', 'rbash'].indexOf(real) < 0) {
          io.err.write(pre + path + ': интерпретатор «' + line + '» недоступен в симуляторе (поддерживается только bash)\n');
          return 126;
        }
      }
      return this.runScriptFile(abs, content, path, argv.slice(1).map(a => typeof a === 'string' ? a : a.assignRaw), io, how || 'exec');
    }
    runScriptFile(abs, content, argv0, args, io, how, extraOpts) {
      const child = this.spawn(argv0, args);
      child.hints = this.hints;
      if (extraOpts) Object.assign(child.opts, extraOpts);
      let st;
      try { st = child.runText(content, io, { script: true }); }
      catch (e) {
        if (e instanceof ExitSig) st = e.code;
        else throw e;
      }
      this.execLog.push({ path: abs, how, status: st, args: args.slice(), t: Date.now() });
      return st;
    }
    sourceFile(file, args, io) {
      let abs = null;
      if (file.indexOf('/') >= 0) abs = this.resolve(file);
      else {
        const c = this.resolve(file);
        if (this.fs.isFile(c)) abs = c;
        else { for (const d of this.getStr('PATH').split(':')) { const p = VFS.normalize(file, d || '/'); if (this.fs.isFile(p)) { abs = p; break; } } }
      }
      let content;
      try {
        if (!abs) throw new BS.FsError('ENOENT');
        content = this.fs.readFile(abs);
      } catch (e) {
        this.errMsg(io, file + ': ' + (e.message || 'No such file or directory'));
        return 1;
      }
      const savedPos = this.positional;
      if (args.length) this.positional = args;
      const savedName = this.srcName;
      const savedLine = this.lineno;
      this.srcName = file;
      this.sourceDepth++;
      let st;
      try { st = this.runText(content, io, { script: true }); }
      catch (e) { if (e instanceof ReturnSig) st = e.code; else throw e; }
      finally {
        this.sourceDepth--;
        this.srcName = savedName;
        this.lineno = savedLine;
        if (args.length) this.positional = savedPos;
      }
      this.execLog.push({ path: abs, how: 'source', status: st, args: args.slice(), t: Date.now() });
      return st;
    }

    /* ---------- Перенаправления ---------- */
    withRedirs(redirs, io, fn) {
      const fds = { 0: io.in, 1: io.out, 2: io.err };
      for (const r of redirs) {
        try {
          if (r.op === '<<') {
            const body = r.quoted ? (r.body || '') : this.expandHeredoc(r.body || '');
            fds[r.fd] = new InStream(body, false);
            continue;
          }
          if (r.op === '<<<') { fds[r.fd == null ? 0 : r.fd] = new InStream(this.expandStr(r.target) + '\n', false); continue; }
          if ((r.op === '>&' || r.op === '<&') && /^[0-9]+-?$|^-$/.test(r.target)) {
            const fd = r.fd == null ? (r.op === '>&' ? 1 : 0) : r.fd;
            if (r.target === '-') { fds[fd] = new NullOut(); continue; }
            const src = parseInt(r.target, 10);
            if (!(src in fds)) throw new ShellError(r.target + ': Bad file descriptor');
            fds[fd] = fds[src];
            continue;
          }
          const fields = this.expandFields(r.target);
          if (fields.length !== 1) throw new ShellError(r.target + ': ambiguous redirect');
          const target = fields[0];
          if (r.op === '<') { fds[r.fd == null ? 0 : r.fd] = this.openRead(target); continue; }
          const append = r.op === '>>' || r.op === '&>>';
          let stream;
          if (target === '/dev/stdout') stream = fds[1];
          else if (target === '/dev/stderr') stream = fds[2];
          else if (target === '/dev/null') stream = new NullOut();
          else if (target === '/dev/tty') stream = io.out;
          else {
            if (target === '') throw new ShellError(': No such file or directory');
            const abs = this.resolve(target);
            try { stream = new FileOut(this.fs.openWrite(abs, append)); }
            catch (e) { if (e instanceof BS.FsError) throw new ShellError(target + ': ' + e.message); throw e; }
          }
          if (r.op === '&>' || r.op === '&>>' || (r.op === '>&')) { fds[1] = stream; fds[2] = stream; }
          else fds[r.fd == null ? 1 : r.fd] = stream;
        } catch (e) {
          if (e instanceof ShellError) { this.reportError(e, io); return 1; }
          throw e;
        }
      }
      return fn({ in: fds[0], out: fds[1], err: fds[2] });
    }
    openRead(target) {
      if (target === '/dev/null') return new InStream('', false);
      if (target === '/dev/stdin') return this.curIn || EMPTY_IN();
      const abs = this.resolve(target);
      try { return new InStream(this.fs.readFile(abs), false); }
      catch (e) { if (e instanceof BS.FsError) throw new ShellError(target + ': ' + e.message); throw e; }
    }

    /* ---------- test / [ ---------- */
    testCmd(args, io, name) {
      const self = this;
      const err = (m) => { const x = new Error(m); x.testErr = true; return x; };
      const UN = ['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-z', '-n', '-L', '-h', '-a', '-v', '-b', '-c', '-p', '-S', '-t', '-O', '-G', '-N', '-u', '-g', '-k'];
      const BIN = ['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef'];
      function int(s) {
        const t = s.trim();
        if (!/^[+-]?[0-9]+$/.test(t)) throw err(s + ': integer expression expected');
        return BigInt(t);
      }
      function unary(op, a) {
        if (op === '-z') return a === '';
        if (op === '-n') return a !== '';
        if (op === '-v') return self.isSetVar(a);
        return self.fileTest(op, a);
      }
      function binary(a, op, b) {
        switch (op) {
          case '=': case '==': return a === b;
          case '!=': return a !== b;
          case '<': return a < b;
          case '>': return a > b;
          case '-eq': return int(a) === int(b);
          case '-ne': return int(a) !== int(b);
          case '-lt': return int(a) < int(b);
          case '-le': return int(a) <= int(b);
          case '-gt': return int(a) > int(b);
          case '-ge': return int(a) >= int(b);
          case '-nt': case '-ot': case '-ef': {
            const A = self.fs.get(self.resolve(a)), B = self.fs.get(self.resolve(b));
            if (op === '-ef') return !!A && A === B;
            if (op === '-nt') return !!A && (!B || A.mt > B.mt);
            return !!B && (!A || A.mt < B.mt);
          }
        }
        throw err(op + ': binary operator expected');
      }
      function evalN(a) {
        const n = a.length;
        if (n === 0) return false;
        if (n === 1) return a[0] !== '';
        if (n === 2) {
          if (a[0] === '!') return !evalN([a[1]]);
          if (UN.indexOf(a[0]) >= 0) return unary(a[0], a[1]);
          throw err(a[0] + ': unary operator expected');
        }
        if (n === 3) {
          if (BIN.indexOf(a[1]) >= 0) return binary(a[0], a[1], a[2]);
          if (a[1] === '-a') return a[0] !== '' && a[2] !== '';
          if (a[1] === '-o') return a[0] !== '' || a[2] !== '';
          if (a[0] === '!') return !evalN(a.slice(1));
          if (a[0] === '(' && a[2] === ')') return a[1] !== '';
          throw err(a[1] + ': binary operator expected');
        }
        if (n === 4) {
          if (a[0] === '!') return !evalN(a.slice(1));
          if (a[0] === '(' && a[3] === ')') return evalN(a.slice(1, 3));
        }
        // общий разбор
        let k = 0;
        function or() { let v = and(); while (a[k] === '-o') { k++; const r = and(); v = v || r; } return v; }
        function and() { let v = not(); while (a[k] === '-a') { k++; const r = not(); v = v && r; } return v; }
        function not() { if (a[k] === '!') { k++; return !not(); } return prim(); }
        function prim() {
          if (k >= a.length) throw err('argument expected');
          if (a[k] === '(') { k++; const v = or(); if (a[k] !== ')') throw err("`)' expected"); k++; return v; }
          if (UN.indexOf(a[k]) >= 0 && k + 1 < a.length) { const op = a[k]; k += 2; return unary(op, a[k - 1]); }
          if (k + 2 < a.length + 0 && BIN.indexOf(a[k + 1]) >= 0) { const v = binary(a[k], a[k + 1], a[k + 2]); k += 3; return v; }
          const v = a[k] !== ''; k++; return v;
        }
        const v = or();
        if (k < a.length) throw err(a[k] + ': unexpected argument');
        return v;
      }
      try { return evalN(args) ? 0 : 1; }
      catch (e) {
        if (e.testErr) {
          this.errMsg(io, name + ': ' + e.message);
          if (this.hints && /unary operator expected/.test(e.message)) io.err.write('\x1b[33m💡 Подсказка: возможно, переменная пустая — заключайте её в кавычки: [ "$x" -gt 5 ]\x1b[0m\n');
          return 2;
        }
        throw e;
      }
    }
  }

  /* ====================== ВСТРОЕННЫЕ КОМАНДЫ ====================== */
  function printfFormat(sh, fmt, args, io) {
    let out = '';
    let ai = 0;
    let status = 0;
    const nextArg = () => (ai < args.length ? args[ai++] : null);
    const toInt = (s) => {
      if (s == null || s === '') return 0n;
      const t = s.trim();
      if (/^['"]/.test(t)) return BigInt(t.length > 1 ? t.codePointAt(1) : 0);
      let m = /^[+-]?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(t);
      if (m) {
        const neg = t[0] === '-';
        const body = t.replace(/^[+-]/, '');
        let v = /^0[xX]/.test(body) ? BigInt(body) : (body.length > 1 && body[0] === '0' ? BigInt('0o' + body.slice(1)) : BigInt(body));
        return neg ? -v : v;
      }
      m = /^[+-]?[0-9]+/.exec(t);
      io.err.write(sh.errPrefix() + 'printf: ' + s + ': invalid number\n');
      status = 1;
      return m ? BigInt(m[0]) : 0n;
    };
    const toFloat = (s) => {
      if (s == null || s === '') return 0;
      const t = s.trim();
      if (/^['"]/.test(t)) return t.length > 1 ? t.codePointAt(1) : 0;
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return parseFloat(t);
      if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
      io.err.write(sh.errPrefix() + 'printf: ' + s + ': invalid number\n');
      status = 1;
      const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(t);
      return m ? parseFloat(m[0]) : 0;
    };
    const pad = (s, width, left, zero) => {
      if (width == null || s.length >= width) return s;
      if (left) return s + ' '.repeat(width - s.length);
      if (zero) { const sign = /^[+-]/.test(s) ? s[0] : ''; const body = sign ? s.slice(1) : s; return sign + '0'.repeat(width - s.length) + body; }
      return ' '.repeat(width - s.length) + s;
    };
    const expFmt = (v, prec, upper) => {
      let s = v.toExponential(prec);
      s = s.replace(/e([+-])(\d)$/, 'e$10$2');
      return upper ? s.toUpperCase() : s;
    };
    let guard = 0;
    do {
      let usedArg = false;
      for (let i = 0; i < fmt.length; i++) {
        const c = fmt[i];
        if (c === '\\') {
          const r = /^\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|(.))/s.exec(fmt.slice(i));
          if (!r) { out += '\\'; continue; }
          i += r[0].length - 1;
          if (r[1]) out += String.fromCharCode(parseInt(r[1], 8));
          else if (r[2]) out += String.fromCharCode(parseInt(r[2], 16));
          else if (r[3]) out += String.fromCharCode(parseInt(r[3], 16));
          else {
            const m = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', '"': '"', "'": "'" }[r[4]];
            out += m != null ? m : '\\' + r[4];
          }
          continue;
        }
        if (c !== '%') { out += c; continue; }
        if (fmt[i + 1] === '%') { out += '%'; i++; continue; }
        const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d*))?([diouxXfFeEgGsbcq])/.exec(fmt.slice(i));
        if (!m) {
          io.err.write(sh.errPrefix() + 'printf: `' + (fmt[i + 1] || '') + "': invalid format character\n");
          return { out, status: 1 };
        }
        i += m[0].length - 1;
        const flags = m[1];
        let width = m[2] === '*' ? Number(toInt(nextArg())) : (m[2] ? parseInt(m[2], 10) : null);
        let prec = m[3] === '*' ? Number(toInt(nextArg())) : (m[3] != null ? (m[3] === '' ? 0 : parseInt(m[3], 10)) : null);
        const left = flags.indexOf('-') >= 0 || (width != null && width < 0);
        if (width != null && width < 0) width = -width;
        const zero = flags.indexOf('0') >= 0 && !left;
        const conv = m[4];
        const arg = nextArg();
        if (arg !== null) usedArg = true;
        let s;
        switch (conv) {
          case 'd': case 'i': {
            const v = toInt(arg);
            s = (v < 0n ? '-' : (flags.indexOf('+') >= 0 ? '+' : flags.indexOf(' ') >= 0 ? ' ' : '')) + (v < 0n ? -v : v).toString();
            if (prec != null) { const sign = /^[+ -]/.test(s) ? s[0] : ''; let b = sign ? s.slice(1) : s; b = b.padStart(prec, '0'); s = sign + b; }
            s = pad(s, width, left, zero && prec == null);
            break;
          }
          case 'u': case 'o': case 'x': case 'X': {
            let v = toInt(arg);
            if (v < 0n) v = BigInt.asUintN(64, v);
            s = conv === 'o' ? v.toString(8) : conv === 'u' ? v.toString() : v.toString(16);
            if (conv === 'X') s = s.toUpperCase();
            if (flags.indexOf('#') >= 0 && v !== 0n) s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + s;
            if (prec != null) s = s.padStart(prec, '0');
            s = pad(s, width, left, zero);
            break;
          }
          case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
            const v = toFloat(arg);
            const p = prec == null ? 6 : prec;
            if (conv === 'f' || conv === 'F') s = v.toFixed(p);
            else if (conv === 'e' || conv === 'E') s = expFmt(v, p, conv === 'E');
            else {
              const P = p === 0 ? 1 : p;
              const ex = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)));
              if (ex < -4 || ex >= P) { s = expFmt(v, P - 1, conv === 'G'); if (flags.indexOf('#') < 0) s = s.replace(/\.?0+e/, 'e').replace(/\.?0+E/, 'E'); }
              else { s = v.toFixed(Math.max(0, P - 1 - ex)); if (flags.indexOf('#') < 0 && s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, ''); }
            }
            if (v >= 0 && flags.indexOf('+') >= 0) s = '+' + s;
            else if (v >= 0 && flags.indexOf(' ') >= 0) s = ' ' + s;
            s = pad(s, width, left, zero);
            break;
          }
          case 's': { s = arg == null ? '' : arg; if (prec != null) s = cutBytes(s, prec); s = padChars(s, width, left); break; }
          case 'b': { const r = echoEscapes(arg == null ? '' : arg); s = r.s; if (prec != null) s = s.slice(0, prec); s = padChars(s, width, left); if (r.stop) { out += s; return { out, status }; } break; }
          case 'c': { s = arg == null ? '' : Array.from(arg)[0] || ''; s = padChars(s, width, left); break; }
          case 'q': { s = padChars(shQuote(arg == null ? '' : arg), width, left); break; }
        }
        out += s;
      }
      if (!usedArg) break;
      if (++guard > 10000) break;
    } while (ai < args.length);
    return { out, status };
  }
  /* Как в bash: ширина поля printf считается в байтах UTF-8 */
  const utf8len = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
  function padChars(s, width, left) {
    const len = utf8len(s);
    if (width == null || len >= width) return s;
    return left ? s + ' '.repeat(width - len) : ' '.repeat(width - len) + s;
  }
  function cutBytes(s, n) { let out = '', b = 0; for (const ch of s) { const l = utf8len(ch); if (b + l > n) break; out += ch; b += l; } return out; }

  function readSplit(text, ifs, n) {
    // n — число переменных; последняя получает остаток
    const isWs = (c) => (c === ' ' || c === '\t' || c === '\n') && ifs.indexOf(c) >= 0;
    const isSep = (c) => ifs.indexOf(c) >= 0;
    let i = 0;
    const L = text.length;
    while (i < L && isWs(text[i])) i++;
    const out = [];
    while (out.length < n - 1 && i < L) {
      let f = '';
      while (i < L && !isSep(text[i])) f += text[i++];
      out.push(f);
      // пропустить разделитель
      while (i < L && isWs(text[i])) i++;
      if (i < L && isSep(text[i]) && !isWs(text[i])) { i++; while (i < L && isWs(text[i])) i++; }
    }
    let rest = text.slice(i);
    // обрезать хвостовые пробельные IFS
    let e = rest.length;
    while (e > 0 && isWs(rest[e - 1])) e--;
    rest = rest.slice(0, e);
    if (n > 0) out.push(rest);
    return out;
  }
  function splitAll(text, ifs) {
    const isWs = (c) => (c === ' ' || c === '\t' || c === '\n') && ifs.indexOf(c) >= 0;
    const isSep = (c) => ifs.indexOf(c) >= 0;
    const out = [];
    let i = 0;
    const L = text.length;
    while (i < L && isWs(text[i])) i++;
    while (i < L) {
      let f = '';
      while (i < L && !isSep(text[i])) f += text[i++];
      out.push(f);
      while (i < L && isWs(text[i])) i++;
      if (i < L && isSep(text[i]) && !isWs(text[i])) { i++; while (i < L && isWs(text[i])) i++; if (i >= L) { /* завершающий разделитель */ } }
    }
    return out;
  }

  function declText(sh, name, o) {
    let fl = '';
    if (o.arr) fl += 'a';
    if (o.map) fl += 'A';
    if (o.int) fl += 'i';
    if (o.lc) fl += 'l';
    if (o.uc) fl += 'u';
    if (o.ro) fl += 'r';
    if (o.ex) fl += 'x';
    const q = (s) => '"' + s.replace(/(["\\$`])/g, '\\$1') + '"';
    let val = '';
    if (o.arr) val = '=(' + sortedKeys(o.arr).map(k => '[' + k + ']=' + q(o.arr.get(k))).join(' ') + ')';
    else if (o.map) val = '=(' + Array.from(o.map.entries()).map(([k, v]) => '[' + k + ']=' + q(v) + ' ').join('') + ')';
    else if (o.v != null) val = '=' + q(o.v);
    return 'declare -' + (fl || '-') + ' ' + name + val;
  }

  function declare(sh, kind, argv, io) {
    const flags = {}; const unflags = {};
    const items = [];
    let i = 1;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (typeof a === 'string' && /^[-+][a-zA-Z]+$/.test(a)) {
        for (const ch of a.slice(1)) (a[0] === '-' ? flags : unflags)[ch] = true;
        continue;
      }
      if (a === '--') { i++; break; }
      break;
    }
    for (; i < argv.length; i++) items.push(argv[i]);
    if (kind === 'local') {
      if (!sh.funcFrames.length) { sh.errMsg(io, 'local: can only be used in a function'); return 1; }
    }
    if (kind === 'readonly') flags.r = true;
    if (kind === 'export') flags.x = true;
    if (flags.f || flags.F) {
      const names = items.length ? items.filter(x => typeof x === 'string') : Array.from(sh.functions.keys()).sort();
      let st = 0;
      for (const n of names) {
        const f = sh.functions.get(n);
        if (!f) { st = 1; continue; }
        io.out.write(flags.F ? 'declare -f ' + n + '\n' : n + ' () \n' + f.text + '\n');
      }
      return st;
    }
    if (!items.length) {
      // список
      const seen = new Map();
      for (let k = 0; k < sh.scopes.length; k++) for (const [n, o] of sh.scopes[k]) seen.set(n, o);
      const names = Array.from(seen.keys()).sort();
      for (const n of names) {
        const o = seen.get(n);
        if (kind === 'export' && !o.ex) continue;
        if (kind === 'readonly' && !o.ro) continue;
        if (flags.a && !o.arr) continue;
        if (flags.A && !o.map) continue;
        if (kind === 'declare' && !flags.p && !flags.a && !flags.A) { if (o.v != null) io.out.write(n + '=' + shQuote(o.v) + '\n'); continue; }
        io.out.write(declText(sh, n, o) + '\n');
      }
      return 0;
    }
    if (flags.p) {
      let st = 0;
      for (const n of items) {
        const name = typeof n === 'string' ? n : n.assignRaw.split('=')[0];
        const o = sh.getVarObj(name);
        if (!o) { sh.errMsg(io, 'declare: ' + name + ': not found'); st = 1; continue; }
        io.out.write(declText(sh, name, o) + '\n');
      }
      return st;
    }
    let st = 0;
    const inFunc = sh.funcFrames.length > 0;
    const frame = (kind === 'local' || (kind === 'declare' && inFunc && !flags.g)) ? sh.funcFrames[sh.funcFrames.length - 1] : null;
    for (const it of items) {
      let name, raw = null;
      if (typeof it === 'string') {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(=([\s\S]*))?$/.exec(it);
        if (!m) { sh.errMsg(io, kind + ": `" + it + "': not a valid identifier"); st = 1; continue; }
        name = m[1];
        if (m[2] != null) raw = name + '=' + shQuote(m[3]);
      } else {
        raw = it.assignRaw;
        name = PU.ASSIGN_RE.exec(raw)[1];
      }
      // значение вычисляется ДО создания локальной переменной (local x=$x)
      let pre = null;
      if (raw) {
        try {
          const m = PU.ASSIGN_RE.exec(raw);
          const valRaw = raw.slice(m[0].length);
          if (!m[2] && valRaw.startsWith('(') && valRaw.endsWith(')')) pre = { arr: sh.parseArrayLiteral(valRaw.slice(1, -1)), append: m[3] === '+' };
          else pre = { value: sh.expandAssignValue(valRaw), sub: m[2] ? m[2].slice(1, -1) : null, append: m[3] === '+' };
        } catch (e) { if (e instanceof ShellError) { sh.reportError(e, io); st = 1; continue; } throw e; }
      }
      let o;
      if (frame) {
        o = frame.get(name);
        if (!o) { o = newVar(); frame.set(name, o); }
      } else {
        o = sh.getVarObj(name);
        if (!o) { o = newVar(); sh.scopes[0].set(name, o); }
      }
      if (o.ro && (raw || flags.a || flags.A)) { sh.errMsg(io, name + ': readonly variable'); st = 1; continue; }
      if (flags.a && !o.arr && !o.map) { o.arr = new Map(); if (o.v != null) o.arr.set(0, o.v); o.v = null; }
      if (flags.A && !o.map) {
        if (o.arr) { sh.errMsg(io, name + ': cannot convert indexed to associative array'); st = 1; continue; }
        o.map = new Map(); if (o.v != null) o.map.set('0', o.v); o.v = null;
      }
      if (flags.i) o.int = true; if (unflags.i) o.int = false;
      if (flags.l) { o.lc = true; o.uc = false; } if (unflags.l) o.lc = false;
      if (flags.u) { o.uc = true; o.lc = false; } if (unflags.u) o.uc = false;
      if (flags.x) o.ex = true; if (unflags.x) o.ex = false;
      if (pre) {
        try {
          if (pre.arr) sh.setArrayOn(o, pre.arr, pre.append);
          else if (pre.sub != null) {
            const idx = o.map ? sh.expandStr(pre.sub) : Number(sh.arith(sh.expandArithText(pre.sub)));
            sh.setVarOn(o, name, idx, pre.value, pre.append);
          } else sh.setVarOn(o, name, null, pre.value, pre.append);
        } catch (e) { if (e instanceof ShellError) { sh.reportError(e, io); st = 1; continue; } throw e; }
      }
      if (flags.r) o.ro = true;
    }
    return st;
  }
  Shell.prototype.setVarOn = function (o, name, idx, value, append) {
    // временно подменяем поиск переменной на конкретный объект
    const tmp = new Map([[name, o]]);
    this.scopes.push(tmp);
    try { this.setVar(name, idx, value, append); } finally { this.scopes.pop(); }
  };
  Shell.prototype.setArrayOn = function (o, items, append) {
    const tmp = new Map([['__arr', o]]);
    this.scopes.push(tmp);
    try { this.setArray('__arr', items, append); } finally { this.scopes.pop(); }
  };

  const HELP_TEXT = [
    'Учебный симулятор bash (урок 10). Доступные команды:',
    '',
    '  Оболочка:  echo printf read cd pwd alias unalias export unset declare local',
    '             readonly let set shift source . exit return break continue test [ [[',
    '             type which history eval true false bash sh clear help man',
    '  Файлы:     ls cat mkdir rmdir touch rm cp mv chmod find file tee nano vim',
    '  Текст:     head tail wc sort uniq grep cut tr sed awk rev tac nl seq',
    '  Прочее:    date whoami id hostname uname basename dirname expr bc env getent sleep xargs',
    '',
    '  Скрипты:   nano script.sh → chmod +x script.sh → ./script.sh',
    '             bash script.sh   — запуск без права x',
    '             bash -x script.sh — запуск с трассировкой (отладка)',
    '',
    '  Клавиши:   ↑/↓ — история, Tab — дополнение, Ctrl+L — очистить, Ctrl+C — отменить ввод',
  ].join('\n') + '\n';

  const BUILTINS = {
    'echo'(argv, io) {
      let i = 1, nl = true, esc = false;
      while (i < argv.length && /^-[neE]+$/.test(argv[i])) {
        for (const ch of argv[i].slice(1)) { if (ch === 'n') nl = false; else if (ch === 'e') esc = true; else esc = false; }
        i++;
      }
      let s = argv.slice(i).map(a => typeof a === 'string' ? a : a.assignRaw).join(' ');
      if (esc) { const r = echoEscapes(s); if (r.stop) { io.out.write(r.s); return 0; } s = r.s; }
      io.out.write(s + (nl ? '\n' : ''));
      return 0;
    },
    'printf'(argv, io) {
      let args = argv.slice(1).map(String);
      let varName = null;
      if (args[0] === '-v') { varName = args[1]; args = args.slice(2); }
      if (args[0] === '--') args = args.slice(1);
      if (!args.length) { this.errMsg(io, 'printf: usage: printf [-v var] format [arguments]'); return 2; }
      const r = printfFormat(this, args[0], args.slice(1), io);
      if (varName) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(varName);
        if (!m) { this.errMsg(io, "printf: `" + varName + "': not a valid identifier"); return 1; }
        this.setVar(m[1], m[2] != null ? Number(this.arith(m[2])) : null, r.out, false);
      } else io.out.write(r.out);
      return r.status;
    },
    'read'(argv, io) {
      let raw = false, prompt = null, arrName = null, nchars = null, delim = '\n', silent = false;
      const vars = [];
      for (let i = 1; i < argv.length; i++) {
        const a = String(argv[i]);
        if (/^-[a-zA-Z]+$/.test(a) && !vars.length) {
          for (let k = 1; k < a.length; k++) {
            const ch = a[k];
            const takeArg = () => { const rest = a.slice(k + 1); k = a.length; if (rest) return rest; return argv[++i] != null ? String(argv[i]) : ''; };
            if (ch === 'r') raw = true;
            else if (ch === 's') silent = true;
            else if (ch === 'e') {}
            else if (ch === 'p') prompt = takeArg();
            else if (ch === 'a') arrName = takeArg();
            else if (ch === 'n' || ch === 'N') nchars = parseInt(takeArg(), 10);
            else if (ch === 'd') { const d = takeArg(); delim = d === '' ? '\0' : d[0]; }
            else if (ch === 't' || ch === 'i' || ch === 'u') takeArg();
            else { this.errMsg(io, 'read: -' + ch + ': invalid option'); io.err.write('read: usage: read [-ers] [-a array] [-d delim] [-n nchars] [-p prompt] [name ...]\n'); return 2; }
          }
          continue;
        }
        vars.push(a);
      }
      for (const v of vars) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) { this.errMsg(io, "read: `" + v + "': not a valid identifier"); return 1; }
      const inp = io.in || EMPTY_IN();
      let text = null, found = false;
      if (inp.atEOF() && inp.interactive && this.host && this.host.prompt) {
        if (prompt) io.err.write(prompt);
        const ans = this.host.prompt(prompt || '', io);
        if (ans == null) { io.err.write('\n'); }
        else {
          text = String(ans); found = true;
          if (!silent) io.err.write(text + '\n'); else io.err.write('\n');
        }
      } else {
        if (prompt && inp.interactive) io.err.write(prompt);
        if (nchars != null) {
          if (inp.atEOF()) text = null;
          else { const rest = inp.data.slice(inp.pos); const chars = Array.from(rest); let take = chars.slice(0, nchars); const dl = take.indexOf(delim); if (dl >= 0) { take = take.slice(0, dl); inp.pos += take.join('').length + 1; found = true; } else { inp.pos += take.join('').length; found = true; } text = take.join(''); }
        } else {
          let r = inp.readUntil(delim);
          if (r) {
            text = r.text; found = r.found;
            if (!raw) {
              while (/(^|[^\\])(\\\\)*\\$/.test(text) && found) {
                const r2 = inp.readUntil(delim);
                text = text.slice(0, -1);
                if (!r2) { found = false; break; }
                text += r2.text; found = r2.found;
              }
            }
          }
        }
      }
      const ifsV = this.getParam('IFS');
      const ifs = ifsV == null ? ' \t\n' : ifsV;
      if (text == null) {
        if (arrName) this.setArray(arrName, [], false);
        else if (vars.length) for (const v of vars) this.setVar(v, null, '', false);
        else this.setVar('REPLY', null, '', false);
        return 1;
      }
      const unesc = (s) => raw ? s : s.replace(/\\(.)/g, '$1');
      if (arrName) {
        const parts = splitAll(raw ? text : text, ifs).map(unesc);
        this.setArray(arrName, parts.map(p => ({ key: null, value: p })), false);
      } else if (!vars.length) {
        this.setVar('REPLY', null, unesc(text), false);
      } else {
        const parts = readSplit(text, ifs, vars.length);
        vars.forEach((v, k) => this.setVar(v, null, unesc(parts[k] != null ? parts[k] : ''), false));
      }
      return found ? 0 : 1;
    },
    'cd'(argv, io) {
      const args = argv.slice(1).filter(a => a !== '-L' && a !== '-P');
      if (args.length > 1) { this.errMsg(io, 'cd: too many arguments'); return 1; }
      let target = args[0];
      let print = false;
      if (target == null || target === '') { target = this.getStr('HOME'); }
      else if (target === '-') { target = this.getStr('OLDPWD'); if (!target) { this.errMsg(io, 'cd: OLDPWD not set'); return 1; } print = true; }
      const abs = this.resolve(target);
      let n;
      try { n = this.fs.lookup(abs); }
      catch (e) { this.errMsg(io, 'cd: ' + target + ': ' + e.message); return 1; }
      if (n.t !== 'd') { this.errMsg(io, 'cd: ' + target + ': Not a directory'); return 1; }
      if (!this.fs.can(n, 'x')) { this.errMsg(io, 'cd: ' + target + ': Permission denied'); return 1; }
      this.setVar('OLDPWD', null, this.cwd, false);
      this.cwd = abs;
      this.setVar('PWD', null, abs, false);
      if (print) io.out.write(abs + '\n');
      return 0;
    },
    'pwd'(argv, io) { io.out.write(this.cwd + '\n'); return 0; },
    'alias'(argv, io) {
      const args = argv.slice(1).map(String).filter(a => a !== '-p');
      const fmt = (k, v) => 'alias ' + k + "='" + v.replace(/'/g, "'\\''") + "'\n";
      if (!args.length) {
        for (const k of Array.from(this.aliases.keys()).sort()) io.out.write(fmt(k, this.aliases.get(k)));
        return 0;
      }
      let st = 0;
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq > 0) {
          const name = a.slice(0, eq);
          if (/[\s\/$`'"=<>|&;()]/.test(name)) { this.errMsg(io, "alias: `" + name + "': invalid alias name"); st = 1; continue; }
          this.aliases.set(name, a.slice(eq + 1));
        } else if (eq === 0) { this.errMsg(io, "alias: `" + a + "': invalid alias name"); st = 1; }
        else {
          if (this.aliases.has(a)) io.out.write(fmt(a, this.aliases.get(a)));
          else { this.errMsg(io, 'alias: ' + a + ': not found'); st = 1; }
        }
      }
      return st;
    },
    'unalias'(argv, io) {
      const args = argv.slice(1).map(String);
      if (!args.length) { this.errMsg(io, 'unalias: usage: unalias [-a] name [name ...]'); return 2; }
      if (args[0] === '-a') { this.aliases.clear(); return 0; }
      let st = 0;
      for (const a of args) { if (this.aliases.has(a)) this.aliases.delete(a); else { this.errMsg(io, 'unalias: ' + a + ': not found'); st = 1; } }
      return st;
    },
    'export'(argv, io) {
      const a = argv.slice(1);
      if (a[0] === '-n') {
        for (const n of a.slice(1)) { const o = this.getVarObj(String(n)); if (o) o.ex = false; }
        return 0;
      }
      return declare(this, 'export', argv, io);
    },
    'readonly'(argv, io) { return declare(this, 'readonly', argv, io); },
    'declare'(argv, io) { return declare(this, 'declare', argv, io); },
    'typeset'(argv, io) { return declare(this, 'declare', argv, io); },
    'local'(argv, io) { return declare(this, 'local', argv, io); },
    'unset'(argv, io) {
      let mode = 'v?';
      let st = 0;
      for (const a0 of argv.slice(1)) {
        const a = String(a0);
        if (a === '-f') { mode = 'f'; continue; }
        if (a === '-v') { mode = 'v'; continue; }
        if (mode === 'f') { this.functions.delete(a); continue; }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(a);
        if (!m) { this.errMsg(io, "unset: `" + a + "': not a valid identifier"); st = 1; continue; }
        const o = this.getVarObj(m[1]);
        if (!o) { if (mode === 'v?' && m[2] == null) this.functions.delete(m[1]); continue; }
        if (o.ro) { this.errMsg(io, 'unset: ' + m[1] + ': cannot unset: readonly variable'); st = 1; continue; }
        if (m[2] != null && m[2] !== '@' && m[2] !== '*') {
          if (o.map) o.map.delete(this.expandStr(m[2]));
          else if (o.arr) { let i = Number(this.arith(this.expandArithText(m[2]))); if (i < 0) { const ks = sortedKeys(o.arr); i = ks[ks.length - 1] + 1 + i; } o.arr.delete(i); }
          else if (Number(this.arith(m[2])) === 0) o.v = null;
          continue;
        }
        for (let k = this.scopes.length - 1; k >= 0; k--) { if (this.scopes[k].has(m[1])) { this.scopes[k].delete(m[1]); break; } }
      }
      return st;
    },
    'let'(argv, io) {
      if (argv.length < 2) { this.errMsg(io, 'let: expression expected'); return 1; }
      let v = 0n;
      for (const a of argv.slice(1)) v = this.arith(String(a));
      return v !== 0n ? 0 : 1;
    },
    'shift'(argv, io) {
      const n = argv[1] == null ? 1 : parseInt(argv[1], 10);
      if (isNaN(n) || n < 0) { this.errMsg(io, 'shift: ' + argv[1] + ': numeric argument required'); return 1; }
      if (n > this.positional.length) return 1;
      this.positional = this.positional.slice(n);
      return 0;
    },
    'set'(argv, io) {
      const a = argv.slice(1).map(String);
      if (!a.length) {
        const seen = new Map();
        for (const s of this.scopes) for (const [k, v] of s) seen.set(k, v);
        for (const k of Array.from(seen.keys()).sort()) {
          const o = seen.get(k);
          if (o.arr || o.map) io.out.write(declText(this, k, o).replace(/^declare -\S+ /, '') + '\n');
          else if (o.v != null) io.out.write(k + '=' + shQuote(o.v) + '\n');
        }
        for (const k of Array.from(this.functions.keys()).sort()) io.out.write(k + ' () \n' + this.functions.get(k).text + '\n');
        return 0;
      }
      const map = { x: 'xtrace', e: 'errexit', u: 'nounset', f: 'noglob' };
      for (let i = 0; i < a.length; i++) {
        const s = a[i];
        if (s === '--') { this.positional = a.slice(i + 1); return 0; }
        if (s === '-o' || s === '+o') {
          const name = a[++i];
          if (name == null) { for (const k of ['errexit', 'noglob', 'nounset', 'pipefail', 'xtrace']) io.out.write(k.padEnd(15) + '\t' + (this.opts[k] ? 'on' : 'off') + '\n'); return 0; }
          if (!(name in this.opts) || name === 'expand_aliases') { this.errMsg(io, 'set: ' + name + ': invalid option name'); return 1; }
          this.opts[name] = s === '-o';
          continue;
        }
        if (/^[-+][a-zA-Z]+$/.test(s)) {
          for (const ch of s.slice(1)) {
            if (map[ch]) this.opts[map[ch]] = s[0] === '-';
            else if ('vhmBHbkCnP'.indexOf(ch) < 0) { this.errMsg(io, 'set: -' + ch + ': invalid option'); return 2; }
          }
          continue;
        }
        this.positional = a.slice(i);
        return 0;
      }
      return 0;
    },
    'shopt'(argv, io) {
      const a = argv.slice(1).map(String);
      if (a[0] === '-s' || a[0] === '-u') { for (const n of a.slice(1)) if (n === 'expand_aliases') this.opts.expand_aliases = a[0] === '-s'; }
      return 0;
    },
    'source'(argv, io) {
      if (argv.length < 2) { this.errMsg(io, 'source: filename argument required'); io.err.write('source: usage: source filename [arguments]\n'); return 2; }
      return this.sourceFile(String(argv[1]), argv.slice(2).map(String), io);
    },
    '.'(argv, io) {
      if (argv.length < 2) { this.errMsg(io, '.: filename argument required'); io.err.write('.: usage: . filename [arguments]\n'); return 2; }
      return this.sourceFile(String(argv[1]), argv.slice(2).map(String), io);
    },
    'exit'(argv, io) {
      let code = this.status;
      if (argv[1] != null) {
        const s = String(argv[1]);
        if (!/^[+-]?[0-9]+$/.test(s.trim())) { this.errMsg(io, 'exit: ' + s + ': numeric argument required'); code = 2; }
        else code = Number(BigInt.asUintN(8, BigInt(s.trim())));
      }
      if (this.interactive && !this.srcName && this.subLevel === 0) io.err.write('exit\n');
      throw new ExitSig(code);
    },
    'logout'(argv, io) { throw new ExitSig(0); },
    'return'(argv, io) {
      if (!this.funcStack.length && !this.sourceDepth) { this.errMsg(io, "return: can only `return' from a function or sourced script"); return 1; }
      let code = this.status;
      if (argv[1] != null) {
        const s = String(argv[1]);
        if (!/^[+-]?[0-9]+$/.test(s.trim())) { this.errMsg(io, 'return: ' + s + ': numeric argument required'); code = 2; }
        else code = Number(BigInt.asUintN(8, BigInt(s.trim())));
      }
      throw new ReturnSig(code);
    },
    'break'(argv, io) { return loopCtl(this, argv, io, false); },
    'continue'(argv, io) { return loopCtl(this, argv, io, true); },
    'true'() { return 0; },
    'false'() { return 1; },
    ':'() { return 0; },
    'test'(argv, io) { return this.testCmd(argv.slice(1).map(String), io, 'test'); },
    '['(argv, io) {
      const a = argv.slice(1).map(String);
      if (a[a.length - 1] !== ']') {
        this.errMsg(io, "[: missing `]'");
        if (this.hints) io.err.write('\x1b[33m💡 Подсказка: перед закрывающей «]» нужен пробел\x1b[0m\n');
        return 2;
      }
      return this.testCmd(a.slice(0, -1), io, '[');
    },
    'type'(argv, io) {
      let st = 0;
      const args = argv.slice(1).map(String);
      const tOnly = args[0] === '-t'; const all = args[0] === '-a';
      for (const n of args.filter(x => !/^-[ta]$/.test(x))) {
        const res = [];
        if (this.aliases.has(n)) res.push(tOnly ? 'alias' : n + " is aliased to `" + this.aliases.get(n) + "'");
        if (KEYWORDS.has(n)) res.push(tOnly ? 'keyword' : n + ' is a shell keyword');
        if (this.functions.has(n)) res.push(tOnly ? 'function' : n + ' is a function\n' + n + ' () \n' + this.functions.get(n).text);
        if (BUILTINS[n]) res.push(tOnly ? 'builtin' : n + ' is a shell builtin');
        if (BS.COMMANDS[n]) res.push(tOnly ? 'file' : (this.hashed && this.hashed.has(n) && !all ? n + ' is hashed (/usr/bin/' + n + ')' : n + ' is /usr/bin/' + n));
        else { const p = n.indexOf('/') >= 0 ? (this.fs.isFile(this.resolve(n)) ? n : null) : this.findInPath(n); if (p) res.push(tOnly ? 'file' : n + ' is ' + p); }
        if (!res.length) { if (!tOnly) this.errMsg(io, 'type: ' + n + ': not found'); st = 1; continue; }
        io.out.write((all ? res : res.slice(0, 1)).join('\n') + '\n');
      }
      return st;
    },
    'command'(argv, io) {
      const a = argv.slice(1).map(String);
      if (a[0] === '-v' || a[0] === '-V') {
        let st = 0;
        for (const n of a.slice(1)) {
          if (this.aliases.has(n)) io.out.write("alias " + n + "='" + this.aliases.get(n) + "'\n");
          else if (this.functions.has(n) || BUILTINS[n] || KEYWORDS.has(n)) io.out.write(n + '\n');
          else if (BS.COMMANDS[n]) io.out.write('/usr/bin/' + n + '\n');
          else { const p = this.findInPath(n); if (p) io.out.write(p + '\n'); else st = 1; }
        }
        return st;
      }
      if (!a.length) return 0;
      return this.invoke(a, io, true);
    },
    'builtin'(argv, io) {
      const n = String(argv[1] || '');
      if (!BUILTINS[n]) { this.errMsg(io, 'builtin: ' + n + ': not a shell builtin'); return 1; }
      return BUILTINS[n].call(this, argv.slice(1), io);
    },
    'eval'(argv, io) {
      const text = argv.slice(1).map(a => typeof a === 'string' ? a : a.assignRaw).join(' ');
      if (!text.trim()) return 0;
      return this.evalText(text, io);
    },
    'history'(argv, io) {
      const a = argv.slice(1).map(String);
      if (a[0] === '-c') { this.history.length = 0; return 0; }
      let list = this.history.map((h, i) => ({ n: i + 1, h }));
      if (a[0] && /^\d+$/.test(a[0])) list = list.slice(-parseInt(a[0], 10));
      for (const x of list) io.out.write(String(x.n).padStart(5) + '  ' + x.h + '\n');
      return 0;
    },
    'help'(argv, io) { io.out.write(HELP_TEXT); return 0; },
    'mapfile'(argv, io) { return mapfile(this, argv, io); },
    'readarray'(argv, io) { return mapfile(this, argv, io); },
    'hash'() { return 0; }, 'wait'() { return 0; }, 'trap'() { return 0; }, 'ulimit'(argv, io) { io.out.write('unlimited\n'); return 0; },
    'umask'(argv, io) { if (argv.length < 2) io.out.write('0002\n'); return 0; },
    'jobs'() { return 0; }, 'disown'() { return 0; }, 'times'(argv, io) { io.out.write('0m0.010s 0m0.004s\n0m0.000s 0m0.000s\n'); return 0; },
    'getopts'(argv, io) { return getopts(this, argv, io); },
    'exec'(argv, io) {
      if (argv.length < 2) return 0;
      const st = this.invoke(argv.slice(1).map(String), io);
      throw new ExitSig(st);
    },
    'enable'() { return 0; }, 'caller'(argv, io) { return 1; },
    'pushd'(argv, io) { this.dirStack = this.dirStack || []; const old = this.cwd; const r = BUILTINS.cd.call(this, ['cd', argv[1] || this.getStr('HOME')], io); if (r === 0) { this.dirStack.unshift(old); io.out.write([this.cwd].concat(this.dirStack).map(d => d.replace(this.home, '~')).join(' ') + '\n'); } return r; },
    'popd'(argv, io) { this.dirStack = this.dirStack || []; if (!this.dirStack.length) { this.errMsg(io, 'popd: directory stack empty'); return 1; } const d = this.dirStack.shift(); const r = BUILTINS.cd.call(this, ['cd', d], io); io.out.write([this.cwd].concat(this.dirStack).map(x => x.replace(this.home, '~')).join(' ') + '\n'); return r; },
    'dirs'(argv, io) { io.out.write([this.cwd].concat(this.dirStack || []).map(x => x.replace(this.home, '~')).join(' ') + '\n'); return 0; },
  };
  function loopCtl(sh, argv, io, cont) {
    const name = cont ? 'continue' : 'break';
    let n = 1;
    if (argv[1] != null) {
      n = parseInt(String(argv[1]), 10);
      if (isNaN(n)) { sh.errMsg(io, name + ': ' + argv[1] + ': numeric argument required'); return 1; }
      if (n < 1) { sh.errMsg(io, name + ': ' + argv[1] + ': loop count out of range'); return 1; }
    }
    if (sh.loopDepth === 0) { sh.errMsg(io, name + ": only meaningful in a `for', `while', or `until' loop"); return 0; }
    throw new BreakSig(Math.min(n, sh.loopDepth), cont);
  }
  function mapfile(sh, argv, io) {
    let strip = false, name = 'MAPFILE';
    const a = argv.slice(1).map(String);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-t') strip = true;
      else if (a[i] === '-d' || a[i] === '-n' || a[i] === '-s' || a[i] === '-u' || a[i] === '-O' || a[i] === '-c' || a[i] === '-C') i++;
      else name = a[i];
    }
    const data = (io.in || EMPTY_IN()).readAll();
    const lines = data === '' ? [] : data.split(/(?<=\n)/);
    sh.setArray(name, lines.map(l => ({ key: null, value: strip ? l.replace(/\n$/, '') : l })), false);
    return 0;
  }
  function getopts(sh, argv, io) {
    const spec = String(argv[1] || ''), name = String(argv[2] || '');
    const args = argv.length > 3 ? argv.slice(3).map(String) : sh.positional;
    let ind = parseInt(sh.getStr('OPTIND') || '1', 10);
    sh.optPos = sh.optPos || 1;
    if (ind > args.length) { sh.setVar(name, null, '?', false); return 1; }
    const cur = args[ind - 1];
    if (!cur || cur[0] !== '-' || cur === '-' ) { sh.setVar(name, null, '?', false); return 1; }
    if (cur === '--') { sh.setVar('OPTIND', null, String(ind + 1), false); sh.setVar(name, null, '?', false); return 1; }
    const ch = cur[sh.optPos];
    const k = spec.indexOf(ch);
    const advance = () => { if (sh.optPos + 1 >= cur.length) { sh.optPos = 1; ind++; } else sh.optPos++; };
    if (k < 0 || ch === ':') {
      if (spec[0] !== ':') sh.errMsg(io, 'illegal option -- ' + ch);
      sh.setVar(name, null, '?', false);
      advance(); sh.setVar('OPTIND', null, String(ind), false);
      return 0;
    }
    if (spec[k + 1] === ':') {
      let val;
      if (sh.optPos + 1 < cur.length) { val = cur.slice(sh.optPos + 1); }
      else { val = args[ind]; ind++; }
      ind++; sh.optPos = 1;
      if (val == null) { sh.errMsg(io, 'option requires an argument -- ' + ch); sh.setVar(name, null, '?', false); sh.setVar('OPTIND', null, String(ind), false); return 0; }
      sh.setVar('OPTARG', null, val, false);
    } else advance();
    sh.setVar(name, null, ch, false);
    sh.setVar('OPTIND', null, String(ind), false);
    return 0;
  }

  BS.Shell = Shell;
  BS.BUILTINS = BUILTINS;
  BS.KEYWORDS = KEYWORDS;
  BS.sig = { ExitSig, ReturnSig, BreakSig, FatalError, ShellError };
  BS.io = { OutBuf, NullOut, FileOut, InStream };
  BS.util = { patMatch, globToRe, posixToJs, shQuote, echoEscapes, printfFormat, hasGlob, bracket, CLASSES, globEscape };
})(globalThis.BS = globalThis.BS || {});
