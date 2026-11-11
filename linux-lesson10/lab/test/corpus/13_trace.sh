set -x
a=5
b=$((a*2))
echo "b=$b"
if [ $b -gt 5 ]; then echo big; fi
for i in 1 2; do echo $i; done
set +x
echo done
