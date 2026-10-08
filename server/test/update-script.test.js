import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// deploy/update.sh run for real, against a real git repository standing in for GitHub and a real "server" clone, with fake `docker` and `curl` that record what they're asked to do.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'deploy/update.sh'), 'utf8');
const have = (c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;
const SKIP = !have('git') || !have('bash');

let tmp, remote, dev, bin, tools, N = 0;
const env0 = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const sh = (cmd, cwd) => execSync(cmd, { cwd, env: { ...process.env, ...env0 }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const commit = (msg, files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dev, f)), { recursive: true }); fs.writeFileSync(path.join(dev, f), c); } sh(`git add -A && git commit -q -m "${msg}" && git push -q origin main`, dev); return sh('git rev-parse --short HEAD', dev); };

before(() => {
  if (SKIP) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')); remote = path.join(tmp, 'github.git'); dev = path.join(tmp, 'dev'); bin = path.join(tmp, 'fakebin'); tools = path.join(tmp, 'tools');
  sh(`git init -q --bare -b main ${remote}`); sh(`git clone -q ${remote} ${dev}`); sh('git checkout -q -b main', dev).toString();
  fs.mkdirSync(bin); fs.mkdirSync(tools);
  // fake docker: records every call; behaviour is switched by environment variables; "docker run … alpine/git …" really runs git in the shared folder
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "docker $*" >> "$FAKE_LOG"
if [ "$1" = "run" ]; then dir=""; while [ $# -gt 0 ]; do case "$1" in -v) dir="\${2%%:*}"; shift 2;; alpine/git) shift; break;; *) shift;; esac; done; cd "$dir" && exec /usr/bin/git "$@"; fi
[ "$1" = "compose" ] || exit 0
case "$2" in
  version) exit 0;;
  ps) [ -n "$FAKE_NO_DB" ] || echo db; exit 0;;
  run) [ -n "$FAKE_BACKUP_FAIL" ] && { echo "backup exploded" >&2; exit 1; }; exit 0;;
  up) [ -n "$FAKE_UP_FAIL" ] && { echo "build exploded" >&2; exit 1; }; exit 0;;
  logs) echo "app log line"; exit 0;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\necho "curl $*" >> "$FAKE_LOG"\n[ -n "$FAKE_HEALTH_FAIL" ] && exit 22\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  for (const t of ['bash', 'grep', 'cut', 'tr', 'seq', 'wc', 'head', 'dirname', 'cat', 'mkdir']) fs.symlinkSync(sh(`command -v ${t}`), path.join(tools, t));   // a PATH with NO git on it
  fs.writeFileSync(path.join(dev, '.gitignore'), '.env\ndata/\n');
  commit('first version', { 'deploy/update.sh': SCRIPT, 'db/migrations/001_init.sql': '-- one', 'app.txt': 'v1' });
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// a fresh "server": a clone of the repo with its own .env, plus a log of what docker/curl were asked
function server(name = `srv${++N}`) {
  const dir = path.join(tmp, name); sh(`git clone -q ${remote} ${dir}`);
  fs.writeFileSync(path.join(dir, '.env'), 'APP_PORT=3999\nDB_PASSWORD=secret\n');
  const log = path.join(tmp, `${name}.log`); fs.writeFileSync(log, '');
  const run = (args = [], extra = {}, { noGit = false } = {}) => {
    const r = spawnSync('bash', [path.join(dir, 'deploy/update.sh'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env0, FAKE_LOG: log, PATH: noGit ? `${bin}:${tools}` : `${bin}:${process.env.PATH}`, ...extra } });
    return { code: r.status, out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''), calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  return { dir, run, head: () => sh('git rev-parse --short HEAD', dir), file: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}
const idx = (calls, re) => calls.findIndex((c) => re.test(c));
const T = (name, fn) => test(name, { skip: SKIP && 'git and bash are needed to test the update script' }, fn);

T('already up to date: says so and touches nothing (no backup, no rebuild)', () => {
  const s = server(); const r = s.run();
  assert.equal(r.code, 0); assert.match(r.out, /Already up to date/); assert.deepEqual(r.calls.filter((c) => /run|up/.test(c) && !/version/.test(c)), []);
});

T('A NEW VERSION: it shows what is changing, backs up BEFORE touching the code, then updates, rebuilds, checks the site, and leaves .env alone', () => {
  const s = server(); const v1 = s.head();
  const v2 = commit('add the thing', { 'app.txt': 'v2', 'db/migrations/002_more.sql': '-- two' });
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`Going from ${v1} to ${v2}`)); assert.match(r.out, /add the thing/); assert.match(r.out, /changes the database layout — 1 migration file/);
  assert.match(r.out, new RegExp(`✔ Updated to ${v2} \\(was ${v1}\\)\\. The site is up`));
  assert.equal(s.file('app.txt'), 'v2'); assert.equal(s.head(), v2);
  const [backup, up, health] = [idx(r.calls, /run --rm -e ONCE=1 backup/), idx(r.calls, /compose up -d --build/), idx(r.calls, /curl .*127\.0\.0\.1:3999\/healthz/)];
  assert.ok(backup >= 0 && up > backup && health > up, `backup → rebuild → health check, in that order: ${JSON.stringify(r.calls)}`);
  assert.equal(s.file('.env'), 'APP_PORT=3999\nDB_PASSWORD=secret\n', 'the server\'s own settings were not touched');
  assert.ok(r.calls.some((c) => /image prune/.test(c)), 'old images are cleaned up');
});

T('IF THE BACKUP FAILS, NOTHING IS UPDATED: the code stays exactly as it was, and it never rebuilds', () => {
  const s = server(); const before = s.head();
  commit('risky change', { 'app.txt': 'risky' });
  const r = s.run([], { FAKE_BACKUP_FAIL: '1' });
  assert.notEqual(r.code, 0); assert.match(r.out, /The backup failed, so I have NOT updated anything/);
  assert.equal(s.head(), before); assert.notEqual(s.file('app.txt'), 'risky');
  assert.equal(idx(r.calls, /compose up/), -1, 'no rebuild');
});

T('files edited on the server stop an update before anything happens (no backup, no changes)', () => {
  const s = server(); fs.writeFileSync(path.join(s.dir, 'app.txt'), 'edited on the server');
  commit('upstream change', { 'other.txt': 'x' });
  const r = s.run();
  assert.notEqual(r.code, 0); assert.match(r.out, /Files in this folder have been changed on the server/); assert.match(r.out, /app\.txt/);
  assert.equal(s.file('app.txt'), 'edited on the server'); assert.deepEqual(r.calls.filter((c) => /backup|up -d/.test(c)), []);
});

T('if the rebuild fails it says exactly how to go back; if the site does not come back it shows the log and says how to go back', () => {
  const a = server(); const aBefore = a.head(); commit('change a', { 'app.txt': 'a' });
  const rebuild = a.run([], { FAKE_UP_FAIL: '1' });
  assert.notEqual(rebuild.code, 0); assert.match(rebuild.out, new RegExp(`The rebuild failed\\. To go back to how it was:  bash deploy/update\\.sh ${aBefore}`));
  const b = server(); const bBefore = b.head(); commit('change b', { 'app.txt': 'b' });
  const down = b.run([], { FAKE_HEALTH_FAIL: '1' });
  assert.notEqual(down.code, 0); assert.match(down.out, /app log line/); assert.match(down.out, new RegExp(`The site didn't come back within a minute\\. To go back to how it was:  bash deploy/update\\.sh ${bBefore}`)); assert.match(down.out, /restore the backup/);
});

T('ROLLING BACK to an earlier version works (with a backup first), and a plain update afterwards returns to the newest', () => {
  const s = server(); const v1 = s.head(); const v1Content = s.file('app.txt'); const v2 = commit('v2 for rollback', { 'app.txt': 'v2-rb' });
  assert.equal(s.run().code, 0); assert.equal(s.head(), v2);
  const back = s.run([v1]);
  assert.equal(back.code, 0, back.out); assert.equal(s.head(), v1); assert.equal(s.file('app.txt'), v1Content); assert.ok(idx(back.calls, /ONCE=1 backup/) < idx(back.calls, /compose up/));
  assert.match(back.out, /You're on a fixed version now/);
  const fwd = s.run();
  assert.equal(fwd.code, 0, fwd.out); assert.equal(s.file('app.txt'), 'v2-rb'); assert.equal(sh('git rev-parse --abbrev-ref HEAD', s.dir), 'main');
});

T('a version that does not exist, a missing .env, and a first start with no database yet are each handled plainly', () => {
  const s = server();
  const bad = s.run(['nonsense-version']); assert.notEqual(bad.code, 0); assert.match(bad.out, /I can't find 'nonsense-version'/); assert.equal(idx(bad.calls, /compose up/), -1);
  fs.rmSync(path.join(s.dir, '.env'));
  const noEnv = s.run(); assert.notEqual(noEnv.code, 0); assert.match(noEnv.out, /There's no \.env file here\. Copy \.env\.example to \.env/);
  const f = server(); commit('first-start change', { 'app.txt': 'fs' });
  const first = f.run([], { FAKE_NO_DB: '1' });
  assert.equal(first.code, 0, first.out); assert.match(first.out, /nothing to back up yet/); assert.equal(idx(first.calls, /ONCE=1 backup/), -1);
});

T('a server WITHOUT git still updates: it runs git inside a throw-away container instead', () => {
  const s = server(); commit('for the no-git server', { 'app.txt': 'nogit' });
  const r = s.run([], {}, { noGit: true });
  assert.equal(r.code, 0, r.out); assert.equal(s.file('app.txt'), 'nogit');
  assert.ok(r.calls.some((c) => /^docker run --rm -v .* alpine\/git -c safe\.directory=\/git fetch/.test(c)), `git ran inside the container: ${JSON.stringify(r.calls.slice(0, 6))}`);
});

T('the script and the git settings are safe to commit from Windows: Unix line endings are forced, and the script has none of the Windows kind', () => {
  assert.doesNotMatch(SCRIPT, /\r/);
  const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\.sh text eol=lf$/m);
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
  for (const must of ['.env', 'data/', 'node_modules/']) assert.ok(ignore.includes(must), `${must} is never committed`);
});
