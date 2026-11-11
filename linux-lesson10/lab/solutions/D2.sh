#!/bin/bash
# D2. Палиндром
word=$1
lower=${word,,}
rev=""
for (( i=${#lower}-1; i>=0; i-- )); do
    rev+=${lower:i:1}
done
if [ "$lower" = "$rev" ]; then
    echo "$word: палиндром"
else
    echo "$word: не палиндром"
fi
