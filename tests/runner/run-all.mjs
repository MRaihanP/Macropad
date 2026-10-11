// Penjalur suite test yang bisa diulang.
//
// Alasan file ini ada: sebelumnya suite dijalankan dengan comando PowerShell
// yang dirakit tangan. Akibatnya test ikut tercampur dengan skrip patch/fix
// yang MENULIS ke repo - dan skrip itu tidak idempoten.seluruh file repo
// jadi rusak: rgb_effects.h hancur jadi 212 baris "diANDLE", 6 perintah BLE
// terduplikasi di lib.rs, 148 kunci i18n muncul dua kali.
//
// Dua hal yang dijaga file ini:
//  1. hanya file *test* yang dijalankan, tidak ada skrip patch
//  2. setiap file dicek punya exit code yang benar-benar mengikuti `fail`
//
// Jalankan: node tests/runner/run-all.mjs   (atau: npm test)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, SUITES_DIR } from './paths.mjs';

const semua = fs.readdirSync(SUITES_DIR)
  .filter(f => fs.statSync(path.join(SUITES_DIR, f)).isFile())
  .filter(f => /\.(js|cjs|mjs)$/.test(f))
  // Negative test sengaja mengacak repo; jalankan terpisah.
  .filter(f => !/^negative-/.test(f))
  .filter(f => /^.*test\.(js|cjs|mjs)$/.test(f))
  .sort();

let gagal = 0;
const hasil = [];

for (const f of semua) {
  const src = fs.readFileSync(path.join(SUITES_DIR, f), 'utf8');

  // --- guard 1: exit code benar-benar mengikuti penghitung kegagalan ---
  const punyaExit = /process\.exit\s*\(\s*\w+\s*===\s*0\s*\?\s*0\s*\s*:\s*1\s*\)/.test(src)
    || /process\.exit\s*\(\s*\w+\s*\?\s*1\s*:\s*0\s*\)/.test(src)
    || /process\.exitCode\s*=/.test(src)
    || /throw new Error/.test(src)
    || /assert\./.test(src);
  if (!punyaExit) {
    console.log(`LEWAT  ${f}  (tidak ada exit code - selalu hijau?)`);
    gagal++;
    hasil.push([f, 'LEWAT']);
    continue;
  }

  // --- guard 2: assertion yang sama diulang (tanda file rusak) ---
  const pesan = [...src.matchAll(/ok\([^,]*,\s*(?:`([^`$]*)`|['"]([^'"]*)['"])/g)]
    .map(m => (m[1] || m[2] || '').trim())
    .filter(p => p.length > 12);
  const dup = [...new Set(pesan.filter((p, i) => pesan.indexOf(p) !== i))];
  if (dup.length) {
    console.log(`GAGAL  ${f}  ${dup.length} assertion duplikat: ${dup.slice(0, 3).map(d => '"' + d.slice(0, 40) + '"').join(', ')}`);
    gagal++;
    hasil.push([f, 'DUPLIKAT']);
    continue;
  }

  try {
    execFileSync('node', [path.join(SUITES_DIR, f)], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`OK     ${f}`);
    hasil.push([f, 'OK']);
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l));
    console.log(`GAGAL  ${f}`);
    out.slice(0, 5).forEach(l => console.log(`         ${l.trim()}`));
    gagal++;
    hasil.push([f, 'GAGAL']);
  }
}

const okCount = hasil.filter(h => h[1] === 'OK').length;
console.log(`\n${okCount}/${semua.length} suite hijau, ${gagal} bermasalah`);
process.exit(gagal ? 1 : 0);
