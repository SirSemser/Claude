#!/bin/bash
# C2. Оценка по баллу
score=$1
if [ "$score" -lt 0 ] || [ "$score" -gt 100 ]; then
    echo "Ошибка: балл должен быть от 0 до 100"
elif [ "$score" -ge 90 ]; then
    echo "Отлично"
elif [ "$score" -ge 75 ]; then
    echo "Хорошо"
elif [ "$score" -ge 50 ]; then
    echo "Удовлетворительно"
else
    echo "Неудовлетворительно"
fi
