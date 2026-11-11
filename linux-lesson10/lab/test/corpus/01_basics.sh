#!/bin/bash
# переменные и кавычки
name="Linux"
ver=5
echo "Hello, $name! v$ver"
echo 'Single $name'
echo "Braces ${name}OS"
echo $name   spaced    words
x="a   b"; echo $x; echo "$x"
echo -n "no newline"; echo " done"
echo -e "tab\there\nnew"
printf "%s=%d\n" age 19
printf "%-8s|%5s|\n" left right
printf "%05.2f %x %o %e\n" 3.14159 255 8 12345.678
printf "%s\n" a b c
printf "[%3d]\n" 1 22 333
readonly PI=3.14; echo $PI
unset name; echo "[${name}]"
