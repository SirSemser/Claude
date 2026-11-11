#!/bin/bash
# E3. Кто сдал (балл >= 50)
file=$1
total=0
passed=0
echo "Сдали:"
while read -r last first score; do
    total=$((total + 1))
    if [ "$score" -ge 50 ]; then
        echo "$last $first $score"
        passed=$((passed + 1))
    fi
done < "$file"
echo "Итого: $passed из $total"
