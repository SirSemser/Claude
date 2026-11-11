#!/bin/bash
# H1. Статистика по массиву
nums=("$@")
sum=0
min=${nums[0]}
max=${nums[0]}
for n in "${nums[@]}"; do
    sum=$((sum + n))
    if [ $n -lt $min ]; then min=$n; fi
    if [ $n -gt $max ]; then max=$n; fi
done
echo "Количество: ${#nums[@]}"
echo "Сумма: $sum"
echo "Минимум: $min"
echo "Максимум: $max"
echo "Среднее: $((sum / ${#nums[@]}))"
