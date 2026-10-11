// Memeriksa graf import src/ benar-benar bebas siklus.
//
// Penting karena Phase 8 memecah main.js jadi 15 modul dan kebijakan proyeknya
// eksplisit: modul tidak boleh saling mengimpor balik. Import langsung
// getLastDeviceLayerEventAt dari protocol-parser.js ke adaptive.js sempat
// melanggar itu (parser sudah mengimpor escape/preset dari adaptive).
//
// Script ini membangun graf dan mencari siklus dengan DFS.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'src');
if (!fs.existsSync(dir)) {
  console.log('GAGAL: src/ tidak ditemukan. Jalankan dari root repo.');
  process.exit(2);
}
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

// Ambil semua import lokal (relatif) per berkas.
const graph = new Map();
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  // Buang komentar baris dan blok dulu. device-state.js menyebut
  // `import { ROWS } from './device-state.js'` DI DALAM komentar penjelasan -
  // tanpa ini dia dilaporkan mengimpor dirinya sendiri, dan siklus palsu
  // menutupi siklus asli kalau ada.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const deps = new Set();
  const re = /from\s+['"]\.\/([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const target = m[1];
    if (files.includes(target)) deps.add(target);
  }
  graph.set(f, [...deps]);
}

// DFS dengan warna: 0 = belum dilihat, 1 = sedang ditelusuri, 2 = selesai.
const color = new Map(files.map(f => [f, 0]));
const cycles = [];
const stack = [];

function dfs(node) {
  color.set(node, 1);
  stack.push(node);
  for (const dep of graph.get(node) || []) {
    if (color.get(dep) === 1) {
      const i = stack.indexOf(dep);
      cycles.push([...stack.slice(i), dep]);
    } else if (color.get(dep) === 0) {
      dfs(dep);
    }
  }
  stack.pop();
  color.set(node, 2);
}
for (const f of files) if (color.get(f) === 0) dfs(f);

console.log('Graf import src/:');
for (const [f, deps] of graph) {
  if (deps.length) console.log(`  ${f} -> ${deps.join(', ')}`);
}
console.log(`\nSiklus ditemukan: ${cycles.length}`);
if (cycles.length) {
  for (const c of cycles) console.log('  ' + c.join(' -> '));
  process.exit(1);
}
console.log('OK: graf bebas siklus.');
