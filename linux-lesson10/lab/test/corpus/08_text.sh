grep ERROR logs/app.log
grep -c INFO logs/app.log
grep -i error logs/*.log
grep -v INFO logs/app.log
grep -n a a.txt
grep -E 'alpha|zeta' a.txt
grep -o '[0-9]\+' nums.txt | head -2
grep -w two b.txt | wc -l
grep -r WARN logs
sort b.txt
sort -u b.txt
sort -n nums.txt
sort -rn nums.txt
sort b.txt | uniq -c
sort b.txt | uniq -c | sort -rn | head -1
sort -t, -k2 -n data.csv
wc -l a.txt
wc -w < a.txt
wc a.txt b.txt
wc -l < b.txt
cat a.txt | wc -l
head -n 2 b.txt; tail -n 1 b.txt; tail -n +5 b.txt; head -1 a.txt
cut -d, -f1,3 data.csv
cut -c1-3 a.txt
tail -n +2 data.csv | cut -d, -f2 | sort -n | tail -1
sed 's/a/A/' a.txt
sed 's/a/A/g' a.txt
sed -n '2p' b.txt
sed '1d' b.txt
sed -E 's/([a-z]+) ([a-z]+)/\2 \1/' a.txt
awk '{print $2}' a.txt
awk -F, 'NR>1 {print $1, $2}' data.csv
awk -F, 'NR>1 {s+=$2} END {print "total", s, "avg", s/(NR-1)}' data.csv
awk -F, '$2 > 80 {print $1}' data.csv
awk '{print NR": "$0}' b.txt | head -2
awk -F: '$7 == "/bin/bash" {print $1}' passwd.txt
awk 'BEGIN { for (i=1;i<=3;i++) printf "%d^2=%d\n", i, i*i }'
awk '{ c[$1]++ } END { for (w in c) print w, c[w] }' b.txt | sort
cat -n a.txt
tac a.txt
nl b.txt | head -2
echo "one two three" | awk '{print NF, $NF}'
paste -d: a.txt nums.txt
basename /a/b/c.txt; basename /a/b/c.txt .txt; dirname /a/b/c.txt
tr ',' '\t' < data.csv | head -2
echo "Hello" | sed 's/l/L/2'
grep -c '' b.txt
grep nothing a.txt; echo "status=$?"
