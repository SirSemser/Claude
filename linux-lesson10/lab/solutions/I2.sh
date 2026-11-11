#!/bin/bash
# I2. Проверка пароля
p=$1
score=0
check() {
    if [ $2 -eq 1 ]; then
        echo "$1: да"
        score=$((score + 1))
    else
        echo "$1: нет"
    fi
}
[ ${#p} -ge 8 ] && r=1 || r=0;      check "Длина >= 8" $r
[[ $p =~ [0-9] ]] && r=1 || r=0;     check "Есть цифра" $r
[[ $p =~ [A-Z] ]] && r=1 || r=0;     check "Есть заглавная буква" $r
[[ $p =~ [a-z] ]] && r=1 || r=0;     check "Есть строчная буква" $r
[[ $p =~ [^a-zA-Z0-9] ]] && r=1 || r=0; check "Есть спецсимвол" $r
echo "Надёжность: $score/5"
