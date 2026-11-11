/* «Внешние» команды учебного симулятора (ls, cat, grep, sort, ...). */
(function (BS) {
  'use strict';
  const { VFS, FsError } = BS;
  const { InStream, OutBuf } = BS.io;
  const U = BS.util;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p2 = (n) => String(n).padStart(2, '0');
  const Q = (s) => '\u2018' + s + '\u2019'; // ‘…’ как в GNU coreutils
  const q1 = (s) => "'" + s + "'";

  function err(io, cmd, msg) { io.err.write(cmd + ': ' + msg + '\n'); }

  /* Разбор опций: spec = { flags: 'abc', args: 'nk', long: { '--lines': 'n' } } */
  function opts(argv, spec, io) {
    const o = {}; const rest = [];
    const name = argv[0];
    let i = 1;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { i++; break; }
      if (a.startsWith('--') && a.length > 2) {
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(0, eq) : a;
        const map = (spec.long || {})[key];
        if (map === undefined) { if (spec.ignoreLong) continue; err(io, name, 'unrecognized option ' + q1(a)); io.err.write("Try '" + name + " --help' for more information.\n"); return null; }
        if (map === null) continue;
        if ((spec.args || '').indexOf(map) >= 0) o[map] = eq > 0 ? a.slice(eq + 1) : argv[++i];
        else o[map] = eq > 0 ? a.slice(eq + 1) : true;
        continue;
      }
      if (a[0] === '-' && a.length > 1 && !(spec.numeric && /^-\d+$/.test(a))) {
        if (spec.negNum && /^-\d/.test(a)) { rest.push(a); continue; }
        for (let k = 1; k < a.length; k++) {
          const ch = a[k];
          if ((spec.args || '').indexOf(ch) >= 0) {
            const v = a.slice(k + 1) || argv[++i];
            if (v == null) { err(io, name, 'option requires an argument -- ' + q1(ch)); io.err.write("Try '" + name + " --help' for more information.\n"); return null; }
            o[ch] = v; break;
          }
          if ((spec.flags || '').indexOf(ch) >= 0) { o[ch] = true; continue; }
          err(io, name, 'invalid option -- ' + q1(ch));
          io.err.write("Try '" + name + " --help' for more information.\n");
          return null;
        }
        continue;
      }
      if (spec.numeric && /^-\d+$/.test(a)) { o.num = a.slice(1); continue; }
      rest.push(a);
      if (spec.stopAtFirst) { i++; break; }
    }
    for (; i < argv.length; i++) rest.push(argv[i]);
    o._ = rest;
    return o;
  }

  /* Чтение входов: файлы или stdin. Возвращает массив {name, data} или null при ошибке (сообщения уже выведены). */
  function inputs(sh, files, io, cmd, st) {
    if (!files.length) files = ['-'];
    const out = [];
    for (const f of files) {
      if (f === '-') {
        const inp = io.in;
        if (inp && inp.interactive && inp.atEOF()) {
          if (sh.hints) io.err.write('\x1b[33m💡 ' + cmd + ' ждёт ввод с клавиатуры — в симуляторе это недоступно. Укажите файл или используйте конвейер: echo текст | ' + cmd + '\x1b[0m\n');
          out.push({ name: '-', data: '' });
          continue;
        }
        out.push({ name: '-', data: inp ? inp.readAll() : '' });
        continue;
      }
      try { out.push({ name: f, data: sh.fs.readFile(sh.resolve(f)) }); }
      catch (e) {
        if (e instanceof FsError) { err(io, cmd, f + ': ' + e.message); st.s = 1; continue; }
        throw e;
      }
    }
    return out;
  }
  function lines(data) {
    if (data === '') return [];
    const l = data.split('\n');
    if (l[l.length - 1] === '') l.pop();
    return l;
  }
  function joinLines(arr) { return arr.length ? arr.join('\n') + '\n' : ''; }

  function permStr(n) {
    let s = n.t === 'd' ? 'd' : n.t === 'c' ? 'c' : '-';
    const m = n.m;
    const tri = (sh, sp, ch) => {
      let r = ((m >> sh) & 4 ? 'r' : '-') + ((m >> sh) & 2 ? 'w' : '-');
      const x = (m >> sh) & 1;
      if (m & sp) r += x ? ch : ch.toUpperCase(); else r += x ? 'x' : '-';
      return r;
    };
    s += tri(6, 0o4000, 's') + tri(3, 0o2000, 's') + tri(0, 0o1000, 't');
    return s;
  }
  function dateStr(ms) {
    const d = new Date(ms);
    const now = Date.now();
    const recent = Math.abs(now - ms) < 180 * 24 * 3600 * 1000;
    return MONTHS[d.getMonth()] + ' ' + String(d.getDate()).padStart(2) + ' ' + (recent ? p2(d.getHours()) + ':' + p2(d.getMinutes()) : ' ' + d.getFullYear());
  }
  function sizeOf(n) { return n.t === 'd' ? 4096 : n.t === 'c' ? 0 : new TextEncoder().encode(n.x).length; }
  function human(n) {
    if (n < 1024) return String(n);
    const u = ['K', 'M', 'G', 'T'];
    let v = n, i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + u[i];
  }
  function colorName(name, n, tty) {
    if (!tty || !n) return name;
    if (n.t === 'd') return (n.m & 0o1000 && n.m & 0o002 ? '\x1b[30;42m' : '\x1b[01;34m') + name + '\x1b[0m';
    if (n.t === 'c') return '\x1b[40;33;01m' + name + '\x1b[0m';
    if (n.m & 0o111) return '\x1b[01;32m' + name + '\x1b[0m';
    if (/\.(tar|gz|zip|tgz|bz2|xz|7z|rar)$/.test(name)) return '\x1b[01;31m' + name + '\x1b[0m';
    return name;
  }
  function byteLen(s) { return new TextEncoder().encode(s).length; }
  function displayWidth(s) { return Array.from(s).length; }

  const COMMANDS = {};
  const C = (names, fn) => { for (const n of names.split(' ')) COMMANDS[n] = fn; };

  /* ---------------- ls ---------------- */
  C('ls dir vdir', (sh, argv, io) => {
    const o = opts(argv, { flags: 'laA1hdrRtSFiG', long: { '--color': null, '--all': 'a', '--almost-all': 'A', '--human-readable': 'h', '--directory': 'd', '--reverse': 'r', '--classify': 'F', '--group-directories-first': null } }, io);
    if (!o) return 2;
    const color = argv.some(a => a === '--color' || a === '--color=auto' || a === '--color=always') && io.out.tty;
    const long = o.l || argv[0] === 'vdir';
    const one = o['1'] || !io.out.tty;
    let st = 0;
    const targets = o._.length ? o._ : ['.'];
    const files = [], dirs = [];
    for (const t of targets) {
      const abs = sh.resolve(t);
      let n;
      try { n = sh.fs.lookup(abs); }
      catch (e) { err(io, 'ls', 'cannot access ' + q1(t) + ': ' + e.message); st = 2; continue; }
      if (n.t === 'd' && !o.d) dirs.push({ t, abs, n }); else files.push({ name: t, n });
    }
    const sortEntries = (arr) => {
      arr.sort((a, b) => BS.cmpNames(a.name, b.name));
      if (o.t) arr.sort((a, b) => b.n.mt - a.n.mt);
      if (o.S) arr.sort((a, b) => sizeOf(b.n) - sizeOf(a.n));
      if (o.r) arr.reverse();
      return arr;
    };
    const render = (entries, withTotal) => {
      let s = '';
      if (long) {
        if (withTotal) {
          let total = 0;
          for (const e of entries) { const z = sizeOf(e.n); total += e.n.t === 'd' ? 4 : Math.ceil(z / 4096) * 4; }
          s += 'total ' + total + '\n';
        }
        const sizes = entries.map(e => o.h ? human(sizeOf(e.n)) : String(sizeOf(e.n)));
        const links = entries.map(e => String(e.n.t === 'd' ? 2 + Object.values(e.n.c || {}).filter(c => c.t === 'd').length : 1));
        const sw = Math.max(0, ...sizes.map(x => x.length));
        const lw = Math.max(0, ...links.map(x => x.length));
        const ow = Math.max(0, ...entries.map(e => e.n.o.length));
        entries.forEach((e, i) => {
          let nm = colorName(e.name, e.n, color);
          if (o.F) nm += e.n.t === 'd' ? '/' : (e.n.m & 0o111 ? '*' : '');
          s += permStr(e.n) + ' ' + links[i].padStart(lw) + ' ' + e.n.o.padEnd(ow) + ' ' + e.n.o.padEnd(ow) + ' ' + sizes[i].padStart(sw) + ' ' + dateStr(e.n.mt) + ' ' + nm + '\n';
        });
        return s;
      }
      const names = entries.map(e => { let nm = e.name; if (o.F) nm += e.n.t === 'd' ? '/' : (e.n.m & 0o111 ? '*' : ''); return { raw: nm, shown: colorName(nm, e.n, color) }; });
      if (one) return names.map(x => x.shown).join('\n') + (names.length ? '\n' : '');
      // колонки по ширине 80
      const width = sh.termWidth || 80;
      const n = names.length;
      if (!n) return '';
      for (let rows = 1; rows <= n; rows++) {
        const cols = Math.ceil(n / rows);
        const colW = [];
        for (let c = 0; c < cols; c++) {
          let w = 0;
          for (let r = 0; r < rows; r++) { const k = c * rows + r; if (k < n) w = Math.max(w, displayWidth(names[k].raw)); }
          colW.push(w);
        }
        const total = colW.reduce((a, b) => a + b, 0) + 2 * (cols - 1);
        if (total <= width || rows === n) {
          let out = '';
          for (let r = 0; r < rows; r++) {
            let line = '';
            for (let c = 0; c < cols; c++) {
              const k = c * rows + r;
              if (k >= n) continue;
              const last = c === cols - 1 || (c + 1) * rows + r >= n;
              line += names[k].shown + (last ? '' : ' '.repeat(colW[c] - displayWidth(names[k].raw) + 2));
            }
            out += line + '\n';
          }
          return out;
        }
      }
      return '';
    };
    let out = '';
    if (files.length) out += render(sortEntries(files), false);
    dirs.sort((a, b) => BS.cmpNames(a.t, b.t));
    const multi = targets.length > 1;
    const listDir = (d, header) => {
      if (!sh.fs.can(d.n, 'r')) { err(io, 'ls', 'cannot open directory ' + q1(d.t) + ': Permission denied'); st = 2; return; }
      let entries = Object.keys(d.n.c).filter(k => o.a || o.A || !k.startsWith('.')).map(k => ({ name: k, n: d.n.c[k] }));
      if (o.a) entries = [{ name: '.', n: d.n }, { name: '..', n: sh.fs.get(VFS.normalize('..', d.abs)) }].concat(entries);
      sortEntries(entries);
      if (header) out += (out ? '\n' : '') + d.t + ':\n';
      out += render(entries, true);
      if (o.R) {
        for (const e of entries) if (e.n.t === 'd' && e.name !== '.' && e.name !== '..') listDir({ t: d.t.replace(/\/$/, '') + '/' + e.name, abs: VFS.normalize(e.name, d.abs), n: e.n }, true);
      }
    };
    dirs.forEach((d) => listDir(d, multi || files.length > 0 || o.R));
    io.out.write(out);
    return st;
  });

  /* ---------------- cat / tac / rev / nl ---------------- */
  C('cat', (sh, argv, io) => {
    const o = opts(argv, { flags: 'nbEAsTv', long: { '--number': 'n', '--show-ends': 'E' } }, io);
    if (!o) return 1;
    const st = { s: 0 };
    let n = 0;
    for (const inp of inputs(sh, o._, io, 'cat', st)) {
      let data = inp.data;
      if (o.n || o.b || o.E || o.A || o.s) {
        let ls = data.split('\n');
        const endNl = data.endsWith('\n');
        if (endNl) ls.pop();
        if (o.s) ls = ls.filter((l, i) => !(l === '' && ls[i - 1] === ''));
        data = ls.map(l => {
          let t = l;
          if (o.E || o.A) t += '$';
          if (o.b) return l === '' ? t : String(++n).padStart(6) + '\t' + t;
          if (o.n) return String(++n).padStart(6) + '\t' + t;
          return t;
        }).join('\n') + (endNl ? '\n' : '');
      }
      io.out.write(data);
    }
    return st.s;
  });
  C('tac', (sh, argv, io) => {
    const st = { s: 0 };
    for (const inp of inputs(sh, argv.slice(1), io, 'tac', st)) io.out.write(joinLines(lines(inp.data).reverse()));
    return st.s;
  });
  C('rev', (sh, argv, io) => {
    const st = { s: 0 };
    for (const inp of inputs(sh, argv.slice(1), io, 'rev', st)) {
      const d = inp.data;
      const ls = d.split('\n');
      io.out.write(ls.map(l => Array.from(l).reverse().join('')).join('\n'));
    }
    return st.s;
  });
  C('nl', (sh, argv, io) => {
    const o = opts(argv, { args: 'bws', flags: '' }, io);
    if (!o) return 1;
    const st = { s: 0 };
    let n = 0;
    for (const inp of inputs(sh, o._, io, 'nl', st)) {
      io.out.write(joinLines(lines(inp.data).map(l => (l === '' && o.b !== 'a') ? '      ' + (o.s != null ? '' : '') : String(++n).padStart(6) + (o.s != null ? o.s : '\t') + l)));
    }
    return st.s;
  });

  /* ---------------- файлы ---------------- */
  C('mkdir', (sh, argv, io) => {
    const o = opts(argv, { flags: 'pv', args: 'm', long: { '--parents': 'p', '--verbose': 'v' } }, io);
    if (!o) return 1;
    if (!o._.length) { err(io, 'mkdir', 'missing operand'); io.err.write("Try 'mkdir --help' for more information.\n"); return 1; }
    let st = 0;
    for (const d of o._) {
      try {
        const abs = sh.resolve(d);
        if (o.p) {
          const parts = abs.split('/').filter(Boolean);
          let cur = '';
          for (const p of parts) { cur += '/' + p; if (!sh.fs.get(cur)) { sh.fs.mkdir(cur, false); if (o.v) io.out.write("mkdir: created directory " + q1(cur) + '\n'); } else if (!sh.fs.isDir(cur)) throw new FsError('ENOTDIR'); }
        } else { sh.fs.mkdir(abs, false); if (o.v) io.out.write('mkdir: created directory ' + q1(d) + '\n'); }
        if (o.m) { const n = sh.fs.get(abs); if (n) n.m = parseInt(o.m, 8) || n.m; }
      } catch (e) {
        if (e instanceof FsError) { err(io, 'mkdir', 'cannot create directory ' + Q(d) + ': ' + e.message); st = 1; continue; }
        throw e;
      }
    }
    return st;
  });
  C('rmdir', (sh, argv, io) => {
    const o = opts(argv, { flags: 'pv' }, io);
    if (!o) return 1;
    if (!o._.length) { err(io, 'rmdir', 'missing operand'); return 1; }
    let st = 0;
    for (const d of o._) {
      const abs = sh.resolve(d);
      const n = sh.fs.get(abs);
      if (!n) { err(io, 'rmdir', 'failed to remove ' + q1(d) + ': No such file or directory'); st = 1; continue; }
      if (n.t !== 'd') { err(io, 'rmdir', 'failed to remove ' + q1(d) + ': Not a directory'); st = 1; continue; }
      if (Object.keys(n.c).length) { err(io, 'rmdir', 'failed to remove ' + q1(d) + ': Directory not empty'); st = 1; continue; }
      try { sh.fs.remove(abs); } catch (e) { err(io, 'rmdir', 'failed to remove ' + q1(d) + ': ' + e.message); st = 1; }
    }
    return st;
  });
  C('touch', (sh, argv, io) => {
    const o = opts(argv, { flags: 'acm', args: 'dt' }, io);
    if (!o) return 1;
    if (!o._.length) { err(io, 'touch', 'missing file operand'); io.err.write("Try 'touch --help' for more information.\n"); return 1; }
    let st = 0;
    for (const f of o._) {
      const abs = sh.resolve(f);
      const n = sh.fs.get(abs);
      if (n) { sh.fs.touch(n); continue; }
      if (o.c) continue;
      try { sh.fs.openWrite(abs, true); }
      catch (e) { if (e instanceof FsError) { err(io, 'touch', 'cannot touch ' + q1(f) + ': ' + e.message); st = 1; continue; } throw e; }
    }
    return st;
  });
  C('rm', (sh, argv, io) => {
    const o = opts(argv, { flags: 'rRfivd', long: { '--recursive': 'r', '--force': 'f', '--verbose': 'v', '--no-preserve-root': null } }, io);
    if (!o) return 1;
    const rec = o.r || o.R;
    if (!o._.length) { if (o.f) return 0; err(io, 'rm', 'missing operand'); io.err.write("Try 'rm --help' for more information.\n"); return 1; }
    let st = 0;
    for (const f of o._) {
      const abs = sh.resolve(f);
      if (abs === '/' && rec) { err(io, 'rm', "it is dangerous to operate recursively on '/'"); io.err.write("rm: use --no-preserve-root to override this failsafe\n"); st = 1; continue; }
      if (f === '.' || f === '..' || /\/\.\.?$/.test(f)) { err(io, 'rm', 'refusing to remove \'.\' or \'..\' directory: skipping ' + q1(f)); st = 1; continue; }
      const n = sh.fs.get(abs);
      if (!n) { if (!o.f) { err(io, 'rm', 'cannot remove ' + q1(f) + ': No such file or directory'); st = 1; } continue; }
      if (n.t === 'd' && !rec && !o.d) { err(io, 'rm', 'cannot remove ' + q1(f) + ': Is a directory'); st = 1; continue; }
      if (n.t === 'd' && o.d && !rec && Object.keys(n.c).length) { err(io, 'rm', 'cannot remove ' + q1(f) + ': Directory not empty'); st = 1; continue; }
      if (abs === sh.home && sh.hints) { io.err.write('\x1b[33m💡 Удалять домашний каталог в симуляторе не стоит :) Операция отменена.\x1b[0m\n'); st = 1; continue; }
      try { sh.fs.remove(abs); if (o.v) io.out.write((n.t === 'd' ? 'removed directory ' : 'removed ') + q1(f) + '\n'); }
      catch (e) { err(io, 'rm', 'cannot remove ' + q1(f) + ': ' + e.message); st = 1; }
    }
    return st;
  });
  function copyLike(sh, argv, io, move) {
    const name = move ? 'mv' : 'cp';
    const o = opts(argv, { flags: 'rRfivnpau', long: { '--recursive': 'r', '--force': 'f', '--verbose': 'v' } }, io);
    if (!o) return 1;
    const args = o._;
    if (args.length < 2) {
      if (!args.length) err(io, name, 'missing file operand');
      else err(io, name, 'missing destination file operand after ' + q1(args[0]));
      io.err.write("Try '" + name + " --help' for more information.\n");
      return 1;
    }
    const dest = args[args.length - 1];
    const srcs = args.slice(0, -1);
    const dabs = sh.resolve(dest);
    const dnode = sh.fs.get(dabs);
    if (srcs.length > 1 && (!dnode || dnode.t !== 'd')) { err(io, name, 'target ' + q1(dest) + ' is not a directory'); return 1; }
    let st = 0;
    for (const s of srcs) {
      const sabs = sh.resolve(s);
      const sn = sh.fs.get(sabs);
      if (!sn) { err(io, name, (move ? 'cannot stat ' : 'cannot stat ') + q1(s) + ': No such file or directory'); st = 1; continue; }
      if (sn.t === 'd' && !move && !(o.r || o.R || o.a)) { err(io, name, '-r not specified; omitting directory ' + q1(s)); st = 1; continue; }
      let target = dabs;
      if (dnode && dnode.t === 'd') target = VFS.normalize(sabs.split('/').pop(), dabs);
      if (target === sabs) { err(io, name, q1(s) + ' and ' + q1(dest) + ' are the same file'); st = 1; continue; }
      if (sn.t === 'd' && (target + '/').startsWith(sabs + '/')) { err(io, name, 'cannot ' + (move ? 'move ' : 'copy a directory, ') + q1(s) + ' into itself, ' + q1(dest)); st = 1; continue; }
      const tn = sh.fs.get(target);
      if (tn && tn.t === 'd' && sn.t !== 'd') { err(io, name, 'cannot overwrite directory ' + q1(target) + ' with non-directory'); st = 1; continue; }
      if (o.n && tn) continue;
      try {
        if (move) {
          sh.fs.remove(sabs);
          sh.fs.link(target, sn);
          sn.mt = Date.now();
        } else {
          const copy = VFS.cloneNode(sn);
          copy.o = sh.user; copy.mt = Date.now();
          if (tn && tn.t === 'f' && sn.t === 'f') { if (!sh.fs.can(tn, 'w')) throw new FsError('EACCES'); tn.x = sn.x; tn.mt = Date.now(); }
          else sh.fs.link(target, copy);
        }
        if (o.v) io.out.write(q1(s) + ' -> ' + q1(target.replace(sh.cwd + '/', '')) + '\n');
      } catch (e) {
        if (e instanceof FsError) { err(io, name, (move ? 'cannot move ' + q1(s) + ' to ' + q1(dest) : 'cannot create regular file ' + q1(dest)) + ': ' + e.message); st = 1; continue; }
        throw e;
      }
    }
    return st;
  }
  C('cp', (sh, argv, io) => copyLike(sh, argv, io, false));
  C('mv', (sh, argv, io) => copyLike(sh, argv, io, true));
  C('ln', (sh, argv, io) => {
    const o = opts(argv, { flags: 'sfvn' }, io);
    if (!o) return 1;
    if (o._.length < 2) { err(io, 'ln', 'missing file operand'); return 1; }
    if (o.s) { err(io, 'ln', 'символические ссылки в этом симуляторе не поддерживаются (тема урока 3)'); return 1; }
    const sabs = sh.resolve(o._[0]); const sn = sh.fs.get(sabs);
    if (!sn) { err(io, 'ln', 'failed to access ' + q1(o._[0]) + ': No such file or directory'); return 1; }
    if (sn.t === 'd') { err(io, 'ln', q1(o._[0]) + ': hard link not allowed for directory'); return 1; }
    let target = sh.resolve(o._[1]);
    if (sh.fs.isDir(target)) target = VFS.normalize(sabs.split('/').pop(), target);
    if (sh.fs.get(target)) { if (!o.f) { err(io, 'ln', 'failed to create hard link ' + q1(o._[1]) + ': File exists'); return 1; } }
    try { sh.fs.link(target, sn); } catch (e) { err(io, 'ln', e.message); return 1; }
    return 0;
  });
  C('chmod', (sh, argv, io) => {
    const args = argv.slice(1);
    let rec = false, verbose = false;
    const rest = [];
    for (const a of args) {
      if (a === '-R' || a === '--recursive') rec = true;
      else if (a === '-v' || a === '--verbose') verbose = true;
      else if (a === '-c' || a === '-f') {}
      else rest.push(a);
    }
    if (rest.length < 2) {
      if (!rest.length) err(io, 'chmod', 'missing operand'); else err(io, 'chmod', 'missing operand after ' + Q(rest[0]));
      io.err.write("Try 'chmod --help' for more information.\n");
      return 1;
    }
    const mode = rest[0];
    let st = 0;
    const apply = (n, path) => {
      let nm;
      if (/^[0-7]{1,4}$/.test(mode)) nm = parseInt(mode, 8) | (mode.length < 4 ? (n.m & 0 ) : 0);
      else {
        nm = n.m;
        for (const clause of mode.split(',')) {
          const m = /^([ugoa]*)([-+=])([rwxXst]*|[ugo])$/.exec(clause);
          if (!m) return 'invalid';
          let who = m[1] || 'a';
          if (who.indexOf('a') >= 0) who = 'ugo';
          let bits = 0;
          const perm = m[3];
          const copyFrom = /^[ugo]$/.test(perm) ? perm : null;
          for (const w of who) {
            const sft = w === 'u' ? 6 : w === 'g' ? 3 : 0;
            let b = 0;
            if (copyFrom) { const cs = copyFrom === 'u' ? 6 : copyFrom === 'g' ? 3 : 0; b = (n.m >> cs) & 7; }
            else {
              if (perm.indexOf('r') >= 0) b |= 4;
              if (perm.indexOf('w') >= 0) b |= 2;
              if (perm.indexOf('x') >= 0 || (perm.indexOf('X') >= 0 && (n.t === 'd' || (n.m & 0o111)))) b |= 1;
            }
            bits |= b << sft;
            if (perm.indexOf('s') >= 0) bits |= w === 'u' ? 0o4000 : w === 'g' ? 0o2000 : 0;
            if (perm.indexOf('t') >= 0 && w === 'o') bits |= 0o1000;
          }
          if (!m[1] && m[2] !== '=') bits &= ~0o022 | (perm.indexOf('w') >= 0 ? 0 : 0);
          if (m[2] === '+') nm |= bits;
          else if (m[2] === '-') nm &= ~bits;
          else {
            let mask = 0;
            for (const w of who) mask |= 7 << (w === 'u' ? 6 : w === 'g' ? 3 : 0);
            nm = (nm & ~mask) | bits;
          }
        }
      }
      return nm;
    };
    for (const f of rest.slice(1)) {
      const abs = sh.resolve(f);
      const n = sh.fs.get(abs);
      if (!n) { err(io, 'chmod', 'cannot access ' + q1(f) + ': No such file or directory'); st = 1; continue; }
      const walk = (node, path) => {
        if (node.o !== sh.user) { err(io, 'chmod', 'changing permissions of ' + q1(path) + ': Operation not permitted'); st = 1; return; }
        const nm = apply(node, path);
        if (nm === 'invalid') { err(io, 'chmod', 'invalid mode: ' + Q(mode)); io.err.write("Try 'chmod --help' for more information.\n"); st = 1; throw 'stop'; }
        if (verbose) io.out.write("mode of " + q1(path) + ' changed from ' + (node.m & 0o7777).toString(8).padStart(4, '0') + ' (' + permStr(node).slice(1) + ') to ' + (nm & 0o7777).toString(8).padStart(4, '0') + ' (' + permStr({ t: node.t, m: nm }).slice(1) + ')\n');
        node.m = nm & 0o7777;
        if (rec && node.t === 'd') for (const k of Object.keys(node.c)) walk(node.c[k], path + '/' + k);
      };
      try { walk(n, f); } catch (e) { if (e === 'stop') return 1; throw e; }
    }
    return st;
  });
  C('chown chgrp', (sh, argv, io) => {
    const a = argv.slice(1).filter(x => !x.startsWith('-'));
    if (a.length < 2) { err(io, argv[0], 'missing operand'); return 1; }
    for (const f of a.slice(1)) {
      if (!sh.fs.get(sh.resolve(f))) { err(io, argv[0], 'cannot access ' + q1(f) + ': No such file or directory'); return 1; }
      err(io, argv[0], 'changing ownership of ' + q1(f) + ': Operation not permitted');
    }
    return 1;
  });
  C('find', (sh, argv, io) => {
    const a = argv.slice(1);
    const paths = [];
    let i = 0;
    while (i < a.length && !a[i].startsWith('-') && a[i] !== '!' && a[i] !== '(') paths.push(a[i++]);
    if (!paths.length) paths.push('.');
    const tests = [];
    let maxd = Infinity, mind = 0;
    let neg = false;
    for (; i < a.length; i++) {
      const t = a[i];
      if (t === '!' || t === '-not') { neg = true; continue; }
      const push = (fn) => { const n = neg; tests.push(n ? (x) => !fn(x) : fn); neg = false; };
      if (t === '-name' || t === '-iname') { const p = a[++i] || ''; const re = U.globToRe(p); const rei = new RegExp(re.source, 'i'); push(x => (t === '-name' ? re : rei).test(x.name)); }
      else if (t === '-type') { const ty = a[++i]; push(x => (ty === 'd' ? x.n.t === 'd' : ty === 'f' ? x.n.t === 'f' : false)); }
      else if (t === '-maxdepth') maxd = parseInt(a[++i], 10);
      else if (t === '-mindepth') mind = parseInt(a[++i], 10);
      else if (t === '-empty') push(x => x.n.t === 'd' ? !Object.keys(x.n.c).length : !x.n.x);
      else if (t === '-perm') { const m = a[++i]; push(x => (x.n.m & 0o777).toString(8) === m.replace(/^0/, '')); }
      else if (t === '-size') { const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(a[++i] || ''); push(x => { if (!m) return false; const unit = { c: 1, k: 1024, M: 1048576, G: 1073741824, '': 512 }[m[3]]; const sz = Math.ceil(sizeOf(x.n) / unit); const v = parseInt(m[2], 10); return m[1] === '+' ? sz > v : m[1] === '-' ? sz < v : sz === v; }); }
      else if (t === '-print' || t === '-a' || t === '-and') {}
      else if (t === '-exec' || t === '-delete' || t === '-o') { err(io, 'find', 'действие ' + t + ' не поддерживается в симуляторе'); return 1; }
      else { err(io, 'find', 'unknown predicate ' + Q(t)); return 1; }
    }
    let st = 0;
    for (const p of paths) {
      const abs = sh.resolve(p);
      const n = sh.fs.get(abs);
      if (!n) { err(io, 'find', Q(p) + ': No such file or directory'); st = 1; continue; }
      const walk = (node, shown, name, depth) => {
        if (depth >= mind && tests.every(f => f({ n: node, name }))) io.out.write(shown + '\n');
        if (node.t === 'd' && depth < maxd) {
          if (!sh.fs.can(node, 'r')) { err(io, 'find', Q(shown) + ': Permission denied'); st = 1; return; }
          for (const k of Object.keys(node.c).sort(BS.cmpNames)) walk(node.c[k], (shown.endsWith('/') ? shown : shown + '/') + k, k, depth + 1);
        }
      };
      walk(n, p, abs.split('/').pop() || '/', 0);
    }
    return st;
  });
  C('file', (sh, argv, io) => {
    let st = 0;
    for (const f of argv.slice(1)) {
      const n = sh.fs.get(sh.resolve(f));
      let d;
      if (!n) { d = "cannot open `" + f + "' (No such file or directory)"; st = 0; }
      else if (n.t === 'd') d = 'directory';
      else if (n.t === 'c') d = 'character special (1/3)';
      else if (n.x.startsWith('\x7fELF')) d = 'ELF 64-bit LSB pie executable, x86-64, dynamically linked';
      else if (n.x === '') d = 'empty';
      else if (/^#!.*\b(bash)\b/.test(n.x)) d = 'Bourne-Again shell script, ' + (/[^\x00-\x7f]/.test(n.x) ? 'Unicode text, UTF-8 text' : 'ASCII text') + ' executable';
      else if (/^#!.*\bsh\b/.test(n.x)) d = 'POSIX shell script, ASCII text executable';
      else d = (/[^\x00-\x7f]/.test(n.x) ? 'Unicode text, UTF-8 text' : 'ASCII text');
      io.out.write(f + ': ' + d + '\n');
    }
    return st;
  });
  C('stat', (sh, argv, io) => {
    let st = 0;
    for (const f of argv.slice(1).filter(x => !x.startsWith('-'))) {
      const n = sh.fs.get(sh.resolve(f));
      if (!n) { err(io, 'stat', 'cannot statx ' + q1(f) + ': No such file or directory'); st = 1; continue; }
      const d = new Date(n.mt);
      const ts = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.000000000 +0500';
      io.out.write('  File: ' + f + '\n  Size: ' + sizeOf(n) + '\t\tBlocks: 8          IO Block: 4096   ' + (n.t === 'd' ? 'directory' : 'regular file') + '\nAccess: (' + (n.m & 0o7777).toString(8).padStart(4, '0') + '/' + permStr(n) + ')  Uid: ( ' + (n.o === 'root' ? '   0/    root' : '1000/ student') + ')   Gid: ( ' + (n.o === 'root' ? '   0/    root' : '1000/ student') + ')\nModify: ' + ts + '\n');
    }
    return st;
  });
  C('tee', (sh, argv, io) => {
    const o = opts(argv, { flags: 'ai' }, io);
    if (!o) return 1;
    const data = io.in ? io.in.readAll() : '';
    let st = 0;
    for (const f of o._) {
      try { const n = sh.fs.openWrite(sh.resolve(f), !!o.a); n.x += data; }
      catch (e) { if (e instanceof FsError) { err(io, 'tee', f + ': ' + e.message); st = 1; continue; } throw e; }
    }
    io.out.write(data);
    return st;
  });

  /* ---------------- head / tail ---------------- */
  function headTail(sh, argv, io, tail) {
    const name = tail ? 'tail' : 'head';
    const o = opts(argv, { flags: 'qvf', args: 'nc', numeric: true, long: { '--lines': 'n', '--bytes': 'c', '--quiet': 'q' } }, io);
    if (!o) return 1;
    let nspec = o.n != null ? o.n : (o.num != null ? o.num : '10');
    const fromStart = tail && /^\+/.test(nspec);
    const neg = !tail && /^-/.test(nspec);
    const n = parseInt(String(nspec).replace(/^[+-]/, ''), 10);
    if (isNaN(n)) { err(io, name, 'invalid number of lines: ' + Q(nspec)); return 1; }
    const st = { s: 0 };
    const ins = inputs(sh, o._, io, name, st);
    ins.forEach((inp, k) => {
      if (ins.length > 1 && !o.q) io.out.write((k ? '\n' : '') + '==> ' + (inp.name === '-' ? 'standard input' : inp.name) + ' <==\n');
      if (o.c != null) {
        const c = parseInt(o.c, 10);
        io.out.write(tail ? inp.data.slice(-c) : inp.data.slice(0, c));
        return;
      }
      const ls = inp.data.split('\n');
      const endNl = inp.data.endsWith('\n');
      if (endNl) ls.pop();
      let sel;
      if (tail) sel = fromStart ? ls.slice(Math.max(0, n - 1)) : (n === 0 ? [] : ls.slice(-n));
      else sel = neg ? ls.slice(0, Math.max(0, ls.length - n)) : ls.slice(0, n);
      if (!sel.length) return;
      const lastIncluded = tail ? true : (neg ? false : sel.length === ls.length);
      io.out.write(sel.join('\n') + ((lastIncluded && !endNl) ? '' : '\n'));
    });
    return st.s;
  }
  C('head', (sh, argv, io) => headTail(sh, argv, io, false));
  C('tail', (sh, argv, io) => headTail(sh, argv, io, true));

  /* ---------------- wc ---------------- */
  C('wc', (sh, argv, io) => {
    const o = opts(argv, { flags: 'lwcmL', long: { '--lines': 'l', '--words': 'w', '--bytes': 'c', '--chars': 'm' } }, io);
    if (!o) return 1;
    const sel = [];
    if (o.l) sel.push('l'); if (o.w) sel.push('w'); if (o.m) sel.push('m'); if (o.c) sel.push('c'); if (o.L) sel.push('L');
    if (!sel.length) sel.push('l', 'w', 'c');
    const st = { s: 0 };
    const ins = inputs(sh, o._, io, 'wc', st);
    const rows = [];
    const tot = { l: 0, w: 0, c: 0, m: 0, L: 0 };
    let anyStdin = false;
    for (const inp of ins) {
      const d = inp.data;
      const r = {
        l: (d.match(/\n/g) || []).length,
        w: (d.match(/\S+/g) || []).length,
        c: byteLen(d),
        m: Array.from(d).length,
        L: Math.max(0, ...d.split('\n').map(x => Array.from(x).length)),
      };
      for (const k in tot) tot[k] = k === 'L' ? Math.max(tot.L, r.L) : tot[k] + r[k];
      if (inp.name === '-') anyStdin = true;
      rows.push({ r, name: inp.name === '-' ? (o._.length ? '-' : '') : inp.name });
    }
    if (ins.length > 1) rows.push({ r: tot, name: 'total' });
    let width;
    if (sel.length === 1 && rows.length === 1) width = 1;
    else if (anyStdin) width = 7;
    else { let bytes = 0; for (const inp of ins) bytes += byteLen(inp.data); width = Math.max(1, String(bytes).length); }
    for (const row of rows) io.out.write(sel.map(k => String(row.r[k]).padStart(width)).join(' ') + (row.name ? ' ' + row.name : '') + '\n');
    return st.s;
  });

  /* ---------------- sort / uniq ---------------- */
  C('sort', (sh, argv, io) => {
    const o = opts(argv, { flags: 'nrufbhVsMR', args: 'kto', long: { '--numeric-sort': 'n', '--reverse': 'r', '--unique': 'u', '--ignore-case': 'f', '--key': 'k', '--field-separator': 't', '--output': 'o' } }, io);
    if (!o) return 2;
    const st = { s: 0 };
    let all = [];
    for (const inp of inputs(sh, o._, io, 'sort', st)) all = all.concat(lines(inp.data));
    const keys = [];
    if (o.k) {
      for (const ks of String(o.k).split(' ')) {
        const m = /^(\d+)(?:\.(\d+))?([a-zA-Z]*)(?:,(\d+)(?:\.(\d+))?([a-zA-Z]*))?$/.exec(ks);
        if (!m) { err(io, 'sort', 'invalid number at field start: invalid count at start of ' + Q(ks)); return 2; }
        keys.push({ f1: parseInt(m[1], 10), f2: m[4] ? parseInt(m[4], 10) : null, flags: (m[3] || '') + (m[6] || '') });
      }
    }
    const sep = o.t;
    const fieldsOf = (line) => {
      if (sep != null) return line.split(sep);
      const out = []; const re = /\s*\S+/g; let m;
      while ((m = re.exec(line))) out.push(m[0]);
      return out;
    };
    const keyText = (line, k) => {
      const f = fieldsOf(line);
      const a = k.f1 - 1, b = k.f2 == null ? f.length - 1 : k.f2 - 1;
      return f.slice(a, b + 1).join(sep != null ? sep : '');
    };
    const num = (s) => { const m = /^\s*([+-]?\d*\.?\d+)/.exec(s); return m ? parseFloat(m[1]) : 0; };
    const hnum = (s) => { const m = /^\s*([+-]?\d*\.?\d+)([KMGTP]?)/i.exec(s); if (!m) return 0; return parseFloat(m[1]) * Math.pow(1024, ' KMGTP'.indexOf((m[2] || ' ').toUpperCase())); };
    const cmpStr = (a, b, fold) => { if (fold) { a = a.toUpperCase(); b = b.toUpperCase(); } return a < b ? -1 : a > b ? 1 : 0; };
    const cmpBy = (a, b, flags) => {
      const numeric = flags.indexOf('n') >= 0 || (!flags && o.n);
      const human = flags.indexOf('h') >= 0 || (!flags && o.h);
      const fold = flags.indexOf('f') >= 0 || o.f;
      const ign = flags.indexOf('b') >= 0 || o.b;
      if (human) return hnum(a) - hnum(b);
      if (numeric) return num(a) - num(b);
      if (ign) { a = a.replace(/^\s+/, ''); b = b.replace(/^\s+/, ''); }
      return cmpStr(a, b, fold);
    };
    const rev = (flags) => (flags.indexOf('r') >= 0) !== !!o.r ? -1 : 1;
    const cmp = (a, b) => {
      if (keys.length) {
        for (const k of keys) { const c = cmpBy(keyText(a, k), keyText(b, k), k.flags) * (k.flags.indexOf('r') >= 0 ? -1 : 1); if (c) return o.r ? -c : c; }
      } else {
        const c = cmpBy(a, b, '');
        if (c) return o.r ? -c : c;
      }
      if (o.s || o.u) return 0;
      const c = cmpStr(a, b, false);
      return o.r ? -c : c;
    };
    all = all.map((l, i) => ({ l, i })).sort((x, y) => cmp(x.l, y.l) || x.i - y.i).map(x => x.l);
    if (o.u) all = all.filter((l, i) => i === 0 || cmp(all[i - 1], l) !== 0);
    if (o.R) all.sort(() => Math.random() - 0.5);
    const text = joinLines(all);
    if (o.o) { try { sh.fs.writeFile(sh.resolve(o.o), text); } catch (e) { err(io, 'sort', 'open failed: ' + o.o + ': ' + e.message); return 2; } }
    else io.out.write(text);
    return st.s;
  });
  C('uniq', (sh, argv, io) => {
    const o = opts(argv, { flags: 'cduiz', long: { '--count': 'c', '--repeated': 'd', '--unique': 'u', '--ignore-case': 'i' } }, io);
    if (!o) return 1;
    const st = { s: 0 };
    const ins = inputs(sh, o._.slice(0, 1), io, 'uniq', st);
    if (!ins.length) return st.s;
    const ls = lines(ins[0].data);
    const groups = [];
    for (const l of ls) {
      const g = groups[groups.length - 1];
      if (g && (o.i ? g.l.toLowerCase() === l.toLowerCase() : g.l === l)) g.n++;
      else groups.push({ l, n: 1 });
    }
    const out = groups.filter(g => (o.d ? g.n > 1 : true) && (o.u ? g.n === 1 : true)).map(g => (o.c ? String(g.n).padStart(7) + ' ' : '') + g.l);
    const text = joinLines(out);
    if (o._[1]) sh.fs.writeFile(sh.resolve(o._[1]), text); else io.out.write(text);
    return st.s;
  });

  /* ---------------- grep ---------------- */
  C('grep egrep fgrep', (sh, argv, io) => {
    const o = opts(argv, { flags: 'ivcnlLhHoqswxEFGrRZ', args: 'eABCmf', long: { '--color': null, '--colour': null, '--ignore-case': 'i', '--invert-match': 'v', '--count': 'c', '--line-number': 'n', '--files-with-matches': 'l', '--only-matching': 'o', '--quiet': 'q', '--word-regexp': 'w', '--line-regexp': 'x', '--extended-regexp': 'E', '--fixed-strings': 'F', '--recursive': 'r' } }, io);
    if (!o) return 2;
    const color = argv.some(a => /^--colou?r(=auto|=always)?$/.test(a)) && io.out.tty;
    const ere = o.E || argv[0] === 'egrep';
    const fixed = o.F || argv[0] === 'fgrep';
    let pats = [];
    let files = o._;
    if (o.e != null) pats.push(o.e);
    else {
      if (!files.length) { io.err.write('Usage: grep [OPTION]... PATTERNS [FILE]...\nTry \'grep --help\' for more information.\n'); return 2; }
      pats.push(files[0]); files = files.slice(1);
    }
    pats = pats.flatMap(p => p.split('\n'));
    let src = pats.map(p => fixed ? p.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&') : U.posixToJs(p, !ere)).map(s => '(?:' + s + ')').join('|');
    if (o.w) src = '(?<![A-Za-z0-9_\\u0400-\\u04FF])(?:' + src + ')(?![A-Za-z0-9_\\u0400-\\u04FF])';
    if (o.x) src = '^(?:' + src + ')$';
    let re;
    try { re = new RegExp(src, o.i ? 'gi' : 'g'); }
    catch (e) { err(io, 'grep', 'Unmatched ( or \\('); return 2; }
    const st = { s: 0 };
    // рекурсия
    if (o.r || o.R) {
      if (!files.length) files = ['.'];
      const exp = [];
      for (const f of files) {
        const abs = sh.resolve(f); const n = sh.fs.get(abs);
        if (!n) { err(io, 'grep', f + ': No such file or directory'); st.s = 2; continue; }
        const walk = (node, shown) => {
          if (node.t === 'd') { for (const k of Object.keys(node.c).sort(BS.cmpNames)) walk(node.c[k], (shown === '.' ? '' : shown.replace(/\/$/, '') + '/') + k); }
          else if (node.t === 'f') exp.push(shown);
        };
        walk(n, f);
      }
      files = exp;
    }
    const multi = files.length > 1 || o.r || o.R;
    const showName = o.H || (multi && !o.h);
    let any = false;
    const ins = [];
    if (!files.length) ins.push(...inputs(sh, [], io, 'grep', st));
    else for (const f of files) {
      const abs = sh.resolve(f); const n = sh.fs.get(abs);
      if (n && n.t === 'd') { err(io, 'grep', f + ': Is a directory'); st.s = 2; continue; }
      ins.push(...inputs(sh, [f], io, 'grep', st));
    }
    if (st.s) st.s = 2;
    let out = '';
    for (const inp of ins) {
      const ls = lines(inp.data);
      let cnt = 0;
      const nm = inp.name === '-' ? '(standard input)' : inp.name;
      const pre = (k) => (showName ? (color ? '\x1b[35m' + nm + '\x1b[36m:\x1b[0m' : nm + ':') : '') + (o.n ? (color ? '\x1b[32m' + (k + 1) + '\x1b[36m:\x1b[0m' : (k + 1) + ':') : '');
      for (let k = 0; k < ls.length; k++) {
        const l = ls[k];
        re.lastIndex = 0;
        const hit = re.test(l);
        if (hit === !!o.v) continue;
        cnt++;
        any = true;
        if (o.q || o.l || o.L || o.c) { if (o.m && cnt >= parseInt(o.m, 10)) break; continue; }
        if (o.o && !o.v) {
          re.lastIndex = 0; let m;
          while ((m = re.exec(l))) { if (m[0] === '') { re.lastIndex++; continue; } out += pre(k) + (color ? '\x1b[01;31m\x1b[K' + m[0] + '\x1b[m\x1b[K' : m[0]) + '\n'; }
        } else {
          let shown = l;
          if (color && !o.v) { re.lastIndex = 0; shown = l.replace(re, (x) => x ? '\x1b[01;31m\x1b[K' + x + '\x1b[m\x1b[K' : x); }
          out += pre(k) + shown + '\n';
        }
        if (o.m && cnt >= parseInt(o.m, 10)) break;
      }
      if (o.c) out += (showName ? nm + ':' : '') + cnt + '\n';
      if (o.l && cnt) out += nm + '\n';
      if (o.L && !cnt) out += nm + '\n';
      if (o.q && any) break;
    }
    if (!o.q) io.out.write(out);
    if (st.s === 2 && !any) return 2;
    return any ? 0 : 1;
  });

  /* ---------------- cut / tr / paste ---------------- */
  function parseList(spec) {
    const r = [];
    for (const part of spec.split(',')) {
      const m = /^(\d*)(-?)(\d*)$/.exec(part);
      if (!m || (!m[1] && !m[3])) return null;
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? (m[3] ? parseInt(m[3], 10) : Infinity) : a;
      r.push([a, b]);
    }
    return r;
  }
  C('cut', (sh, argv, io) => {
    const o = opts(argv, { flags: 's', args: 'dfcb', long: { '--delimiter': 'd', '--fields': 'f', '--characters': 'c', '--output-delimiter': 'O', '--complement': null } }, io);
    if (!o) return 1;
    const spec = o.f || o.c || o.b;
    if (!spec) { err(io, 'cut', 'you must specify a list of bytes, characters, or fields'); io.err.write("Try 'cut --help' for more information.\n"); return 1; }
    const list = parseList(spec);
    if (!list) { err(io, 'cut', 'invalid field value ' + Q(spec)); return 1; }
    const inList = (i) => list.some(([a, b]) => i >= a && i <= b);
    const d = o.d != null ? o.d : '\t';
    if (d.length > 1 && o.f) { err(io, 'cut', 'the delimiter must be a single character'); return 1; }
    const outD = o.O != null ? o.O : d;
    const st = { s: 0 };
    let out = '';
    for (const inp of inputs(sh, o._, io, 'cut', st)) {
      for (const l of lines(inp.data)) {
        if (o.f) {
          if (l.indexOf(d) < 0) { if (!o.s) out += l + '\n'; continue; }
          const parts = l.split(d);
          out += parts.filter((p, i) => inList(i + 1)).join(outD) + '\n';
        } else {
          const ch = Array.from(l);
          out += ch.filter((c, i) => inList(i + 1)).join('') + '\n';
        }
      }
    }
    io.out.write(out);
    return st.s;
  });
  function expandSet(s) {
    const out = [];
    let i = 0;
    const ch = Array.from(s);
    const esc = (c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' })[c];
    while (i < ch.length) {
      if (ch[i] === '[' && ch[i + 1] === ':') {
        const rest = ch.slice(i).join('');
        const m = /^\[:(\w+):\]/.exec(rest);
        if (m) {
          const cls = m[1];
          const add = (a, b) => { for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out.push(String.fromCharCode(c)); };
          if (cls === 'lower') { add('a', 'z'); }
          else if (cls === 'upper') { add('A', 'Z'); }
          else if (cls === 'digit') add('0', '9');
          else if (cls === 'alpha') { add('A', 'Z'); add('a', 'z'); }
          else if (cls === 'alnum') { add('0', '9'); add('A', 'Z'); add('a', 'z'); }
          else if (cls === 'space') out.push(' ', '\t', '\n', '\r', '\v', '\f');
          else if (cls === 'blank') out.push(' ', '\t');
          else if (cls === 'punct') for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') out.push(c);
          i += Array.from(m[0]).length; continue;
        }
      }
      let c = ch[i];
      if (c === '\\' && i + 1 < ch.length) { c = esc(ch[i + 1]) != null ? esc(ch[i + 1]) : ch[i + 1]; i += 2; }
      else i++;
      if (ch[i] === '-' && i + 1 < ch.length) {
        let e = ch[i + 1]; i += 2;
        if (e === '\\' && i < ch.length) { e = esc(ch[i]) != null ? esc(ch[i]) : ch[i]; i++; }
        const a = c.codePointAt(0), b = e.codePointAt(0);
        for (let k = a; k <= b; k++) out.push(String.fromCodePoint(k));
        continue;
      }
      out.push(c);
    }
    return out;
  }
  C('tr', (sh, argv, io) => {
    const o = opts(argv, { flags: 'dscC' }, io);
    if (!o) return 1;
    if (!o._.length) { err(io, 'tr', 'missing operand'); io.err.write("Try 'tr --help' for more information.\n"); return 1; }
    const s1 = expandSet(o._[0]);
    const s2 = o._[1] != null ? expandSet(o._[1]) : null;
    if (!o.d && !o.s && s2 == null) { err(io, 'tr', 'missing operand after ' + Q(o._[0])); io.err.write('Two strings must be given when translating.\n'); return 1; }
    const data = Array.from(io.in ? io.in.readAll() : '');
    const set1 = new Set(s1);
    const inS1 = (c) => (o.c || o.C) ? !set1.has(c) : set1.has(c);
    let out = [];
    if (o.d) {
      out = data.filter(c => !inS1(c));
      if (o.s && s2) { const sq = new Set(s2); out = out.filter((c, i) => !(i > 0 && c === out[i - 1] && sq.has(c))); }
    } else if (s2) {
      const map = new Map();
      s1.forEach((c, i) => map.set(c, s2[Math.min(i, s2.length - 1)]));
      out = data.map(c => (o.c || o.C) ? (inS1(c) ? s2[s2.length - 1] : c) : (map.has(c) ? map.get(c) : c));
      if (o.s) { const sq = new Set(s2); out = out.filter((c, i) => !(i > 0 && c === out[i - 1] && sq.has(c))); }
    } else if (o.s) {
      out = data.filter((c, i) => !(i > 0 && c === data[i - 1] && inS1(c)));
    }
    io.out.write(out.join(''));
    return 0;
  });
  C('paste', (sh, argv, io) => {
    const o = opts(argv, { flags: 's', args: 'd' }, io);
    if (!o) return 1;
    const st = { s: 0 };
    const ins = inputs(sh, o._, io, 'paste', st).map(x => lines(x.data));
    const d = o.d != null ? o.d : '\t';
    if (o.s) { io.out.write(ins.map(l => l.join(d)).join('\n') + '\n'); return st.s; }
    const n = Math.max(0, ...ins.map(l => l.length));
    let out = '';
    for (let i = 0; i < n; i++) out += ins.map(l => l[i] == null ? '' : l[i]).join(d) + '\n';
    io.out.write(out);
    return st.s;
  });

  /* ---------------- sed (упрощённый) ---------------- */
  C('sed', (sh, argv, io) => {
    const o = opts(argv, { flags: 'nErsi', args: 'e', long: { '--quiet': 'n', '--regexp-extended': 'E', '--in-place': 'i' } }, io);
    if (!o) return 1;
    let script = o.e;
    let files = o._;
    if (script == null) { if (!files.length) { io.err.write('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n'); return 1; } script = files[0]; files = files.slice(1); }
    const ere = o.E || o.r;
    // разбор скрипта
    const cmds = [];
    let i = 0;
    const s = script;
    const readRe = (delim) => { let r = ''; while (i < s.length && s[i] !== delim) { if (s[i] === '\\' && s[i + 1] === delim) { r += delim; i += 2; continue; } if (s[i] === '\\') { r += s[i] + (s[i + 1] || ''); i += 2; continue; } r += s[i++]; } i++; return r; };
    const mkRe = (src, flags) => new RegExp(U.posixToJs(src, !ere), flags);
    const readAddr = () => {
      while (s[i] === ' ') i++;
      if (/\d/.test(s[i])) { let n = ''; while (/\d/.test(s[i])) n += s[i++]; return { line: parseInt(n, 10) }; }
      if (s[i] === '$') { i++; return { last: true }; }
      if (s[i] === '/') { i++; return { re: mkRe(readRe('/'), '') }; }
      return null;
    };
    try {
      while (i < s.length) {
        while (i < s.length && /[\s;]/.test(s[i])) i++;
        if (i >= s.length) break;
        const a1 = readAddr();
        let a2 = null;
        if (a1 && s[i] === ',') { i++; a2 = readAddr(); }
        while (s[i] === ' ') i++;
        let neg = false;
        if (s[i] === '!') { neg = true; i++; }
        const c = s[i++];
        const cmd = { a1, a2, neg, c };
        if (c === 's') {
          const delim = s[i++];
          const pat = readRe(delim);
          const rep = readRe(delim);
          let flags = '';
          while (i < s.length && /[gipI0-9]/.test(s[i])) flags += s[i++];
          cmd.re = mkRe(pat, (flags.indexOf('g') >= 0 ? 'g' : '') + (/[iI]/.test(flags) ? 'i' : ''));
          cmd.rep = rep; cmd.print = flags.indexOf('p') >= 0;
          const nth = /\d+/.exec(flags); cmd.nth = nth ? parseInt(nth[0], 10) : 0;
        } else if (c === 'y') {
          const delim = s[i++]; cmd.from = Array.from(readRe(delim)); cmd.to = Array.from(readRe(delim));
        } else if (c === 'a' || c === 'i' || c === 'c') {
          while (s[i] === ' ' || s[i] === '\\') i++;
          let t = ''; while (i < s.length && s[i] !== ';' && s[i] !== '\n') t += s[i++];
          cmd.text = t;
        } else if (c === 'p' || c === 'd' || c === 'q' || c === '=') { /* ok */ }
        else throw new Error('unknown command: ' + Q(c || ''));
        cmds.push(cmd);
      }
    } catch (e) { err(io, 'sed', '-e expression #1, char ' + i + ': ' + (e.message.startsWith('unknown') ? e.message : 'unterminated `s\' command')); return 1; }
    const run = (data) => {
      const ls = lines(data);
      let out = '';
      const ranges = cmds.map(() => ({ on: false }));
      for (let ln = 0; ln < ls.length; ln++) {
        let line = ls[ln];
        let deleted = false; let quit = false;
        let append = '';
        const isLast = ln === ls.length - 1;
        const matchA = (a) => a.line != null ? a.line === ln + 1 : a.last ? isLast : a.re.test(line);
        for (let k = 0; k < cmds.length && !deleted; k++) {
          const c = cmds[k];
          let sel = true;
          if (c.a1 && !c.a2) sel = matchA(c.a1);
          else if (c.a1 && c.a2) {
            const r = ranges[k];
            if (!r.on) { if (matchA(c.a1)) { r.on = true; sel = true; if (c.a2.line != null && c.a2.line <= ln + 1) r.on = false; } else sel = false; }
            else { sel = true; if (matchA(c.a2)) r.on = false; }
          }
          if (c.neg) sel = !sel;
          if (!sel) continue;
          switch (c.c) {
            case 's': {
              let n = 0; let did = false;
              c.re.lastIndex = 0;
              const repl = (m, ...g) => {
                n++;
                if (c.nth && n !== c.nth) return m;
                did = true;
                return c.rep.replace(/\\(\d)|&|\\n|\\t|\\&|\\\\/g, (x, d) => d != null ? (g[parseInt(d, 10) - 1] || '') : x === '&' ? m : x === '\\n' ? '\n' : x === '\\t' ? '\t' : x === '\\&' ? '&' : '\\');
              };
              line = c.nth ? line.replace(new RegExp(c.re.source, c.re.flags.indexOf('g') >= 0 ? c.re.flags : c.re.flags + 'g'), repl) : line.replace(c.re, repl);
              if (did && c.print) out += line + '\n';
              break;
            }
            case 'y': line = Array.from(line).map(ch => { const p = c.from.indexOf(ch); return p >= 0 ? c.to[p] : ch; }).join(''); break;
            case 'p': out += line + '\n'; break;
            case 'd': deleted = true; break;
            case 'q': quit = true; break;
            case '=': out += (ln + 1) + '\n'; break;
            case 'a': append += c.text + '\n'; break;
            case 'i': out += c.text + '\n'; break;
            case 'c': out += c.text + '\n'; deleted = true; break;
          }
          if (quit) break;
        }
        if (!deleted && !o.n) out += line + '\n';
        out += append;
        if (quit) break;
      }
      return out;
    };
    const st = { s: 0 };
    if (o.i) {
      for (const f of files) {
        try { const abs = sh.resolve(f); sh.fs.writeFile(abs, run(sh.fs.readFile(abs))); }
        catch (e) { err(io, 'sed', "can't read " + f + ': ' + e.message); st.s = 2; }
      }
      return st.s;
    }
    for (const inp of inputs(sh, files, io, 'sed', st)) io.out.write(run(inp.data));
    return st.s ? 2 : 0;
  });

  /* ---------------- awk (очень упрощённый) ---------------- */
  C('awk gawk mawk', (sh, argv, io) => BS.awk ? BS.awk(sh, argv, io) : (err(io, 'awk', 'недоступно'), 2));

  /* ---------------- seq / date / sleep ---------------- */
  C('seq', (sh, argv, io) => {
    const o = opts(argv, { flags: 'w', args: 'sf', negNum: true }, io);
    if (!o) return 1;
    const a = o._;
    if (!a.length) { err(io, 'seq', 'missing operand'); io.err.write("Try 'seq --help' for more information.\n"); return 1; }
    for (const x of a) if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(x)) { err(io, 'seq', 'invalid floating point argument: ' + Q(x)); io.err.write("Try 'seq --help' for more information.\n"); return 1; }
    let first = 1, inc = 1, last;
    if (a.length === 1) last = parseFloat(a[0]);
    else if (a.length === 2) { first = parseFloat(a[0]); last = parseFloat(a[1]); }
    else { first = parseFloat(a[0]); inc = parseFloat(a[1]); last = parseFloat(a[2]); }
    if (inc === 0) { err(io, 'seq', 'invalid Zero increment value: ' + Q(a[1])); return 1; }
    const dec = Math.max(...a.map(x => (x.split('.')[1] || '').length));
    const out = [];
    const sep = o.s != null ? o.s : '\n';
    let count = 0;
    for (let v = first; inc > 0 ? v <= last + 1e-9 : v >= last - 1e-9; v = first + inc * (++count)) {
      let t = dec ? v.toFixed(dec) : String(Math.round(v));
      out.push(t);
      if (out.length > 200000) break;
    }
    if (o.w) { const w = Math.max(...out.map(x => x.length)); for (let k = 0; k < out.length; k++) out[k] = out[k].padStart(w, '0'); }
    if (out.length) io.out.write(out.join(sep) + '\n');
    return 0;
  });
  function strftime(fmt, d) {
    return fmt.replace(/%([-_0^#]?)([a-zA-Z%])/g, (m, fl, c) => {
      const pad = (n, w) => fl === '-' ? String(n) : String(n).padStart(w, fl === '_' ? ' ' : '0');
      let r;
      switch (c) {
        case 'Y': r = String(d.getFullYear()); break;
        case 'y': r = pad(d.getFullYear() % 100, 2); break;
        case 'm': r = pad(d.getMonth() + 1, 2); break;
        case 'd': r = pad(d.getDate(), 2); break;
        case 'e': r = String(d.getDate()).padStart(2, ' '); break;
        case 'H': r = pad(d.getHours(), 2); break;
        case 'I': r = pad(d.getHours() % 12 || 12, 2); break;
        case 'M': r = pad(d.getMinutes(), 2); break;
        case 'S': r = pad(d.getSeconds(), 2); break;
        case 'p': r = d.getHours() < 12 ? 'AM' : 'PM'; break;
        case 'A': r = DAYS_FULL[d.getDay()]; break;
        case 'a': r = DAYS[d.getDay()]; break;
        case 'B': r = MONTHS_FULL[d.getMonth()]; break;
        case 'b': case 'h': r = MONTHS[d.getMonth()]; break;
        case 'j': { const st = new Date(d.getFullYear(), 0, 1); r = pad(Math.floor((d - st) / 86400000) + 1, 3); break; }
        case 'u': r = String(d.getDay() || 7); break;
        case 'w': r = String(d.getDay()); break;
        case 's': r = String(Math.floor(d.getTime() / 1000)); break;
        case 'F': r = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); break;
        case 'T': r = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); break;
        case 'R': r = p2(d.getHours()) + ':' + p2(d.getMinutes()); break;
        case 'D': r = p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + '/' + p2(d.getFullYear() % 100); break;
        case 'Z': r = '+05'; break;
        case 'z': r = '+0500'; break;
        case 'N': r = String(d.getMilliseconds() * 1000000).padStart(9, '0'); break;
        case 'n': r = '\n'; break;
        case 't': r = '\t'; break;
        case '%': r = '%'; break;
        default: return m;
      }
      if (fl === '^') r = r.toUpperCase();
      return r;
    });
  }
  C('date', (sh, argv, io) => {
    let d = new Date();
    let fmt = null;
    const a = argv.slice(1);
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x.startsWith('+')) fmt = x.slice(1);
      else if (x === '-d' || x === '--date') {
        const v = a[++i] || '';
        if (/^(tomorrow|завтра)$/i.test(v)) d = new Date(Date.now() + 86400000);
        else if (/^(yesterday|вчера)$/i.test(v)) d = new Date(Date.now() - 86400000);
        else if (/^@\d+$/.test(v)) d = new Date(parseInt(v.slice(1), 10) * 1000);
        else { const t = Date.parse(v); if (isNaN(t)) { err(io, 'date', 'invalid date ' + Q(v)); return 1; } d = new Date(t); }
      } else if (x.startsWith('--date=')) { const t = Date.parse(x.slice(7)); if (!isNaN(t)) d = new Date(t); }
      else if (x === '-u' || x === '-R' || x === '-I') {}
      else { err(io, 'date', 'invalid date ' + Q(x)); return 1; }
    }
    if (fmt == null) fmt = '%a %b %e %H:%M:%S %Z %Y';
    io.out.write(strftime(fmt, d) + '\n');
    return 0;
  });
  C('sleep', (sh, argv, io) => {
    if (argv.length < 2) { err(io, 'sleep', 'missing operand'); return 1; }
    for (const x of argv.slice(1)) if (!/^\d*\.?\d+[smhd]?$/.test(x)) { err(io, 'sleep', 'invalid time interval ' + Q(x)); return 1; }
    return 0;
  });

  /* ---------------- информация о системе ---------------- */
  C('whoami', (sh, argv, io) => { io.out.write(sh.user + '\n'); return 0; });
  C('logname', (sh, argv, io) => { io.out.write(sh.user + '\n'); return 0; });
  C('id', (sh, argv, io) => {
    const a = argv.slice(1);
    if (a.includes('-u')) io.out.write('1000\n');
    else if (a.includes('-un') || (a.includes('-u') && a.includes('-n'))) io.out.write('student\n');
    else if (a.includes('-g')) io.out.write('1000\n');
    else if (a.includes('-G')) io.out.write('1000 4 27 1500\n');
    else if (a.includes('-Gn')) io.out.write('student adm sudo devops\n');
    else io.out.write('uid=1000(student) gid=1000(student) groups=1000(student),4(adm),27(sudo),1500(devops)\n');
    return 0;
  });
  C('groups', (sh, argv, io) => { io.out.write('student adm sudo devops\n'); return 0; });
  C('hostname', (sh, argv, io) => { io.out.write(argv.includes('-I') ? '192.168.10.25\n' : 'lab10-pc\n'); return 0; });
  C('uname', (sh, argv, io) => {
    const a = argv.slice(1).join('');
    if (/a/.test(a)) io.out.write('Linux lab10-pc 6.8.0-48-generic #48-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux\n');
    else {
      const parts = [];
      if (!a || /s/.test(a)) parts.push('Linux');
      if (/n/.test(a)) parts.push('lab10-pc');
      if (/r/.test(a)) parts.push('6.8.0-48-generic');
      if (/m/.test(a)) parts.push('x86_64');
      if (/o/.test(a)) parts.push('GNU/Linux');
      io.out.write(parts.join(' ') + '\n');
    }
    return 0;
  });
  C('uptime', (sh, argv, io) => { const d = new Date(); io.out.write(' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + ' up  1:12,  1 user,  load average: 0.08, 0.05, 0.01\n'); return 0; });
  C('free', (sh, argv, io) => { io.out.write('               total        used        free      shared  buff/cache   available\nMem:         4011340     1022584     2154980       16336     1083720     2988756\nSwap:        2097148           0     2097148\n'); return 0; });
  C('df', (sh, argv, io) => { io.out.write('Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/sda2       40970464 9876512  28982272  26% /\ntmpfs            2005668       0   2005668   0% /dev/shm\n'); return 0; });
  C('du', (sh, argv, io) => {
    const targets = argv.slice(1).filter(x => !x.startsWith('-'));
    const sum = (n) => n.t === 'd' ? 4 + Object.values(n.c).reduce((a, c) => a + sum(c), 0) : Math.ceil(sizeOf(n) / 4096) * 4;
    for (const t of (targets.length ? targets : ['.'])) { const n = sh.fs.get(sh.resolve(t)); if (!n) { err(io, 'du', 'cannot access ' + q1(t) + ': No such file or directory'); return 1; } io.out.write(sum(n) + '\t' + t + '\n'); }
    return 0;
  });
  C('ps', (sh, argv, io) => { io.out.write('    PID TTY          TIME CMD\n   ' + (sh.rootPid || sh.pid) + ' pts/0    00:00:00 bash\n   ' + (sh.pid + 1) + ' pts/0    00:00:00 ps\n'); return 0; });
  C('kill', (sh, argv, io) => { if (argv.length < 2) { io.err.write('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n'); return 2; } err(io, 'bash: kill', '(' + argv[argv.length - 1] + ') - No such process'); return 1; });
  C('tty', (sh, argv, io) => { io.out.write('/dev/pts/0\n'); return 0; });
  C('env printenv', (sh, argv, io) => {
    const seen = new Map();
    for (const s of sh.scopes) for (const [k, v] of s) if (v.ex && v.v != null) seen.set(k, v.v);
    seen.set('PWD', sh.cwd);
    if (argv[0] === 'printenv' && argv.length > 1) {
      let st = 0;
      for (const n of argv.slice(1)) { if (seen.has(n)) io.out.write(seen.get(n) + '\n'); else st = 1; }
      return st;
    }
    if (argv[0] === 'env' && argv.length > 1) {
      // env VAR=val cmd ...
      const a = argv.slice(1); const assigns = [];
      while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) assigns.push(a.shift());
      if (!a.length) { for (const x of assigns) { const k = x.split('=')[0]; seen.set(k, x.slice(k.length + 1)); } }
      else {
        const sub = sh.fork();
        for (const x of assigns) { const k = x.split('=')[0]; sub.setVar(k, null, x.slice(k.length + 1), false); sub.getVarObj(k).ex = true; }
        return sub.invoke(a, io, true);
      }
    }
    for (const k of Array.from(seen.keys()).sort()) io.out.write(k + '=' + seen.get(k) + '\n');
    return 0;
  });
  C('getent', (sh, argv, io) => {
    const db = argv[1];
    const files = { passwd: '/etc/passwd', group: '/etc/group', shells: '/etc/shells' };
    if (!files[db]) { io.err.write("Unknown database: " + (db || '') + "\nTry 'getent --help' or 'getent --usage' for more information.\n"); return 1; }
    let ls = lines(sh.fs.get(files[db]).x).filter(l => !l.startsWith('#'));
    if (argv.length > 2) {
      const keys = argv.slice(2);
      ls = ls.filter(l => keys.includes(l.split(':')[0]) || keys.includes(l.split(':')[2]));
      if (!ls.length) return 2;
    }
    io.out.write(joinLines(ls));
    return 0;
  });
  C('which', (sh, argv, io) => {
    const all = argv.includes('-a');
    let st = 0;
    for (const n of argv.slice(1).filter(x => x !== '-a')) {
      const found = [];
      if (n.indexOf('/') >= 0) { if (sh.fs.isFile(sh.resolve(n)) && sh.fs.can(sh.fs.get(sh.resolve(n)), 'x')) found.push(n); }
      else {
        for (const d of sh.getStr('PATH').split(':')) {
          if (!d) continue;
          const p = VFS.normalize(n, d);
          const node = sh.fs.get(p);
          if (node && node.t === 'f' && sh.fs.can(node, 'x')) found.push(p);
          else if ((d === '/usr/bin' || (d === '/bin' && ['bash', 'sh', 'dash', 'rbash', 'ls', 'cat', 'echo', 'grep', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'date', 'pwd'].includes(n))) && (COMMANDS[n] || ['echo', 'printf', 'test', '[', 'true', 'false', 'pwd', 'kill'].includes(n)) && !(node && node.t === 'f')) found.push(p);
        }
      }
      const uniq = Array.from(new Set(found));
      if (!uniq.length) { st = 1; continue; }
      io.out.write((all ? uniq : uniq.slice(0, 1)).join('\n') + '\n');
    }
    return st;
  });
  C('whereis', (sh, argv, io) => { for (const n of argv.slice(1)) io.out.write(n + ':' + (COMMANDS[n] ? ' /usr/bin/' + n + ' /usr/share/man/man1/' + n + '.1.gz' : '') + '\n'); return 0; });
  C('basename', (sh, argv, io) => {
    const a = argv.slice(1).filter(x => x !== '-a');
    if (!a.length) { err(io, 'basename', 'missing operand'); return 1; }
    const multi = argv.includes('-a');
    const doOne = (p, suf) => { let b = p.replace(/\/+$/, ''); b = b.slice(b.lastIndexOf('/') + 1) || (p.startsWith('/') ? '/' : ''); if (suf && b.endsWith(suf) && b !== suf) b = b.slice(0, -suf.length); return b; };
    if (multi) { for (const p of a) io.out.write(doOne(p) + '\n'); return 0; }
    if (a[0] === '-s') { for (const p of a.slice(2)) io.out.write(doOne(p, a[1]) + '\n'); return 0; }
    io.out.write(doOne(a[0], a[1]) + '\n');
    return 0;
  });
  C('dirname', (sh, argv, io) => {
    if (argv.length < 2) { err(io, 'dirname', 'missing operand'); return 1; }
    for (const p of argv.slice(1)) {
      let d = p.replace(/\/+$/, '');
      const i = d.lastIndexOf('/');
      d = i < 0 ? '.' : (i === 0 ? '/' : d.slice(0, i).replace(/\/+$/, '') || '/');
      io.out.write(d + '\n');
    }
    return 0;
  });
  C('realpath readlink', (sh, argv, io) => { for (const p of argv.slice(1).filter(x => !x.startsWith('-'))) io.out.write(sh.resolve(p) + '\n'); return 0; });

  /* ---------------- expr ---------------- */
  C('expr', (sh, argv, io) => {
    const a = argv.slice(1);
    let k = 0;
    const isInt = (s) => /^[+-]?\d+$/.test(String(s));
    const fail = (m) => { const e = new Error(m); e.expr = true; throw e; };
    function or() { let l = and(); while (a[k] === '|') { k++; const r = and(); l = (l !== '' && l !== '0' && l !== 0) ? l : (r !== '' && r !== '0' && r !== 0 ? r : '0'); } return l; }
    function and() { let l = cmp(); while (a[k] === '&') { k++; const r = cmp(); l = (l !== '' && l !== '0') && (r !== '' && r !== '0') ? l : '0'; } return l; }
    function cmp() {
      let l = add();
      while (['<', '<=', '=', '==', '!=', '>=', '>'].includes(a[k])) {
        const op = a[k++]; const r = add();
        let c;
        if (isInt(l) && isInt(r)) c = BigInt(l) < BigInt(r) ? -1 : BigInt(l) > BigInt(r) ? 1 : 0; else c = String(l) < String(r) ? -1 : String(l) > String(r) ? 1 : 0;
        l = ({ '<': c < 0, '<=': c <= 0, '=': c === 0, '==': c === 0, '!=': c !== 0, '>=': c >= 0, '>': c > 0 }[op]) ? '1' : '0';
      }
      return l;
    }
    function add() {
      let l = mul();
      while (a[k] === '+' || a[k] === '-') { const op = a[k++]; const r = mul(); if (!isInt(l) || !isInt(r)) fail('non-integer argument'); l = String(op === '+' ? BigInt(l) + BigInt(r) : BigInt(l) - BigInt(r)); }
      return l;
    }
    function mul() {
      let l = prim();
      while (a[k] === '*' || a[k] === '/' || a[k] === '%') {
        const op = a[k++]; const r = prim();
        if (!isInt(l) || !isInt(r)) fail('non-integer argument');
        if ((op === '/' || op === '%') && BigInt(r) === 0n) fail('division by zero');
        l = String(op === '*' ? BigInt(l) * BigInt(r) : op === '/' ? BigInt(l) / BigInt(r) : BigInt(l) % BigInt(r));
      }
      return l;
    }
    function prim() {
      const t = a[k++];
      if (t === undefined) fail('syntax error: missing argument after ' + Q(a[k - 2] || ''));
      if (t === '(') { const v = or(); if (a[k++] !== ')') fail('syntax error: expecting \')\''); return v; }
      if (t === 'length') return String(Array.from(prim()).length);
      if (t === 'substr') { const s = Array.from(prim()); const p = parseInt(prim(), 10); const n = parseInt(prim(), 10); return s.slice(p - 1, p - 1 + n).join(''); }
      if (t === 'index') { const s = prim(); const c = prim(); let r = 0; for (let i = 0; i < s.length; i++) if (c.indexOf(s[i]) >= 0) { r = i + 1; break; } return String(r); }
      if (t === 'match') { const s = prim(); const re = prim(); const m = new RegExp('^(?:' + U.posixToJs(re, true) + ')').exec(s); return m ? (m[1] != null ? m[1] : String(m[0].length)) : (/\\\(/.test(re) ? '' : '0'); }
      if (a[k] === ':') { k++; const re = prim(); const m = new RegExp('^(?:' + U.posixToJs(re, true) + ')').exec(t); return m ? (m[1] != null ? m[1] : String(m[0].length)) : (/\\\(/.test(re) ? '' : '0'); }
      return t;
    }
    try {
      if (!a.length) { err(io, 'expr', 'missing operand'); return 2; }
      const v = or();
      if (k < a.length) fail('syntax error: unexpected argument ' + Q(a[k]));
      io.out.write(v + '\n');
      return (v === '' || v === '0' || /^-?0+$/.test(v)) ? 1 : 0;
    } catch (e) {
      if (e.expr) { err(io, 'expr', e.message); if (sh.hints && e.message.indexOf('syntax error') >= 0 && a.some(x => /\*/.test(x) === false) ) io.err.write('\x1b[33m💡 Подсказка: в expr знак умножения экранируют: expr 3 \\* 4, а все части разделяют пробелами\x1b[0m\n'); return 2; }
      throw e;
    }
  });

  /* ---------------- bc (десятичная арифметика) ---------------- */
  C('bc', (sh, argv, io) => {
    const mathlib = argv.includes('-l');
    const st = { s: 0 };
    const files = argv.slice(1).filter(x => !x.startsWith('-'));
    let src = inputs(sh, files.length ? files : [], io, 'bc', st).map(x => x.data).join('\n');
    const vars = new Map();
    let scale = mathlib ? 20 : 0;
    // число: {v: BigInt, s: scale}
    const mk = (v, s) => ({ v, s });
    const pow10 = (n) => 10n ** BigInt(n);
    const parseNum = (t) => { const [i, f = ''] = t.split('.'); return mk(BigInt((i || '0') + f), f.length); };
    const align = (a, b) => { const s = Math.max(a.s, b.s); return [a.v * pow10(s - a.s), b.v * pow10(s - b.s), s]; };
    const trunc = (a, s) => s >= a.s ? mk(a.v * pow10(s - a.s), s) : mk(a.v / pow10(a.s - s), s);
    const fmt = (a) => {
      const neg = a.v < 0n; let v = neg ? -a.v : a.v;
      let str = v.toString();
      if (a.s > 0) { str = str.padStart(a.s + 1, '0'); str = str.slice(0, -a.s) + '.' + str.slice(-a.s); if (str.startsWith('0.')) str = str.slice(1); }
      if (str === '' ) str = '0';
      if (/^\.?0*$/.test(str.replace('.', '')) ) return '0';
      return (neg ? '-' : '') + str;
    };
    const toks = [];
    const re = /\s*(\d+\.?\d*|\.\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|\^|==|!=|<=|>=|&&|\|\||[-+*\/%()<>=;,\n])/y;
    let m; let pos = 0;
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/#[^\n]*/g, '');
    while (pos < src.length) {
      re.lastIndex = pos;
      m = re.exec(src);
      if (!m) { if (/^\s*$/.test(src.slice(pos))) break; err(io, '(standard_in) 1', 'syntax error'); return 1; }
      toks.push(m[1]); pos = re.lastIndex;
    }
    let k = 0;
    const peek = () => toks[k];
    const ev = {
      expr() { return this.cmp(); },
      cmp() {
        let l = this.add();
        while (['<', '>', '<=', '>=', '==', '!='].includes(peek())) {
          const op = toks[k++]; const r = this.add(); const [x, y] = align(l, r);
          l = mk(({ '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y, '==': x === y, '!=': x !== y }[op]) ? 1n : 0n, 0);
        }
        return l;
      },
      add() {
        let l = this.mul();
        while (peek() === '+' || peek() === '-') { const op = toks[k++]; const r = this.mul(); const [x, y, s] = align(l, r); l = mk(op === '+' ? x + y : x - y, s); }
        return l;
      },
      mul() {
        let l = this.pow();
        while (peek() === '*' || peek() === '/' || peek() === '%') {
          const op = toks[k++]; const r = this.pow();
          if (op === '*') { const full = mk(l.v * r.v, l.s + r.s); l = trunc(full, Math.min(l.s + r.s, Math.max(scale, l.s, r.s))); }
          else {
            if (r.v === 0n) throw new Error('Runtime error (func=(main), adr=0): Divide by zero');
            if (op === '/') { const num = l.v * pow10(scale + r.s); const den = r.v * pow10(l.s); l = mk(num / den, scale); }
            else { const q = (() => { const num = l.v * pow10(scale + r.s); const den = r.v * pow10(l.s); return mk(num / den, scale); })(); const prod = mk(q.v * r.v, q.s + r.s); const [x, y, s] = align(l, prod); l = mk(x - y, s); }
          }
        }
        return l;
      },
      pow() {
        const b = this.unary();
        if (peek() === '^' || peek() === '**') { k++; const e = this.pow(); let n = Number(e.v / pow10(e.s)); let r = mk(1n, 0); const neg = n < 0; n = Math.abs(n); for (let i = 0; i < n; i++) { r = mk(r.v * b.v, r.s + b.s); } r = trunc(r, Math.min(r.s, Math.max(scale, b.s))); if (neg) { const num = pow10(scale + r.s); return mk(num / (r.v || 1n), scale); } return r; }
        return b;
      },
      unary() { if (peek() === '-') { k++; const v = this.unary(); return mk(-v.v, v.s); } if (peek() === '+') { k++; return this.unary(); } return this.prim(); },
      prim() {
        const t = toks[k++];
        if (t === '(') { const v = this.expr(); k++; return v; }
        if (t == null) throw new Error('syntax error');
        if (/^[\d.]/.test(t)) return parseNum(t);
        if (t === 'sqrt' && peek() === '(') { k++; const v = this.expr(); k++; const x = Number(v.v) / Math.pow(10, v.s); const s = Math.max(scale, v.s); return trunc(parseNum(Math.sqrt(x).toFixed(Math.min(s + 2, 20))), s); }
        if (t === 'length' && peek() === '(') { k++; const v = this.expr(); k++; return mk(BigInt(v.v < 0n ? (-v.v).toString().length : v.v.toString().length), 0); }
        if (t === 'scale' && peek() === '(') { k++; const v = this.expr(); k++; return mk(BigInt(v.s), 0); }
        if (t === 'scale') return mk(BigInt(scale), 0);
        if (/^[A-Za-z_]/.test(t)) { if (peek() === '(') { k++; let d = 1; while (k < toks.length && d) { if (toks[k] === '(') d++; if (toks[k] === ')') d--; k++; } const x = 0; return mk(0n, 0); } return vars.get(t) || mk(0n, 0); }
        throw new Error('syntax error');
      },
    };
    let out = '';
    try {
      while (k < toks.length) {
        if (peek() === ';' || peek() === '\n') { k++; continue; }
        if (peek() === 'quit') break;
        if (/^[A-Za-z_]/.test(peek()) && toks[k + 1] === '=') {
          const name = toks[k]; k += 2; const v = ev.expr();
          if (name === 'scale') scale = Number(v.v / pow10(v.s)); else vars.set(name, v);
          continue;
        }
        const v = ev.expr();
        out += fmt(v) + '\n';
      }
    } catch (e) { io.out.write(out); err(io, '(standard_in) 1', e.message.indexOf('Divide') >= 0 ? e.message : 'syntax error'); return 1; }
    io.out.write(out);
    return st.s;
  });

  /* ---------------- xargs ---------------- */
  C('xargs', (sh, argv, io) => {
    let n = null; const a = argv.slice(1);
    while (a.length && a[0].startsWith('-')) { const x = a.shift(); if (x === '-n') n = parseInt(a.shift(), 10); else if (/^-n\d+$/.test(x)) n = parseInt(x.slice(2), 10); }
    const cmd = a.length ? a : ['echo'];
    const words = (io.in ? io.in.readAll() : '').split(/\s+/).filter(Boolean);
    let st = 0;
    const groups = [];
    if (n) for (let i = 0; i < words.length; i += n) groups.push(words.slice(i, i + n)); else groups.push(words);
    for (const g of groups) { const r = sh.invoke(cmd.concat(g), { in: new InStream('', false), out: io.out, err: io.err }, false); if (r) st = 123; }
    return st;
  });

  /* ---------------- clear / редакторы / справка ---------------- */
  C('clear', (sh, argv, io) => { if (io.out.tty) io.out.write('\x1b[2J\x1b[H'); return 0; });
  C('reset', (sh, argv, io) => { if (io.out.tty) io.out.write('\x1b[2J\x1b[H'); return 0; });
  C('nano vi vim mcedit pico editor gedit code', (sh, argv, io) => {
    const files = argv.slice(1).filter(x => !x.startsWith('-') && !x.startsWith('+'));
    if (!sh.host || !sh.host.openEditor || !io.out.tty || sh.subLevel > 0 || !sh.interactive) {
      err(io, argv[0], 'редактор можно открыть только из терминала (не из скрипта и не в конвейере)');
      return 1;
    }
    if (!files.length) { err(io, argv[0], 'укажите имя файла, например: ' + argv[0] + ' script.sh'); return 1; }
    const abs = sh.resolve(files[0]);
    const n = sh.fs.get(abs);
    if (n && n.t === 'd') { err(io, argv[0], q1(files[0]) + ' is a directory'); return 1; }
    if (n && !sh.fs.can(n, 'r')) { err(io, argv[0], 'Permission denied: ' + files[0]); return 1; }
    if (!n) {
      const { dir } = sh.fs.parentOf(abs);
      if (!sh.fs.isDir(dir)) { err(io, argv[0], 'Directory ' + q1(dir) + ' does not exist'); return 1; }
    }
    sh.host.openEditor(abs, files[0], argv[0]);
    return 0;
  });
  C('less more most', (sh, argv, io) => COMMANDS.cat(sh, ['cat'].concat(argv.slice(1).filter(x => !x.startsWith('-'))), io));
  const MAN = {
    bash: 'BASH(1)\n\nNAME\n       bash - GNU Bourne-Again SHell\n\nSYNOPSIS\n       bash [options] [file]\n\nOPTIONS\n       -c string   выполнить команды из строки\n       -x          печатать команды перед выполнением (отладка)\n       -n          только проверить синтаксис\n',
    echo: 'ECHO(1)\n\n       echo [-neE] [строка...]\n       -n   не выводить перевод строки\n       -e   включить обработку \\n, \\t и др.\n',
    chmod: 'CHMOD(1)\n\n       chmod [ugoa][+-=][rwx] файл\n       chmod 755 файл   (rwxr-xr-x)\n       chmod +x script.sh   — сделать скрипт исполняемым\n',
    alias: 'alias: alias [-p] [имя[=значение] ... ]\n       alias c=\'clear\'   — создать\n       alias            — показать все\n       unalias c        — удалить\n',
    test: 'TEST(1)\n\n       [ выражение ]\n       Числа: -eq -ne -lt -le -gt -ge\n       Строки: = != -z -n\n       Файлы: -e -f -d -r -w -x -s\n',
    read: 'read: read [-r] [-p подсказка] [-a массив] [имя ...]\n       Читает строку из стандартного ввода.\n',
  };
  C('man info', (sh, argv, io) => {
    const n = argv[argv.length - 1];
    if (argv.length < 2) { io.err.write('What manual page do you want?\nFor example, try \'man man\'.\n'); return 1; }
    if (MAN[n]) { io.out.write(MAN[n]); return 0; }
    if (COMMANDS[n] || BS.BUILTINS[n]) { io.out.write(n + ' — команда доступна в симуляторе. Краткая справка: help, а также ' + n + ' --help на настоящем Linux.\n'); return 0; }
    io.err.write('No manual entry for ' + n + '\n');
    return 16;
  });
  const NOPE = (msg) => (sh, argv, io) => { err(io, argv[0], msg); return 1; };
  C('sudo', (sh, argv, io) => { io.err.write('[sudo] password for student: \nsudo: в учебном симуляторе права администратора недоступны\n'); return 1; });
  C('su', NOPE('Authentication failure (в симуляторе недоступно)'));
  C('apt apt-get yum dnf snap pip pip3 npm', (sh, argv, io) => { err(io, argv[0], 'установка программ в симуляторе недоступна (тема урока 8)'); return 100; });
  C('ping curl wget ssh scp ftp telnet nc ip ifconfig nmcli', NOPE('сеть в симуляторе недоступна'));
  C('python python3 perl ruby node gcc g++ make java javac php', NOPE('в симуляторе доступен только bash'));
  C('zsh ksh csh tcsh fish dash rbash', (sh, argv, io) => {
    if (argv[0] === 'dash' || argv[0] === 'rbash') return COMMANDS.bash(sh, ['bash'].concat(argv.slice(1)), io);
    err(io, argv[0], 'в симуляторе работает только bash (а ' + argv[0] + ' — другая оболочка)'); return 1;
  });
  C('chsh', (sh, argv, io) => { io.out.write('Password: \n'); err(io, 'chsh', 'в симуляторе смена оболочки недоступна. На настоящем Linux: chsh -s /bin/zsh'); return 1; });
  C('passwd', NOPE('в симуляторе пароль менять нельзя'));
  C('shutdown reboot poweroff halt', NOPE('в симуляторе выключение недоступно :)'));
  C('yes', (sh, argv, io) => { const w = argv.slice(1).join(' ') || 'y'; io.out.write((w + '\n').repeat(1000)); return 0; });
  C('factor', (sh, argv, io) => {
    for (const x of argv.slice(1)) {
      let n = BigInt(x); const f = [];
      for (let d = 2n; d * d <= n; d++) while (n % d === 0n) { f.push(d); n /= d; }
      if (n > 1n) f.push(n);
      io.out.write(x + ': ' + f.join(' ') + '\n');
    }
    return 0;
  });
  C('cal', (sh, argv, io) => {
    const d = new Date(); const y = d.getFullYear(), mo = d.getMonth();
    const first = new Date(y, mo, 1).getDay(); const days = new Date(y, mo + 1, 0).getDate();
    const title = MONTHS_FULL[mo] + ' ' + y;
    let s = ' '.repeat(Math.floor((20 - title.length) / 2)) + title + '\nSu Mo Tu We Th Fr Sa\n';
    let line = '   '.repeat(first);
    for (let i = 1; i <= days; i++) { line += String(i).padStart(2) + ' '; if ((first + i) % 7 === 0) { s += line.trimEnd() + '\n'; line = ''; } }
    if (line) s += line.trimEnd() + '\n';
    io.out.write(s);
    return 0;
  });

  /* ---------------- bash / sh ---------------- */
  C('bash sh', (sh, argv, io) => {
    const a = argv.slice(1);
    const extra = {};
    let i = 0;
    let noexec = false;
    while (i < a.length && /^[-+]/.test(a[i]) && a[i] !== '-' && a[i] !== '--') {
      const x = a[i];
      if (x === '--version') { io.out.write('GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\nCopyright (C) 2022 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n'); return 0; }
      if (x === '--help') { io.out.write('Usage: bash [option] script-file [args]\n  -c string  -x  -n  -e\n'); return 0; }
      if (x === '-c') {
        const cmd = a[i + 1];
        if (cmd == null) { err(io, 'bash', '-c: option requires an argument'); return 2; }
        const child = sh.spawn(a[i + 2] || 'bash', a.slice(i + 3));
        child.hints = sh.hints; Object.assign(child.opts, extra);
        try { return child.runText(cmd, io, { script: true }); } catch (e) { if (e instanceof BS.sig.ExitSig) return e.code; throw e; }
      }
      for (const ch of x.slice(1)) {
        if (ch === 'x') extra.xtrace = x[0] === '-';
        else if (ch === 'e') extra.errexit = x[0] === '-';
        else if (ch === 'u') extra.nounset = x[0] === '-';
        else if (ch === 'n') noexec = true;
        else if (ch === 'v' || ch === 'l' || ch === 'i' || ch === 's') {}
        else { err(io, 'bash', '-' + ch + ': invalid option'); return 2; }
      }
      i++;
    }
    if (a[i] === '--') i++;
    if (i >= a.length) {
      if (io.in && !io.in.interactive) {
        const child = sh.spawn('bash', []);
        child.hints = sh.hints; Object.assign(child.opts, extra);
        try { return child.runText(io.in.readAll(), io, { script: true }); } catch (e) { if (e instanceof BS.sig.ExitSig) return e.code; throw e; }
      }
      io.out.write('(Вы уже работаете в bash. Вложенная интерактивная оболочка в симуляторе не запускается.)\n');
      return 0;
    }
    const file = a[i];
    const abs = sh.resolve(file);
    const n = sh.fs.get(abs);
    if (!n) { io.err.write(argv[0] + ': ' + file + ': No such file or directory\n'); return 127; }
    if (n.t === 'd') { io.err.write(argv[0] + ': ' + file + ': Is a directory\n'); return 126; }
    if (!sh.fs.can(n, 'r')) { io.err.write(argv[0] + ': ' + file + ': Permission denied\n'); return 126; }
    if (n.x.startsWith('\x7fELF')) { io.err.write(argv[0] + ': ' + file + ': cannot execute binary file\n'); return 126; }
    if (noexec) {
      try { new BS.Parser(n.x).parseProgram(); return 0; }
      catch (e) { if (e instanceof BS.ParseError) { const p = new BS.Parser(n.x); io.err.write(file + ': line ' + p.lineOf(e.pos) + ': ' + e.message + '\n'); return 2; } throw e; }
    }
    return sh.runScriptFile(abs, n.x, file, a.slice(i + 1), io, 'bash', extra);
  });

  BS.COMMANDS = COMMANDS;
  BS.cmdUtil = { opts, inputs, lines, joinLines, strftime, permStr };
})(globalThis.BS = globalThis.BS || {});
