#!/bin/bash
# G2. Таблица степеней
square() { echo $(( $1 * $1 )); }
cube() { echo $(( $1 * $1 * $1 )); }
printf "%3s %6s %6s\n" n "n^2" "n^3"
for (( i=1; i<=$1; i++ )); do
    printf "%3d %6d %6d\n" $i $(square $i) $(cube $i)
done
