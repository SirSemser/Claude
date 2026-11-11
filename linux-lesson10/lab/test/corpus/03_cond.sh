n=7
if [ $n -gt 5 ]; then echo "big"; else echo "small"; fi
if [ "$n" -eq 7 ] && [ "$n" -lt 10 ]; then echo both; fi
if [[ $n -ge 1 && $n -le 9 ]]; then echo digit; fi
s="hello"
[ -z "$s" ] && echo empty || echo "not empty"
[ -n "$s" ] && echo "has text"
[[ $s == h* ]] && echo "starts with h"
[[ $s =~ ^h(e)l ]] && echo "regex ${BASH_REMATCH[1]}"
[ "$s" = "hello" ] && echo eq
[ "$s" != "world" ] && echo ne
if (( n % 2 == 0 )); then echo even; elif (( n % 3 == 0 )); then echo three; else echo other; fi
[ -f script.sh ] && echo "file exists"
[ -d . ] && echo "dir exists"
[ -e nothing ] || echo "no such"
test 5 -lt 3; echo "status $?"
[ abc -gt 1 ]; echo "status $?"
[ -gt 5 ]; echo "st $?"
true && echo yes; false || echo no
! false && echo negated
