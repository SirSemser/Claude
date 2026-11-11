# STDIN: Aigerim 19\nhello world  \n  spaced   line  \nlast
read name age
echo "Name: $name, age: $age"
read -r line; echo "[$line]"
read -r a b; echo "[$a] [$b]"
read -r z; echo "rc=$? z=[$z]"
read -r none; echo "rc=$? none=[$none]"
cat <<EOF2
Hello $name
  Indented line
Total: $((age + 1))
EOF2
cat <<'EOF3'
No $expansion here
EOF3
cat <<-EOF4
	tab stripped
	EOF4
while IFS=: read -r user _ uid _; do
  [ "$uid" -ge 1000 ] 2>/dev/null && echo "$user $uid"
done < passwd.txt
IFS=, read -ra parts <<< "x,y,,z"; echo "${#parts[@]}: ${parts[*]}"
echo "a b c" | { read x y; echo "$y|$x"; }
