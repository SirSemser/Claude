/* Синтаксический анализатор подмножества bash. */
(function (BS) {
  'use strict';

  class ParseError extends Error {
    constructor(msg, pos, incomplete, token) {
      super(msg);
      this.pos = pos;
      this.incomplete = !!incomplete;
      this.token = token;
    }
  }

  const OPS = ['&>>', ';;&', '<<<', '<<-', '&&', '||', ';;', ';&', '|&', '&>', '>>', '<<', '<>', '>&', '<&', '>|', ';', '&', '|', '<', '>', '(', ')'];
  const REDIR_OPS = new Set(['&>>', '<<<', '<<-', '&>', '>>', '<<', '<>', '>&', '<&', '>|', '<', '>']);
  const DECL = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);
  const WORD_BREAK = ' \t\r\n;&|<>()';

  function isName(s) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s); }
  function isLiteral(s) { return s != null && /^[^'"\\$`]*$/.test(s); }
  const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/;
  const ARR_ASSIGN_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/;

  /* ---------- Сканеры (работают с любой строкой) ---------- */
  function scanSingle(src, i) { // i указывает на '
    const e = src.indexOf("'", i + 1);
    if (e < 0) throw new ParseError("unexpected EOF while looking for matching `''", src.length, true);
    return e + 1;
  }
  function scanAnsiC(src, i) { // i указывает на $ в $'...'
    let j = i + 2;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === "'") return j + 1;
      j++;
    }
    throw new ParseError("unexpected EOF while looking for matching `''", src.length, true);
  }
  function scanDouble(src, i) { // i указывает на "
    let j = i + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '"') return j + 1;
      if (c === '$') { j = scanDollar(src, j); continue; }
      if (c === '`') { j = scanBacktick(src, j); continue; }
      j++;
    }
    throw new ParseError('unexpected EOF while looking for matching `"\'', src.length, true);
  }
  function scanBacktick(src, i) {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') return j + 1;
      j++;
    }
    throw new ParseError('unexpected EOF while looking for matching ``\'', src.length, true);
  }
  function scanBrace(src, i) { // i указывает на $ в ${
    let j = i + 2, depth = 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { j = scanSingle(src, j); continue; }
      if (c === '"') { j = scanDouble(src, j); continue; }
      if (c === '`') { j = scanBacktick(src, j); continue; }
      if (c === '$' && (src[j + 1] === '(' || src[j + 1] === '{')) { j = scanDollar(src, j); continue; }
      if (c === '}') { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    throw new ParseError("unexpected EOF while looking for matching `}'", src.length, true);
  }
  function scanArith(src, i) { // i указывает на $ в $(( или на первую ( в ((
    let j = src[i] === '$' ? i + 3 : i + 2, depth = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) {
          if (src[j + 1] === ')') return j + 2;
          throw new ParseError("syntax error near unexpected token `)'", j, false, ')');
        }
        depth--;
      }
      j++;
    }
    throw new ParseError("unexpected EOF while looking for matching `))'", src.length, true);
  }
  function scanCmdSubst(src, i) { // i указывает на $ в $(
    const p = new Parser(src);
    p.pos = i + 2;
    p.parseList([], true, false);
    p.skipBlanks();
    if (p.pos >= src.length) throw new ParseError("unexpected EOF while looking for matching `)'", src.length, true);
    if (src[p.pos] !== ')') throw p.unexpected();
    return p.pos + 1;
  }
  function scanDollar(src, i) {
    const n = src[i + 1];
    if (n === '(') return src[i + 2] === '(' ? scanArithOrSubst(src, i) : scanCmdSubst(src, i);
    if (n === '{') return scanBrace(src, i);
    if (n === "'") return scanAnsiC(src, i);
    if (n === '[') return scanOldArith(src, i);
    return i + 1;
  }
  function scanOldArith(src, i) { // $[ ... ] — устаревшая форма $(( ))
    let j = i + 2, depth = 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    throw new ParseError("unexpected EOF while looking for matching `]'", src.length, true);
  }
  function scanArithOrSubst(src, i) {
    try { return scanArith(src, i); } catch (e) {
      if (e.incomplete) throw e;
      return scanCmdSubst(src, i);
    }
  }
  function scanArrayLiteral(src, i) { // i указывает на (
    let j = i + 1, depth = 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { j = scanSingle(src, j); continue; }
      if (c === '"') { j = scanDouble(src, j); continue; }
      if (c === '`') { j = scanBacktick(src, j); continue; }
      if (c === '$') { const k = scanDollar(src, j); j = k > j + 1 ? k : j + 1; continue; }
      if (c === '#' && (j === 0 || /[\s(]/.test(src[j - 1]))) { while (j < src.length && src[j] !== '\n') j++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    throw new ParseError("unexpected EOF while looking for matching `)'", src.length, true);
  }

  /* ---------- Парсер ---------- */
  class Parser {
    constructor(src) {
      this.src = src;
      this.pos = 0;
      this.heredocs = [];
      this._nl = null;
    }
    lineOf(pos) {
      if (!this._nl) { this._nl = []; for (let i = 0; i < this.src.length; i++) if (this.src[i] === '\n') this._nl.push(i); }
      let lo = 0, hi = this._nl.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this._nl[mid] < pos) lo = mid + 1; else hi = mid; }
      return lo + 1;
    }
    eof() { return this.pos >= this.src.length; }
    peekc(o) { return this.src[this.pos + (o || 0)]; }

    skipBlanks() {
      const s = this.src;
      while (this.pos < s.length) {
        const c = s[this.pos];
        if (c === ' ' || c === '\t' || c === '\r') this.pos++;
        else if (c === '\\' && s[this.pos + 1] === '\n') this.pos += 2;
        else if (c === '#') { while (this.pos < s.length && s[this.pos] !== '\n') this.pos++; }
        else break;
      }
    }
    consumeNewline() {
      this.pos++;
      if (this.heredocs.length) this.readHeredocs();
    }
    skipNewlines() {
      for (;;) {
        this.skipBlanks();
        if (this.peekc() === '\n') this.consumeNewline(); else break;
      }
    }
    readHeredocs() {
      const s = this.src;
      for (const h of this.heredocs) {
        let body = '';
        let found = false;
        while (this.pos < s.length) {
          let nl = s.indexOf('\n', this.pos);
          const end = nl < 0 ? s.length : nl;
          let line = s.slice(this.pos, end);
          if (h.strip) line = line.replace(/^\t+/, '');
          this.pos = nl < 0 ? s.length : nl + 1;
          if (line === h.delim) { found = true; break; }
          body += line + '\n';
        }
        if (!found) {
          if (this.interactive) throw new ParseError('here-document', s.length, true);
          h.warn = true;
        }
        h.body = body;
      }
      this.heredocs = [];
    }
    peekOp() {
      const s = this.src;
      const c = s[this.pos];
      if (c === undefined || '&|;<>()'.indexOf(c) < 0) return null;
      for (const op of OPS) if (s.startsWith(op, this.pos)) return op;
      return null;
    }
    atFdRedir() {
      const m = /^(\d+)(?=[<>])/.exec(this.src.slice(this.pos, this.pos + 6));
      return m ? m[1] : null;
    }
    unexpected(tok) {
      if (this.eof()) return new ParseError('syntax error: unexpected end of file', this.pos, true);
      if (tok == null) {
        tok = this.peekOp();
        if (tok == null) {
          if (this.peekc() === '\n') tok = 'newline';
          else { const save = this.pos; tok = this.readWord(false) || this.peekc(); this.pos = save; }
        }
      }
      return new ParseError("syntax error near unexpected token `" + tok + "'", this.pos, false, tok);
    }

    readWord(allowArray) {
      const s = this.src;
      const start = this.pos;
      let w = '';
      while (this.pos < s.length) {
        const c = s[this.pos];
        if (WORD_BREAK.indexOf(c) >= 0) {
          if (c === '(' && allowArray && ARR_ASSIGN_PREFIX.test(w)) {
            const e = scanArrayLiteral(s, this.pos);
            w += s.slice(this.pos, e); this.pos = e; continue;
          }
          break;
        }
        if (c === '\\') {
          if (s[this.pos + 1] === '\n') { this.pos += 2; continue; }
          if (this.pos + 1 >= s.length) { w += '\\'; this.pos++; continue; }
          w += s.substr(this.pos, 2); this.pos += 2; continue;
        }
        let e = -1;
        if (c === "'") e = scanSingle(s, this.pos);
        else if (c === '"') e = scanDouble(s, this.pos);
        else if (c === '`') e = scanBacktick(s, this.pos);
        else if (c === '$') e = scanDollar(s, this.pos);
        if (e > this.pos) { w += s.slice(this.pos, e); this.pos = e; continue; }
        w += c; this.pos++;
      }
      if (this.pos === start) return null;
      return w;
    }
    peekWord() {
      const save = this.pos;
      this.skipBlanks();
      let w = null;
      try { w = this.peekOp() ? null : this.readWord(false); } catch (e) { w = null; }
      this.pos = save;
      return w;
    }
    expectWord(word) {
      this.skipBlanks();
      const save = this.pos;
      const w = this.peekOp() ? null : this.readWord(false);
      if (w !== word) { this.pos = save; throw this.unexpected(); }
    }

    /* Следующая команда верхнего уровня (до перевода строки). */
    parseNextTopLevel() {
      this.skipNewlines();
      if (this.eof()) return null;
      const start = this.pos;
      const items = [];
      for (;;) {
        const op0 = this.peekOp();
        if (op0 && op0 !== '(' && !REDIR_OPS.has(op0)) throw this.unexpected(op0);
        const node = this.parseAndOr();
        this.skipBlanks();
        const op = this.peekOp();
        if (op === ';' || op === '&') {
          this.pos++;
          items.push({ node, async: op === '&' });
          this.skipBlanks();
          if (this.eof()) break;
          if (this.peekc() === '\n') { this.consumeNewline(); break; }
          continue;
        }
        items.push({ node, async: false });
        if (this.eof()) break;
        if (this.peekc() === '\n') { this.consumeNewline(); break; }
        throw this.unexpected();
      }
      if (this.heredocs.length) {
        if (this.eof()) this.readHeredocs(); else this.readHeredocs();
      }
      return { type: 'list', items, line: this.lineOf(start), text: this.src.slice(start, this.pos) };
    }
    parseProgram() {
      const list = this.parseList([], false, false);
      this.skipNewlines();
      if (!this.eof()) throw this.unexpected();
      return list;
    }
    parseList(stopWords, stopParen, stopCase) {
      const items = [];
      for (;;) {
        this.skipNewlines();
        if (this.eof()) break;
        const op = this.peekOp();
        if (op === ')' && stopParen) break;
        if ((op === ';;' || op === ';&' || op === ';;&') && stopCase) break;
        if (op && op !== '(' && !REDIR_OPS.has(op)) throw this.unexpected(op);
        if (!op && stopWords.length) {
          const w = this.peekWord();
          if (w !== null && stopWords.indexOf(w) >= 0) break;
        }
        const node = this.parseAndOr();
        this.skipBlanks();
        const op2 = this.peekOp();
        if (op2 === ';' || op2 === '&') { this.pos++; items.push({ node, async: op2 === '&' }); continue; }
        items.push({ node, async: false });
        if (this.peekc() === '\n') { this.consumeNewline(); continue; }
        break;
      }
      return { type: 'list', items };
    }
    requireBody(list, ctx) {
      if (!list.items.length) throw this.unexpected();
    }
    parseAndOr() {
      let node = this.parsePipeline();
      for (;;) {
        this.skipBlanks();
        const op = this.peekOp();
        if (op === '&&' || op === '||') {
          this.pos += 2;
          this.skipNewlines();
          if (this.eof()) throw new ParseError('syntax error: unexpected end of file', this.pos, true);
          const right = this.parsePipeline();
          node = { type: 'andor', op, left: node, right };
        } else break;
      }
      return node;
    }
    parsePipeline() {
      this.skipBlanks();
      let bang = false;
      if (this.peekWord() === '!') { this.skipBlanks(); this.pos++; bang = true; this.skipBlanks(); }
      const cmds = [this.parseCommand()];
      const errPipe = [];
      for (;;) {
        this.skipBlanks();
        const op = this.peekOp();
        if (op === '|' || op === '|&') {
          this.pos += op.length;
          errPipe.push(op === '|&');
          this.skipNewlines();
          if (this.eof()) throw new ParseError('syntax error: unexpected end of file', this.pos, true);
          cmds.push(this.parseCommand());
        } else break;
      }
      if (cmds.length === 1 && !bang) return cmds[0];
      return { type: 'pipeline', cmds, bang, errPipe };
    }
    parseCommand() {
      this.skipBlanks();
      if (this.eof()) throw new ParseError('syntax error: unexpected end of file', this.pos, true);
      const start = this.pos;
      const op = this.peekOp();
      let node;
      if (op === '(') {
        if (this.peekc(1) === '(') {
          const e = scanArith(this.src, this.pos);
          node = { type: 'arith', expr: this.src.slice(this.pos + 2, e - 2) };
          this.pos = e;
        } else {
          this.pos++;
          const body = this.parseList([], true, false);
          this.skipBlanks();
          if (this.peekc() !== ')') throw this.unexpected();
          this.pos++;
          node = { type: 'subshell', body };
        }
      } else if (op && !REDIR_OPS.has(op)) {
        throw this.unexpected(op);
      } else if (!op && !this.atFdRedir()) {
        const w = this.peekWord();
        switch (w) {
          case 'if': node = this.parseIf(); break;
          case 'for': node = this.parseFor(); break;
          case 'while': case 'until': node = this.parseWhile(w); break;
          case 'case': node = this.parseCase(); break;
          case '{': node = this.parseGroup(); break;
          case '[[': node = this.parseCond(); break;
          case 'function': node = this.parseFunction(true); break;
          case 'then': case 'else': case 'elif': case 'fi': case 'do': case 'done':
          case 'esac': case '}': case 'in': case ']]':
            throw this.unexpected(w);
          default:
            if (w && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(w)) {
              const save = this.pos;
              this.skipBlanks(); this.readWord(false); this.skipBlanks();
              if (this.peekc() === '(') {
                this.pos++; this.skipBlanks();
                if (this.peekc() === ')') { this.pos = save; node = this.parseFunction(false); break; }
              }
              this.pos = save;
            }
        }
      }
      if (!node) return this.parseSimple();
      node.line = this.lineOf(start);
      node.redirs = this.parseRedirs();
      return node;
    }
    parseRedirs() {
      const r = [];
      for (;;) {
        this.skipBlanks();
        const op = this.peekOp();
        if ((op && REDIR_OPS.has(op)) || this.atFdRedir()) r.push(this.parseRedir());
        else break;
      }
      return r;
    }
    parseRedir() {
      let fd = null;
      const d = this.atFdRedir();
      if (d) { fd = parseInt(d, 10); this.pos += d.length; }
      const op = this.peekOp();
      this.pos += op.length;
      this.skipBlanks();
      if (op === '<<' || op === '<<-') {
        const raw = this.readWord(false);
        if (raw == null) throw this.unexpected();
        const quoted = /['"\\]/.test(raw);
        const delim = raw.replace(/\\(.)/g, '$1').replace(/['"]/g, '');
        const h = { op: '<<', fd: fd == null ? 0 : fd, delim, quoted, strip: op === '<<-', body: null };
        this.heredocs.push(h);
        return h;
      }
      const target = this.readWord(false);
      if (target == null) throw this.unexpected();
      return { op, fd, target };
    }
    parseSimple() {
      const start = this.pos;
      const node = { type: 'cmd', assigns: [], words: [], redirs: [], line: this.lineOf(start) };
      let w0s = -1, w0e = -1;
      for (;;) {
        this.skipBlanks();
        if (this.eof()) break;
        const op = this.peekOp();
        if ((op && REDIR_OPS.has(op)) || this.atFdRedir()) { node.redirs.push(this.parseRedir()); continue; }
        if (op) break;
        if (this.peekc() === '\n') break;
        const allowArr = node.words.length === 0 || DECL.has(node.words[0]);
        const ws = this.pos;
        const w = this.readWord(allowArr);
        if (w == null) break;
        if (node.words.length === 0 && ASSIGN_RE.test(w)) { node.assigns.push(w); continue; }
        if (node.words.length === 0) { w0s = ws - start; w0e = this.pos - start; }
        node.words.push(w);
      }
      if (!node.assigns.length && !node.words.length && !node.redirs.length) throw this.unexpected();
      node.text = this.src.slice(start, this.pos);
      node.w0s = w0s; node.w0e = w0e;
      return node;
    }
    parseIf() {
      this.expectWord('if');
      const clauses = [];
      let cond = this.parseList(['then'], false, false); this.requireBody(cond);
      this.expectWord('then');
      let body = this.parseList(['elif', 'else', 'fi'], false, false); this.requireBody(body);
      clauses.push({ cond, body });
      let elseBody = null;
      for (;;) {
        const w = this.peekWord();
        if (w === 'elif') {
          this.expectWord('elif');
          cond = this.parseList(['then'], false, false); this.requireBody(cond);
          this.expectWord('then');
          body = this.parseList(['elif', 'else', 'fi'], false, false); this.requireBody(body);
          clauses.push({ cond, body });
        } else if (w === 'else') {
          this.expectWord('else');
          elseBody = this.parseList(['fi'], false, false); this.requireBody(elseBody);
          this.expectWord('fi');
          break;
        } else if (w === 'fi') { this.expectWord('fi'); break; }
        else throw this.unexpected();
      }
      return { type: 'if', clauses, elseBody };
    }
    parseFor() {
      this.expectWord('for');
      this.skipBlanks();
      if (this.src.startsWith('((', this.pos)) {
        const e = scanArith(this.src, this.pos);
        const inner = this.src.slice(this.pos + 2, e - 2);
        this.pos = e;
        const parts = splitTopLevel(inner, ';');
        if (parts.length !== 3) throw new ParseError("syntax error: arithmetic expression required", this.pos, false);
        this.skipBlanks();
        if (this.peekOp() === ';') this.pos++;
        this.skipNewlines();
        let body;
        if (this.peekWord() === '{') { body = this.parseGroup(); }
        else { this.expectWord('do'); body = this.parseList(['done'], false, false); this.requireBody(body); this.expectWord('done'); }
        return { type: 'forarith', init: parts[0], cond: parts[1], step: parts[2], body };
      }
      const name = this.readWord(false);
      if (name == null) throw this.unexpected();
      if (!isName(name)) throw new ParseError("`" + name + "': not a valid identifier", this.pos, false);
      this.skipBlanks();
      let words = null;
      if (this.peekOp() === ';') { this.pos++; }
      this.skipNewlines();
      if (this.peekWord() === 'in') {
        this.expectWord('in');
        words = [];
        for (;;) {
          this.skipBlanks();
          if (this.eof()) throw new ParseError('syntax error: unexpected end of file', this.pos, true);
          const op = this.peekOp();
          if (op === ';') { this.pos++; break; }
          if (op) throw this.unexpected(op);
          if (this.peekc() === '\n') { this.consumeNewline(); break; }
          words.push(this.readWord(false));
        }
        this.skipNewlines();
      }
      this.expectWord('do');
      const body = this.parseList(['done'], false, false); this.requireBody(body);
      this.expectWord('done');
      return { type: 'for', name, words, body };
    }
    parseWhile(kw) {
      this.expectWord(kw);
      const cond = this.parseList(['do'], false, false); this.requireBody(cond);
      this.expectWord('do');
      const body = this.parseList(['done'], false, false); this.requireBody(body);
      this.expectWord('done');
      return { type: 'while', until: kw === 'until', cond, body };
    }
    parseCase() {
      this.expectWord('case');
      this.skipBlanks();
      const word = this.readWord(false);
      if (word == null) throw this.unexpected();
      this.skipNewlines();
      this.expectWord('in');
      const items = [];
      for (;;) {
        this.skipNewlines();
        if (this.eof()) throw new ParseError('syntax error: unexpected end of file', this.pos, true);
        if (this.peekWord() === 'esac') { this.expectWord('esac'); break; }
        if (this.peekOp() === '(') this.pos++;
        const patterns = [];
        for (;;) {
          this.skipBlanks();
          const p = this.peekOp() ? null : this.readWord(false);
          if (p == null) throw this.unexpected();
          patterns.push(p);
          this.skipBlanks();
          if (this.peekOp() === '|') { this.pos++; continue; }
          break;
        }
        this.skipBlanks();
        if (this.peekOp() !== ')') throw this.unexpected();
        this.pos++;
        const body = this.parseList(['esac'], false, true);
        this.skipBlanks();
        const op = this.peekOp();
        let term = ';;';
        if (op === ';;' || op === ';&' || op === ';;&') { this.pos += op.length; term = op; }
        else {
          this.skipNewlines();
          if (this.peekWord() !== 'esac') throw this.unexpected();
        }
        items.push({ patterns, body, term });
      }
      return { type: 'case', word, items };
    }
    parseGroup() {
      this.expectWord('{');
      const body = this.parseList(['}'], false, false); this.requireBody(body);
      this.expectWord('}');
      return { type: 'group', body };
    }
    parseFunction(kw) {
      if (kw) this.expectWord('function');
      this.skipBlanks();
      const name = this.readWord(false);
      if (name == null) throw this.unexpected();
      this.skipBlanks();
      if (this.peekc() === '(') {
        this.pos++; this.skipBlanks();
        if (this.peekc() !== ')') throw this.unexpected();
        this.pos++;
      }
      this.skipNewlines();
      const bodyStart = this.pos;
      const body = this.parseCommand();
      if (['group', 'subshell', 'if', 'for', 'forarith', 'while', 'case', 'cond', 'arith'].indexOf(body.type) < 0) {
        this.pos = bodyStart;
        throw this.unexpected();
      }
      return { type: 'funcdef', name, body, text: this.src.slice(bodyStart, this.pos) };
    }

    /* ---------- [[ ... ]] ---------- */
    parseCond() {
      this.expectWord('[[');
      const e = this.condOr();
      const t = this.condTok();
      if (t.t !== 'end') throw new ParseError("syntax error in conditional expression", this.pos, false);
      return { type: 'cond', expr: e };
    }
    condTok(peek) {
      const save = this.pos;
      for (;;) {
        this.skipBlanks();
        if (this.peekc() === '\n') { this.consumeNewline(); continue; }
        break;
      }
      const s = this.src;
      let tok;
      if (this.eof()) throw new ParseError('syntax error: unexpected end of file', this.pos, true);
      if (s.startsWith(']]', this.pos) && (this.pos + 2 >= s.length || WORD_BREAK.indexOf(s[this.pos + 2]) >= 0)) { tok = { t: 'end' }; this.pos += 2; }
      else if (s.startsWith('&&', this.pos)) { tok = { t: 'and' }; this.pos += 2; }
      else if (s.startsWith('||', this.pos)) { tok = { t: 'or' }; this.pos += 2; }
      else if (s[this.pos] === '(') { tok = { t: 'lp' }; this.pos++; }
      else if (s[this.pos] === ')') { tok = { t: 'rp' }; this.pos++; }
      else if (s[this.pos] === '<' || s[this.pos] === '>') { tok = { t: 'w', w: s[this.pos] }; this.pos++; }
      else if (s[this.pos] === '!' && (this.pos + 1 >= s.length || ' \t\n('.indexOf(s[this.pos + 1]) >= 0)) { tok = { t: 'not' }; this.pos++; }
      else {
        const w = this.readWord(false);
        if (w == null) throw this.unexpected();
        tok = { t: 'w', w };
      }
      if (peek) this.pos = save;
      return tok;
    }
    condOr() {
      let l = this.condAnd();
      while (this.condTok(true).t === 'or') { this.condTok(); l = { op: 'or', l, r: this.condAnd() }; }
      return l;
    }
    condAnd() {
      let l = this.condNot();
      while (this.condTok(true).t === 'and') { this.condTok(); l = { op: 'and', l, r: this.condNot() }; }
      return l;
    }
    condNot() {
      if (this.condTok(true).t === 'not') { this.condTok(); return { op: 'not', e: this.condNot() }; }
      return this.condPrimary();
    }
    condPrimary() {
      const t = this.condTok();
      if (t.t === 'lp') {
        const e = this.condOr();
        if (this.condTok().t !== 'rp') throw new ParseError("syntax error in conditional expression: expected `)'", this.pos, false);
        return e;
      }
      if (t.t !== 'w') throw new ParseError("unexpected token in conditional command", this.pos, false);
      const UN = ['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-z', '-n', '-L', '-h', '-a', '-v', '-b', '-c', '-p', '-S', '-t', '-O', '-G', '-N', '-u', '-g', '-k'];
      const BIN = ['==', '=', '!=', '<', '>', '=~', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef'];
      if (UN.indexOf(t.w) >= 0) {
        const n = this.condTok(true);
        if (n.t === 'w' && BIN.indexOf(n.w) < 0) { this.condTok(); return { op: 'unary', o: t.w, a: n.w }; }
      }
      const n = this.condTok(true);
      if (n.t === 'w' && BIN.indexOf(n.w) >= 0) {
        this.condTok();
        let r;
        if (n.w === '=~') r = this.readRegexWord();
        else { const rt = this.condTok(); if (rt.t !== 'w') throw new ParseError("unexpected argument to conditional binary operator", this.pos, false); r = rt.w; }
        return { op: 'bin', o: n.w, l: t.w, r };
      }
      return { op: 'str', w: t.w };
    }
    readRegexWord() {
      this.skipBlanks();
      const s = this.src;
      const start = this.pos;
      let depth = 0;
      while (this.pos < s.length) {
        const c = s[this.pos];
        if (c === '\\') { this.pos += 2; continue; }
        if (c === "'") { this.pos = scanSingle(s, this.pos); continue; }
        if (c === '"') { this.pos = scanDouble(s, this.pos); continue; }
        if (c === '$') { const e = scanDollar(s, this.pos); this.pos = e > this.pos ? e : this.pos + 1; continue; }
        if (c === '(') depth++;
        else if (c === ')') { if (depth === 0) break; depth--; }
        else if (depth === 0 && (c === ' ' || c === '\t' || c === '\n')) break;
        else if (depth === 0 && (s.startsWith('&&', this.pos) || s.startsWith('||', this.pos))) break;
        this.pos++;
      }
      if (this.pos === start) throw this.unexpected();
      return s.slice(start, this.pos);
    }
  }

  function splitTopLevel(s, sep) {
    const out = []; let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  BS.Parser = Parser;
  BS.ParseError = ParseError;
  BS.parserUtil = { scanOldArith, scanSingle, scanDouble, scanBacktick, scanBrace, scanArith, scanCmdSubst, scanDollar, scanAnsiC, scanArrayLiteral, isName, isLiteral, ASSIGN_RE, DECL, splitTopLevel };
})(globalThis.BS = globalThis.BS || {});
