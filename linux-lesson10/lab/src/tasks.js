/* Задания лабораторной работы №10 «Bash Shell Scripting». */
(function (BS) {
  'use strict';

  const LAB = {
    id: 'linux-lab10-bash-v1',
    title: 'Лабораторная работа №10. Bash Shell Scripting',
    minutes: 60,
    salt: 'lab10·bash·2026',
  };

  /* ---------- Файлы в ~/lab10 (и для проверок) ---------- */
  const FIXTURES = {
    'README.txt': [
      'Папка для лабораторной работы №10.',
      'Здесь лежат файлы для заданий: students.txt, group2.txt, text.txt, logs/, var/ ...',
      'Ваши скрипты из редактора тоже сохраняются сюда — их можно запускать: ./greet.sh Айгерим 19',
      '',
    ].join('\n'),
    'students.txt': [
      'Ахметов Али 85',
      'Бекова Дана 42',
      'Ким Тимур 67',
      'Серикова Аружан 91',
      'Жумабаев Ерлан 50',
      'Оспанова Мадина 38',
      '',
    ].join('\n'),
    'group2.txt': [
      'Иванов Иван 49',
      'Петрова Анна 100',
      'Нурланов Санжар 73',
      'Ли Виктория 50',
      'Абдиев Нурсултан 12',
      'Касымова Айгерим 88',
      'Смирнов Олег 0',
      'Тен Алина 64',
      '',
    ].join('\n'),
    'text.txt': 'the cat and the dog\nthe dog and the bird\na cat\n',
    'text2.txt': 'linux bash linux shell\nbash bash script\n',
    'notes.txt': 'Bash — командная оболочка Linux.\n',
    'empty.txt': '',
    'run.sh': '#!/bin/bash\necho "run.sh запущен"\n',
    'logs/app.log': 'INFO  app started\nWARN  low memory\nINFO  request /index\n',
    'logs/db.log': 'INFO  db connected\nERROR query timeout\n',
    'logs/error.log': 'ERROR disk full\nERROR disk full\nERROR cannot write\nINFO  retry ok\n',
    'logs/readme.txt': 'Это не лог-файл.\n',
    'var/auth.log': 'student logged in\n',
    'var/kern.log': 'boot\nusb connected\nusb disconnected\nwifi up\nwifi down\n',
    'var/sys.log': 'cron job\ncron job done\n',
  };
  const FIXTURE_MODES = { 'run.sh': 0o755 };

  /* ---------- Вспомогательное ---------- */
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /* Пример запуска: строки вида '$ команда' и вывод */
  const ex = (text) => '<pre class="ex">' + esc(text).replace(/^\$ (.*)$/gm, '<span class="ex-p">$</span> <span class="ex-c">$1</span>') + '</pre>';
  const hint = (html) => '<details class="hint"><summary>Подсказка</summary>' + html + '</details>';
  const code = (s) => '<code>' + esc(s) + '</code>';
  const FUNC_RE = '(^|\\n)\\s*(function\\s+)?[A-Za-z_][\\w-]*\\s*\\(\\s*\\)|(^|\\n)\\s*function\\s+[A-Za-z_]';

  const SECTIONS = [
    { id: 'quiz', title: 'Разминка', icon: '?' },
    { id: 'term', title: 'Терминал и alias', icon: '>' },
    { id: 'vars', title: 'Переменные', icon: '$' },
    { id: 'cond', title: 'Условия', icon: 'if' },
    { id: 'str', title: 'Строки', icon: 'ab' },
    { id: 'loop', title: 'Циклы', icon: '↻' },
    { id: 'case', title: 'case', icon: '⋮' },
    { id: 'func', title: 'Функции', icon: 'f' },
    { id: 'arr', title: 'Массивы', icon: '[]' },
    { id: 'final', title: 'Итоговые', icon: '★' },
  ];

  /* ---------- Терминальные проверки ---------- */
  const H = '/home/student';
  const ran = (ctx, re) => ctx.history.some(h => re.test(h));
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const stripQuotes = (s) => norm(s).replace(/^(['"])(.*)\1$/, '$2');

  const TASKS = [
    /* ================= РАЗМИНКА ================= */
    {
      id: 'Q1', section: 'quiz', type: 'choice', points: 2, core: true, minutes: 1,
      title: 'Первая строка скрипта',
      desc: '<p>С какой строки должен начинаться bash-скрипт, чтобы система знала, каким интерпретатором его выполнять?</p>',
      options: ['#!/bin/bash', '#/bin/bash', '!#/bin/bash', '//bin/bash'],
    },
    {
      id: 'Q2', section: 'quiz', type: 'choice', points: 2, core: true, minutes: 1,
      title: '$SHELL и $0',
      desc: '<p>Чем отличаются переменные ' + code('$SHELL') + ' и ' + code('$0') + '?</p>',
      options: [
        '$SHELL — оболочка входа пользователя (из /etc/passwd), $0 — имя программы или скрипта, который выполняется сейчас',
        'Это одно и то же: путь к bash',
        '$SHELL — текущий каталог, $0 — код завершения последней команды',
        '$0 — первый аргумент скрипта, $SHELL — последний аргумент',
      ],
    },
    {
      id: 'Q3', section: 'quiz', type: 'output', points: 2, core: true, minutes: 1,
      title: 'Кавычки',
      desc: '<p>Что выведет этот фрагмент? Впишите вывод точно.</p>',
      code: "x=5\necho '$x' \"$x\" x",
    },
    {
      id: 'Q4', section: 'quiz', type: 'output', points: 2, core: true, minutes: 1,
      title: 'Арифметика',
      desc: '<p>Что выведет этот фрагмент?</p>',
      code: 'a=17; b=5\necho $((a / b)) $((a % b))',
    },
    {
      id: 'Q5', section: 'quiz', type: 'output', points: 2, core: true, minutes: 1,
      title: 'Строки',
      desc: '<p>Что выведет этот фрагмент?</p>',
      code: 's="Hello World"\necho ${#s} ${s:6:3}',
    },
    {
      id: 'Q6', section: 'quiz', type: 'output', points: 2, core: true, minutes: 1,
      title: 'Массив',
      desc: '<p>Что выведет этот фрагмент?</p>',
      code: 'arr=(red green blue)\necho ${arr[1]} ${#arr[@]}',
    },

    /* ================= ТЕРМИНАЛ ================= */
    {
      id: 'T1', section: 'term', type: 'terminal', points: 3, core: true, minutes: 3,
      title: 'Знакомство с оболочкой',
      desc: '<p>Выполните в терминале команды со слайда «Информация об оболочке» и ответьте на вопросы.</p>' +
        ex('$ echo $SHELL\n$ echo $0\n$ cat /etc/shells\n$ getent passwd student') +
        '<p>Посмотрите также строку пользователя ' + code('dana') + ' — например, ' + code('grep dana /etc/passwd') + '.</p>',
      fields: [
        { id: 'a', label: 'Сколько оболочек перечислено в /etc/shells? (строки с # не считаются)' },
        { id: 'b', label: 'Какая оболочка входа у пользователя dana? (полный путь)' },
      ],
      check(ctx) {
        const shells = ctx.fs.get('/etc/shells').x.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length;
        const dana = (ctx.fs.get('/etc/passwd').x.split('\n').find(l => l.startsWith('dana:')) || '').split(':')[6] || '';
        return [
          { ok: ran(ctx, /echo\s+"?\$\{?SHELL/), label: 'выполнена команда echo $SHELL' },
          { ok: ran(ctx, /echo\s+"?\$0/), label: 'выполнена команда echo $0' },
          { ok: ran(ctx, /\/etc\/shells/), label: 'просмотрен файл /etc/shells' },
          { ok: norm(ctx.answers.a) === String(shells), label: 'ответ 1 верный' },
          { ok: norm(ctx.answers.b) === dana, label: 'ответ 2 верный' },
        ];
      },
    },
    {
      id: 'T2', section: 'term', type: 'terminal', points: 3, core: true, minutes: 2,
      title: 'Алиасы (alias)',
      desc: '<p>Создайте в терминале три алиаса и проверьте их работу:</p><ul>' +
        '<li>' + code('ll') + ' → ' + code('ls -l') + '</li>' +
        '<li>' + code('la') + ' → ' + code('ls -la') + '</li>' +
        '<li>' + code('h') + ' → ' + code('history') + '</li></ul>' +
        '<p>Затем выведите список всех алиасов командой ' + code('alias') + ' и запустите ' + code('ll') + '.</p>' +
        ex("$ alias ll='ls -l'\n$ ll") +
        hint('<p>Между именем, знаком = и значением не должно быть пробелов. Значение с пробелами берите в кавычки. Удалить алиас: ' + code('unalias имя') + '.</p>'),
      check(ctx) {
        const a = ctx.aliases;
        return [
          { ok: a.has('ll') && norm(a.get('ll')) === 'ls -l', label: "alias ll='ls -l'" },
          { ok: a.has('la') && norm(a.get('la')) === 'ls -la', label: "alias la='ls -la'" },
          { ok: a.has('h') && norm(a.get('h')) === 'history', label: "alias h='history'" },
          { ok: ran(ctx, /^\s*alias\s*$/), label: 'выведен список алиасов (alias)' },
          { ok: ran(ctx, /^\s*ll(\s|$)/), label: 'алиас ll проверен в работе' },
        ];
      },
    },
    {
      id: 'T3', section: 'term', type: 'terminal', points: 4, core: true, minutes: 3,
      title: 'Постоянный алиас в ~/.bashrc',
      desc: '<p>Алиас, созданный в терминале, исчезает после выхода. Чтобы он сохранялся, его пишут в файл ' + code('~/.bashrc') + '.</p>' +
        '<ol><li>Добавьте в конец ' + code('~/.bashrc') + ' строку ' + code("alias lab='cd ~/lab10'") + ' (через ' + code('nano ~/.bashrc') + ' или ' + code('echo ... >> ~/.bashrc') + ').</li>' +
        '<li>Примените изменения: ' + code('source ~/.bashrc') + '.</li>' +
        '<li>Перейдите в домашний каталог (' + code('cd') + '), затем выполните ' + code('lab') + ' и ' + code('pwd') + '.</li></ol>' +
        ex("$ echo \"alias lab='cd ~/lab10'\" >> ~/.bashrc\n$ source ~/.bashrc\n$ cd\n$ lab\n$ pwd\n/home/student/lab10") +
        hint('<p>Обратите внимание на кавычки: снаружи двойные, внутри одинарные. Посмотреть файл: ' + code('tail -3 ~/.bashrc') + '.</p>'),
      check(ctx) {
        const rc = (ctx.fs.get(H + '/.bashrc') || {}).x || '';
        const lineOk = /^\s*alias\s+lab=(['"])cd\s+(~|\/home\/student|\$HOME)\/lab10\/?\1\s*$/m.test(rc);
        return [
          { ok: lineOk, label: "в ~/.bashrc есть строка alias lab='cd ~/lab10'" },
          { ok: ctx.execLog.some(e => e.how === 'source' && e.path === H + '/.bashrc'), label: 'выполнено source ~/.bashrc' },
          { ok: ctx.aliases.has('lab'), label: 'алиас lab действует в терминале' },
          { ok: ran(ctx, /^\s*lab\s*$/), label: 'команда lab запущена' },
        ];
      },
    },
    {
      id: 'T4', section: 'term', type: 'terminal', points: 5, core: true, minutes: 3,
      title: 'Первый скрипт: nano → chmod → ./',
      desc: '<p>Повторите путь со слайда «Bash скрипт жазу».</p><ol>' +
        '<li>Перейдите в ' + code('~/lab10') + ' и откройте редактор: ' + code('nano hello.sh') + '.</li>' +
        '<li>Первая строка — shebang ' + code('#!/bin/bash') + ', вторая — комментарий (что делает скрипт), дальше — команда, выводящая ровно ' + code('Hello, Linux!') + '. Можно добавить и другие команды, например ' + code('whoami') + '.</li>' +
        '<li>Сохраните (Ctrl+O или Ctrl+S) и выйдите (Ctrl+X).</li>' +
        '<li>Сделайте файл исполняемым: ' + code('chmod +x hello.sh') + ' и запустите: ' + code('./hello.sh') + '.</li></ol>' +
        ex('$ cd ~/lab10\n$ nano hello.sh\n$ chmod +x hello.sh\n$ ./hello.sh\nHello, Linux!') +
        hint('<p>Если видите ' + code('Permission denied') + ' — забыли ' + code('chmod +x') + '. Если ' + code('required file not found') + ' — ошибка в первой строке.</p>'),
      check(ctx) {
        const p = H + '/lab10/hello.sh';
        const n = ctx.fs.get(p);
        const lines = n && n.t === 'f' ? n.x.split('\n') : [];
        let out = '';
        if (n && n.t === 'f') out = ctx.runScript(p).out;
        return [
          { ok: !!n && n.t === 'f', label: 'файл ~/lab10/hello.sh создан' },
          { ok: /^#!\s*(\/bin\/bash|\/usr\/bin\/bash|\/usr\/bin\/env\s+bash)\s*$/.test(lines[0] || ''), label: 'первая строка — #!/bin/bash' },
          { ok: lines.slice(1).some(l => /^\s*#/.test(l)), label: 'есть строка-комментарий' },
          { ok: !!n && (n.m & 0o100) !== 0, label: 'есть право на выполнение (chmod +x)' },
          { ok: out.split('\n')[0] === 'Hello, Linux!', label: 'первая строка вывода — Hello, Linux!' },
          { ok: ctx.execLog.some(e => e.path === p && e.how === 'exec' && e.status === 0), label: 'скрипт запущен как ./hello.sh' },
        ];
      },
    },
    {
      id: 'T5', section: 'term', type: 'terminal', points: 4, core: true, minutes: 3,
      title: 'Скрипт со слайда: script2.sh',
      desc: '<p>Создайте в ' + code('~/lab10') + ' скрипт ' + code('script2.sh') + ' (как на слайде), дайте права ' + code('755') + ' и запустите его из папки ' + code('~/lab10') + '.</p>' +
        ex("#!/bin/bash\nmkdir -p dir1\n# This is a Bash comment\necho 'Welcome to Almaty!' > dir1/file1.txt\nls -l dir1          # listing the directory\ncat dir1/file1.txt  # file contents") +
        ex('$ chmod 755 script2.sh\n$ ./script2.sh'),
      check(ctx) {
        const p = H + '/lab10/script2.sh';
        const n = ctx.fs.get(p);
        const f = ctx.fs.get(H + '/lab10/dir1/file1.txt');
        return [
          { ok: !!n && n.t === 'f', label: 'файл ~/lab10/script2.sh создан' },
          { ok: !!n && (n.m & 0o777) === 0o755, label: 'права 755 (rwxr-xr-x)' },
          { ok: !!n && /mkdir\s+-p\s+dir1/.test(n.x), label: 'в скрипте есть mkdir -p dir1' },
          { ok: !!f && f.t === 'f' && f.x === 'Welcome to Almaty!\n', label: 'создан dir1/file1.txt с текстом Welcome to Almaty!' },
          { ok: ctx.execLog.some(e => e.path === p && e.how === 'exec' && e.status === 0), label: 'скрипт запущен как ./script2.sh' },
        ];
      },
    },

    /* ================= ПЕРЕМЕННЫЕ ================= */
    {
      id: 'B1', section: 'vars', type: 'script', points: 6, core: true, minutes: 3,
      title: 'Приветствие по аргументам', file: 'greet.sh',
      desc: '<p>Скрипт получает два аргумента: имя (' + code('$1') + ') и возраст (' + code('$2') + '). Сохраните их в переменные и выведите три строки:</p>' +
        ex('$ ./greet.sh Айгерим 19\nПривет, Айгерим!\nТебе 19 лет.\nЧерез 5 лет тебе будет 24.') +
        hint('<p>Присваивание без пробелов: ' + code('name=$1') + '. Арифметика: ' + code('$((age + 5))') + '.</p>'),
      args: 'Айгерим 19',
      tests: [{ args: ['Айгерим', '19'] }, { args: ['Timur', '30'] }, { args: ['Дана', '7'] }],
      req: [['\\$\\{?1', 'используйте аргумент $1'], ['\\$\\{?2', 'используйте аргумент $2'], ['\\$\\(\\(|\\blet\\b|\\bexpr\\b', 'возраст через 5 лет посчитайте через $(( ))']],
    },
    {
      id: 'B2', section: 'vars', type: 'script', points: 3, core: false, minutes: 2,
      title: 'Специальные переменные', file: 'args.sh',
      desc: '<p>Выведите количество аргументов, все аргументы, первый и последний аргумент.</p>' +
        ex('$ ./args.sh a b c\nКоличество аргументов: 3\nВсе аргументы: a b c\nПервый: a\nПоследний: c') +
        hint('<p>' + code('$#') + ' — количество, ' + code('$@') + ' — все аргументы. Последний: ' + code('${@: -1}') + ' (пробел перед минусом обязателен) или ' + code('${!#}') + '.</p>'),
      args: 'a b c',
      tests: [{ args: ['a', 'b', 'c'] }, { args: ['one'] }, { args: ['x', 'y', 'z', 'w'] }],
      req: [['\\$#', 'количество аргументов — $#'], ['\\$@|\\$\\*|\\$\\{@', 'все аргументы — $@']],
    },
    {
      id: 'B3', section: 'vars', type: 'script', points: 6, core: true, minutes: 3,
      title: 'Калькулятор: read и $(( ))', file: 'math.sh',
      desc: '<p>Скрипт читает два целых числа командой ' + code('read') + ' (каждое на своей строке) и выводит результаты пяти операций:</p>' +
        ex('$ ./math.sh\n17\n5\n17 + 5 = 22\n17 - 5 = 12\n17 * 5 = 85\n17 / 5 = 3\n17 % 5 = 2') +
        '<p>Для проверки числа подаются на стандартный ввод (поле «Ввод (stdin)»).</p>' +
        hint('<p>' + code('read a') + ' читает одну строку в переменную a. Деление в bash целочисленное.</p>'),
      stdin: '17\n5\n',
      tests: [{ stdin: '17\n5\n' }, { stdin: '100\n7\n' }, { stdin: '-9\n4\n' }],
      req: [['\\bread\\b', 'числа читайте командой read']],
    },
    {
      id: 'B4', section: 'vars', type: 'script', points: 3, core: false, minutes: 3,
      title: 'Подстановка команд $( )', file: 'count.sh',
      desc: '<p>Аргумент — имя файла. Сохраните количество строк и слов в переменные с помощью ' + code('$( )') + ' и выведите одну строку:</p>' +
        ex('$ ./count.sh students.txt\nФайл: students.txt, строк: 6, слов: 18') +
        hint('<p>' + code('wc -l < файл') + ' печатает только число, без имени файла.</p>'),
      args: 'students.txt',
      tests: [{ args: ['students.txt'] }, { args: ['logs/app.log'] }, { args: ['text.txt'] }],
      req: [['\\$\\(', 'используйте подстановку команды $( )'], ['\\bwc\\b', 'посчитайте через wc']],
    },

    /* ================= УСЛОВИЯ ================= */
    {
      id: 'C1', section: 'cond', type: 'script', points: 6, core: true, minutes: 3,
      title: 'Чётное или нечётное', file: 'even.sh',
      desc: '<p>Если аргумент не передан — выведите ' + code('Ошибка: укажите число') + ' и завершите скрипт с кодом 1 (' + code('exit 1') + '). Иначе сообщите, чётное ли число.</p>' +
        ex('$ ./even.sh 4\nЧисло 4 чётное\n$ ./even.sh 7\nЧисло 7 нечётное\n$ ./even.sh\nОшибка: укажите число\n$ echo $?\n1') +
        hint('<p>Проверка количества аргументов: ' + code('[ $# -eq 0 ]') + '. Остаток от деления: ' + code('$((n % 2))') + '.</p>'),
      args: '4',
      tests: [{ args: [], code: true }, { args: ['4'] }, { args: ['7'] }, { args: ['0'] }, { args: ['-3'] }],
      req: [['\\bif\\b', 'используйте if'], ['\\bexit\\s+1\\b', 'при ошибке завершайте скрипт: exit 1']],
    },
    {
      id: 'C2', section: 'cond', type: 'script', points: 7, core: true, minutes: 4,
      title: 'Оценка по баллу (elif)', file: 'grade.sh',
      desc: '<p>Аргумент — балл. Выведите оценку:</p><table class="t"><tr><td>90–100</td><td>Отлично</td></tr><tr><td>75–89</td><td>Хорошо</td></tr><tr><td>50–74</td><td>Удовлетворительно</td></tr><tr><td>0–49</td><td>Неудовлетворительно</td></tr><tr><td>иначе</td><td>Ошибка: балл должен быть от 0 до 100</td></tr></table>' +
        ex('$ ./grade.sh 82\nХорошо\n$ ./grade.sh 120\nОшибка: балл должен быть от 0 до 100') +
        hint('<p>Сравнение чисел: ' + code('-lt -le -gt -ge -eq -ne') + '. Несколько условий подряд — ' + code('if ... elif ... else ... fi') + '.</p>'),
      args: '82',
      tests: ['95', '90', '89', '75', '74', '50', '49', '0', '100', '101', '-5'].map(a => ({ args: [a] })),
      req: [['\\belif\\b', 'используйте elif']],
    },
    {
      id: 'C3', section: 'cond', type: 'script', points: 4, core: false, minutes: 3,
      title: 'Проверка файлов', file: 'check.sh',
      desc: '<p>Аргумент — путь. Проверьте его в таком порядке и выведите одну строку:</p><table class="t">' +
        '<tr><td>не существует</td><td>' + code('путь: не существует') + '</td></tr>' +
        '<tr><td>каталог</td><td>' + code('путь: каталог') + '</td></tr>' +
        '<tr><td>исполняемый файл</td><td>' + code('путь: исполняемый файл') + '</td></tr>' +
        '<tr><td>пустой файл</td><td>' + code('путь: пустой файл') + '</td></tr>' +
        '<tr><td>иначе</td><td>' + code('путь: обычный файл') + '</td></tr></table>' +
        ex('$ ./check.sh logs\nlogs: каталог\n$ ./check.sh run.sh\nrun.sh: исполняемый файл') +
        hint('<p>Файловые проверки: ' + code('-e') + ' существует, ' + code('-d') + ' каталог, ' + code('-x') + ' исполняемый, ' + code('-s') + ' не пустой. Отрицание: ' + code('[ ! -e "$p" ]') + '.</p>'),
      args: 'logs',
      tests: [{ args: ['logs'] }, { args: ['run.sh'] }, { args: ['notes.txt'] }, { args: ['empty.txt'] }, { args: ['zzz'] }],
      req: [['-e\\b|-d\\b', 'используйте файловые проверки -e, -d, -x, -s']],
    },

    /* ================= СТРОКИ ================= */
    {
      id: 'D1', section: 'str', type: 'script', points: 7, core: true, minutes: 4,
      title: 'Имя файла по частям', file: 'fname.sh',
      desc: '<p>Аргумент — имя файла. Используя операции со строками bash (без внешних команд), выведите:</p>' +
        ex('$ ./fname.sh report_2026.txt\nИмя файла: report_2026.txt\nДлина: 15\nБез расширения: report_2026\nРасширение: txt\nЗаглавными: REPORT_2026.TXT') +
        '<p>Если точек несколько (' + code('photo.backup.JPG') + '), расширение — часть после <b>последней</b> точки (' + code('JPG') + '), а без расширения — ' + code('photo.backup') + '.</p>' +
        hint('<p>' + code('${#f}') + ' — длина, ' + code('${f%.*}') + ' — убрать самый короткий хвост «.что-то», ' + code('${f##*.}') + ' — убрать самое длинное начало до точки, ' + code('${f^^}') + ' — заглавные.</p>'),
      args: 'report_2026.txt',
      tests: [{ args: ['report_2026.txt'] }, { args: ['photo.backup.JPG'] }, { args: ['archive.tar.gz'] }],
      req: [['\\$\\{#\\w+\\}', 'длину найдите через ${#переменная}'], ['\\$\\{\\w+%', 'имя без расширения — ${f%.*}'], ['\\$\\{\\w+#', 'расширение — ${f##*.}']],
    },
    {
      id: 'D2', section: 'str', type: 'script', points: 4, core: false, minutes: 4,
      title: 'Палиндром', file: 'palindrome.sh',
      desc: '<p>Аргумент — слово. Без учёта регистра проверьте, читается ли оно одинаково в обе стороны:</p>' +
        ex('$ ./palindrome.sh Level\nLevel: палиндром\n$ ./palindrome.sh Linux\nLinux: не палиндром') +
        hint('<p>Нижний регистр: ' + code('${w,,}') + '. Перевернуть строку можно циклом по ' + code('${w:i:1}') + ' или командой ' + code('rev') + ': ' + code('r=$(echo "$w" | rev)') + '.</p>'),
      args: 'Level',
      tests: ['Level', 'Linux', 'abba', 'Казак', 'a'].map(a => ({ args: [a] })),
      req: [],
    },

    /* ================= ЦИКЛЫ ================= */
    {
      id: 'E1', section: 'loop', type: 'script', points: 6, core: true, minutes: 3,
      title: 'Таблица умножения (for)', file: 'table.sh',
      desc: '<p>Выведите таблицу умножения для числа-аргумента от 1 до 10 с помощью цикла ' + code('for') + ':</p>' +
        ex('$ ./table.sh 7\n7 x 1 = 7\n7 x 2 = 14\n...\n7 x 10 = 70') +
        hint('<p>' + code('for i in {1..10}; do ... done') + ' или ' + code('for ((i=1; i<=10; i++))') + '.</p>'),
      args: '7',
      tests: ['7', '3', '12'].map(a => ({ args: [a] })),
      req: [['\\bfor\\b', 'используйте цикл for']],
    },
    {
      id: 'E2', section: 'loop', type: 'script', points: 6, core: true, minutes: 4,
      title: 'Суммы (while)', file: 'sum.sh',
      desc: '<p>С помощью цикла ' + code('while') + ' посчитайте сумму чисел от 1 до N и сумму только чётных из них:</p>' +
        ex('$ ./sum.sh 10\nСумма от 1 до 10 = 55\nСумма чётных = 30') +
        hint('<p>Счётчик: ' + code('i=1') + ', условие ' + code('while [ $i -le $n ]') + ', внутри не забудьте ' + code('i=$((i + 1))') + ', иначе цикл будет бесконечным.</p>'),
      args: '10',
      tests: ['10', '1', '100', '7'].map(a => ({ args: [a] })),
      req: [['\\bwhile\\b|\\buntil\\b', 'используйте цикл while']],
    },
    {
      id: 'E3', section: 'loop', type: 'script', points: 7, core: true, minutes: 5,
      title: 'Кто сдал? (while read)', file: 'passed.sh',
      desc: '<p>Аргумент — файл, где в каждой строке «Фамилия Имя Балл» (см. ' + code('cat students.txt') + '). Прочитайте его циклом ' + code('while read') + ' и выведите студентов с баллом 50 и выше, а в конце — итог:</p>' +
        ex('$ ./passed.sh students.txt\nСдали:\nАхметов Али 85\nКим Тимур 67\nСерикова Аружан 91\nЖумабаев Ерлан 50\nИтого: 4 из 6') +
        hint('<p>' + code('while read -r last first score; do ... done < "$file"') + ' — read сам разделит строку на три переменные.</p>'),
      args: 'students.txt',
      tests: [{ args: ['students.txt'] }, { args: ['group2.txt'] }],
      req: [['\\bwhile\\b[\\s\\S]*\\bread\\b', 'читайте файл циклом while read']],
    },
    {
      id: 'E4', section: 'loop', type: 'script', points: 4, core: false, minutes: 4,
      title: 'Логи: перебор файлов', file: 'logs.sh',
      desc: '<p>Аргумент — каталог. Для каждого файла ' + code('*.log') + ' в нём (по алфавиту) выведите имя файла и число строк, в конце — общее число строк:</p>' +
        ex('$ ./logs.sh logs\napp.log - 3\ndb.log - 2\nerror.log - 4\nВсего строк: 9') +
        hint('<p>' + code('for f in "$1"/*.log') + '. Имя без пути: ' + code('${f##*/}') + ' или ' + code('basename "$f"') + '.</p>'),
      args: 'logs',
      tests: [{ args: ['logs'] }, { args: ['var'] }],
      req: [['\\bfor\\b', 'перебирайте файлы циклом for']],
    },

    /* ================= CASE ================= */
    {
      id: 'F1', section: 'case', type: 'script', points: 6, core: true, minutes: 4,
      title: 'Калькулятор на case', file: 'calc.sh',
      desc: '<p>Аргументы: число, операция, число. Операции: ' + code('+ - x / %') + ' (умножение — буква ' + code('x') + ', потому что ' + code('*') + ' оболочка превращает в список файлов).</p>' +
        ex('$ ./calc.sh 12 x 5\n12 x 5 = 60\n$ ./calc.sh 7 / 0\nОшибка: деление на ноль\n$ ./calc.sh 2 ^ 3\nНеизвестная операция: ^') +
        '<p>При делении (/ или %) на ноль завершайте скрипт с кодом 2, при неизвестной операции — с кодом 1.</p>' +
        hint('<p>' + code('case $op in +) ... ;; -) ... ;; *) ... ;; esac') + '. Несколько вариантов в одной ветке: ' + code('/|%)') + '.</p>'),
      args: '12 x 5',
      tests: [
        { args: ['12', '+', '5'] }, { args: ['12', '-', '5'] }, { args: ['12', 'x', '5'] }, { args: ['12', '/', '5'] },
        { args: ['12', '%', '5'] }, { args: ['7', '/', '0'], code: true }, { args: ['9', '%', '0'], code: true }, { args: ['2', '^', '3'], code: true },
      ],
      req: [['\\bcase\\b', 'используйте case']],
    },
    {
      id: 'F2', section: 'case', type: 'script', points: 4, core: false, minutes: 3,
      title: 'Тип файла по расширению', file: 'ftype.sh',
      desc: '<p>Определите тип файла по расширению без учёта регистра:</p><table class="t">' +
        '<tr><td>jpg, jpeg, png, gif</td><td>Изображение</td></tr><tr><td>txt, doc, docx, pdf</td><td>Документ</td></tr>' +
        '<tr><td>zip, tar, gz, rar</td><td>Архив</td></tr><tr><td>sh</td><td>Скрипт</td></tr><tr><td>другое</td><td>Неизвестный тип</td></tr></table>' +
        ex('$ ./ftype.sh photo.JPG\nphoto.JPG: Изображение'),
      args: 'photo.JPG',
      tests: ['photo.JPG', 'notes.txt', 'backup.tar.gz', 'run.sh', 'README', 'data.csv'].map(a => ({ args: [a] })),
      req: [['\\bcase\\b', 'используйте case']],
    },

    /* ================= ФУНКЦИИ ================= */
    {
      id: 'G1', section: 'func', type: 'script', points: 6, core: true, minutes: 5,
      title: 'Простые числа (функция)', file: 'primes.sh',
      desc: '<p>Напишите функцию ' + code('is_prime') + ', которая возвращает код 0, если её аргумент — простое число, и 1 — если нет. С её помощью выведите в одну строку все простые числа от 2 до N:</p>' +
        ex('$ ./primes.sh 20\nПростые числа до 20: 2 3 5 7 11 13 17 19\n$ ./primes.sh 1\nНет простых чисел') +
        hint('<p>Функция «отвечает» кодом возврата: ' + code('return 0') + ' / ' + code('return 1') + '. Тогда её можно ставить прямо в if: ' + code('if is_prime $i; then ...') + '. Переменные внутри функции объявляйте через ' + code('local') + '.</p>'),
      args: '20',
      tests: ['20', '2', '1', '50'].map(a => ({ args: [a] })),
      req: [[FUNC_RE, 'объявите функцию: is_prime() { ... }'], ['\\breturn\\b', 'функция должна возвращать результат через return']],
    },
    {
      id: 'G2', section: 'func', type: 'script', points: 4, core: false, minutes: 4,
      title: 'Таблица степеней (printf)', file: 'powers.sh',
      desc: '<p>Напишите функции ' + code('square') + ' и ' + code('cube') + ' (выводят n² и n³ через echo) и напечатайте ровную таблицу для n от 1 до N командой ' + code('printf "%3d %6d %6d\\n"') + '. Заголовок — ' + code('printf "%3s %6s %6s\\n" n "n^2" "n^3"') + '.</p>' +
        ex('$ ./powers.sh 3\n  n    n^2    n^3\n  1      1      1\n  2      4      8\n  3      9     27') +
        hint('<p>Результат функции: ' + code('s=$(square $i)') + '.</p>'),
      args: '3',
      tests: ['3', '5', '12'].map(a => ({ args: [a] })),
      req: [[FUNC_RE, 'объявите функции square и cube'], ['\\bprintf\\b', 'выводите таблицу через printf']],
    },

    /* ================= МАССИВЫ ================= */
    {
      id: 'H1', section: 'arr', type: 'script', points: 6, core: true, minutes: 4,
      title: 'Статистика по массиву', file: 'stats.sh',
      desc: '<p>Числа передаются аргументами. Сохраните их в массив и выведите:</p>' +
        ex('$ ./stats.sh 5 3 9 1 7\nКоличество: 5\nСумма: 25\nМинимум: 1\nМаксимум: 9\nСреднее: 5') +
        '<p>Среднее — целая часть (как делит bash).</p>' +
        hint('<p>' + code('nums=("$@")') + ', длина — ' + code('${#nums[@]}') + ', перебор — ' + code('for n in "${nums[@]}"') + '. Начальные min и max — ' + code('${nums[0]}') + '.</p>'),
      args: '5 3 9 1 7',
      tests: [{ args: ['5', '3', '9', '1', '7'] }, { args: ['10'] }, { args: ['-4', '8', '2', '-10'] }],
      req: [['=\\s*\\(', 'сохраните числа в массив: nums=("$@")'], ['\\[@\\]|\\[\\*\\]', 'используйте элементы массива: "${nums[@]}"']],
    },
    {
      id: 'H2', section: 'arr', type: 'script', points: 4, core: false, minutes: 4,
      title: 'Массив слов', file: 'words.sh',
      desc: '<p>Слова передаются аргументами. Сохраните их в массив и выведите количество, слова по порядку, в обратном порядке и самое длинное (при равной длине — первое):</p>' +
        ex('$ ./words.sh banana apple cherry\nСлов: 3\nПо порядку: banana apple cherry\nВ обратном порядке: cherry apple banana\nСамое длинное: banana'),
      args: 'banana apple cherry',
      tests: [{ args: ['banana', 'apple', 'cherry'] }, { args: ['Linux', 'bash', 'shell', 'scripting'] }, { args: ['a'] }],
      req: [['=\\s*\\(', 'сохраните слова в массив'], ['\\[@\\]|\\[\\*\\]|\\[\\w+\\]|\\[\\$', 'обращайтесь к элементам массива']],
    },
    {
      id: 'H3', section: 'arr', type: 'script', points: 5, core: false, minutes: 4,
      title: 'Частота слов (declare -A)', file: 'freq.sh',
      desc: '<p>Аргумент — текстовый файл. С помощью ассоциативного массива посчитайте, сколько раз встречается каждое слово, и выведите пары «слово число», отсортированные по слову:</p>' +
        ex('$ ./freq.sh text.txt\na 1\nand 2\nbird 1\ncat 2\ndog 2\nthe 4') +
        hint('<p>' + code('declare -A count') + ', ' + code('count[$w]=$(( ${count[$w]:-0} + 1 ))') + '. Порядок ключей в ассоциативном массиве не определён — отсортируйте вывод: ' + code('done | sort') + '.</p>'),
      args: 'text.txt',
      tests: [{ args: ['text.txt'] }, { args: ['text2.txt'] }],
      req: [['declare\\s+-A|local\\s+-A', 'нужен ассоциативный массив: declare -A']],
    },

    /* ================= ИТОГОВЫЕ ================= */
    {
      id: 'I1', section: 'final', type: 'script', points: 6, core: false, minutes: 6,
      title: 'Банковский счёт', file: 'bank.sh',
      desc: '<p>Скрипт читает команды со стандартного ввода (по одной в строке) циклом ' + code('while read') + ' и обрабатывает их через ' + code('case') + ' и функции. Начальный баланс — 0.</p><table class="t">' +
        '<tr><td>deposit N</td><td>Пополнение: N. Баланс: B</td></tr>' +
        '<tr><td>withdraw N</td><td>Снятие: N. Баланс: B — или, если денег мало: Недостаточно средств. Баланс: B</td></tr>' +
        '<tr><td>balance</td><td>Баланс: B</td></tr><tr><td>exit</td><td>До свидания! (и выход из цикла)</td></tr>' +
        '<tr><td>другое</td><td>Неизвестная команда: X</td></tr></table>' +
        ex('$ ./bank.sh\ndeposit 100\nПополнение: 100. Баланс: 100\nwithdraw 30\nСнятие: 30. Баланс: 70\nexit\nДо свидания!'),
      stdin: 'deposit 100\nwithdraw 30\nbalance\nexit\n',
      tests: [
        { stdin: 'deposit 100\nwithdraw 30\nbalance\nexit\n' },
        { stdin: 'withdraw 10\ndeposit 50\nfoo\nwithdraw 60\ndeposit 25\nbalance\nexit\nbalance\n' },
        { stdin: 'deposit 5\nbalance\n' },
      ],
      req: [[FUNC_RE, 'оформите операции функциями'], ['\\bcase\\b', 'используйте case'], ['\\bwhile\\b', 'используйте цикл while read']],
    },
    {
      id: 'I2', section: 'final', type: 'script', points: 5, core: false, minutes: 5,
      title: 'Проверка пароля (=~)', file: 'password.sh',
      desc: '<p>Аргумент — пароль. Проверьте 5 условий и выведите «да»/«нет» для каждого и итог:</p>' +
        ex('$ ./password.sh Passw0rd!\nДлина >= 8: да\nЕсть цифра: да\nЕсть заглавная буква: да\nЕсть строчная буква: да\nЕсть спецсимвол: да\nНадёжность: 5/5') +
        hint('<p>Регулярные выражения: ' + code('[[ $p =~ [0-9] ]]') + ', ' + code('[A-Z]') + ', ' + code('[a-z]') + ', спецсимвол — ' + code('[^a-zA-Z0-9]') + '.</p>'),
      args: 'Passw0rd!',
      tests: ['qwerty', 'Passw0rd!', 'abcdefgh1', 'ABC#1', 'Str0ng#Pass'].map(a => ({ args: [a] })),
      req: [['=~', 'используйте [[ строка =~ шаблон ]]']],
    },
  ];

  /* Начальный код для заданий-скриптов */
  for (const t of TASKS) {
    if (t.type !== 'script') continue;
    const run = './' + t.file + (t.args ? ' ' + t.args : '');
    t.starter = '#!/bin/bash\n# Задание ' + t.id + '. ' + t.title + '\n# Запуск: ' + run + '\n\n';
  }

  /* ---------- Хеш (cyrb53) ---------- */
  function hash(str) {
    let h1 = 0xdeadbeef ^ 53, h2 = 0x41c6ce57 ^ 53;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }
  const answerHash = (id, s) => hash(LAB.salt + '|' + id + '|' + s);

  /* Нормализация вывода для сравнения */
  function normOut(s) {
    return String(s || '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r/g, '')
      .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
      .replace(/\n+$/, '');
  }
  function normQuiz(s) {
    return String(s || '').replace(/\r/g, '').split('\n').map(l => l.trim().replace(/[ \t]+/g, ' ')).join('\n').replace(/^\n+|\n+$/g, '');
  }
  /* Удаление комментариев перед проверкой требований */
  function stripComments(src) {
    return src.split('\n').map((line, idx) => {
      if (idx === 0 && line.startsWith('#!')) return '';
      let q = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '\\' && q === '"') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\\') { i++; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '#' && (i === 0 || /[\s;|&(]/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    }).join('\n');
  }

  BS.LAB = LAB;
  BS.TASKS = TASKS;
  BS.SECTIONS = SECTIONS;
  BS.FIXTURES = FIXTURES;
  BS.FIXTURE_MODES = FIXTURE_MODES;
  BS.labUtil = { hash, answerHash, normOut, normQuiz, stripComments, esc };
})(globalThis.BS = globalThis.BS || {});
