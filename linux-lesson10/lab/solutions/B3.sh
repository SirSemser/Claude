#!/bin/bash
# B3. Калькулятор: два числа со стандартного ввода
read a
read b
echo "$a + $b = $((a + b))"
echo "$a - $b = $((a - b))"
echo "$a * $b = $((a * b))"
echo "$a / $b = $((a / b))"
echo "$a % $b = $((a % b))"
