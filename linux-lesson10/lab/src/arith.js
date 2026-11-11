/* Арифметика bash: $(( )), (( )), let, индексы массивов. Целые 64 бита (BigInt). */
(function (BS) {
  'use strict';

  class ArithError extends Error {
    constructor(msg, token) { super(msg); this.token = token; }
  }

  const OPS3 = ['<<=', '>>='];
  const OPS2 = ['**', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|='];
  const OPS1 = '+-*/%<>=!~&^|?:,()[]';

  function wrap(v) { return BigInt.asIntN(64, v); }

  function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (/[0-9]/.test(c)) {
        const m = /^(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z@_]+|[0-9]+)/.exec(s.slice(i));
        let j = i + m[0].length;
        if (j < s.length && /[A-Za-z_.]/.test(s[j])) {
          const bad = /^[0-9A-Za-z_.]+/.exec(s.slice(i))[0];
          throw new ArithError(bad.indexOf('.') >= 0 ? 'syntax error: invalid arithmetic operator' : 'value too great for base', bad);
        }
        toks.push({ t: 'num', v: m[0], p: i });
        i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        toks.push({ t: 'id', v: m[0], p: i });
        i += m[0].length; continue;
      }
      let op = null;
      for (const o of OPS3) if (s.startsWith(o, i)) { op = o; break; }
      if (!op) for (const o of OPS2) if (s.startsWith(o, i)) { op = o; break; }
      if (!op && OPS1.indexOf(c) >= 0) op = c;
      if (!op) throw new ArithError('syntax error: operand expected', s.slice(i));
      toks.push({ t: 'op', v: op, p: i });
      i += op.length;
    }
    toks.push({ t: 'eof', p: s.length });
    return toks;
  }

  function parseNum(v) {
    if (/^0[xX]/.test(v)) return BigInt(v);
    const h = v.indexOf('#');
    if (h > 0) {
      const base = parseInt(v.slice(0, h), 10);
      if (base < 2 || base > 64) throw new ArithError('invalid arithmetic base', v);
      let r = 0n;
      for (const ch of v.slice(h + 1)) {
        let d;
        if (/[0-9]/.test(ch)) d = ch.charCodeAt(0) - 48;
        else if (/[a-z]/.test(ch)) d = ch.charCodeAt(0) - 97 + 10;
        else if (/[A-Z]/.test(ch)) d = base <= 36 ? ch.charCodeAt(0) - 65 + 10 : ch.charCodeAt(0) - 65 + 36;
        else if (ch === '@') d = 62; else d = 63;
        if (d >= base) throw new ArithError('value too great for base', v);
        r = r * BigInt(base) + BigInt(d);
      }
      return r;
    }
    if (v.length > 1 && v[0] === '0') {
      if (/[89]/.test(v)) throw new ArithError('value too great for base', v);
      return BigInt('0o' + v.slice(1));
    }
    return BigInt(v);
  }

  /* Парсер выражений → AST */
  function parse(src) {
    const toks = tokenize(src);
    let k = 0;
    const peek = () => toks[k];
    const next = () => toks[k++];
    const isOp = (v) => toks[k].t === 'op' && toks[k].v === v;
    function expect(v) {
      if (!isOp(v)) throw new ArithError(toks[k].t === 'eof' ? 'syntax error: operand expected' : "syntax error: invalid arithmetic operator", src.slice(toks[k].p));
      k++;
    }
    function comma() {
      let e = assign();
      while (isOp(',')) { k++; e = { k: ',', a: e, b: assign() }; }
      return e;
    }
    const ASSIGN = ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='];
    function assign() {
      const save = k;
      const t = peek();
      if (t.t === 'id') {
        const lv = lvalue();
        if (peek().t === 'op' && ASSIGN.indexOf(peek().v) >= 0) {
          const op = next().v;
          return { k: 'asg', op, lv, e: assign() };
        }
        k = save;
      }
      return ternary();
    }
    function lvalue() {
      const t = next();
      let idx = null, idxSrc = null;
      if (isOp('[')) {
        const st = toks[k].p + 1; k++;
        idx = comma();
        idxSrc = src.slice(st, toks[k].p).trim();
        expect(']');
      }
      return { name: t.v, idx, idxSrc };
    }
    function ternary() {
      const c = binary(0);
      if (isOp('?')) {
        k++;
        const a = assign();
        expect(':');
        const b = assign();
        return { k: '?', c, a, b };
      }
      return c;
    }
    const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    function binary(lvl) {
      if (lvl >= LEVELS.length) return power();
      let l = binary(lvl + 1);
      while (peek().t === 'op' && LEVELS[lvl].indexOf(peek().v) >= 0) {
        const op = next().v;
        l = { k: 'bin', op, a: l, b: binary(lvl + 1) };
      }
      return l;
    }
    function power() {
      const b = unary();
      if (isOp('**')) { k++; return { k: 'bin', op: '**', a: b, b: power() }; }
      return b;
    }
    function unary() {
      const t = peek();
      if (t.t === 'op') {
        if (t.v === '++' || t.v === '--') {
          k++;
          if (peek().t !== 'id') throw new ArithError('syntax error: operand expected', src.slice(peek().p));
          return { k: 'pre', op: t.v, lv: lvalue() };
        }
        if (t.v === '!' || t.v === '~' || t.v === '-' || t.v === '+') { k++; return { k: 'un', op: t.v, e: unary() }; }
      }
      return postfix();
    }
    function postfix() {
      const t = peek();
      if (t.t === 'id') {
        const lv = lvalue();
        if (isOp('++') || isOp('--')) { const op = next().v; return { k: 'post', op, lv }; }
        return { k: 'var', lv };
      }
      return primary();
    }
    function primary() {
      const t = next();
      if (t.t === 'num') return { k: 'num', v: parseNum(t.v) };
      if (t.t === 'op' && t.v === '(') { const e = comma(); expect(')'); return e; }
      if (t.t === 'eof') throw new ArithError('syntax error: operand expected', '');
      throw new ArithError('syntax error: operand expected', src.slice(t.p));
    }
    if (toks.length === 1) return { k: 'num', v: 0n };
    const e = comma();
    if (peek().t !== 'eof') throw new ArithError('syntax error in expression', src.slice(peek().p));
    return e;
  }

  const cache = new Map();

  /* env: { get(name, idxValueOrNull) -> string|null, set(name, idx, string) , depth } */
  function evaluate(src, env, depth) {
    depth = depth || 0;
    if (depth > 20) throw new ArithError('expression recursion level exceeded', src);
    let ast = cache.get(src);
    if (!ast) { ast = parse(src); if (cache.size > 2000) cache.clear(); cache.set(src, ast); }
    return ev(ast);

    function idxOf(lv) { return lv.idx ? ev(lv.idx) : null; }
    function getVal(lv) {
      const idx = lv.idx ? (env.isAssoc(lv.name) ? lv.idxSrc : ev(lv.idx)) : null;
      const s = env.get(lv.name, idx);
      if (s == null || s === '') return 0n;
      const t = s.trim();
      if (/^-?[0-9]+$/.test(t)) {
        if (t.length > 1 && /^-?0[0-9]/.test(t)) return parseNum(t.replace('-', '')) * (t[0] === '-' ? -1n : 1n);
        return wrap(BigInt(t));
      }
      return evaluate(s, env, depth + 1);
    }
    function setVal(lv, v) {
      const idx = lv.idx ? (env.isAssoc(lv.name) ? lv.idxSrc : ev(lv.idx)) : null;
      env.set(lv.name, idx, String(v));
      return v;
    }
    function ev(n) {
      switch (n.k) {
        case 'num': return n.v;
        case 'var': return getVal(n.lv);
        case ',': ev(n.a); return ev(n.b);
        case '?': return ev(n.c) !== 0n ? ev(n.a) : ev(n.b);
        case 'un': {
          const v = ev(n.e);
          if (n.op === '-') return wrap(-v);
          if (n.op === '+') return v;
          if (n.op === '!') return v === 0n ? 1n : 0n;
          return wrap(~v);
        }
        case 'pre': { const v = wrap(getVal(n.lv) + (n.op === '++' ? 1n : -1n)); return setVal(n.lv, v); }
        case 'post': { const v = getVal(n.lv); setVal(n.lv, wrap(v + (n.op === '++' ? 1n : -1n))); return v; }
        case 'asg': {
          let v = ev(n.e);
          if (n.op !== '=') v = binop(n.op.slice(0, -1), getVal(n.lv), v);
          return setVal(n.lv, v);
        }
        case 'bin': {
          if (n.op === '&&') return ev(n.a) !== 0n && ev(n.b) !== 0n ? 1n : 0n;
          if (n.op === '||') return ev(n.a) !== 0n || ev(n.b) !== 0n ? 1n : 0n;
          return binop(n.op, ev(n.a), ev(n.b));
        }
      }
      throw new ArithError('syntax error', '');
    }
    function binop(op, a, b) {
      switch (op) {
        case '+': return wrap(a + b);
        case '-': return wrap(a - b);
        case '*': return wrap(a * b);
        case '/': if (b === 0n) throw new ArithError('division by 0', String(b)); return wrap(a / b);
        case '%': if (b === 0n) throw new ArithError('division by 0', String(b)); return wrap(a % b);
        case '**': if (b < 0n) throw new ArithError('exponent less than 0', String(b)); return wrap(a ** b);
        case '<<': return wrap(a << (b & 63n));
        case '>>': return wrap(a >> (b & 63n));
        case '<': return a < b ? 1n : 0n;
        case '>': return a > b ? 1n : 0n;
        case '<=': return a <= b ? 1n : 0n;
        case '>=': return a >= b ? 1n : 0n;
        case '==': return a === b ? 1n : 0n;
        case '!=': return a !== b ? 1n : 0n;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
      }
      throw new ArithError('syntax error', op);
    }
  }

  BS.ArithError = ArithError;
  BS.arith = { evaluate, parse, tokenize };
})(globalThis.BS = globalThis.BS || {});
