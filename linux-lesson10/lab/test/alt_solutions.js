/* Альтернативные «студенческие» решения: симулятор должен вести себя как настоящий bash. */
'use strict';
const path = require('path');
const { runReal } = require('./harness');
const BS = globalThis.BS;
require(path.join(__dirname, '..', 'src', 'tasks.js'));
require(path.join(__dirname, '..', 'src', 'labcore.js'));
const LC = BS.labCore;

const ALT = [
  ['B1', 'echo "Привет, $1!"\necho "Тебе $2 лет."\nlet n=$2+5\necho "Через 5 лет тебе будет $n."'],
  ['B1', 'printf "Привет, %s!\\nТебе %d лет.\\nЧерез 5 лет тебе будет %d.\\n" "$1" "$2" "$(expr $2 + 5)"'],
  ['B2', 'echo "Количество аргументов: $#"\necho "Все аргументы: $*"\necho "Первый: $1"\necho "Последний: ${!#}"'],
  ['B2', 'for last; do :; done\necho "Количество аргументов: $#"; echo "Все аргументы: $@"; echo "Первый: $1"; echo "Последний: $last"'],
  ['B3', 'read -r a\nread -r b\nfor op in + - "*" / %; do\n  echo "$a $op $b = $(( a $op b ))"\ndone'],
  ['B3', 'read a; read b\necho "$a + $b = $(expr $a + $b)"\necho "$a - $b = $(expr $a - $b)"\necho "$a * $b = $(expr $a \\* $b)"\necho "$a / $b = $(expr $a / $b)"\necho "$a % $b = $(expr $a % $b)"'],
  ['B4', 'echo "Файл: $1, строк: $(cat $1 | wc -l), слов: $(wc -w < $1)"'],
  ['B4', 'l=$(wc -l "$1" | awk \'{print $1}\')\nw=$(wc -w "$1" | cut -d" " -f1)\necho "Файл: $1, строк: $l, слов: $w"'],
  ['C1', '[[ -z $1 ]] && { echo "Ошибка: укажите число"; exit 1; }\nif (( $1 % 2 == 0 )); then echo "Число $1 чётное"; else echo "Число $1 нечётное"; fi'],
  ['C1', 'if [ -z "$1" ]\nthen\n  echo "Ошибка: укажите число"\n  exit 1\nfi\nr=$(expr $1 % 2)\nif [ $r -eq 0 ]; then echo "Число $1 чётное"\nelse echo "Число $1 нечётное"\nfi'],
  ['C2', 's=$1\nif (( s < 0 || s > 100 )); then echo "Ошибка: балл должен быть от 0 до 100"\nelif (( s >= 90 )); then echo "Отлично"\nelif (( s >= 75 )); then echo "Хорошо"\nelif (( s >= 50 )); then echo "Удовлетворительно"\nelse echo "Неудовлетворительно"; fi'],
  ['C2', 'if [[ $1 -ge 90 && $1 -le 100 ]]; then echo Отлично\nelif [[ $1 -ge 75 && $1 -lt 90 ]]; then echo Хорошо\nelif [ $1 -ge 50 -a $1 -lt 75 ]; then echo Удовлетворительно\nelif [ $1 -ge 0 ] && [ $1 -lt 50 ]; then echo Неудовлетворительно\nelse echo "Ошибка: балл должен быть от 0 до 100"; fi'],
  ['C3', 'if [[ ! -e $1 ]]; then echo "$1: не существует"\nelif [[ -d $1 ]]; then echo "$1: каталог"\nelif [[ -x $1 ]]; then echo "$1: исполняемый файл"\nelif [[ -s $1 ]]; then echo "$1: обычный файл"\nelse echo "$1: пустой файл"; fi'],
  ['D1', 'f="$1"\nname=$(echo $f | rev | cut -d. -f2- | rev)\next=$(echo $f | awk -F. \'{print $NF}\')\necho "Имя файла: $f"\necho "Длина: ${#f}"\necho "Без расширения: ${f%.*}"\necho "Расширение: ${f##*.}"\necho "Заглавными: $(echo $f | tr a-z A-Z)"'],
  ['D2', 'w=$(echo "$1" | tr "[:upper:]" "[:lower:]")\nr=$(echo "${1,,}" | rev)\nif [[ "${1,,}" == "$r" ]]; then echo "$1: палиндром"; else echo "$1: не палиндром"; fi'],
  ['E1', 'for i in $(seq 1 10); do echo "$1 x $i = $(( $1 * i ))"; done'],
  ['E1', 'for ((i = 1; i <= 10; i++))\ndo\n    printf "%d x %d = %d\\n" $1 $i $(($1*i))\ndone'],
  ['E2', 'n=$1; i=0; s=0; e=0\nuntil [ $i -ge $n ]; do\n  ((i++))\n  ((s += i))\n  (( i % 2 == 0 )) && ((e += i))\ndone\necho "Сумма от 1 до $n = $s"\necho "Сумма чётных = $e"'],
  ['E2', 'i=1; sum=0; ev=0\nwhile (( i <= $1 )); do let sum+=i; if [ $((i%2)) == 0 ]; then let ev=ev+i; fi; i=$[i+1]; done\necho "Сумма от 1 до $1 = $sum"; echo "Сумма чётных = $ev"'],
  ['E3', 'echo "Сдали:"\nc=0; t=0\nwhile read line; do\n  t=$((t+1))\n  score=$(echo $line | awk \'{print $3}\')\n  if (( score >= 50 )); then echo "$line"; c=$((c+1)); fi\ndone < $1\necho "Итого: $c из $t"'],
  ['E3', 'echo Сдали:\nawk \'$3 >= 50\' "$1"\nwhile IFS=" " read -r a b s; do :; done < "$1"\necho "Итого: $(awk \'$3>=50\' $1 | wc -l) из $(wc -l < $1)"'],
  ['E4', 'sum=0\nfor f in $(ls $1/*.log); do\n  n=$(cat $f | wc -l)\n  echo "${f##*/} - $n"\n  sum=$((sum+n))\ndone\necho "Всего строк: $sum"'],
  ['E4', 'cd "$1"\ntotal=0\nfor f in *.log; do c=$(wc -l < $f); echo "$f - $c"; total=$((total + c)); done\necho "Всего строк: $total"'],
  ['F1', 'case "$2" in\n  "+") r=$(($1+$3)) ;;\n  "-") r=$(($1-$3)) ;;\n  "x") r=$(($1*$3)) ;;\n  "/"|"%")\n    if (( $3 == 0 )); then echo "Ошибка: деление на ноль"; exit 2; fi\n    [ "$2" = "/" ] && r=$(($1/$3)) || r=$(($1%$3)) ;;\n  *) echo "Неизвестная операция: $2"; exit 1 ;;\nesac\necho "$1 $2 $3 = $r"'],
  ['F2', 'e="${1##*.}"\ncase "${e,,}" in\n  jpg|jpeg|png|gif) echo "$1: Изображение";;\n  txt|doc|docx|pdf) echo "$1: Документ";;\n  zip|tar|gz|rar) echo "$1: Архив";;\n  sh) echo "$1: Скрипт";;\n  *) echo "$1: Неизвестный тип";;\nesac'],
  ['G1', 'function is_prime {\n  (( $1 < 2 )) && return 1\n  local i\n  for ((i=2; i<$1; i++)); do (( $1 % i == 0 )) && return 1; done\n  return 0\n}\nlist=()\nfor n in $(seq 2 $1); do is_prime $n && list+=($n); done\nif [ ${#list[@]} -eq 0 ]; then echo "Нет простых чисел"; else echo "Простые числа до $1: ${list[*]}"; fi'],
  ['G2', 'square() { local n=$1; echo $((n*n)); }\ncube() { echo $(( $1 ** 3 )); }\nprintf "%3s %6s %6s\\n" n n^2 n^3\nfor i in $(seq $1); do printf "%3d %6d %6d\\n" "$i" "$(square $i)" "$(cube $i)"; done'],
  ['H1', 'arr=($@)\nn=${#arr[@]}\nsum=0\nfor x in ${arr[@]}; do sum=$(( sum + x )); done\nsorted=($(printf "%s\\n" "${arr[@]}" | sort -n))\necho "Количество: $n"\necho "Сумма: $sum"\necho "Минимум: ${sorted[0]}"\necho "Максимум: ${sorted[-1]}"\necho "Среднее: $(( sum / n ))"'],
  ['H2', 'w=("$@")\necho "Слов: ${#w[@]}"\necho "По порядку: ${w[@]}"\nr=""\nfor ((i=${#w[@]}-1; i>=0; i--)); do r="$r ${w[$i]}"; done\necho "В обратном порядке:$r"\nmax=${w[0]}\nfor x in "${w[@]}"; do (( ${#x} > ${#max} )) && max=$x; done\necho "Самое длинное: $max"'],
  ['H3', 'declare -A c\nwhile read -r line; do\n  for w in $line; do ((c[$w]++)); done\ndone < "$1"\nfor k in $(echo ${!c[@]} | tr " " "\\n" | sort); do echo "$k ${c[$k]}"; done'],
  ['I1', 'b=0\ndeposit() { (( b += $1 )); echo "Пополнение: $1. Баланс: $b"; }\nwithdraw() { if (( $1 > b )); then echo "Недостаточно средств. Баланс: $b"; return; fi; (( b -= $1 )); echo "Снятие: $1. Баланс: $b"; }\nwhile read c a; do\n  case $c in\n    deposit) deposit $a;;\n    withdraw) withdraw $a;;\n    balance) echo "Баланс: $b";;\n    exit) echo "До свидания!"; exit 0;;\n    *) echo "Неизвестная команда: $c";;\n  esac\ndone'],
  ['I2', 'p="$1"; s=0\nyn() { if eval "$1"; then echo "$2: да"; s=$((s+1)); else echo "$2: нет"; fi; }\nyn \'[ ${#p} -ge 8 ]\' "Длина >= 8"\nyn \'[[ $p =~ [[:digit:]] ]]\' "Есть цифра"\nyn \'[[ $p == *[A-Z]* ]]\' "Есть заглавная буква"\nyn \'[[ $p =~ [a-z] ]]\' "Есть строчная буква"\nyn \'[[ $p =~ [^[:alnum:]] ]]\' "Есть спецсимвол"\necho "Надёжность: $s/5"'],
];

let fail = 0, n = 0;
for (const [id, body] of ALT) {
  const t = BS.TASKS.find(x => x.id === id);
  const code = '#!/bin/bash\n' + body + '\n';
  t.tests.forEach((tc, i) => {
    n++;
    const sim = LC.runIsolated(t.file, code, tc.args || [], tc.stdin || '');
    const fixtures = Object.assign({}, BS.FIXTURES);
    const real = runReal(code, { name: t.file, fixtures, modes: BS.FIXTURE_MODES, args: tc.args || [], stdin: tc.stdin || '' });
    if (sim.out !== real.out || sim.code !== real.code) {
      fail++;
      console.log('DIFF ' + id + ' test ' + (i + 1) + '\n  real: ' + JSON.stringify(real.out) + ' (' + real.code + ')\n  sim:  ' + JSON.stringify(sim.out) + ' (' + sim.code + ')');
    }
  });
}
console.log('alt runs: ' + n + ', diffs: ' + fail);
process.exit(fail ? 1 : 0);
