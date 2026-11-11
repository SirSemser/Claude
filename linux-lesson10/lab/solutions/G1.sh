#!/bin/bash
# G1. Простые числа с функцией
is_prime() {
    local n=$1
    if [ $n -lt 2 ]; then
        return 1
    fi
    for (( d=2; d*d<=n; d++ )); do
        if [ $((n % d)) -eq 0 ]; then
            return 1
        fi
    done
    return 0
}
limit=$1
result=""
for (( i=2; i<=limit; i++ )); do
    if is_prime $i; then
        result+="$i "
    fi
done
if [ -z "$result" ]; then
    echo "Нет простых чисел"
else
    echo "Простые числа до $limit: $result"
fi
