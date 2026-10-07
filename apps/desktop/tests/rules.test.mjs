import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_IDS,
  BUILTIN_RULES,
  DEFAULT_RULES,
  MAX_PATTERN,
  MAX_RULES,
  applicableRules,
  askReason,
  blockedMessage,
  commandAction,
  decideCommand,
  describeRule,
  evaluateCommand,
  globMatches,
  isDangerousTarget,
  legacyAllowRules,
  normalizeProjectPath,
  normalizeRulesConfig,
  parseCommand,
  prefixWords,
  sameProject,
  validatePattern,
  wildcardMatch,
} from '../src/agent/rules.ts';

const rule = (effect, match, pattern, project) => ({
  id: `${effect}:${match}:${pattern}:${project ?? ''}`,
  effect,
  match,
  pattern,
  ...(project ? { project } : {}),
});
const allow = (pattern, match = 'prefix', project) => rule('allow', match, pattern, project);
const ask = (pattern, match = 'prefix', project) => rule('ask', match, pattern, project);
const deny = (pattern, match = 'prefix', project) => rule('deny', match, pattern, project);
const decide = (command, rules = [], options) => evaluateCommand(command, rules, options).decision;
const words = (command) => parseCommand(command).segments.map((s) => s.words);

// ------------------------------------------------------------------------------------------------------------------
// parsing
// ------------------------------------------------------------------------------------------------------------------

test('commands are split at ; && || | |& & and newlines', () => {
  assert.deepEqual(words('a && b'), [['a'], ['b']]);
  assert.deepEqual(words('a || b'), [['a'], ['b']]);
  assert.deepEqual(words('a; b'), [['a'], ['b']]);
  assert.deepEqual(words('a;b'), [['a'], ['b']]);
  assert.deepEqual(words('a | b'), [['a'], ['b']]);
  assert.deepEqual(words('a |& b'), [['a'], ['b']]);
  assert.deepEqual(words('a & b'), [['a'], ['b']]);
  assert.deepEqual(words('a &\nb'), [['a'], ['b']]);
  assert.deepEqual(words('a\nb'), [['a'], ['b']]);
  assert.deepEqual(words('a\n\n\nb;;c'), [['a'], ['b'], ['c']]);
  assert.deepEqual(words('a\\\nb c'), [['ab', 'c']], 'a backslash before a newline joins the lines');
  assert.deepEqual(words(' \t a   b\tc \t'), [['a', 'b', 'c']]);
  assert.deepEqual(words(''), []);
  assert.deepEqual(words('   \n  '), []);
  assert.deepEqual(words(';;&& ||'), []);
});

test('quotes and escapes hide operators and are removed from words', () => {
  assert.deepEqual(words('echo "a && b"'), [['echo', 'a && b']]);
  assert.deepEqual(words("echo 'a; b | c'"), [['echo', 'a; b | c']]);
  assert.deepEqual(words('echo a\\;b'), [['echo', 'a;b']]);
  assert.deepEqual(words('echo "a\\"b"'), [['echo', 'a"b']]);
  assert.deepEqual(words("echo 'a\\b'"), [['echo', 'a\\b']]);
  assert.deepEqual(words('echo "line1\nline2"'), [['echo', 'line1\nline2']]);
  assert.deepEqual(words('r""m -rf /'), [['rm', '-rf', '/']]);
  assert.deepEqual(words("r''m -rf /"), [['rm', '-rf', '/']]);
  assert.deepEqual(words('\\rm -rf /'), [['rm', '-rf', '/']]);
  assert.deepEqual(words('"rm" -rf /'), [['rm', '-rf', '/']]);
  assert.deepEqual(words("echo ''"), [['echo', '']]);
  assert.deepEqual(words('a"b c"d'), [['ab cd']]);
  assert.deepEqual(words("echo $'a\\nb'"), [['echo', 'a\nb']]);
  assert.deepEqual(words("$'\\x72\\x6d' -rf /"), [['rm', '-rf', '/']], 'ANSI-C hex escapes are decoded');
  assert.deepEqual(words("$'\\162\\155' x"), [['rm', 'x']], 'ANSI-C octal escapes are decoded');
  assert.deepEqual(words("$'\\u0072m' x"), [['rm', 'x']]);
  assert.deepEqual(words('echo $"hi there"'), [['echo', 'hi there']]);
});

test('comments end the line but # inside a word does not start one', () => {
  assert.deepEqual(words('git status # && rm -rf x'), [['git', 'status']]);
  assert.deepEqual(words('git status #comment\nls'), [['git', 'status'], ['ls']]);
  assert.deepEqual(words('echo a#b'), [['echo', 'a#b']]);
  assert.deepEqual(words('echo "# not a comment" && ls'), [['echo', '# not a comment'], ['ls']]);
  assert.deepEqual(words('# nothing'), []);
});

test('command substitution, backticks and process substitution are parsed as commands of their own', () => {
  const p = parseCommand('git status $(rm -rf x)');
  assert.deepEqual(p.segments.map((s) => s.words[0]).sort(), ['git', 'rm']);
  assert.deepEqual(p.segments.find((s) => s.words[0] === 'git').nested, ['rm']);
  assert.deepEqual(
    parseCommand('echo `whoami`')
      .segments.map((s) => s.words[0])
      .sort(),
    ['echo', 'whoami'],
  );
  assert.deepEqual(
    parseCommand('echo "x $(rm -rf y) z"')
      .segments.map((s) => s.words[0])
      .sort(),
    ['echo', 'rm'],
    'substitutions in double quotes run',
  );
  assert.deepEqual(
    parseCommand("echo '$(rm -rf y)'").segments.map((s) => s.words[0]),
    ['echo'],
    'but not in single quotes',
  );
  assert.deepEqual(
    parseCommand('echo \\$(rm -rf y)').segments.map((s) => s.words[0]),
    ['echo', 'rm'],
    'an escaped dollar is text, but what follows still reads as a subshell: the cautious reading',
  );
  assert.deepEqual(
    parseCommand('echo $(echo $(rm -rf y))')
      .segments.map((s) => s.words[0])
      .sort(),
    ['echo', 'echo', 'rm'],
  );
  assert.deepEqual(
    parseCommand('echo `echo \\`rm x\\``')
      .segments.map((s) => s.words[0])
      .sort(),
    ['echo', 'echo', 'rm'],
    'nested backticks',
  );
  assert.deepEqual(
    parseCommand('diff <(ls a) <(rm b)')
      .segments.map((s) => s.words[0])
      .sort(),
    ['diff', 'ls', 'rm'],
  );
  assert.deepEqual(
    parseCommand('tee >(rm b)')
      .segments.map((s) => s.words[0])
      .sort(),
    ['rm', 'tee'],
  );
  assert.deepEqual(
    parseCommand('cat < <(rm b)')
      .segments.map((s) => s.words[0])
      .sort(),
    ['cat', 'rm'],
  );
  assert.deepEqual(
    parseCommand('echo ${x:-$(rm -rf y)}')
      .segments.map((s) => s.words[0])
      .sort(),
    ['echo', 'rm'],
    'defaults of ${…} are evaluated',
  );
  assert.deepEqual(
    parseCommand('echo $(( $(rm x) + 1 ))')
      .segments.map((s) => s.words[0])
      .sort(),
    ['echo', 'rm'],
    'arithmetic may contain substitutions',
  );
  assert.deepEqual(words('echo $((1+2)) $HOME ${x} $1 $$ $?'), [
    ['echo', '$((1+2))', '$HOME', '${x}', '$1', '$$', '$?'],
  ]);
  assert.deepEqual(words('echo a$'), [['echo', 'a$']], 'a lone dollar is text');
  assert.deepEqual(words('echo "cost $"'), [['echo', 'cost $']]);
});

test('subshells, groups and shell keywords expose the commands inside', () => {
  assert.deepEqual(words('(cd x && make) | tee log'), [['cd', 'x'], ['make'], ['tee', 'log']]);
  assert.deepEqual(words('{ rm -rf x; }'), [['rm', '-rf', 'x']]);
  assert.deepEqual(words('if true; then sudo ls; fi'), [['true'], ['sudo', 'ls'], ['ls']]);
  assert.deepEqual(words('for f in a b; do rm -rf "$f"; done'), [
    ['for', 'f', 'in', 'a', 'b'],
    ['rm', '-rf', '$f'],
  ]);
  assert.deepEqual(
    words('while read l; do echo $l; done < in.txt'),
    [
      ['read', 'l'],
      ['echo', '$l'],
    ],
    'while, do and done are keywords',
  );
  assert.deepEqual(words('case $x in a) rm -rf y;; esac'), [
    ['case', '$x', 'in', 'a'],
    ['rm', '-rf', 'y'],
  ]);
  assert.deepEqual(words('! rm x'), [['rm', 'x']]);
  assert.deepEqual(
    words('time rm x').map((w) => w[0]),
    ['time', 'rm'],
    'time is a wrapper and its command is judged too',
  );
});

test('leading VAR=value assignments are separated from the command', () => {
  const [s] = parseCommand('FOO=1 BAR="a b" npm test').segments;
  assert.deepEqual(s.words, ['npm', 'test']);
  assert.deepEqual(s.assignments, ['FOO=1', 'BAR=a b']);
  const only = parseCommand('PATH=/tmp/evil').segments[0];
  assert.deepEqual(only.words, []);
  assert.deepEqual(only.assignments, ['PATH=/tmp/evil']);
  assert.deepEqual(words('echo a=b'), [['echo', 'a=b']], 'an assignment-looking argument stays an argument');
  assert.deepEqual(words('a[1]=x b'), [['b']]);
});

test('redirections are removed from the words; writes to files are flagged', () => {
  const seg = (c) => parseCommand(c).segments[0];
  assert.deepEqual(seg('ls > out.txt').words, ['ls']);
  assert.equal(seg('ls > out.txt').writes, true);
  assert.equal(seg('ls >> out.txt').writes, true);
  assert.equal(seg('ls >out.txt').writes, true);
  assert.equal(seg('ls 2> err.txt').writes, true);
  assert.equal(seg('ls &> all.txt').writes, true);
  assert.equal(seg('ls &>> all.txt').writes, true);
  assert.equal(seg('ls >| out.txt').writes, true);
  assert.equal(seg('ls >& out.txt').writes, true);
  assert.equal(seg('ls <> file').writes, true);
  assert.equal(seg('> out.txt').writes, true);
  assert.equal(seg('ls > /dev/null').writes, false);
  assert.equal(seg('ls 2>/dev/null').writes, false);
  assert.equal(seg('ls &>/dev/null').writes, false);
  assert.equal(seg('ls 2>&1').writes, false);
  assert.equal(seg('ls >&2').writes, false);
  assert.equal(seg('ls 2>&-').writes, false);
  assert.equal(seg('ls < in.txt').writes, false);
  assert.equal(seg('ls < in.txt').words.join(' '), 'ls');
  assert.equal(seg('ls > /dev/stderr').writes, false);
  assert.equal(seg('ls > /dev/tty').writes, false);
  assert.equal(seg('ls > ~/.zshrc').writes, true);
  assert.deepEqual(seg('echo hi > "my file.txt"').redirects, [{ op: '>', target: 'my file.txt' }]);
  assert.deepEqual(words('ls 2>&1 | grep x'), [['ls'], ['grep', 'x']]);
  assert.deepEqual(words('echo 2'), [['echo', '2']], 'a number that is not followed by < or > is a word');
});

test('heredocs: the body is data, except for shells and for unquoted $(…)', () => {
  assert.deepEqual(words('cat <<EOF\nrm -rf /\nEOF\nls'), [['cat'], ['ls']]);
  assert.deepEqual(words("cat <<'EOF'\n$(rm -rf /)\nEOF\nls"), [['cat'], ['ls']], 'quoted delimiter: no expansion');
  assert.deepEqual(
    parseCommand('cat <<EOF\n$(rm -rf /)\nEOF')
      .segments.map((s) => s.words[0])
      .sort(),
    ['cat', 'rm'],
    'unquoted delimiter: $(…) runs',
  );
  assert.deepEqual(
    parseCommand('cat <<EOF\n`rm x`\nEOF')
      .segments.map((s) => s.words[0])
      .sort(),
    ['cat', 'rm'],
  );
  assert.deepEqual(words('bash <<EOF\nrm -rf /\nEOF'), [['bash'], ['rm', '-rf', '/']], 'a shell runs its heredoc');
  assert.deepEqual(words("sh <<'EOF'\nrm x\nEOF"), [['sh'], ['rm', 'x']]);
  assert.deepEqual(
    words('sudo bash <<EOF\nrm x\nEOF').map((w) => w[0]),
    ['sudo', 'bash', 'rm'],
  );
  assert.deepEqual(
    words('cat <<-EOF\n\trm x\n\tEOF\nls'),
    [['cat'], ['ls']],
    '<<- strips leading tabs from the delimiter line',
  );
  assert.deepEqual(words('cat <<EOF | grep x\nbody\nEOF\nls'), [['cat'], ['grep', 'x'], ['ls']]);
  assert.deepEqual(
    words('cat <<A; cat <<B\none\nA\ntwo\nB\nls'),
    [['cat'], ['cat'], ['ls']],
    'two heredocs, bodies in order',
  );
  assert.deepEqual(
    words('cat <<EOF\nnever closed\nrm x'),
    [['cat']],
    'an unterminated heredoc swallows the rest, as the shell does',
  );
  assert.deepEqual(
    words('bash <<< "rm -rf x"'),
    [['bash'], ['rm', '-rf', 'x']],
    'a here-string for a shell is a script',
  );
  assert.deepEqual(words('cat <<< "rm -rf x"'), [['cat']]);
});

test('wrappers: the command they run is judged as well', () => {
  const programs = (c) => parseCommand(c).segments.map((s) => s.words[0]);
  assert.deepEqual(programs('sudo rm -rf x'), ['sudo', 'rm']);
  assert.deepEqual(programs('sudo -u bob rm x'), ['sudo', 'rm']);
  assert.deepEqual(programs('sudo -E -- rm x'), ['sudo', 'rm']);
  assert.deepEqual(programs('env A=1 B=2 rm x'), ['env', 'rm']);
  assert.deepEqual(programs('env -i -u HOME rm x'), ['env', 'rm']);
  assert.deepEqual(programs('sudo env A=1 nice -n 5 rm x'), ['sudo', 'env', 'nice', 'rm']);
  assert.deepEqual(programs('nohup rm x'), ['nohup', 'rm']);
  assert.deepEqual(programs('timeout 5 rm x'), ['timeout', 'rm']);
  assert.deepEqual(programs('timeout -s KILL 5 rm x'), ['timeout', 'rm']);
  assert.deepEqual(programs('command rm x'), ['command', 'rm']);
  assert.deepEqual(programs('command -v rm'), ['command'], 'command -v only looks the program up');
  assert.deepEqual(programs('exec rm x'), ['exec', 'rm']);
  assert.deepEqual(programs('xargs rm'), ['xargs', 'rm']);
  assert.deepEqual(programs('xargs -0 -n1 -I{} rm {}'), ['xargs', 'rm']);
  assert.deepEqual(programs('xargs -I {} rm {}'), ['xargs', 'rm']);
  assert.deepEqual(programs('find . -name x -exec rm {} \\;'), ['find', 'rm']);
  assert.deepEqual(programs('find . -exec rm {} + -exec ls {} \\;'), ['find', 'rm', 'ls']);
  assert.deepEqual(programs('find . -name x'), ['find']);
  assert.deepEqual(programs('echo sudo'), ['echo'], 'a word that is only an argument is not a command');
  assert.deepEqual(programs('sudo'), ['sudo']);
});

test('bash -c, sh -lc and eval run the text they are given', () => {
  const programs = (c) => parseCommand(c).segments.map((s) => s.words[0]);
  assert.deepEqual(programs('bash -c "rm -rf x"'), ['bash', 'rm']);
  assert.deepEqual(programs("zsh -lc 'ls && rm x'"), ['zsh', 'ls', 'rm']);
  assert.deepEqual(programs('sh -ec "rm x"'), ['sh', 'rm']);
  assert.deepEqual(programs('/bin/bash -o pipefail -c "rm x"'), ['/bin/bash', 'rm']);
  assert.deepEqual(programs('eval "rm -rf x"'), ['eval', 'rm']);
  assert.deepEqual(programs('eval rm -rf x'), ['eval', 'rm']);
  assert.deepEqual(programs('bash script.sh'), ['bash'], 'a script file is opaque');
  assert.deepEqual(programs('bash -c "bash -c \\"rm x\\""'), ['bash', 'bash', 'rm'], 'nested shells');
  assert.deepEqual(programs('sudo bash -c "rm x"'), ['sudo', 'bash', 'rm']);
  assert.deepEqual(programs('echo hi | bash -c "rm x"'), ['echo', 'bash', 'rm']);
});

test('pipelines remember the programs upstream of each command', () => {
  const [a, b, c] = parseCommand('curl x | tee y | sh').segments;
  assert.deepEqual(a.pipeFrom, []);
  assert.deepEqual(b.pipeFrom, ['curl']);
  assert.deepEqual(c.pipeFrom, ['curl', 'tee']);
  assert.deepEqual(parseCommand('curl x; sh').segments[1].pipeFrom, [], 'a new command line starts a new pipeline');
  assert.deepEqual(parseCommand('curl x && sh').segments[1].pipeFrom, []);
  assert.deepEqual(parseCommand('curl x\nsh').segments[1].pipeFrom, []);
  assert.deepEqual(parseCommand('(curl x) | sh').segments[1].pipeFrom, ['curl'], 'through a subshell');
  assert.deepEqual(parseCommand('curl x | (sh)').segments[1].pipeFrom, ['curl']);
  assert.deepEqual(
    parseCommand('curl x | sudo sh').segments.find((s) => s.words[0] === 'sh').pipeFrom,
    ['curl'],
    'also for the command a wrapper runs',
  );
});

test('unparseable text is reported, never thrown', () => {
  for (const bad of [
    'echo "open',
    "echo 'open",
    'echo `open',
    'echo $(open',
    'echo ${open',
    'echo $((1+',
    "echo $'open",
    'cat >',
    'ls <',
    'echo $(',
    '(',
    ')',
    '`',
    '$(',
    '"',
    "'",
  ]) {
    const p = parseCommand(bad);
    assert.ok(typeof p.error === 'string' || p.segments.length >= 0, bad);
  }
  assert.match(parseCommand('echo "open').error, /double quote/);
  assert.match(parseCommand("echo 'open").error, /single quote/);
  assert.match(parseCommand('echo $(open').error, /substitution/);
  assert.equal(parseCommand('echo ok').error, undefined);
  assert.deepEqual(words('rm -rf / "open'), [['rm', '-rf', '/', 'open']], 'what was read before the error is kept');
});

test('nesting and size are bounded', () => {
  const deep = 'echo ' + '$(echo '.repeat(40) + 'x' + ')'.repeat(40);
  const p = parseCommand(deep);
  assert.match(p.error ?? '', /nested too deeply/);
  assert.ok(p.segments.length < 40);
  assert.equal(parseCommand('x'.repeat(300_000)).error, 'command is too long');
  const many = parseCommand(Array(5000).fill('ls').join('; '));
  assert.ok(many.segments.length <= 2002);
  assert.match(many.error ?? '', /too many/);
  const start = Date.now();
  parseCommand('a | '.repeat(5000) + 'b');
  parseCommand('('.repeat(3000) + 'x' + ')'.repeat(3000));
  parseCommand('$('.repeat(3000));
  assert.ok(Date.now() - start < 2000, 'degenerate input stays fast');
});

test('random garbage never throws and always terminates', () => {
  const alphabet = [
    'a',
    'b',
    ' ',
    '\n',
    ';',
    '&',
    '|',
    '(',
    ')',
    '$',
    '`',
    '"',
    "'",
    '\\',
    '<',
    '>',
    '{',
    '}',
    '#',
    '=',
    '*',
    '-',
    'x',
    '\t',
    '!',
    '~',
  ];
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 4000; i++) {
    let s = '';
    for (let n = Math.floor(rand() * 40); n > 0; n--) s += alphabet[Math.floor(rand() * alphabet.length)];
    const e = evaluateCommand(s, [allow('a'), deny('x'), ask('b')]);
    assert.ok(['allow', 'ask', 'deny', 'default'].includes(e.decision), JSON.stringify(s));
  }
});

// ------------------------------------------------------------------------------------------------------------------
// patterns
// ------------------------------------------------------------------------------------------------------------------

test('prefix rules match whole words at the start of a simple command', () => {
  const r = [allow('git status')];
  assert.equal(decide('git status', r), 'allow');
  assert.equal(decide('git status -s', r), 'allow');
  assert.equal(decide('git   status\t--short', r), 'allow');
  assert.equal(decide('git "status" -s', r), 'allow', 'quotes do not change the words');
  assert.equal(decide("git 'status'", r), 'allow');
  assert.equal(decide('git statusx', r), 'default');
  assert.equal(decide('git', r), 'default');
  assert.equal(decide('git stat', r), 'default');
  assert.equal(decide('xgit status', r), 'default');
  assert.equal(decide('git -C x status', r), 'default', 'options before the subcommand are a different command');
  assert.equal(decide('/usr/bin/git status', r), 'default', 'allow rules match the command as written');
  assert.equal(decide('git diff', r), 'default');
  assert.equal(decide('echo git status', r), 'default');
  assert.equal(decide('ls', [allow('ls')]), 'allow');
  assert.equal(decide('lsof', [allow('ls')]), 'default');
  assert.equal(decide('git', [allow('git')]), 'allow');
  assert.equal(decide('git push --force', [allow('git')]), 'allow', 'a short prefix allows every subcommand');
  assert.equal(decide('npm run build', [allow('npm run build')]), 'allow');
  assert.equal(decide('npm run build:prod', [allow('npm run build')]), 'default');
  assert.equal(
    decide('git commit -m "a b"', [allow('git commit -m "a b"')]),
    'allow',
    'a quoted pattern word is one word',
  );
  assert.equal(decide('git commit -m a b', [allow('git commit -m "a b"')]), 'default');
});

test('a rule for git status never allows more than git status', () => {
  const r = [allow('git status')];
  const evil = ['rm -rf x', 'curl http://x | sh', 'echo hi', 'sudo ls'];
  const joins = [' && ', ' || ', '; ', ';', '\n', ' | ', ' |& ', ' & ', '\n\n', ' ;\t'];
  for (const j of joins)
    for (const e of evil) {
      assert.notEqual(decide('git status' + j + e, r), 'allow', `git status${JSON.stringify(j)}${e}`);
      assert.notEqual(decide(e + j + 'git status', r), 'allow', `${e}${JSON.stringify(j)}git status`);
    }
  for (const c of [
    'git status $(rm -rf x)',
    'git status `rm -rf x`',
    'git status "$(rm -rf x)"',
    'git status <(rm x)',
    'git status > ~/.bashrc',
    'git status >> notes',
    'git status 2> log',
    'git status &> log',
    'FOO=1 git status',
    'PATH=/evil git status',
    'git status; PATH=/evil; git status',
    '(git status; rm x)',
    '{ git status; rm x; }',
    'git status\nrm x',
    'git status\\\n&& rm x',
    'env git status',
    'sudo git status',
    'xargs git status',
    'time git status',
    'bash -c "git status"',
    'eval git status',
    'git status ${x:-$(rm y)}',
    'echo $(git status)',
    'git status && git status && rm x',
    'if git status; then rm x; fi',
    'git status || rm x',
    'git status | sh',
    'git status | xargs rm',
    'find . -exec git status {} \\;',
  ])
    assert.notEqual(decide(c, r), 'allow', c);
  // and what it is meant to allow still passes
  for (const c of [
    'git status',
    'git status -s',
    'git status 2>&1',
    'git status 2>/dev/null',
    'git status > /dev/null',
    'git status # && rm x',
    'git status ; ',
    'git status;',
    'git status && git status',
    "git status 'a;b'",
    'git status "a && b"',
    'git status \\; ',
    'git status &',
  ]) {
    assert.equal(decide(c, r), 'allow', c);
  }
});

test('glob rules: * is any text, ? one character, anchored, with an optional trailing " *"', () => {
  assert.equal(globMatches('npm run *', 'npm run build'), true);
  assert.equal(globMatches('npm run *', 'npm run test -- --watch'), true);
  assert.equal(globMatches('npm run *', 'npm run'), true, 'a trailing " *" also matches the bare command');
  assert.equal(globMatches('npm run *', 'npm runx'), false);
  assert.equal(globMatches('npm run*', 'npm runx'), true);
  assert.equal(globMatches('npm run*', 'npm run'), true);
  assert.equal(globMatches('git *', 'git'), true);
  assert.equal(globMatches('git *', 'gitx'), false);
  assert.equal(globMatches('git status', 'git status -s'), false, 'no wildcard: whole command');
  assert.equal(globMatches('git status', 'git status'), true);
  assert.equal(globMatches('git  status', 'git status'), true, 'spaces collapse in the pattern');
  assert.equal(globMatches('*', 'anything at all'), true);
  assert.equal(globMatches('* --force', 'git push --force'), true);
  assert.equal(globMatches('* --force', 'git push --force-with-lease'), false);
  assert.equal(globMatches('*push*', 'git push origin'), true);
  assert.equal(globMatches('git p?sh', 'git push'), true);
  assert.equal(globMatches('git p?sh', 'git pussh'), false);
  assert.equal(globMatches('a\\*b', 'a*b'), true, 'a backslash makes the next character literal');
  assert.equal(globMatches('a\\*b', 'axb'), false);
  assert.equal(globMatches('', ''), true);
  assert.equal(globMatches('', 'a'), false);
  assert.equal(globMatches('a**b', 'axyb'), true);
  assert.equal(wildcardMatch('**', ''), true);
  assert.equal(wildcardMatch('a*b*c', 'aXbYc'), true);
  assert.equal(wildcardMatch('a*b*c', 'aXbY'), false);
  assert.equal(wildcardMatch('*a*a*a*a*a*b', 'a'.repeat(5000)), false, 'no exponential backtracking');
  assert.equal(wildcardMatch('a*', 'ab\ncd'), true, '* also spans newlines');
});

test('glob rules apply to each simple command, not to the whole line', () => {
  const r = [allow('npm run *', 'glob')];
  assert.equal(decide('npm run build', r), 'allow');
  assert.equal(decide('npm run build && rm -rf x', r), 'default');
  assert.equal(decide('npm run build; sudo x', r), 'deny');
  assert.equal(decide('npm run $(rm x)', r), 'default');
  assert.equal(decide('npm run "a; rm x"', r), 'allow', 'a quoted ; is just an argument');
  const d = [deny('* --force', 'glob')];
  assert.equal(decide('git push --force', d), 'deny');
  assert.equal(decide('echo hi && git push --force', d), 'deny');
  assert.equal(decide('git push --force-with-lease', d), 'default');
  assert.equal(decide('git push', [deny('git push*', 'glob')]), 'deny');
  assert.equal(decide('git pull', [deny('git push*', 'glob')]), 'default');
});

test('pattern validation', () => {
  assert.deepEqual(validatePattern('prefix', '  git status  '), { ok: true, pattern: 'git status' });
  assert.deepEqual(validatePattern('prefix', 'npm run "a b"'), { ok: true, pattern: 'npm run "a b"' });
  assert.deepEqual(validatePattern('glob', '  npm   run *  '), { ok: true, pattern: 'npm run *' });
  assert.deepEqual(validatePattern('prefix', '   '), { ok: false, error: 'empty' });
  assert.deepEqual(validatePattern('glob', ''), { ok: false, error: 'empty' });
  assert.deepEqual(validatePattern('prefix', 'a'.repeat(MAX_PATTERN + 1)), { ok: false, error: 'tooLong' });
  assert.equal(validatePattern('prefix', 'a'.repeat(MAX_PATTERN)).ok, true);
  for (const bad of [
    'git status && ls',
    'git status; ls',
    'git status | cat',
    'git status\nls',
    'git $(x)',
    'git `x`',
    'a & b',
  ]) {
    assert.deepEqual(validatePattern('prefix', bad), { ok: false, error: 'compound' }, bad);
  }
  for (const bad of [
    'git status && ls',
    'git status; ls',
    'a | b',
    'a\nb',
    'git $(x)',
    'git `x`',
    'a > b',
    'a < b',
    'a & b',
  ]) {
    assert.deepEqual(validatePattern('glob', bad), { ok: false, error: 'compound' }, bad);
  }
  for (const bad of ['FOO=1 npm test', 'ls > out', 'echo "open', 'FOO=1'])
    assert.deepEqual(validatePattern('prefix', bad), { ok: false, error: 'unsupported' }, bad);
  assert.deepEqual(prefixWords('git "a b" c'), ['git', 'a b', 'c']);
  assert.equal(prefixWords('a; b'), null);
  assert.equal(prefixWords(''), null);
});

// ------------------------------------------------------------------------------------------------------------------
// precedence
// ------------------------------------------------------------------------------------------------------------------

test('deny beats ask beats allow, wherever the rules are listed', () => {
  const rs = [allow('git'), ask('git push'), deny('git push --force')];
  for (const order of [rs, [...rs].reverse(), [rs[1], rs[2], rs[0]]]) {
    assert.equal(decide('git status', order), 'allow');
    assert.equal(decide('git push origin', order), 'ask');
    assert.equal(decide('git push --force', order), 'deny');
    assert.equal(decide('git push origin --force', order), 'ask', 'prefix rules look at the first words only');
  }
  assert.equal(decide('git push', [allow('git push'), deny('git push')]), 'deny');
  assert.equal(decide('git push', [deny('git push'), allow('git push')]), 'deny');
  assert.equal(decide('git push', [allow('git push', 'glob'), ask('git push*', 'glob')]), 'ask');
  assert.equal(decide('rm x', [allow('rm'), deny('rm x', 'prefix')]), 'deny');
});

test('one deny or ask anywhere in a line decides the whole line', () => {
  const rs = [allow('ls'), allow('echo'), ask('git push'), deny('rm -rf')];
  assert.equal(decide('ls && echo hi', rs), 'allow');
  assert.equal(decide('ls && git push', rs), 'ask');
  assert.equal(decide('git push && rm -rf x', rs), 'deny');
  assert.equal(decide('echo $(rm -rf x)', rs), 'deny');
  assert.equal(decide('echo `git push`', rs), 'ask');
  assert.equal(decide('ls | xargs rm -rf', rs), 'deny');
  assert.equal(decide('bash -c "ls; rm -rf x"', rs), 'deny');
  assert.equal(decide('env rm -rf x', rs), 'deny');
  assert.equal(decide('FOO=1 rm -rf x', rs), 'deny', 'assignments do not hide a command from deny rules');
  assert.equal(decide('/bin/rm -rf x', rs), 'deny', 'nor does a path');
  assert.equal(decide('RM -rf x', rs), 'deny');
  assert.equal(decide('"rm" -rf x', rs), 'deny');
  assert.equal(decide('\\rm -rf x', rs), 'deny');
  assert.equal(decide("$'rm' -rf x", rs), 'deny');
  assert.equal(decide('find . -exec rm -rf {} \\;', rs), 'deny');
  assert.equal(decide('ls > out.txt', rs), 'default', 'a redirect to a file is never allowed by a rule');
  assert.equal(decide('ls 2>&1', rs), 'allow');
});

test('commands that no rule decides are "default" and the access mode picks', () => {
  assert.equal(decide('make', []), 'default');
  assert.equal(decide('', [allow('ls')]), 'default');
  assert.equal(decide('# comment', [allow('ls')]), 'default');
  assert.equal(decide('FOO=1', [allow('FOO=1')]), 'default', 'an assignment alone is not a command a rule can allow');
  assert.equal(decide('PATH=/evil; ls', [allow('ls')]), 'default', 'it could change what the next command is');
  assert.equal(commandAction('allow', 'auto'), 'run');
  assert.equal(commandAction('allow', 'full'), 'run');
  assert.equal(commandAction('ask', 'auto'), 'ask');
  assert.equal(commandAction('ask', 'full'), 'ask', 'an ask rule asks even in full access');
  assert.equal(commandAction('deny', 'auto'), 'block');
  assert.equal(commandAction('deny', 'full'), 'block', 'deny blocks even in full access');
  assert.equal(commandAction('default', 'auto'), 'ask');
  assert.equal(commandAction('default', 'full'), 'run');
  for (const d of ['allow', 'ask', 'deny', 'default'])
    assert.equal(commandAction(d, 'readonly'), 'block', 'read-only never runs commands');
});

test('unparseable commands are never allowed by a rule but can still be denied or asked', () => {
  assert.equal(decide('ls "open', [allow('ls')]), 'default');
  assert.equal(decide('ls $(echo', [allow('ls')]), 'default');
  assert.equal(decide('rm -rf x "open', [deny('rm')]), 'deny');
  assert.equal(decide('git push "open', [ask('git push')]), 'ask');
  assert.equal(evaluateCommand('ls "open', [allow('ls')]).parseError, 'unterminated double quote');
  assert.equal(evaluateCommand('ls', [allow('ls')]).parseError, undefined);
});

test('a few shell builtins that run nothing need no rule', () => {
  const r = [allow('npm test')];
  assert.equal(decide('cd app && npm test', r), 'allow');
  assert.equal(decide('cd app; pwd; npm test', r), 'allow');
  assert.equal(decide('true && npm test', r), 'allow');
  assert.equal(decide('cd app && npm install', r), 'default');
  assert.equal(decide('cd $(rm x)', r), 'default');
  assert.equal(decide('cd app > out', r), 'default');
  assert.equal(decide('cd app', [ask('cd')]), 'ask', 'a rule on cd still applies');
  assert.equal(decide('cd app', [deny('cd')]), 'deny');
  assert.equal(decide('cd', []), 'allow');
});

test('exact rules compare the whole line', () => {
  const r = [{ id: 'e', effect: 'allow', match: 'exact', pattern: 'cd app && npm test' }];
  assert.equal(decide('cd app && npm test', r), 'allow');
  assert.equal(decide('  cd app && npm test  ', r), 'allow');
  assert.equal(decide('cd app && npm test && ls', r), 'default', 'only that exact line');
  assert.equal(decide('cd app && npm test; sudo x', r), 'deny', 'built-in protections still win');
  assert.equal(decide('cd app', r), 'allow', 'cd needs no rule');
  assert.equal(decide('npm test', r), 'default');
  const dr = [{ id: 'e', effect: 'deny', match: 'exact', pattern: 'make clean && make' }, allow('make')];
  assert.equal(decide('make clean && make', dr), 'deny');
  assert.equal(decide('make', dr), 'allow');
  const ar = [{ id: 'e', effect: 'ask', match: 'exact', pattern: 'make deploy' }, allow('make')];
  assert.equal(decide('make deploy', ar), 'ask');
});

// ------------------------------------------------------------------------------------------------------------------
// the old allowlist
// ------------------------------------------------------------------------------------------------------------------

test('the old "always allowed" list keeps its meaning and loses its hole', () => {
  const rules = legacyAllowRules([
    'git status',
    'git diff',
    'ls',
    'npm test',
    'npm run build',
    '  ',
    'cd app && npm test',
    'echo $(date)',
  ]);
  assert.deepEqual(
    rules.map((r) => r.match),
    ['prefix', 'prefix', 'prefix', 'prefix', 'prefix', 'exact', 'exact'],
  );
  assert.ok(rules.every((r) => r.effect === 'allow'));
  assert.equal(decide('git status', rules), 'allow');
  assert.equal(decide('git status -sb', rules), 'allow', 'prefix, as before');
  assert.equal(decide('ls -la src', rules), 'allow');
  assert.equal(
    decide('git status && rm -rf x', rules),
    'default',
    'the old startsWith(prefix + " ") check allowed this',
  );
  assert.equal(decide('ls; rm -rf x', rules), 'default');
  assert.equal(decide('npm test | sh', rules), 'default');
  assert.equal(decide('cd app && npm test', rules), 'allow');
  assert.equal(decide('cd app && npm test && rm x', rules), 'default');
  assert.equal(decide('echo $(date)', rules), 'allow');
  assert.equal(decide('echo $(date) $(rm x)', rules), 'default');
  assert.deepEqual(legacyAllowRules([]), []);
  assert.deepEqual(legacyAllowRules([1, null, undefined, {}]), []);
});

// ------------------------------------------------------------------------------------------------------------------
// built-in protections
// ------------------------------------------------------------------------------------------------------------------

const builtin = (c, disabled) => {
  const e = evaluateCommand(c, [], { disabledBuiltins: disabled });
  return e.decision === 'deny' && e.rule?.builtin ? e.rule.id.replace('builtin:', '') : null;
};

test('built-in rules are listed with ids and examples', () => {
  assert.deepEqual(BUILTIN_IDS, ['privilege', 'rm-root', 'chmod-root', 'curl-sh', 'disk', 'power', 'fork-bomb']);
  for (const b of BUILTIN_RULES) assert.ok(b.example.length > 0 && typeof b.test === 'function', b.id);
  assert.deepEqual(DEFAULT_RULES, { version: 1, rules: [], disabledBuiltins: [] });
});

test('built-in: privilege escalation', () => {
  for (const c of [
    'sudo ls',
    'sudo -i',
    'doas ls',
    'su -',
    'su root',
    'pkexec ls',
    '/usr/bin/sudo ls',
    'SUDO ls',
    'ls && sudo rm x',
    'echo $(sudo id)',
    'env sudo ls',
    'nohup sudo ls',
    'bash -c "sudo ls"',
    'x=1 sudo ls',
    'if true; then sudo x; fi',
    'ls | sudo tee /etc/x',
    'xargs sudo rm',
  ]) {
    assert.equal(builtin(c), 'privilege', c);
  }
  for (const c of [
    'echo sudo',
    'which sudo',
    'command -v sudo',
    'grep sudo file',
    'man su',
    'git commit -m "no sudo"',
    'ls sudo',
    'pseudo x',
    'sudoers',
  ]) {
    assert.equal(builtin(c), null, c);
  }
});

test('built-in: recursive removal of the system, home and parents', () => {
  for (const c of [
    'rm -rf /',
    'rm -fr /',
    'rm -r -f /',
    'rm -Rf /',
    'rm --recursive --force /',
    'rm -rf /*',
    'rm -rf / --no-preserve-root',
    'rm -rf --no-preserve-root /',
    'rm -rf -- /',
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf ~/*',
    'rm -rf ~/Documents',
    'rm -rf $HOME',
    'rm -rf "$HOME"',
    'rm -rf ${HOME}',
    'rm -rf $HOME/',
    'rm -rf $HOME/*',
    'rm -rf ~root',
    'rm -rf /usr',
    'rm -rf /usr/',
    'rm -rf /etc',
    'rm -rf /etc/*',
    'rm -rf /var',
    'rm -rf /Library',
    'rm -rf /System/Library',
    'rm -rf /Applications',
    'rm -rf /Users',
    'rm -rf /Users/me',
    'rm -rf /Users/me/Documents',
    'rm -rf /Users/me/*',
    'rm -rf /home/me',
    'rm -rf /Volumes/Backup',
    'rm -rf /usr/local',
    'rm -rf /opt/homebrew',
    'rm -rf //',
    'rm -rf /.',
    'rm -rf /./',
    'rm -rf /tmp',
    'rm -rf /private/etc',
    'rm -rf ..',
    'rm -rf ../',
    'rm -rf ../..',
    'rm -rf x /',
    'rm -rf / x',
    'rm / -rf',
    'rm -r /',
    'rm -ri /',
    'rm -rfv /',
    'rm --no-preserve-root x',
    '/bin/rm -rf /',
    'RM -RF /',
    'ls && rm -rf /',
    'echo $(rm -rf /)',
    'xargs rm -rf /',
    'find / -delete',
    'find ~ -delete',
    'find / -name x -delete',
    'find / -exec rm {} +',
    'find $HOME -name "*.js" -delete',
    'find -L / -delete',
    'rm -rf "/"',
    "rm -rf '/'",
    'rm -rf \\/',
    'rm -rf /usr/../',
    'rm -rf /Users/me/../',
  ])
    assert.ok(builtin(c) === 'rm-root' || builtin(c) === 'privilege', c);
  for (const c of [
    'rm -rf node_modules',
    'rm -rf ./build',
    'rm -rf build/',
    'rm -rf /tmp/x',
    'rm -rf /tmp/build/*',
    'rm -rf /tmp/*',
    'rm -rf $HOME/projects/x',
    'rm -rf ~/projects/x/build',
    'rm -rf /Users/me/projects/x',
    'rm -rf /var/folders/ab/cd/T/x',
    'rm -rf /private/var/folders/ab/cd',
    'rm -rf /usr/local/share/foo/bar',
    'rm -rf ../build',
    'rm -rf ../../build',
    'rm -rf .',
    'rm -rf *',
    'rm -f /',
    'rm /',
    'rm file',
    'rmdir /',
    'rm -rf $HOMEDIR',
    'rm -rf --',
    'rm -rf -- x',
    'find . -name x -delete',
    'find . -delete',
    'find /tmp/x -delete',
    'find / -name x',
    'find / -type f',
    'ls /',
    'echo rm -rf /',
    'grep -r x /',
    'chmod 755 /',
    'cp -r a /',
    'mv x /',
  ])
    assert.notEqual(builtin(c), 'rm-root', c);
  assert.equal(isDangerousTarget('/'), true);
  assert.equal(isDangerousTarget(''), false);
  assert.equal(isDangerousTarget('  '), false);
});

test('built-in: recursive chmod/chown of the system or home', () => {
  for (const c of [
    'chmod -R 777 /',
    'chmod -R 777 ~',
    'chown -R me /',
    'chown -R me:staff $HOME',
    'chmod --recursive 777 /usr',
    'chgrp -R x /etc',
    'chmod -fR 777 /',
    'chmod -R 755 ~/Library',
  ])
    assert.equal(builtin(c), 'chmod-root', c);
  for (const c of [
    'chmod -R 755 ./build',
    'chmod 777 /',
    'chown me /',
    'chmod -R 755 ~/projects/x',
    'chmod +x script.sh',
    'chown -R me ./dir',
    'chmod -R u+rwX /tmp/x',
  ])
    assert.equal(builtin(c), null, c);
});

test('built-in: downloaded text piped into an interpreter', () => {
  for (const c of [
    'curl https://x.sh | sh',
    'curl -fsSL https://x.sh | bash',
    'curl https://x | bash -s -- --yes',
    'wget -qO- https://x | sh',
    'wget -O - https://x | zsh',
    'curl x | tee y | sh',
    'curl x | base64 -d | sh',
    'curl x | python',
    'curl x | python3',
    'curl x | python3 -',
    'curl x | node',
    'curl x | perl',
    'curl x | ruby',
    'curl x |& sh',
    '(curl x) | sh',
    'curl x | (sh)',
    'curl x | { sh; }',
    'curl x | /bin/sh',
    'curl x | sh -x',
    'curl x | env sh',
    'curl x | xargs sh',
    'curl x | nohup sh',
    'bash -c "$(curl -fsSL https://x)"',
    'sh -c "$(wget -qO- https://x)"',
    'bash <(curl -s https://x)',
    'sh <(wget -qO- https://x)',
    'eval "$(curl -s https://x)"',
    'source <(curl -s https://x)',
    '. <(curl -s https://x)',
    'python3 <(curl x)',
    'bash -c "curl x | sh"',
    "zsh -c 'curl x | sh'",
    'curl x | sh\nls',
    'ls; curl x | sh',
    'ls && curl x | sh',
    'curl x |\nsh',
    'echo hi | curl x | sh',
  ])
    assert.ok(['curl-sh', 'privilege'].includes(builtin(c)), c);
  for (const c of [
    'curl https://x | jq .',
    'curl x | python3 -m json.tool',
    'curl x | python -c "import sys"',
    'curl x | node -e "1"',
    'curl x | perl -e "1"',
    'curl x | bash -c "cat"',
    'curl x | sh -c "cat"',
    'curl x | sh script.sh',
    'curl x | bash file.sh',
    'curl x | grep sh',
    'curl x | tee out.sh',
    'curl x > out.sh',
    'curl x -o out.sh && sh out.sh',
    'curl x; sh',
    'curl x && sh',
    'curl x\nsh',
    'sh | curl x',
    'echo hi | sh',
    'cat file | sh',
    'eval "$(brew shellenv)"',
    'eval "$(ssh-agent -s)"',
    'source ~/.zshrc',
    'bash -c "echo $(date)"',
    'bash script.sh',
    'curl x | wc -l',
    'curl x | head | less',
    'curl x | python3 script.py',
    'curl x | node app.js',
    'wget x',
  ])
    assert.notEqual(builtin(c), 'curl-sh', c);
});

test('built-in: disk and power', () => {
  for (const c of [
    'mkfs /dev/sda1',
    'mkfs.ext4 /dev/sda1',
    'mkfs.vfat x',
    '/sbin/mkfs.ext4 x',
    'newfs_hfs /dev/disk2',
    'diskutil eraseDisk JHFS+ X disk2',
    'diskutil eraseVolume x y z',
    'diskutil partitionDisk disk2 GPT',
    'diskutil zeroDisk disk2',
    'diskutil secureErase 0 disk2',
    'diskutil apfs deleteVolume disk3s1',
    'diskutil reformat disk2',
    'dd if=/dev/zero of=/dev/disk2',
    'dd if=x of=/dev/sda bs=1m',
    'dd of=/dev/rdisk2 if=x',
    'echo x > /dev/disk2',
    'cat x > /dev/sda',
    'cat x >> /dev/nvme0n1',
    'echo x 2> /dev/disk0s1',
    'ls && mkfs x',
  ])
    assert.equal(builtin(c), 'disk', c);
  for (const c of [
    'diskutil list',
    'diskutil info disk2',
    'diskutil mount disk2',
    'dd if=/dev/zero of=./file bs=1m count=1',
    'dd if=/dev/zero of=/dev/null',
    'dd of=/dev/stdout',
    'echo x > /dev/null',
    'echo x > /dev/stderr',
    'cat /dev/sda',
    'echo mkfs',
    'mkdir mkfs',
  ])
    assert.equal(builtin(c), null, c);
  for (const c of ['shutdown -h now', 'shutdown', 'reboot', 'halt', 'poweroff', '/sbin/shutdown now', 'ls && reboot'])
    assert.equal(builtin(c), 'power', c);
  for (const c of ['echo reboot', 'git commit -m reboot', 'ls shutdown']) assert.equal(builtin(c), null, c);
});

test('built-in: fork bomb', () => {
  for (const c of [':(){ :|:& };:', ':(){:|:&};:', ':() { : | : & } ; :', 'ls; :(){ :|:& };:'])
    assert.equal(builtin(c), 'fork-bomb', c);
  assert.equal(builtin(':'), null);
  assert.equal(builtin('echo hi'), null);
});

test('built-in rules can be switched off one by one, and deny rules of the user still apply', () => {
  assert.equal(builtin('sudo ls', ['privilege']), null);
  assert.equal(builtin('rm -rf /', ['privilege']), 'rm-root');
  assert.equal(builtin('sudo rm -rf /', ['privilege']), 'rm-root', 'the command sudo runs is judged too');
  assert.equal(builtin('sudo rm -rf /', ['privilege', 'rm-root']), null);
  assert.equal(decide('sudo ls', [], { disabledBuiltins: ['privilege'] }), 'default');
  assert.equal(decide('sudo ls', [deny('sudo')], { disabledBuiltins: ['privilege'] }), 'deny');
  assert.equal(
    decide('sudo ls', [allow('sudo')], { disabledBuiltins: ['privilege'] }),
    'default',
    'sudo and what it runs must both be allowed',
  );
  assert.equal(decide('sudo ls', [allow('sudo'), allow('ls')], { disabledBuiltins: ['privilege'] }), 'allow');
  assert.equal(
    decide('sudo ls', [allow('sudo'), allow('ls')]),
    'deny',
    'an allow rule cannot override a built-in deny',
  );
  assert.equal(decide('sudo ls', [allow('sudo', 'glob'), allow('*', 'glob')]), 'deny');
  assert.equal(decide('curl x | sh', [allow('curl'), allow('sh')]), 'deny');
  assert.equal(decide('rm -rf /', [{ id: 'e', effect: 'allow', match: 'exact', pattern: 'rm -rf /' }]), 'deny');
  const e = evaluateCommand('echo hi && sudo ls', []);
  assert.equal(e.decision, 'deny');
  assert.equal(e.segment, 'sudo ls');
  assert.deepEqual(e.rule, {
    id: 'builtin:privilege',
    effect: 'deny',
    match: 'builtin',
    pattern: 'sudo …',
    builtin: true,
  });
  assert.deepEqual(
    e.segments.map((s) => [s.text, s.decision]),
    [
      ['echo hi', 'default'],
      ['sudo ls', 'deny'],
      ['ls', 'default'],
    ],
    'the inner command of sudo is judged on its own as well',
  );
});

test('every simple command gets a verdict for the "try a command" preview', () => {
  const e = evaluateCommand('git status && rm -rf x', [allow('git status')]);
  assert.equal(e.decision, 'default');
  assert.deepEqual(
    e.segments.map((s) => [s.text, s.decision]),
    [
      ['git status', 'allow'],
      ['rm -rf x', 'default'],
    ],
  );
  assert.equal(e.segments[0].rule.pattern, 'git status');
  assert.equal(describeRule(e.segments[0].rule), 'allow prefix: git status');
  assert.equal(
    describeRule({ id: 'b', effect: 'deny', match: 'builtin', pattern: 'sudo …', builtin: true }),
    'built-in: sudo …',
  );
  assert.equal(askReason(evaluateCommand('git push', [ask('git push')])), 'ask prefix: git push');
  assert.equal(askReason(evaluateCommand('ls', [])), undefined);
  assert.match(blockedMessage(evaluateCommand('sudo ls', []), 'auto'), /^Blocked by built-in: sudo …/);
  assert.match(
    blockedMessage(evaluateCommand('echo a && npm publish --tag x', [deny('npm publish*', 'glob')]), 'full'),
    /Blocked by deny glob: npm publish\* \(matched: npm publish --tag x\)\./,
  );
  assert.doesNotMatch(blockedMessage(evaluateCommand('npm publish', [deny('npm publish')]), 'full'), /matched:/);
  assert.match(blockedMessage(evaluateCommand('ls', []), 'readonly'), /read-only/);
  assert.match(blockedMessage(evaluateCommand('sudo ls', []), 'auto'), /do not retry/);
});

// ------------------------------------------------------------------------------------------------------------------
// scope and configuration
// ------------------------------------------------------------------------------------------------------------------

test('project rules apply to their project; when the project is unknown only deny and ask apply', () => {
  const g = allow('ls');
  const pa = allow('make', 'prefix', '/Users/me/a');
  const pd = deny('make deploy', 'prefix', '/Users/me/a');
  const pk = ask('make test', 'prefix', '/Users/me/a');
  const pb = allow('make', 'prefix', '/Users/me/b');
  const all = [g, pa, pd, pk, pb];
  assert.deepEqual(applicableRules(all, '/Users/me/a'), [g, pa, pd, pk]);
  assert.deepEqual(applicableRules(all, '/Users/me/b'), [g, pb]);
  assert.deepEqual(applicableRules(all, '/Users/me/c'), [g]);
  assert.deepEqual(applicableRules(all, null), [g, pd, pk], 'unknown project: the safe side only');
  assert.deepEqual(applicableRules(all, undefined), [g, pd, pk]);
  assert.deepEqual(applicableRules(all, '/Users/me/a/'), [g, pa, pd, pk], 'a trailing slash does not matter');
  assert.deepEqual(applicableRules(all, '/Users/me/a/sub'), [g], 'a sub folder is another project');
  assert.deepEqual(applicableRules(all, '/Users/me/ab'), [g]);
  assert.equal(sameProject('/private/var/x/', '/var/x'), true);
  assert.equal(sameProject('/private/tmp/p', '/tmp/p'), true);
  assert.equal(sameProject('/private/foo', '/foo'), false);
  assert.equal(sameProject('/a/b', '/a/c'), false);
  assert.equal(normalizeProjectPath(' /a/b// '), '/a/b');

  const run = (project) => ({ config: { version: 1, rules: all, disabledBuiltins: [] }, allowlist: [], project });
  assert.equal(decideCommand('make', run('/Users/me/a'), 'auto').action, 'run');
  assert.equal(decideCommand('make', run('/Users/me/c'), 'auto').action, 'ask');
  assert.equal(decideCommand('make', run(null), 'auto').action, 'ask');
  assert.equal(decideCommand('make deploy', run('/Users/me/a'), 'full').action, 'block');
  assert.equal(decideCommand('make deploy', run(null), 'full').action, 'block');
  assert.equal(decideCommand('make deploy', run('/Users/me/b'), 'full').action, 'run');
  assert.equal(decideCommand('make test', run('/Users/me/a'), 'full').action, 'ask');
});

test('decideCommand combines project rules, the old allowlist and the built-in protections', () => {
  const config = { version: 1, rules: [deny('npm publish'), ask('git push')], disabledBuiltins: [] };
  const run = { config, allowlist: ['git status', 'cd app && npm test'], project: null };
  const d = (c, a = 'auto') => decideCommand(c, run, a).action;
  assert.equal(d('git status'), 'run');
  assert.equal(d('cd app && npm test'), 'run');
  assert.equal(d('git push'), 'ask');
  assert.equal(d('git push', 'full'), 'ask');
  assert.equal(d('npm publish', 'full'), 'block');
  assert.equal(d('sudo ls', 'full'), 'block');
  assert.equal(d('make'), 'ask');
  assert.equal(d('make', 'full'), 'run');
  assert.equal(d('git status && make'), 'ask');
  assert.equal(d('git status && make', 'full'), 'run');
  assert.equal(d('git status', 'readonly'), 'block');
  assert.equal(
    decideCommand('sudo ls', { ...run, config: { ...config, disabledBuiltins: ['privilege'] } }, 'full').action,
    'run',
  );
});

test('stored configuration is validated and cleaned', () => {
  assert.deepEqual(normalizeRulesConfig(undefined), DEFAULT_RULES);
  assert.deepEqual(normalizeRulesConfig(null), DEFAULT_RULES);
  assert.deepEqual(normalizeRulesConfig('junk'), DEFAULT_RULES);
  assert.deepEqual(normalizeRulesConfig(42), DEFAULT_RULES);
  assert.deepEqual(normalizeRulesConfig([]), DEFAULT_RULES);
  assert.deepEqual(normalizeRulesConfig({ rules: 'nope' }), DEFAULT_RULES);
  const raw = {
    version: 99,
    rules: [
      { id: 'a', effect: 'allow', match: 'prefix', pattern: '  git status  ' },
      { id: 'b', effect: 'deny', match: 'glob', pattern: 'rm   -rf *', project: ' /Users/me/a ' },
      { id: 'c', effect: 'maybe', match: 'prefix', pattern: 'x' },
      { id: 'd', effect: 'allow', match: 'regex', pattern: 'x' },
      { id: 'e', effect: 'allow', match: 'prefix', pattern: '' },
      { id: 'f', effect: 'allow', match: 'prefix', pattern: 'a && b' },
      { id: 'g', effect: 'allow', match: 'prefix', pattern: 5 },
      null,
      7,
      'x',
      [],
      { id: 'a', effect: 'ask', match: 'exact', pattern: 'cd x && make' },
      { effect: 'allow', match: 'prefix', pattern: 'git status' },
      { id: 'h', effect: 'allow', match: 'prefix', pattern: 'ls', project: '' },
      { id: 'i', effect: 'allow', match: 'exact', pattern: '' },
    ],
    disabledBuiltins: ['privilege', 'privilege', 'nope', 7],
  };
  const c = normalizeRulesConfig(raw);
  assert.equal(c.version, 1);
  assert.deepEqual(c.disabledBuiltins, ['privilege']);
  assert.deepEqual(
    c.rules.map((r) => [r.effect, r.match, r.pattern, r.project]),
    [
      ['allow', 'prefix', 'git status', undefined],
      ['deny', 'glob', 'rm -rf *', '/Users/me/a'],
      ['ask', 'exact', 'cd x && make', undefined],
      ['allow', 'prefix', 'ls', undefined],
    ],
  );
  assert.equal(
    new Set(c.rules.map((r) => r.id)).size,
    c.rules.length,
    'ids are unique (a duplicate id gets a new one)',
  );
  assert.ok(c.rules.every((r) => typeof r.id === 'string' && r.id));
  assert.deepEqual(normalizeRulesConfig(JSON.parse(JSON.stringify(c))), c, 'normalising is idempotent');
  const many = {
    rules: Array.from({ length: MAX_RULES + 50 }, (_, i) => ({
      id: `r${i}`,
      effect: 'allow',
      match: 'prefix',
      pattern: `cmd${i}`,
    })),
  };
  assert.equal(normalizeRulesConfig(many).rules.length, MAX_RULES);
  assert.equal(
    normalizeRulesConfig({ rules: [{ effect: 'allow', match: 'prefix', pattern: 'a'.repeat(MAX_PATTERN + 1) }] }).rules
      .length,
    0,
  );
  assert.equal(
    normalizeRulesConfig({ rules: [{ effect: 'allow', match: 'prefix', pattern: 'x', project: 'p'.repeat(1001) }] })
      .rules[0].project,
    undefined,
  );
  assert.equal(
    normalizeRulesConfig({ rules: [{ id: 'x'.repeat(200), effect: 'allow', match: 'prefix', pattern: 'x' }] }).rules[0]
      .id.length < 100,
    true,
  );
});

test('a hostile prefix or glob pattern cannot widen or break matching', () => {
  // patterns that look like shell syntax are rejected by validation, and unvalidated ones simply never match a single command
  assert.equal(decide('rm -rf x', [allow('ls; rm', 'prefix')]), 'default');
  assert.equal(decide('ls', [allow('ls; rm', 'prefix')]), 'default');
  assert.equal(decide('rm', [allow('', 'prefix')]), 'default');
  assert.equal(decide('rm', [allow('   ', 'glob')]), 'default');
  assert.equal(decide('anything', [allow('', 'glob')]), 'default');
  assert.equal(decide('ls', [{ id: 'x', effect: 'allow', match: 'prefix', pattern: 'ls "open' }]), 'default');
  assert.equal(decide('ls', [{ id: 'x', effect: 'bogus', match: 'prefix', pattern: 'ls' }]), 'default');
  assert.equal(decide('ls', [{ id: 'x', effect: 'allow', match: 'bogus', pattern: 'ls' }]), 'default');
});
