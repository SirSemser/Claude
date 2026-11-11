#!/bin/bash
# E1. Таблица умножения
n=$1
for i in {1..10}; do
    echo "$n x $i = $((n * i))"
done
