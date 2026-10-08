import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { passwordProblem } from '../src/lib/password.js';

// deploy/unraid/docker-compose.yml + stack.env.example: the stand-alone stack for Unraid. There is no Docker here, so these tests do what Compose would —
// read the file, fill in the ${settings} from the env file, and check what comes out.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stack = parse(read('deploy/unraid/docker-compose.yml'));
const ENV_TEXT = read('deploy/unraid/stack.env.example');
const dotenv = (t) => Object.fromEntries(t.split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ENV = dotenv(ENV_TEXT);
// Compose's ${VAR}, ${VAR:-default} and ${VAR:?message}
const resolve = (s, env = ENV) => String(s).replace(/\$\{([A-Z0-9_]+)(?:(:-|:\?)([^}]*))?\}/g, (_, name, op, arg) => {
  const v = env[name];
  if (op === ':?' && (v === undefined || v === '')) throw new Error(`required: ${arg}`);
  return v !== undefined && v !== '' ? v : (op === ':-' ? arg : '');
});
const REQUIRED = { REPO_URL: 'https://github.com/someone/stormofshadowss.git#main', DB_PASSWORD: 'x'.repeat(20), PUBLIC_URL: 'http://192.168.1.50:2999' };   // the only things a user MUST set
const services = Object.entries(stack.services);
const refs = (text) => [...text.matchAll(/\$\{([A-Z0-9_]+)(?:(:-|:\?)[^}]*)?\}/g)].map((m) => ({ name: m[1], required: m[2] === ':?', hasDefault: m[2] === ':-' }));

test('the stack is separate from every other install: its own project name, container names, network, images and data folder', () => {
  assert.equal(stack.name, 'sos');
  const names = services.map(([, s]) => s.container_name);
  assert.deepEqual(names, ['sos-init', 'sos-db', 'sos-app', 'sos-backup', 'sos-tunnel', 'sos-adminer']);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([stack.services.app.image, stack.services.backup.image], ['sos-app:latest', 'sos-backup:latest']);
  const clone = parse(read('docker-compose.yml'));
  assert.notEqual(stack.services.app.image, clone.services.app.image, 'a different image name from the clone-based install');
  assert.equal(clone.services.app.build, '.', 'and the clone-based install is untouched');
  assert.deepEqual(Object.keys(stack.networks), ['sos-net']);
  assert.ok(Object.entries(stack.services).filter(([k]) => k !== 'init').every(([, s]) => s.networks.includes('sos-net')));
  assert.match(ENV.DATA_DIR, /^\/mnt\/user\/appdata\/sos$/);
});

test('PORTS AS ASKED: the app listens on 2999 in its container and is published on 0.0.0.0 (any device on the network); nothing else is exposed except a localhost-only database viewer', () => {
  assert.equal(stack.services.app.environment.PORT, '2999');
  assert.deepEqual(stack.services.app.ports.map((p) => resolve(p)), ['0.0.0.0:2999:2999']);
  assert.equal(stack.services.app.ports[0].split(':').at(-1), stack.services.app.environment.PORT, 'the published container port is the one the app listens on');
  assert.deepEqual([ENV.APP_BIND, ENV.APP_PORT], ['0.0.0.0', '2999']);
  assert.deepEqual(stack.services.adminer.ports, ['127.0.0.1:8081:8080'], 'the database viewer is this-machine-only');
  for (const s of ['db', 'backup', 'init', 'cloudflared']) assert.equal(stack.services[s].ports, undefined, `${s} publishes no port`);
  assert.deepEqual(stack.services.app.ports.map((p) => resolve(p, REQUIRED)), ['0.0.0.0:2999:2999'], 'and that is the default even if the env file leaves them out');
});

test('NO FILES NEEDED ON THE SERVER: it builds from the GitHub address in the settings, every volume is an absolute folder under DATA_DIR, nothing is relative', () => {
  assert.equal(stack.services.app.build.context, '${REPO_URL:?Set REPO_URL in the env file (your GitHub repository address)}');
  assert.equal(stack.services.backup.build.context, '${REPO_URL}');
  assert.equal(resolve(stack.services.app.build.context), ENV.REPO_URL);
  assert.match(ENV.REPO_URL, /^https:\/\/(YOUR_TOKEN@)?github\.com\/YOUR_USERNAME\/stormofshadowss\.git#main$/);
  for (const [name, s] of services) for (const v of s.volumes || []) {
    const host = resolve(v, REQUIRED).split(':')[0];                       // fill in the ${settings} first — they contain colons themselves
    assert.ok(host.startsWith('/mnt/user/appdata/sos/'), `${name}: ${v} → ${host} is an absolute folder under the data folder`);
    assert.ok(!v.startsWith('./') && !v.startsWith('../'), `${name}: no relative path`);
  }
  assert.equal(services.filter(([, s]) => s.volumes?.some((v) => /deploy|\.sh/.test(v))).length, 0, 'no script is mounted from a local folder');
});

test('the files the repository build needs really exist, and the backup image copies the real script', () => {
  const df = read('deploy/backup.Dockerfile');
  assert.equal(stack.services.backup.build.dockerfile, 'deploy/backup.Dockerfile');
  assert.match(df, /^FROM mariadb:10\.11$/m); assert.match(df, /^COPY deploy\/backup\.sh \/backup\.sh$/m); assert.match(df, /^ENTRYPOINT \["\/bin\/sh", "\/backup\.sh"\]$/m);
  for (const f of ['deploy/backup.sh', 'Dockerfile', 'db/migrations/001_init.sql', 'server/package.json', 'server/package-lock.json']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  const ignore = read('.dockerignore').split('\n');
  for (const needed of ['deploy', 'Dockerfile']) assert.ok(!ignore.includes(needed), `${needed} is not excluded from the build`);
});

test('UPDATING IS JUST "COMPOSE UP" AGAIN: the app and backup are rebuilt from the repository every time (cached when nothing changed)', () => {
  assert.equal(stack.services.app.pull_policy, 'build'); assert.equal(stack.services.backup.pull_policy, 'build');
  assert.equal(stack.services.db.pull_policy, undefined, 'the database image is never rebuilt');
});

test('START-UP ORDER: the pictures folder is made writable first, the database must be healthy, then the app; backups wait for the database', () => {
  const init = stack.services.init;
  assert.equal(init.restart, 'no'); assert.deepEqual(init.command, ['sh', '-c', 'mkdir -p /uploads && chown -R 1000:1000 /uploads']);
  assert.equal(init.volumes[0], stack.services.app.volumes[0].replace(':/app/uploads', ':/uploads'), 'it fixes the very folder the app writes pictures to');
  assert.deepEqual(stack.services.app.depends_on, { db: { condition: 'service_healthy' }, init: { condition: 'service_completed_successfully' } });
  assert.deepEqual(stack.services.backup.depends_on, { db: { condition: 'service_healthy' } });
  assert.ok(stack.services.db.healthcheck.test.includes('healthcheck.sh'));
  const df = read('Dockerfile'); assert.match(df, /USER node/, 'the app runs as the "node" user — uid 1000, which the init step makes the owner');
});

test('the database needs no root password to be chosen (it is random and unused), and is not reachable from outside', () => {
  const e = stack.services.db.environment;
  assert.equal(e.MARIADB_RANDOM_ROOT_PASSWORD, '1'); assert.equal(e.MARIADB_ROOT_PASSWORD, undefined);
  assert.equal(e.MARIADB_USER, '${DB_USER:-sos}'); assert.match(e.MARIADB_PASSWORD, /^\$\{DB_PASSWORD:\?/);
  assert.equal(stack.services.app.environment.DB_HOST, 'db'); assert.equal(stack.services.backup.environment.DB_HOST, 'db');
});

test('ONLY FOUR THINGS MUST BE FILLED IN: the repository, a database password, the site address (and the admin login is optional but expected) — everything else has a default', () => {
  const need = new Set(); for (const [, s] of services) for (const r of refs(JSON.stringify(s))) if (r.required) need.add(r.name);
  assert.deepEqual([...need].sort(), ['CLOUDFLARE_TUNNEL_TOKEN', 'DB_PASSWORD', 'PUBLIC_URL', 'REPO_URL'], 'the tunnel token only matters if you turn the tunnel on');
  // with ONLY those three set, every other setting still resolves
  for (const [name, s] of services.filter(([n]) => !['cloudflared'].includes(n))) assert.doesNotThrow(() => resolve(JSON.stringify(s), REQUIRED), name);
  for (const k of ['REPO_URL', 'DB_PASSWORD', 'PUBLIC_URL']) assert.throws(() => resolve(JSON.stringify(stack.services.app) + JSON.stringify(stack.services.db), { ...REQUIRED, [k]: '' }), /required: Set/, `${k} missing is caught with a clear message`);
});

test('every setting the YAML uses is explained in the env file (nothing hidden), and the sample values are obvious placeholders, never real secrets', () => {
  const used = new Set(); for (const [, s] of services) for (const r of refs(JSON.stringify(s))) used.add(r.name);
  for (const name of used) assert.ok(name in ENV, `${name} is in the env file`);
  for (const [k, v] of Object.entries(ENV)) if (/PASSWORD|TOKEN|PASS$/.test(k) && v) assert.match(v, /CHANGE|change-me|YOUR_/i, `${k} is a placeholder`);
  assert.doesNotMatch(ENV_TEXT, /[A-Za-z0-9]{32,}/, 'no long random-looking secret');
});

test('LEFT UNCHANGED, THE PLACEHOLDER ADMIN PASSWORD IS REFUSED (so a forgotten edit never leaves a publicly-known login); the other defaults suit a home network', () => {
  assert.ok(passwordProblem(ENV.INITIAL_ADMIN_PASSWORD, ENV.INITIAL_ADMIN_USERNAME), `"${ENV.INITIAL_ADMIN_PASSWORD}" must not be accepted as a real password`);
  assert.equal(ENV.INITIAL_ADMIN_USERNAME, 'gom');
  assert.deepEqual([ENV.COOKIE_SECURE, ENV.TRUST_PROXY], ['false', '0'], 'plain http on a home network: the login cookie must not require https');
  assert.match(ENV.PUBLIC_URL, /^http:\/\/[\d.]+:2999$/);
  assert.equal(stack.services.app.environment.COOKIE_SECURE, '${COOKIE_SECURE:-false}');
  assert.deepEqual(['INITIAL_ADMIN_USERNAME', 'INITIAL_ADMIN_PASSWORD', 'INITIAL_ADMIN_EMAIL'].map((k) => k in stack.services.app.environment), [true, true, true]);
});

test('optional extras stay off unless asked for: with no profiles the stack is just init, db, app and backup', () => {
  assert.equal(ENV.COMPOSE_PROFILES, '');
  assert.deepEqual(stack.services.cloudflared.profiles, ['tunnel']); assert.deepEqual(stack.services.adminer.profiles, ['tools']);
  const always = services.filter(([, s]) => !s.profiles).map(([k]) => k);
  assert.deepEqual(always, ['init', 'db', 'app', 'backup']);
  assert.match(stack.services.cloudflared.command, /tunnel --no-autoupdate run/);
  assert.match(read('deploy/unraid/docker-compose.yml'), /http:\/\/app:2999/, 'the tunnel instructions point at the right port');
});
