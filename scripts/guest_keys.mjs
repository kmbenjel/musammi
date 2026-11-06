// Guest links for the mushaf mode: people the owner lets try the app on his Gemini key (worker GUEST_KEYS).
//   node scripts/guest_keys.mjs add <name>     a new key for <name> (latin letters/digits), prints the link
//   node scripts/guest_keys.mjs remove <name>  the link stops working
//   node scripts/guest_keys.mjs list
// The keys live in .guests.json (not in git) and go to the Worker as one secret each time the list changes.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../.guests.json', import.meta.url);
const HOST = 'https://musammi.benjelloun.dev/mushaf';
const guests = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const [cmd, name] = process.argv.slice(2);

function push() {
  writeFileSync(FILE, JSON.stringify(guests, null, 2) + '\n', { mode: 0o600 });
  const value = Object.values(guests).join(',') || 'g-none';
  execFileSync('npx', ['wrangler', 'secret', 'put', 'GUEST_KEYS'], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
}

if (cmd === 'add' && /^[a-z0-9]+$/i.test(name ?? '')) {
  guests[name] = `g-${name}-${randomBytes(12).toString('base64url').replace(/-/g, 'x')}`;
  push();
  console.log(`${name}: ${HOST}?k=${guests[name]}`);
} else if (cmd === 'remove' && guests[name]) {
  delete guests[name];
  push();
  console.log(`${name}: removed`);
} else if (cmd === 'list') {
  for (const [n, k] of Object.entries(guests)) console.log(`${n}: ${HOST}?k=${k}`);
} else {
  console.log('node scripts/guest_keys.mjs add <name> | remove <name> | list');
  process.exit(1);
}
