/* Генерирует ключ ответов для преподавателя: teacher/ОТВЕТЫ.md */
'use strict';
const fs = require('fs');
const path = require('path');
for (const f of ['vfs.js', 'parser.js', 'arith.js', 'shell.js', 'commands.js', 'awk.js', 'tasks.js', 'labcore.js']) require(path.join(__dirname, 'src', f));
const BS = globalThis.BS;
const LC = BS.labCore, LU = BS.labUtil;
const SOL = path.join(__dirname, 'solutions');
const quiz = JSON.parse(fs.readFileSync(path.join(SOL, 'quiz.json'), 'utf8'));
const strip = (h) => h.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<pre class="ex">([\s\S]*?)<\/pre>/g, (m, x) => '\n```\n' + x.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') + '\n```\n')
  .replace(/<li>/g, '\n- ').replace(/<tr>/g, '\n- ').replace(/<\/td><td>/g, ' → ').replace(/<code>(.*?)<\/code>/g, '`$1`').replace(/<b>(.*?)<\/b>/g, '**$1**')
  .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

let md = '# Лабораторная работа №10 — ключ ответов для преподавателя\n\n';
md += 'Файл для студентов: `dist/lab10_bash.html`. Этот документ студентам не раздавать.\n\n';
let core = 0, bonus = 0;
for (const t of BS.TASKS) (t.core ? (core += t.points) : (bonus += t.points));
md += '**Баллы:** основные задания — ' + core + ', бонусные — +' + bonus + '. Разминка: каждая ошибка снижает балл за вопрос на 50 %.\n\n';
md += '| № | Задание | Тип | Баллы | ≈ мин |\n|---|---|---|---|---|\n';
const typeName = { choice: 'тест', output: 'что выведет', terminal: 'терминал', script: 'скрипт' };
for (const t of BS.TASKS) md += '| ' + t.id + ' | ' + t.title + (t.type === 'script' ? ' (`' + t.file + '`)' : '') + ' | ' + typeName[t.type] + ' | ' + (t.core ? t.points : '+' + t.points) + ' | ' + t.minutes + ' |\n';
md += '\n';
let section = null;
for (const t of BS.TASKS) {
  if (t.section !== section) { section = t.section; md += '\n## ' + BS.SECTIONS.find(s => s.id === section).title + '\n'; }
  md += '\n### ' + t.id + '. ' + t.title + (t.core ? '' : ' (бонус)') + ' — ' + t.points + ' б.\n\n';
  if (t.type === 'choice') {
    md += strip(t.desc) + '\n\n**Ответ:** ' + t.options[quiz[t.id]] + '\n';
  } else if (t.type === 'output') {
    const r = LC.runIsolated('q.sh', t.code + '\n', [], '');
    md += '```bash\n' + t.code + '\n```\n\n**Ответ:** `' + LU.normQuiz(r.out) + '`\n';
  } else if (t.type === 'terminal') {
    md += strip(t.desc) + '\n\n';
    if (t.id === 'T1') md += '**Ответы:** 1) `8`; 2) `/usr/bin/zsh`.\n\n';
    md += '**Что проверяется:** состояние учебного терминала (файлы, права, алиасы, история команд).\n';
  } else {
    md += strip(t.desc) + '\n\n**Эталонное решение:**\n\n```bash\n' + fs.readFileSync(path.join(SOL, t.id + '.sh'), 'utf8').trimEnd() + '\n```\n\n';
    md += '**Тесты (' + t.tests.length + '):** ' + t.tests.map(x => '`' + (x.args && x.args.length ? x.args.join(' ') : '') + (x.stdin ? ' ← ' + JSON.stringify(x.stdin) : '') + (x.args && !x.args.length && !x.stdin ? '(без аргументов)' : '') + '`').join(', ') + '\n';
    if (t.req && t.req.length) md += '\n**Требования к коду:** ' + t.req.map(r => r[1]).join('; ') + '.\n';
  }
}
md += '\n## Терминальные задания: эталонная последовательность команд\n\n```bash\n' + fs.readFileSync(path.join(SOL, 'terminal_session.txt'), 'utf8').trimEnd() + '\n```\n';
md += '\n## Как проверять работы\n\n1. Студенты присылают файлы `Lab10_Familiya_Imya_Gruppa.html` (имя латиницей).\n2. Откройте `lab10_bash.html`, на стартовом экране нажмите **«Режим преподавателя»** (или добавьте к адресу `#teacher`).\n3. Перетащите все файлы в окно. Каждое решение заново запускается на всех тестах — баллы считаются по перепроверке.\n4. Колонка «Проверка»: «подпись ✓» — файл не редактировали вручную; «расхождения» — статус в файле не совпал с перепроверкой (например, студент поменял файл после проверки).\n5. Кнопка «Скачать таблицу (CSV для Excel)» выгружает итоговую ведомость.\n';
const out = path.join(__dirname, '..', 'teacher', 'ОТВЕТЫ.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
console.log('Записано: ' + out);
