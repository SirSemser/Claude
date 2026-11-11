echo start
nosuchcmd
echo "after: $?"
cat missing.txt
echo "cat status: $?"
ls nodir
echo "ls status: $?"
mkdir logs
cd /nonexistent
echo $((5/0)) next
echo "line after div"
x = 5
[ 5 -gt ]
[ "a" -eq 1 ]
echo "$(( 08 ))"
rm logs
cp logs xyz
echo "ok"
exit 3
echo "unreachable"
