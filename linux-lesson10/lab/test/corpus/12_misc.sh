echo "PID-like var is set: ${$:+yes}"
v=$(echo "  trim me  "); echo "[$v]"
lines=$(printf 'a\nb\n\n\n'); echo "[$lines]"
echo `echo backtick`
echo "nested $(echo "inner $(echo deep)")"
r=$( false ); echo "subst status $?"
cmd="echo via eval"; eval $cmd
{ echo grouped; echo output; } > grp.txt; cat grp.txt
( cd logs && pwd | sed 's|.*/||' ); [ "$(pwd)" != "$(cd logs && pwd)" ] && echo "cwd unchanged"
echo "to stderr" >&2
echo "both" &> both.txt; cat both.txt
echo first > f.txt; echo second >> f.txt; cat f.txt
ls nofile 2> err.txt; cat err.txt
ls nofile 2>/dev/null || echo "hidden error"
echo data | tee t.txt | tr a-z A-Z; cat t.txt
x=5; [[ $x == 5 ]] && echo "string compare"
[[ "abc" < "abd" ]] && echo "lexical"
echo {a,b}{1,2}
echo file{1..3}.txt
echo ~ | sed 's|/home/||'
echo "*.txt" *.txt
echo '$HOME' "$HOME" | sed 's|/home/student|H|'
printf -v out "%03d" 7; echo $out
s="x"; s+="y"; s+=z; echo $s
type echo; type cd; type ls
declare -i num=10; num=num*2; echo $num
n=010; echo $((10#$n))
echo $(( RANDOM >= 0 && RANDOM < 32768 ))
echo "${#}" 
true; echo $?; false; echo $?
: ; echo colon $?
echo "date ok: $(date +%Y | grep -c '^20')"
