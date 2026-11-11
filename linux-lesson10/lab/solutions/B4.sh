#!/bin/bash
# B4. Подстановка команд
file=$1
lines=$(wc -l < "$file")
words=$(wc -w < "$file")
echo "Файл: $file, строк: $lines, слов: $words"
