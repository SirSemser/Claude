for i in 1 2 3; do echo -n "$i "; done; echo
for i in {1..5}; do echo -n "$i "; done; echo
for i in {10..1..3}; do echo -n "$i "; done; echo
for i in {a..e}; do echo -n "$i"; done; echo
for i in {01..03}; do echo -n "$i "; done; echo
for ((i=0; i<4; i++)); do echo -n "$i"; done; echo
for f in *.txt; do echo "file: $f"; done
for w in $(echo one two three); do echo "[$w]"; done
n=3; while [ $n -gt 0 ]; do echo "n=$n"; n=$((n-1)); done
k=0; until [ $k -ge 3 ]; do echo "k=$k"; ((k++)); done
for i in 1 2 3 4 5 6; do
  if [ $i -eq 2 ]; then continue; fi
  if [ $i -eq 5 ]; then break; fi
  echo "loop $i"
done
for i in 1 2; do for j in a b c; do [ $j = b ] && continue 2; echo "$i$j"; done; done
while read -r line; do echo "> $line"; done < a.txt
cat a.txt | while read -r a b; do echo "$b-$a"; done
count=0; cat a.txt | while read l; do count=$((count+1)); done; echo "count after pipe: $count"
count=0; while read l; do count=$((count+1)); done < a.txt; echo "count after redirect: $count"
for x in $(seq 1 3); do echo "seq $x"; done
seq -s, 1 5
seq 2 2 8
