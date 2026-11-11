check() {
  case "$1" in
    [0-9]|[0-9][0-9]) echo "$1 is number" ;;
    y|Y|yes) echo "$1 is yes" ;;
    *.txt) echo "$1 is text" ;;
    "") echo "empty" ;;
    *) echo "$1 is other" ;;
  esac
}
for v in 5 42 yes Y notes.txt hello ""; do check "$v"; done
greet() { local name=$1; echo "Hi, $name (args: $#)"; return 3; }
greet Ali Vali; echo "ret=$?"
sum() { echo $(( $1 + $2 )); }
r=$(sum 3 4); echo "sum=$r"
x=global; f() { local x=local; echo "in f: $x"; g; }; g() { echo "in g: $x"; }; f; echo "after: $x"
h() { y=changed; }; y=orig; h; echo "y=$y"
fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }
echo "5! = $(fact 5)"
is_even() { (( $1 % 2 == 0 )); }
for n in 3 4; do if is_even $n; then echo "$n even"; else echo "$n odd"; fi; done
function old_style { echo "old style $1"; }
old_style ok
counter=0; inc() { counter=$((counter + 1)); }; inc; inc; echo "counter=$counter"
show_args() { for a in "$@"; do echo "<$a>"; done; }
show_args "one two" three
lx=5; tst() { local lx=$lx; lx=$((lx+1)); echo "local lx=$lx"; }; tst; echo "global lx=$lx"
