#!/bin/bash
# C3. Что это за путь?
p=$1
if [ ! -e "$p" ]; then
    echo "$p: не существует"
elif [ -d "$p" ]; then
    echo "$p: каталог"
elif [ -x "$p" ]; then
    echo "$p: исполняемый файл"
elif [ ! -s "$p" ]; then
    echo "$p: пустой файл"
else
    echo "$p: обычный файл"
fi
