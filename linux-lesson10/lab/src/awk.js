/* Упрощённый awk для учебного симулятора. */
(function (BS) {
  'use strict';

  const KW = new Set(['BEGIN', 'END', 'if', 'else', 'while', 'for', 'do', 'in', 'next', 'exit', 'print', 'printf', 'delete', 'break', 'continue', 'getline', 'function', 'return']);
  const FUNCS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'tolower', 'toupper', 'int', 'sqrt', 'exp', 'log', 'sin', 'cos', 'atan2', 'rand', 'srand', 'system']);

  class AwkErr extends Error {}
  class NextSig {}
  class ExitSig { constructor(c) { this.code = c; } }
  class BrkSig { constructor(c) { this.cont = c; } }

  function lex(src) {
    const t = [];
    let i = 0;
    const last = () => t.length ? t[t.length - 1] : null;
    const regexAllowed = () => {
      const p = last();
      if (!p) return true;
      if (p.k === 'num' || p.k === 'str' || p.k === 'name' || p.k === 'func' && false) return false;
      if (p.k === 'op' && (p.v === ')' || p.v === ']' || p.v === '$' || p.v === '++' || p.v === '--')) return false;
      if (p.k === 'name' || p.k === 'builtin') return false;
      return true;
    };
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '\n') { t.push({ k: 'nl' }); i++; continue; }
      if (/[0-9.]/.test(c) && /[0-9.]/.test(src[i + 1] || '') || /[0-9]/.test(c)) {
        const m = /^(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(src.slice(i));
        if (m) { t.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      }
      if (c === '"') {
        let s = ''; i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') { const n = src[i + 1]; s += ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b' })[n] != null ? ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b' })[n] : '\\' + n; i += 2; continue; }
          s += src[i++];
        }
        if (src[i] !== '"') throw new AwkErr('non-terminated string');
        i++; t.push({ k: 'str', v: s }); continue;
      }
      if (c === '/' && regexAllowed()) {
        let s = ''; i++;
        while (i < src.length && src[i] !== '/') { if (src[i] === '\\' && src[i + 1] === '/') { s += '/'; i += 2; continue; } if (src[i] === '\\') { s += src[i] + src[i + 1]; i += 2; continue; } s += src[i++]; }
        if (src[i] !== '/') throw new AwkErr('non-terminated regular expression');
        i++; t.push({ k: 're', v: s }); continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        const w = m[0]; i += w.length;
        if (KW.has(w)) t.push({ k: 'kw', v: w });
        else if (FUNCS.has(w)) t.push({ k: 'builtin', v: w });
        else t.push({ k: 'name', v: w });
        continue;
      }
      const ops = ['+=', '-=', '*=', '/=', '%=', '^=', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '!~', '>>', '**'];
      let op = ops.find(o => src.startsWith(o, i));
      if (!op && '{}()[];,+-*/%^!><|?:~$='.indexOf(c) >= 0) op = c;
      if (!op) throw new AwkErr('syntax error at source line 1: unexpected character ' + c);
      t.push({ k: 'op', v: op === '**' ? '^' : op }); i += op.length;
    }
    t.push({ k: 'eof' });
    return t;
  }

  function parse(src) {
    const T = lex(src);
    let k = 0;
    const peek = () => T[k];
    const isOp = (v) => T[k].k === 'op' && T[k].v === v;
    const isKw = (v) => T[k].k === 'kw' && T[k].v === v;
    const expectOp = (v) => { if (!isOp(v)) throw new AwkErr('syntax error: expected ' + v); k++; };
    const skipNl = () => { while (T[k].k === 'nl' || isOp(';')) k++; };
    const skipNlOnly = () => { while (T[k].k === 'nl') k++; };
    const rules = [];
    skipNl();
    while (T[k].k !== 'eof') {
      let pat = null, kind = 'main';
      if (isKw('BEGIN')) { kind = 'begin'; k++; }
      else if (isKw('END')) { kind = 'end'; k++; }
      else if (!isOp('{')) {
        pat = expr();
        if (isOp(',')) { k++; skipNlOnly(); pat = { t: 'range', a: pat, b: expr(), on: false }; }
      }
      let body = null;
      if (isOp('{')) body = block();
      rules.push({ kind, pat, body });
      skipNl();
    }
    return rules;

    function block() {
      expectOp('{');
      const stmts = [];
      skipNl();
      while (!isOp('}')) { if (T[k].k === 'eof') throw new AwkErr('syntax error: missing }'); stmts.push(stmt()); skipNl(); }
      k++;
      return { t: 'block', stmts };
    }
    function simpleEnd() { if (isOp(';') || T[k].k === 'nl') { k++; return; } if (isOp('}') || T[k].k === 'eof') return; }
    function stmt() {
      if (isOp('{')) return block();
      if (isOp(';')) { k++; return { t: 'block', stmts: [] }; }
      if (isKw('if')) {
        k++; expectOp('('); const c = expr(); expectOp(')'); skipNlOnly();
        const th = stmt();
        const save = k; skipNl();
        if (isKw('else')) { k++; skipNlOnly(); return { t: 'if', c, th, el: stmt() }; }
        k = save;
        return { t: 'if', c, th, el: null };
      }
      if (isKw('while')) { k++; expectOp('('); const c = expr(); expectOp(')'); skipNlOnly(); return { t: 'while', c, body: stmt() }; }
      if (isKw('do')) { k++; skipNlOnly(); const body = stmt(); skipNl(); if (!isKw('while')) throw new AwkErr('syntax error: expected while'); k++; expectOp('('); const c = expr(); expectOp(')'); simpleEnd(); return { t: 'do', c, body }; }
      if (isKw('for')) {
        k++; expectOp('(');
        if (T[k].k === 'name' && T[k + 1].k === 'kw' && T[k + 1].v === 'in' && T[k + 3] && T[k + 3].k === 'op' && T[k + 3].v === ')') {
          const v = T[k].v; const arr = T[k + 2].v; k += 4; skipNlOnly();
          return { t: 'forin', v, arr, body: stmt() };
        }
        const init = isOp(';') ? null : simpleStmt(); expectOp(';'); skipNlOnly();
        const c = isOp(';') ? null : expr(); expectOp(';'); skipNlOnly();
        const step = isOp(')') ? null : simpleStmt(); expectOp(')'); skipNlOnly();
        return { t: 'for', init, c, step, body: stmt() };
      }
      if (isKw('next')) { k++; simpleEnd(); return { t: 'next' }; }
      if (isKw('break')) { k++; simpleEnd(); return { t: 'break' }; }
      if (isKw('continue')) { k++; simpleEnd(); return { t: 'continue' }; }
      if (isKw('exit')) { k++; let e = null; if (!isOp(';') && !isOp('}') && T[k].k !== 'nl' && T[k].k !== 'eof') e = expr(); simpleEnd(); return { t: 'exit', e }; }
      if (isKw('delete')) { k++; const name = T[k++].v; let idx = null; if (isOp('[')) { k++; idx = exprList(); expectOp(']'); } simpleEnd(); return { t: 'delete', name, idx }; }
      const s = simpleStmt();
      simpleEnd();
      return s;
    }
    function simpleStmt() {
      if (isKw('print') || isKw('printf')) {
        const kind = T[k++].v;
        let args = [];
        const paren = isOp('(');
        if (!isOp(';') && !isOp('}') && T[k].k !== 'nl' && T[k].k !== 'eof' && !isOp('>') && !isOp('>>') && !isOp('|')) {
          if (paren) {
            const save = k;
            k++;
            try { args = exprList(true); expectOp(')'); if (!(isOp(';') || isOp('}') || T[k].k === 'nl' || T[k].k === 'eof' || isOp('>') || isOp('>>'))) { k = save; args = exprList(true); } }
            catch (e) { k = save; args = exprList(true); }
          } else args = exprList(true);
        }
        let redir = null;
        if (isOp('>') || isOp('>>')) { const op = T[k++].v; redir = { op, e: concat(true) }; }
        return { t: kind, args, redir };
      }
      return { t: 'expr', e: expr() };
    }
    function exprList(noGt) {
      const l = [expr(noGt)];
      while (isOp(',')) { k++; skipNlOnly(); l.push(expr(noGt)); }
      return l;
    }
    function expr(noGt) { return ternary(noGt); }
    function ternary(noGt) {
      const c = or(noGt);
      if (isOp('?')) { k++; skipNlOnly(); const a = ternary(noGt); skipNlOnly(); expectOp(':'); skipNlOnly(); const b = ternary(noGt); return { t: '?', c, a, b }; }
      if (T[k].k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(T[k].v) && isLval(c)) { const op = T[k++].v; skipNlOnly(); return { t: 'asg', op, lv: c, e: ternary(noGt) }; }
      return c;
    }
    function isLval(n) { return n.t === 'var' || n.t === 'field' || n.t === 'idx'; }
    function or(noGt) { let l = and(noGt); while (isOp('||')) { k++; skipNlOnly(); l = { t: '||', a: l, b: and(noGt) }; } return l; }
    function and(noGt) { let l = inExpr(noGt); while (isOp('&&')) { k++; skipNlOnly(); l = { t: '&&', a: l, b: inExpr(noGt) }; } return l; }
    function inExpr(noGt) { let l = match(noGt); while (isKw('in')) { k++; l = { t: 'in', key: l, arr: T[k++].v }; } return l; }
    function match(noGt) { let l = cmp(noGt); while (isOp('~') || isOp('!~')) { const op = T[k++].v; l = { t: op, a: l, b: cmp(noGt) }; } return l; }
    function cmp(noGt) {
      let l = concat(noGt);
      while (T[k].k === 'op' && ['<', '<=', '==', '!=', '>=', '>'].includes(T[k].v) && !(noGt && T[k].v === '>')) { const op = T[k++].v; l = { t: 'cmp', op, a: l, b: concat(noGt) }; }
      return l;
    }
    function startsOperand() {
      const x = T[k];
      if (x.k === 'num' || x.k === 'str' || x.k === 're' || x.k === 'name' || x.k === 'builtin') return true;
      if (x.k === 'op' && (x.v === '$' || x.v === '!' || x.v === '(' || x.v === '++' || x.v === '--')) return true;
      return false;
    }
    function concat(noGt) {
      let l = add();
      while (startsOperand() && !(T[k].k === 'kw')) { l = { t: 'cat', a: l, b: add() }; }
      return l;
    }
    function add() { let l = mul(); while (isOp('+') || isOp('-')) { const op = T[k++].v; l = { t: 'bin', op, a: l, b: mul() }; } return l; }
    function mul() { let l = unary(); while (isOp('*') || isOp('/') || isOp('%')) { const op = T[k++].v; l = { t: 'bin', op, a: l, b: unary() }; } return l; }
    function unary() {
      if (isOp('!')) { k++; return { t: '!', e: unary() }; }
      if (isOp('-')) { k++; return { t: 'neg', e: unary() }; }
      if (isOp('+')) { k++; return { t: 'num', e: unary() }; }
      return pow();
    }
    function pow() { const b = postfix(); if (isOp('^')) { k++; return { t: 'bin', op: '^', a: b, b: unary() }; } return b; }
    function postfix() {
      if (isOp('++') || isOp('--')) { const op = T[k++].v; return { t: 'pre', op, lv: postfix() }; }
      const p = primary();
      if (isLval(p) && (isOp('++') || isOp('--'))) { const op = T[k++].v; return { t: 'post', op, lv: p }; }
      return p;
    }
    function primary() {
      const x = T[k++];
      if (x.k === 'num') return { t: 'lit', v: x.v };
      if (x.k === 'str') return { t: 'lit', v: x.v, str: true };
      if (x.k === 're') return { t: 're', v: x.v };
      if (x.k === 'op' && x.v === '$') { const e = primaryNoPost(); return { t: 'field', e }; }
      if (x.k === 'op' && x.v === '(') { const e = expr(); if (isOp(',')) { const l = [e]; while (isOp(',')) { k++; l.push(expr()); } expectOp(')'); return { t: 'group', l }; } expectOp(')'); return e; }
      if (x.k === 'builtin') {
        const name = x.v;
        if (!isOp('(')) { if (name === 'length') return { t: 'call', name, args: [] }; throw new AwkErr('syntax error near ' + name); }
        k++;
        const args = isOp(')') ? [] : exprList();
        expectOp(')');
        return { t: 'call', name, args };
      }
      if (x.k === 'name') {
        if (isOp('[')) { k++; const idx = exprList(); expectOp(']'); return { t: 'idx', name: x.v, idx }; }
        return { t: 'var', name: x.v };
      }
      throw new AwkErr('syntax error at source line 1');
    }
    function primaryNoPost() {
      if (isOp('(')) { k++; const e = expr(); expectOp(')'); return e; }
      if (isOp('$')) { k++; return { t: 'field', e: primaryNoPost() }; }
      if (isOp('-')) { k++; return { t: 'neg', e: primaryNoPost() }; }
      if (isOp('++') || isOp('--')) { const op = T[k++].v; return { t: 'pre', op, lv: primary() }; }
      return primary();
    }
  }

  function numStr(v) {
    if (typeof v === 'string') return v;
    if (Number.isInteger(v)) return String(v);
    let s = v.toPrecision(6);
    if (s.indexOf('e') < 0 && s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    else if (s.indexOf('e') >= 0) s = s.replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2');
    return s;
  }
  function toNum(v) {
    if (typeof v === 'number') return v;
    const m = /^\s*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(v);
    return m ? parseFloat(m[0]) : 0;
  }
  function looksNum(v) { return typeof v === 'number' || /^\s*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)\s*$/.test(v); }

  function awkSprintf(fmt, args) {
    let ai = 0;
    return fmt.replace(/%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([diouxXfFeEgGcs%])/g, (m, fl, w, p, c) => {
      if (c === '%') return '%';
      if (w === '*') w = String(toNum(args[ai++]));
      if (p === '*') p = String(toNum(args[ai++]));
      const a = args[ai++];
      const width = w != null ? parseInt(w, 10) : null;
      const prec = p != null ? parseInt(p, 10) : null;
      let s;
      const left = fl.indexOf('-') >= 0, zero = fl.indexOf('0') >= 0;
      switch (c) {
        case 'd': case 'i': { const v = Math.trunc(toNum(a === undefined ? 0 : a)); s = String(Math.abs(v)); if (v < 0) s = '-' + s; else if (fl.indexOf('+') >= 0) s = '+' + s; break; }
        case 'o': s = Math.trunc(toNum(a || 0)).toString(8); break;
        case 'x': s = Math.trunc(toNum(a || 0)).toString(16); break;
        case 'X': s = Math.trunc(toNum(a || 0)).toString(16).toUpperCase(); break;
        case 'u': s = String(Math.trunc(toNum(a || 0))); break;
        case 'f': case 'F': s = toNum(a || 0).toFixed(prec == null ? 6 : prec); if (fl.indexOf('+') >= 0 && toNum(a || 0) >= 0) s = '+' + s; break;
        case 'e': case 'E': s = toNum(a || 0).toExponential(prec == null ? 6 : prec).replace(/e([+-])(\d)$/, 'e$10$2'); if (c === 'E') s = s.toUpperCase(); break;
        case 'g': case 'G': s = numStr(toNum(a || 0)); break;
        case 'c': s = typeof a === 'number' ? String.fromCharCode(a) : String(a == null ? '' : a)[0] || ''; break;
        case 's': s = a == null ? '' : numStr(a); if (prec != null) s = s.slice(0, prec); break;
      }
      if (width != null && Array.from(s).length < width) {
        const padN = width - Array.from(s).length;
        if (left) s = s + ' '.repeat(padN);
        else if (zero && /[dioxXufFeE]/.test(c)) { const sign = /^[+-]/.test(s) ? s[0] : ''; s = sign + '0'.repeat(padN) + s.slice(sign.length); }
        else s = ' '.repeat(padN) + s;
      }
      return s;
    }).replace(/\\n/g, '\n');
  }

  function run(sh, argv, io) {
    const name = argv[0];
    let fs = ' ';
    const assigns = [];
    let i = 1;
    let prog = null;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-F') { fs = argv[++i]; continue; }
      if (a.startsWith('-F')) { fs = a.slice(2); continue; }
      if (a === '-v') { assigns.push(argv[++i]); continue; }
      if (a.startsWith('-v') && a.length > 2) { assigns.push(a.slice(2)); continue; }
      if (a === '--') { i++; break; }
      if (a === '-f') { io.err.write(name + ': -f не поддерживается в симуляторе\n'); return 2; }
      break;
    }
    if (fs === '\\t' || fs === 't') fs = '\t';
    prog = argv[i++];
    if (prog == null) { io.err.write('usage: ' + name + " [-F fs][-v var=value] 'prog' [file ...]\n"); return 2; }
    const files = argv.slice(i);
    let rules;
    try { rules = parse(prog); }
    catch (e) { io.err.write(name + ': ' + e.message + '\n' + name + ': source line number 1\n'); return 2; }

    const V = new Map();
    const A = new Map();
    V.set('FS', fs); V.set('OFS', ' '); V.set('ORS', '\n'); V.set('NR', 0); V.set('NF', 0); V.set('FNR', 0); V.set('FILENAME', ''); V.set('SUBSEP', '\x1c'); V.set('RSTART', 0); V.set('RLENGTH', -1);
    for (const a of assigns) { const eq = a.indexOf('='); if (eq > 0) V.set(a.slice(0, eq), BS.util.echoEscapes(a.slice(eq + 1)).s); }
    let fields = [''];
    let out = '';
    const outFiles = new Map();
    const reCache = new Map();
    const toRe = (s) => { let r = reCache.get(s); if (!r) { r = new RegExp(BS.util.posixToJs(s, false)); reCache.set(s, r); } return r; };
    const splitRec = (s, sep) => {
      if (sep === ' ') return s.split(/[ \t\n]+/).filter((x, k, arr) => !(x === '' && (k === 0 || k === arr.length - 1)));
      if (s === '') return [];
      if (sep.length === 1 && sep !== '\\') return s.split(sep);
      return s.split(new RegExp(BS.util.posixToJs(sep, false)));
    };
    const setRecord = (s) => { const f = splitRec(s, String(V.get('FS'))); fields = [s].concat(f); V.set('NF', f.length); };
    const rebuild = () => { const nf = toNum(V.get('NF')); fields.length = nf + 1; for (let k = 1; k <= nf; k++) if (fields[k] == null) fields[k] = ''; fields[0] = fields.slice(1).join(String(V.get('OFS'))); };
    const getField = (n) => { if (n < 0) throw new AwkErr('trying to access out of range field ' + n); return fields[n] == null ? '' : fields[n]; };
    const setField = (n, v) => { if (n === 0) { setRecord(String(v)); return; } fields[n] = numStr(v); if (n > toNum(V.get('NF'))) V.set('NF', n); rebuild(); };
    const keyOf = (idx) => idx.map(e => numStr(ev(e))).join(String(V.get('SUBSEP')));
    const arr = (n) => { let m = A.get(n); if (!m) { m = new Map(); A.set(n, m); } return m; };
    const getLv = (lv) => {
      if (lv.t === 'var') return V.has(lv.name) ? V.get(lv.name) : '';
      if (lv.t === 'field') return getField(Math.trunc(toNum(ev(lv.e))));
      const m = arr(lv.name); const k = keyOf(lv.idx); if (!m.has(k)) m.set(k, ''); return m.get(k);
    };
    const setLv = (lv, v) => {
      if (lv.t === 'var') { V.set(lv.name, v); if (lv.name === 'NF') rebuild(); return v; }
      if (lv.t === 'field') { setField(Math.trunc(toNum(ev(lv.e))), v); return v; }
      arr(lv.name).set(keyOf(lv.idx), v); return v;
    };
    const truthy = (v, node) => {
      if (typeof v === 'number') return v !== 0;
      if (node && (node.t === 'lit' && node.str)) return v !== '';
      if (looksNum(v) && node && (node.t === 'field' || node.t === 'var' || node.t === 'idx')) return toNum(v) !== 0;
      return v !== '';
    };
    let steps = 0;
    function ev(n) {
      switch (n.t) {
        case 'lit': return n.v;
        case 're': return toRe(n.v).test(fields[0]) ? 1 : 0;
        case 'var': {
          if (n.name === 'NR' || n.name === 'NF' || n.name === 'FNR') return toNum(V.get(n.name));
          return V.has(n.name) ? V.get(n.name) : '';
        }
        case 'field': return getField(Math.trunc(toNum(ev(n.e))));
        case 'idx': return getLv(n);
        case 'group': return n.l.map(e => numStr(ev(e))).join(String(V.get('SUBSEP')));
        case 'asg': {
          let v = ev(n.e);
          if (n.op !== '=') { const o = toNum(getLv(n.lv)); const r = toNum(v); v = { '+=': o + r, '-=': o - r, '*=': o * r, '/=': (() => { if (r === 0) throw new AwkErr('division by zero in /='); return o / r; })(), '%=': o % r, '^=': Math.pow(o, r) }[n.op]; }
          return setLv(n.lv, v);
        }
        case 'pre': { const v = toNum(getLv(n.lv)) + (n.op === '++' ? 1 : -1); setLv(n.lv, v); return v; }
        case 'post': { const v = toNum(getLv(n.lv)); setLv(n.lv, v + (n.op === '++' ? 1 : -1)); return v; }
        case '?': return truthy(ev(n.c), n.c) ? ev(n.a) : ev(n.b);
        case '||': return truthy(ev(n.a), n.a) || truthy(ev(n.b), n.b) ? 1 : 0;
        case '&&': return truthy(ev(n.a), n.a) && truthy(ev(n.b), n.b) ? 1 : 0;
        case '!': return truthy(ev(n.e), n.e) ? 0 : 1;
        case 'neg': return -toNum(ev(n.e));
        case 'num': return toNum(ev(n.e));
        case 'in': return arr(n.arr).has(n.key.t === 'group' ? keyOf(n.key.l) : numStr(ev(n.key))) ? 1 : 0;
        case '~': case '!~': {
          const s = numStr(ev(n.a));
          const re = n.b.t === 're' ? toRe(n.b.v) : toRe(numStr(ev(n.b)));
          const r = re.test(s);
          return (n.t === '~' ? r : !r) ? 1 : 0;
        }
        case 'cmp': {
          const a = ev(n.a), b = ev(n.b);
          const strCmp = (n.a.t === 'lit' && n.a.str) || (n.b.t === 'lit' && n.b.str) || !(looksNum(a) && looksNum(b));
          let c;
          if (strCmp) { const x = numStr(a), y = numStr(b); c = x < y ? -1 : x > y ? 1 : 0; }
          else { const x = toNum(a), y = toNum(b); c = x < y ? -1 : x > y ? 1 : 0; }
          return ({ '<': c < 0, '<=': c <= 0, '==': c === 0, '!=': c !== 0, '>=': c >= 0, '>': c > 0 }[n.op]) ? 1 : 0;
        }
        case 'cat': return numStr(ev(n.a)) + numStr(ev(n.b));
        case 'bin': {
          const a = toNum(ev(n.a)), b = toNum(ev(n.b));
          switch (n.op) {
            case '+': return a + b; case '-': return a - b; case '*': return a * b;
            case '/': if (b === 0) throw new AwkErr('division by zero'); return a / b;
            case '%': if (b === 0) throw new AwkErr('division by zero in %'); return a % b;
            case '^': return Math.pow(a, b);
          }
          break;
        }
        case 'call': return call(n);
      }
      throw new AwkErr('internal error');
    }
    function call(n) {
      const a = n.args;
      const s0 = () => numStr(a.length ? ev(a[0]) : fields[0]);
      switch (n.name) {
        case 'length': if (a.length && a[0].t === 'var' && A.has(a[0].name)) return A.get(a[0].name).size; return Array.from(s0()).length;
        case 'substr': { const s = Array.from(numStr(ev(a[0]))); let m = Math.round(toNum(ev(a[1]))); let len = a.length > 2 ? Math.round(toNum(ev(a[2]))) : Infinity; let st = m < 1 ? 1 : m; let en = len === Infinity ? s.length + 1 : m + len; if (en > s.length + 1) en = s.length + 1; return st >= en ? '' : s.slice(st - 1, en - 1).join(''); }
        case 'index': { const s = numStr(ev(a[0])), t = numStr(ev(a[1])); return Array.from(s.slice(0, Math.max(0, s.indexOf(t)))).length + (s.indexOf(t) >= 0 ? 1 : 0) || 0; }
        case 'split': { const s = numStr(ev(a[0])); const name = a[1].name; const sep = a.length > 2 ? (a[2].t === 're' ? a[2].v : numStr(ev(a[2]))) : String(V.get('FS')); const parts = splitRec(s, sep); const m = arr(name); m.clear(); parts.forEach((p, k) => m.set(String(k + 1), p)); return parts.length; }
        case 'sub': case 'gsub': {
          const re = a[0].t === 're' ? a[0].v : numStr(ev(a[0]));
          const repl = numStr(ev(a[1]));
          const lv = a[2] || { t: 'field', e: { t: 'lit', v: 0 } };
          const target = numStr(getLv(lv));
          let cnt = 0;
          const r = new RegExp(BS.util.posixToJs(re, false), n.name === 'gsub' ? 'g' : '');
          const res = target.replace(r, (m) => { cnt++; return repl.replace(/\\&|&/g, (x) => x === '&' ? m : '&'); });
          if (cnt) setLv(lv, res);
          return cnt;
        }
        case 'match': { const s = numStr(ev(a[0])); const re = a[1].t === 're' ? a[1].v : numStr(ev(a[1])); const m = new RegExp(BS.util.posixToJs(re, false)).exec(s); if (m) { V.set('RSTART', m.index + 1); V.set('RLENGTH', m[0].length); return m.index + 1; } V.set('RSTART', 0); V.set('RLENGTH', -1); return 0; }
        case 'sprintf': return awkSprintf(numStr(ev(a[0])), a.slice(1).map(ev));
        case 'tolower': return s0().toLowerCase();
        case 'toupper': return s0().toUpperCase();
        case 'int': return Math.trunc(toNum(ev(a[0])));
        case 'sqrt': return Math.sqrt(toNum(ev(a[0])));
        case 'exp': return Math.exp(toNum(ev(a[0])));
        case 'log': return Math.log(toNum(ev(a[0])));
        case 'sin': return Math.sin(toNum(ev(a[0])));
        case 'cos': return Math.cos(toNum(ev(a[0])));
        case 'atan2': return Math.atan2(toNum(ev(a[0])), toNum(ev(a[1])));
        case 'rand': return Math.random();
        case 'srand': return 0;
        case 'system': throw new AwkErr('system() недоступна в симуляторе');
      }
      return '';
    }
    const emit = (s, redir) => {
      if (!redir) { out += s; return; }
      const f = numStr(ev(redir.e));
      if (!outFiles.has(f)) { outFiles.set(f, ''); if (redir.op === '>>') { try { outFiles.set(f, sh.fs.readFile(sh.resolve(f))); } catch (e) { } } }
      outFiles.set(f, outFiles.get(f) + s);
    };
    function exec(s) {
      if ((++steps & 1023) === 0) sh.tick();
      switch (s.t) {
        case 'block': for (const x of s.stmts) exec(x); return;
        case 'expr': ev(s.e); return;
        case 'print': {
          const parts = s.args.length ? s.args.map(e => { const v = ev(e); return typeof v === 'number' ? numStr(v) : v; }) : [fields[0]];
          emit(parts.join(String(V.get('OFS'))) + String(V.get('ORS')), s.redir);
          return;
        }
        case 'printf': { if (!s.args.length) throw new AwkErr('printf: no format'); emit(awkSprintf(numStr(ev(s.args[0])), s.args.slice(1).map(ev)), s.redir); return; }
        case 'if': if (truthy(ev(s.c), s.c)) exec(s.th); else if (s.el) exec(s.el); return;
        case 'while': while (truthy(ev(s.c), s.c)) { sh.tick(); try { exec(s.body); } catch (e) { if (e instanceof BrkSig) { if (e.cont) continue; break; } throw e; } } return;
        case 'do': do { sh.tick(); try { exec(s.body); } catch (e) { if (e instanceof BrkSig) { if (e.cont) continue; break; } throw e; } } while (truthy(ev(s.c), s.c)); return;
        case 'for': for (s.init && exec(s.init); s.c ? truthy(ev(s.c), s.c) : true; s.step && exec(s.step)) { sh.tick(); try { exec(s.body); } catch (e) { if (e instanceof BrkSig) { if (e.cont) continue; break; } throw e; } } return;
        case 'forin': { const keys = Array.from(arr(s.arr).keys()); for (const key of keys) { sh.tick(); V.set(s.v, key); try { exec(s.body); } catch (e) { if (e instanceof BrkSig) { if (e.cont) continue; break; } throw e; } } return; }
        case 'next': throw new NextSig();
        case 'break': throw new BrkSig(false);
        case 'continue': throw new BrkSig(true);
        case 'exit': throw new ExitSig(s.e ? Math.trunc(toNum(ev(s.e))) : 0);
        case 'delete': if (s.idx) arr(s.name).delete(keyOf(s.idx)); else arr(s.name).clear(); return;
      }
    }
    let code = 0;
    const st = { s: 0 };
    try {
      try {
        for (const r of rules) if (r.kind === 'begin') exec(r.body || { t: 'block', stmts: [] });
        const mains = rules.filter(r => r.kind === 'main');
        const hasEnd = rules.some(r => r.kind === 'end');
        if (mains.length || hasEnd) {
          const ins = BS.cmdUtil.inputs(sh, files, io, name, st);
          let nr = 0;
          for (const inp of ins) {
            V.set('FILENAME', inp.name === '-' ? '' : inp.name);
            const ls = BS.cmdUtil.lines(inp.data);
            let fnr = 0;
            for (const l of ls) {
              nr++; fnr++;
              V.set('NR', nr); V.set('FNR', fnr);
              setRecord(l);
              try {
                for (const r of mains) {
                  let ok = true;
                  if (r.pat) {
                    if (r.pat.t === 'range') {
                      if (!r.pat.on) { if (truthy(ev(r.pat.a), r.pat.a)) { r.pat.on = true; ok = true; if (truthy(ev(r.pat.b), r.pat.b)) r.pat.on = false; } else ok = false; }
                      else { ok = true; if (truthy(ev(r.pat.b), r.pat.b)) r.pat.on = false; }
                    } else ok = truthy(ev(r.pat), r.pat);
                  }
                  if (!ok) continue;
                  if (r.body) exec(r.body); else out += fields[0] + String(V.get('ORS'));
                }
              } catch (e) { if (!(e instanceof NextSig)) throw e; }
            }
          }
        }
      } catch (e) { if (e instanceof ExitSig) code = e.code; else throw e; }
      try { for (const r of rules) if (r.kind === 'end') exec(r.body || { t: 'block', stmts: [] }); }
      catch (e) { if (e instanceof ExitSig) code = e.code; else throw e; }
    } catch (e) {
      if (e instanceof AwkErr) { io.out.write(out); io.err.write(name + ': ' + e.message + '\n'); return 2; }
      throw e;
    }
    io.out.write(out);
    for (const [f, content] of outFiles) { try { sh.fs.writeFile(sh.resolve(f), content); } catch (e) { io.err.write(name + ': can\'t redirect to ' + f + '\n'); return 2; } }
    return code || st.s;
  }

  BS.awk = run;
})(globalThis.BS = globalThis.BS || {});
