#!/bin/bash
# E2. Суммы через while
n=$1
i=1
sum=0
even=0
while [ $i -le $n ]; do
    sum=$((sum + i))
    if [ $((i % 2)) -eq 0 ]; then
        even=$((even + i))
    fi
    i=$((i + 1))
done
echo "Сумма от 1 до $n = $sum"
echo "Сумма чётных = $even"
