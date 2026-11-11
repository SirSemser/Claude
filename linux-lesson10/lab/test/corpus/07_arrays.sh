arr=(red green blue)
echo ${arr[0]} ${arr[1]} ${arr[2]}
echo ${arr[@]}
echo ${#arr[@]}
arr+=(yellow)
echo "${arr[@]}" ${#arr[@]}
echo ${!arr[@]}
arr[5]=black
echo ${#arr[@]} ${!arr[@]}
unset arr[1]
echo "${arr[@]}"
for c in "${arr[@]}"; do echo "color: $c"; done
nums=(5 3 9 1 7)
sum=0; for n in "${nums[@]}"; do sum=$((sum+n)); done; echo "sum=$sum"
max=${nums[0]}; for n in "${nums[@]}"; do (( n > max )) && max=$n; done; echo "max=$max"
echo "${nums[@]:1:3}"
echo ${arr[-1]}
declare -A ages=([ali]=20 [dana]=19)
ages[timur]=21
echo ${ages[dana]} ${#ages[@]}
for k in $(echo "${!ages[@]}" | tr ' ' '\n' | sort); do echo "$k=${ages[$k]}"; done
words=($(echo "the quick brown fox"))
echo ${#words[@]} ${words[3]}
sorted=($(printf "%s\n" "${nums[@]}" | sort -n)); echo "${sorted[@]}"
mapfile -t lines < a.txt; echo "${#lines[@]} lines, first=${lines[0]}"
declare -a empty=(); echo "empty: ${#empty[@]}"
i=2; echo ${nums[i]} ${nums[$i]} ${nums[i+1]}
declare -p nums
