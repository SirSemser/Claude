#!/bin/bash
# H2. Массив слов
words=("$@")
echo "Слов: ${#words[@]}"
echo "По порядку: ${words[*]}"
rev=()
for (( i=${#words[@]}-1; i>=0; i-- )); do
    rev+=("${words[i]}")
done
echo "В обратном порядке: ${rev[*]}"
longest=""
for w in "${words[@]}"; do
    if [ ${#w} -gt ${#longest} ]; then
        longest=$w
    fi
done
echo "Самое длинное: $longest"
