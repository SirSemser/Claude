max() { if (( $1 > $2 )); then echo $1; else echo $2; fi; }
is_prime() {
  local n=$1
  (( n < 2 )) && return 1
  for (( d=2; d*d<=n; d++ )); do (( n % d == 0 )) && return 1; done
  return 0
}
out=""
for i in $(seq 1 30); do is_prime $i && out+="$i "; done
echo "$out"
echo "max: $(max 4 9) $(max 12 3)"
square() { echo $(( $1 * $1 )); }
cube() { echo $(( $1 ** 3 )); }
for i in 1 2 3 10; do printf "%3d %4d %5d\n" $i $(square $i) $(cube $i); done
deposit() { balance=$(( balance + $1 )); }
balance=100; deposit 50; deposit 25; echo "balance=$balance"
rec() { local d=$1; (( d == 0 )) && { echo "bottom"; return; }; rec $((d-1)); echo "up $d"; }
rec 3
fib() { local a=0 b=1 i; for ((i=0;i<$1;i++)); do echo -n "$a "; local t=$((a+b)); a=$b; b=$t; done; echo; }
fib 10
