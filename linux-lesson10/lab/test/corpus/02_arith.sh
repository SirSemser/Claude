a=17; b=5
echo $((a + b)) $((a - b)) $((a * b)) $((a / b)) $((a % b)) $((a ** 2))
echo $(( (a + b) * 2 ))
let c=a*2; echo $c
((c++)); echo $c
(( d = a > b ? a : b )); echo $d
echo $(( -7 / 2 )) $(( -7 % 2 ))
i=0; while (( i < 3 )); do echo "i=$i"; ((i++)); done
x=10; x+=5; echo $x
declare -i n=4; n+=6; echo $n
echo $(( 0x1F )) $(( 2#101 )) $(( 017 ))
echo $(expr 3 + 4) $(expr 10 \* 3)
echo "3.5 * 2" | bc
echo "scale=2; 10 / 3" | bc
echo "10/4" | bc -l
echo $(( 2**62 ))
