#!/bin/bash
# F1. Калькулятор на case
a=$1
op=$2
b=$3
case $op in
    +) echo "$a + $b = $((a + b))" ;;
    -) echo "$a - $b = $((a - b))" ;;
    x) echo "$a x $b = $((a * b))" ;;
    /|%)
        if [ "$b" -eq 0 ]; then
            echo "Ошибка: деление на ноль"
            exit 2
        fi
        if [ "$op" = "/" ]; then
            echo "$a / $b = $((a / b))"
        else
            echo "$a % $b = $((a % b))"
        fi
        ;;
    *)
        echo "Неизвестная операция: $op"
        exit 1
        ;;
esac
