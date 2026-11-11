#!/bin/bash
# C1. Чётное или нечётное
if [ $# -eq 0 ]; then
    echo "Ошибка: укажите число"
    exit 1
fi
n=$1
if [ $((n % 2)) -eq 0 ]; then
    echo "Число $n чётное"
else
    echo "Число $n нечётное"
fi
