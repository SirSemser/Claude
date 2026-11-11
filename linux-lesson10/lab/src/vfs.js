/* Виртуальная файловая система для учебного симулятора bash. */
(function (BS) {
  'use strict';

  const ERR = {
    ENOENT: 'No such file or directory',
    ENOTDIR: 'Not a directory',
    EISDIR: 'Is a directory',
    EEXIST: 'File exists',
    EACCES: 'Permission denied',
    ENOTEMPTY: 'Directory not empty',
    EINVAL: 'Invalid argument',
  };

  class FsError extends Error {
    constructor(code) { super(ERR[code] || code); this.code = code; }
  }

  let clock = Date.now();
  function now() { const t = Date.now(); clock = t > clock ? t : clock + 1; return clock; }

  function mkDir(owner, mode) {
    return { t: 'd', m: mode == null ? 0o755 : mode, o: owner || 'student', mt: now(), c: Object.create(null) };
  }
  function mkFile(content, owner, mode) {
    return { t: 'f', m: mode == null ? 0o644 : mode, o: owner || 'student', mt: now(), x: content || '' };
  }

  function normalize(path, cwd) {
    if (!path.startsWith('/')) path = (cwd || '/') + '/' + path;
    const out = [];
    for (const p of path.split('/')) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop(); else out.push(p);
    }
    return '/' + out.join('/');
  }

  class VFS {
    constructor(root) {
      this.root = root || mkDir('root', 0o755);
      this.user = 'student';
    }
    static normalize(p, cwd) { return normalize(p, cwd); }

    /* Возвращает узел или null. Если путь проходит через файл — null. */
    get(abs) {
      if (abs === '/') return this.root;
      let n = this.root;
      for (const part of abs.split('/')) {
        if (!part) continue;
        if (n.t !== 'd') return null;
        n = n.c[part];
        if (!n) return null;
      }
      return n;
    }
    /* Подробная проверка пути: различает ENOENT и ENOTDIR. */
    lookup(abs) {
      if (abs === '/') return this.root;
      let n = this.root;
      const parts = abs.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        if (n.t !== 'd') throw new FsError('ENOTDIR');
        if (!this.can(n, 'x')) throw new FsError('EACCES');
        n = n.c[parts[i]];
        if (!n) throw new FsError('ENOENT');
      }
      return n;
    }
    parentOf(abs) {
      const i = abs.lastIndexOf('/');
      const dir = i <= 0 ? '/' : abs.slice(0, i);
      const name = abs.slice(i + 1);
      return { dir, name };
    }
    can(node, what) {
      if (!node) return false;
      if (node.t === 'c') return true;
      const shift = node.o === this.user ? 6 : 0;
      const bit = what === 'r' ? 4 : what === 'w' ? 2 : 1;
      return ((node.m >> shift) & bit) !== 0;
    }
    exists(abs) { return !!this.get(abs); }
    isDir(abs) { const n = this.get(abs); return !!n && n.t === 'd'; }
    isFile(abs) { const n = this.get(abs); return !!n && n.t === 'f'; }

    readFile(abs) {
      const n = this.lookup(abs);
      if (n.t === 'd') throw new FsError('EISDIR');
      if (n.t === 'c') return '';
      if (!this.can(n, 'r')) throw new FsError('EACCES');
      return n.x;
    }
    /* Создаёт/перезаписывает файл. Возвращает узел. */
    openWrite(abs, append) {
      const ex = this.get(abs);
      if (ex) {
        if (ex.t === 'd') throw new FsError('EISDIR');
        if (ex.t === 'c') return ex;
        if (!this.can(ex, 'w')) throw new FsError('EACCES');
        if (!append) ex.x = '';
        ex.mt = now();
        return ex;
      }
      const { dir, name } = this.parentOf(abs);
      const p = this.lookup(dir);
      if (p.t !== 'd') throw new FsError('ENOTDIR');
      if (!this.can(p, 'w')) throw new FsError('EACCES');
      const f = mkFile('', this.user, 0o644);
      p.c[name] = f; p.mt = now();
      return f;
    }
    writeFile(abs, content, mode) {
      const f = this.openWrite(abs, false);
      f.x = content;
      if (mode != null) f.m = mode;
      return f;
    }
    mkdir(abs, parents) {
      if (abs === '/') { if (parents) return this.root; throw new FsError('EEXIST'); }
      const ex = this.get(abs);
      if (ex) {
        if (parents && ex.t === 'd') return ex;
        throw new FsError('EEXIST');
      }
      const { dir, name } = this.parentOf(abs);
      let p = this.get(dir);
      if (!p) {
        if (!parents) throw new FsError('ENOENT');
        p = this.mkdir(dir, true);
      }
      if (p.t !== 'd') throw new FsError('ENOTDIR');
      if (!this.can(p, 'w')) throw new FsError('EACCES');
      const d = mkDir(this.user, 0o755);
      p.c[name] = d; p.mt = now();
      return d;
    }
    remove(abs) {
      const { dir, name } = this.parentOf(abs);
      const p = this.get(dir);
      if (!p || !p.c[name]) throw new FsError('ENOENT');
      if (!this.can(p, 'w')) throw new FsError('EACCES');
      delete p.c[name]; p.mt = now();
    }
    link(abs, node) {
      const { dir, name } = this.parentOf(abs);
      const p = this.lookup(dir);
      if (p.t !== 'd') throw new FsError('ENOTDIR');
      if (!this.can(p, 'w')) throw new FsError('EACCES');
      p.c[name] = node; p.mt = now();
    }
    list(abs) {
      const n = this.lookup(abs);
      if (n.t !== 'd') throw new FsError('ENOTDIR');
      if (!this.can(n, 'r')) throw new FsError('EACCES');
      return Object.keys(n.c).sort(cmpNames);
    }
    touch(node) { node.mt = now(); }

    static cloneNode(n) {
      if (n.t === 'd') {
        const d = { t: 'd', m: n.m, o: n.o, mt: n.mt, c: Object.create(null) };
        for (const k of Object.keys(n.c)) d.c[k] = VFS.cloneNode(n.c[k]);
        return d;
      }
      return { t: n.t, m: n.m, o: n.o, mt: n.mt, x: n.x };
    }
    clone() { const v = new VFS(VFS.cloneNode(this.root)); v.user = this.user; return v; }
    toJSON() { return this.root; }
    static fromJSON(obj) {
      function fix(n) {
        if (n.t === 'd') {
          const c = Object.create(null);
          for (const k of Object.keys(n.c || {})) c[k] = fix(n.c[k]);
          return { t: 'd', m: n.m, o: n.o, mt: n.mt, c };
        }
        return { t: n.t, m: n.m, o: n.o, mt: n.mt, x: n.x || '' };
      }
      return new VFS(fix(obj));
    }
  }

  /* Сортировка имён как в локали C.UTF-8 (по кодовым точкам). */
  function cmpNames(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  /* ---------- Начальная файловая система ---------- */
  const PASSWD = [
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    'bin:x:2:2:bin:/bin:/usr/sbin/nologin',
    'sys:x:3:3:sys:/dev:/usr/sbin/nologin',
    'sync:x:4:65534:sync:/bin:/bin/sync',
    'man:x:6:12:man:/var/cache/man:/usr/sbin/nologin',
    'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
    'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
    'sshd:x:110:65534::/run/sshd:/usr/sbin/nologin',
    'student:x:1000:1000:Student,,,:/home/student:/bin/bash',
    'aigerim:x:1001:1001:Aigerim,,,:/home/aigerim:/bin/bash',
    'timur:x:1002:1002:Timur,,,:/home/timur:/bin/sh',
    'dana:x:1003:1003:Dana,,,:/home/dana:/usr/bin/zsh',
  ].join('\n') + '\n';

  const GROUP = [
    'root:x:0:', 'adm:x:4:student', 'sudo:x:27:student', 'users:x:100:',
    'student:x:1000:', 'aigerim:x:1001:', 'timur:x:1002:', 'dana:x:1003:', 'devops:x:1500:student,aigerim',
  ].join('\n') + '\n';

  const SHELLS = [
    '# /etc/shells: valid login shells',
    '/bin/sh',
    '/usr/bin/sh',
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/rbash',
    '/usr/bin/rbash',
    '/usr/bin/dash',
    '/usr/bin/zsh',
  ].join('\n') + '\n';

  const OS_RELEASE = [
    'PRETTY_NAME="Ubuntu 24.04.3 LTS"',
    'NAME="Ubuntu"',
    'VERSION_ID="24.04"',
    'VERSION="24.04.3 LTS (Noble Numbat)"',
    'ID=ubuntu',
    'ID_LIKE=debian',
  ].join('\n') + '\n';

  const BASHRC = [
    '# ~/.bashrc: выполняется при запуске интерактивной оболочки bash',
    '',
    '# Сюда можно добавлять свои алиасы, например:',
    "# alias ll='ls -l'",
    '',
    "alias ls='ls --color=auto'",
    "alias grep='grep --color=auto'",
    '',
  ].join('\n');

  const PROFILE = [
    '# ~/.profile: выполняется при входе в систему',
    'if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then',
    '    . "$HOME/.bashrc"',
    'fi',
    '',
  ].join('\n');

  const BIN_STUB = '\x7fELF (двоичный исполняемый файл)\n';

  function defaultFS() {
    const fs = new VFS();
    const R = (p, mode) => { const d = fs.get(p) || null; if (d) return d; const { dir, name } = fs.parentOf(p); const par = fs.get(dir); const n = mkDir('root', mode == null ? 0o755 : mode); par.c[name] = n; return n; };
    const F = (p, x, mode, owner) => { const { dir, name } = fs.parentOf(p); fs.get(dir).c[name] = mkFile(x, owner || 'root', mode == null ? 0o644 : mode); };
    ['/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/usr/local', '/usr/local/bin', '/var', '/var/log', '/var/www'].forEach(p => R(p));
    fs.get('/root').m = 0o700;
    fs.get('/tmp').m = 0o1777;
    fs.get('/dev').c['null'] = { t: 'c', m: 0o666, o: 'root', mt: now(), x: '' };
    F('/etc/passwd', PASSWD);
    F('/etc/group', GROUP);
    F('/etc/shells', SHELLS);
    F('/etc/hostname', 'lab10-pc\n');
    F('/etc/os-release', OS_RELEASE);
    F('/etc/shadow', 'root:*:20000:0:99999:7:::\n', 0o640);
    F('/var/log/syslog', 'Nov 11 09:00:01 lab10-pc systemd[1]: Started Daily apt download activities.\nNov 11 09:05:13 lab10-pc CRON[812]: (root) CMD (run-parts /etc/cron.hourly)\n', 0o640);
    for (const b of ['bash', 'sh', 'dash', 'rbash']) { F('/bin/' + b, BIN_STUB, 0o755); F('/usr/bin/' + b, BIN_STUB, 0o755); }
    for (const b of ['env', 'ls', 'cat', 'grep', 'zsh', 'nano', 'python3']) F('/usr/bin/' + b, BIN_STUB, 0o755);
    // домашний каталог
    const home = mkDir('student', 0o750);
    fs.get('/home').c['student'] = home;
    fs.get('/home').c['aigerim'] = mkDir('aigerim', 0o750);
    fs.get('/home').c['timur'] = mkDir('timur', 0o750);
    home.c['.bashrc'] = mkFile(BASHRC, 'student');
    home.c['.profile'] = mkFile(PROFILE, 'student');
    home.c['Documents'] = mkDir('student');
    home.c['Downloads'] = mkDir('student');
    home.c['lab10'] = mkDir('student');
    home.c['Documents'].c['notes.txt'] = mkFile('Урок 10: Bash Shell Scripting\nalias, переменные, условия, циклы, case, функции, массивы\n', 'student');
    return fs;
  }

  BS.VFS = VFS;
  BS.FsError = FsError;
  BS.FS_ERR = ERR;
  BS.mkDir = mkDir;
  BS.mkFile = mkFile;
  BS.defaultFS = defaultFS;
  BS.normalizePath = normalize;
  BS.cmpNames = cmpNames;
})(globalThis.BS = globalThis.BS || {});
