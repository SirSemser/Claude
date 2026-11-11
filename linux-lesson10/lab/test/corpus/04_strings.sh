s="report_2026.backup.txt"
echo ${#s}
echo ${s:0:6} ${s:7} ${s: -3} ${s:(-10):6}
echo ${s%.*} ${s%%.*} ${s#*.} ${s##*.}
echo ${s/report/data} ${s//a/A} ${s/#rep/REP} ${s/%txt/TXT}
echo ${s^^} ${s^}
u="HELLO World"; echo ${u,,} ${u,}
w="Алматы"; echo ${#w} ${w^^} ${w:0:3}
path=/home/student/lab10/file.sh
echo ${path##*/} ${path%/*}
echo ${undefined:-default} ${undefined:=set_now} $undefined
v=""; echo "[${v:-empty}]" "[${v-unset}]" "[${v:+alt}]"
x=abc; echo "[${x:+alt}]"
str="a,b,c"; IFS=, read -r p1 p2 p3 <<< "$str"; echo "$p2 $p3 $p1"
echo "abc" | rev
echo "Hello World" | tr 'a-z' 'A-Z'
echo "Hello World" | tr -d 'lo'
echo "a  b   c" | tr -s ' '
full="$s-$x"; echo $full
echo "${s:3:4}"
