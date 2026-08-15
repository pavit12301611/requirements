// Storage test: a corrupt/unreadable local database file must not take the
// whole backend down. The layer should move the bad file aside, recreate the
// schema and re-seed, so the app boots and serves requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), `reqforge-corrupt-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'requirements.db'), 'this is definitely not a sqlite database');

// Must be set BEFORE importing the db layer.
process.env.DATA_DIR = dir;
process.env.VERCEL = '1';

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };

const { db } = await import('../lib/db.js');
const app = (await import('../server.js')).default;
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const n = (await db.get('SELECT COUNT(*) AS n FROM projects')).n;
check('backend recovered and re-seeded demo projects', n >= 1);

const backups = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'));
check('corrupt file was moved aside (not deleted)', backups.length === 1);

const res = await fetch(`${base}/api/health`);
const health = await res.json();
check('server serves requests after recovery', res.status === 200 && health.ok === true);

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL CORRUPT-DB RECOVERY TESTS PASSED');
process.exit(failures ? 1 : 0);
