#!/usr/bin/env node
// Manage admin (GOM) accounts.  On Unraid:
//   docker compose run --rm app node src/admin-cli.js create
//   docker compose run --rm app node src/admin-cli.js set-password <username>
//   docker compose run --rm app node src/admin-cli.js list
// The password is typed hidden, hashed, and stored in the database. It is never written to a file or a log.
import readline from 'node:readline';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { AdminError, createAdmin, setAdminPassword, listAdmins } from './lib/admins.js';

async function makePrompter() {
  if (!process.stdin.isTTY) {              // piped input (scripts): read every line up front
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    const lines = Buffer.concat(chunks).toString().split(/\r?\n/); let i = 0;
    const next = async (q) => { process.stdout.write(`${q}\n`); return lines[i++] ?? ''; };
    return { ask: next, secret: next, close() {} };
  }
  // Ordinary questions use readline, but only for the moment of asking. While a password is being
  // typed NO readline is attached, because it would echo every key; raw mode alone keeps it silent.
  const ask = (q) => new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a); });
  });
  const secret = (q) => new Promise((res) => {
    process.stdout.write(q);
    const stdin = process.stdin; let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') { stdin.setRawMode(false); stdin.off('data', onData); stdin.pause(); process.stdout.write('\n'); return res(buf); }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
  return { ask, secret, close() {} };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!['create', 'set-password', 'list'].includes(cmd)) {
    console.log('Usage:\n  admin-cli.js create\n  admin-cli.js set-password <username>\n  admin-cli.js list');
    process.exit(cmd ? 1 : 0);
  }
  const cfg = loadConfig();
  await migrate(cfg, () => {});                       // makes sure the tables exist
  const pool = createPool(cfg);
  const p = await makePrompter();
  try {
    if (cmd === 'list') {
      const rows = await listAdmins(pool);
      if (!rows.length) console.log('No admin accounts yet. Create one with:  create');
      for (const a of rows) console.log(`${a.username}  <${a.email}>  last sign-in: ${a.lastLoginAt || 'never'}${a.locked ? '  (locked)' : ''}`);
      return;
    }
    if (cmd === 'create') {
      const username = await p.ask('Admin username: ');
      const email = await p.ask('Your email (kept for your records; never used to sign in): ');
      const pw = await p.secret('Password (12+ characters): ');
      if (pw !== await p.secret('Type it again: ')) throw new AdminError('The two passwords did not match. Nothing was saved.');
      const a = await createAdmin(pool, { username, email, password: pw });
      console.log(`\nDone. You can now sign in at /admin.html as "${a.username}".`);
    } else {
      if (!arg) throw new AdminError('Say which admin: set-password <username>');
      const pw = await p.secret('New password (12+ characters): ');
      if (pw !== await p.secret('Type it again: ')) throw new AdminError('The two passwords did not match. Nothing was changed.');
      await setAdminPassword(pool, arg, pw);
      console.log(`\nDone. The password for "${arg.toLowerCase()}" is changed and every device was signed out.`);
    }
  } catch (e) {
    if (e instanceof AdminError) { console.error(`\n${e.message}`); process.exitCode = 1; } else throw e;
  } finally { p.close(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
