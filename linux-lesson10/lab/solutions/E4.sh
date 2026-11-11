#!/bin/bash
# E4. Строки в лог-файлах
dir=$1
total=0
for f in "$dir"/*.log; do
    n=$(wc -l < "$f")
    echo "$(basename "$f") - $n"
    total=$((total + n))
done
echo "Всего строк: $total"
