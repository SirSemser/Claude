# ARGS: first second third fourth
echo "count: $#"
echo "all: $@"
echo "star: $*"
echo "first: $1, second: $2"
echo "last: ${@: -1} / ${!#}"
echo "slice: ${@:2:2}"
for a; do echo "arg=$a"; done
shift; echo "after shift: $1 ($#)"
shift 2; echo "after shift 2: $*"
set -- x "y z"; echo "$# [$2]"
f() { echo "func got $# args: $@"; }
f "$@"
f $@
f "$*"
echo "${10:-no tenth}"
