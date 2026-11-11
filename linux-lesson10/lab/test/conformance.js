/* Сравнение симулятора с настоящим bash на корпусе скриптов. */
'use strict';
const fs = require('fs');
const path = require('path');
const { runSim, runReal } = require('./harness');

const FIX = {
  'a.txt': 'alpha beta\ngamma delta\nepsilon zeta\n',
  'b.txt': 'one\ntwo\nthree\ntwo\none\none\n',
  'nums.txt': '10\n2\n33\n4\n',
  'data.csv': 'name,score,city\nAli,85,Almaty\nDana,92,Astana\nTimur,67,Shymkent\nAruzhan,74,Almaty\n',
  'logs/app.log': 'INFO start\nERROR disk\nINFO ok\n',
  'logs/db.log': 'WARN slow\n',
};
FIX['passwd.txt'] = require('./harness').BS.defaultFS().get('/etc/passwd').x;
const dir = path.join(__dirname, 'corpus');
const only = process.argv[2];
let fail = 0, pass = 0;
for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith('.sh')) continue;
  if (only && f.indexOf(only) < 0) continue;
  const script = fs.readFileSync(path.join(dir, f), 'utf8');
  const metaArgs = /^# ARGS: (.*)$/m.exec(script);
  const metaIn = /^# STDIN: (.*)$/m.exec(script);
  const opts = { fixtures: FIX, args: metaArgs ? metaArgs[1].split(' ') : [], stdin: metaIn ? metaIn[1].replace(/\\n/g, '\n') : '' };
  const real = runReal(script, opts);
  const sim = runSim(script, opts);
  if (real.out === sim.out && real.code === sim.code) { pass++; continue; }
  fail++;
  console.log('=== FAIL ' + f + ' (code real=' + real.code + ' sim=' + sim.code + ')');
  const a = real.out.split('\n'), b = sim.out.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) console.log('  line ' + (i + 1) + '\n    real: ' + JSON.stringify(a[i]) + '\n    sim:  ' + JSON.stringify(b[i]));
  }
}
console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
