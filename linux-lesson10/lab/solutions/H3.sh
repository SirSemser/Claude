#!/bin/bash
# H3. Частота слов (ассоциативный массив)
declare -A count
for w in $(cat "$1"); do
    count[$w]=$(( ${count[$w]:-0} + 1 ))
done
for w in "${!count[@]}"; do
    echo "$w ${count[$w]}"
done | sort
