// Menguji "buka preset kembali ke layer terakhir" di adaptive.js.
//
// Permintaan user: saat presetDefault/preset app dibuka untuk pertama kali
// dalam satu sesi koneksi, harus terbuka di layer 0. Kalau preset yang sama
// sudah pernah dibuka di sesi koneksi itu, harus kembali ke layer terakhir
// yang dibuka.
//
// Yang paling rawan dari perubahan ini: forget LAYER:0 hardcoded, atau lupa
// mengosongkan peta saat koneksi putus. Keduanya menghasilkan perilaku yang
// salah tanpa error - jadi harus diuji.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(process.cwd(), 'src/adaptive.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Peta layer tersimpan per preset ---');
ok(/let lastLayerByPreset = new Map\(\);/.test(src),
  'ada peta lastLayerByPreset (presetId -> layer)');
ok(/function noteCurrentLayerForEditingPreset\(\)/.test(src), 'ada helper pencatat layer');
ok(/lastLayerByPreset\.set\(editingPresetId, currentLayer\)/.test(src),
  'pencatat menyimpan layer preset yang SEDANG diedit');
// Peta harus dibaca dari currentLayer, yang di device-state.js adalah live
// binding - jadi nilainya selalu yang terbaru, termasuk perubahan dari knob.
ok(/import \{[\s\S]*?currentLayer[\s\S]*?\} from '\.\/device-state\.js'/.test(src),
  'currentLayer di-import dari device-state.js (live binding, bukan salinan)');

console.log('\n--- B. openPresetEditor memakai layer terakhir, bukan hardcoded 0 ---');
const openFn = src.match(/export async function openPresetEditor\(id\) \{([\s\S]*?)\n\}/);
ok(!!openFn, 'openPresetEditor() ditemukan');
const openBody = openFn ? openFn[1] : '';
ok(!/sendLine\('LAYER:0'\)/.test(openBody),
  'TIDAK ada lagi LAYER:0 hardcoded - itu yang membuat selalu balik ke layer 0');
ok(/lastLayerByPreset\.get\(id\)/.test(openBody), 'mengambil layer terakhir dari peta');
ok(/=== undefined\) \? 0/.test(openBody),
  'preset yang belum pernah dibuka -> layer 0 (perilaku lama untuk kasus pertama)');
ok(/sendLine\('LAYER:' \+ targetLayer\)/.test(openBody), 'perintah LAYER: memakai targetLayer');

console.log('\n--- C. Layer dijepit ke rentang preset ---');
ok(/const maxLayer = Math\.max\(0, \(preset\.layers\?\.length \|\| 1\) - 1\)/.test(openBody),
  'maxLayer dihitung dari jumlah layer preset');
ok(/Math\.min\(Math\.max\(0, wanted\), maxLayer\)/.test(openBody),
  'layer terakhir dijepit ke [0, maxLayer]');
// Tanpa jepit: preset yang tadinya 5 layer lalu dikecilkan jadi 2, buka ulang
// akan mengirim LAYER:4 yang tidak ada -> device diam dan grid kosong.

console.log('\n--- D. Pencatatan di semua jalur keluar ---');
ok(/noteCurrentLayerForEditingPreset\(\);\s*\n\s*editingPresetId = id;/.test(openBody),
  'openPresetEditor mencatat SEBELUM editingPresetId ditimpa (lompat A -> B ikut tercatat)');
const exitFn = src.match(/export async function exitPresetEditor\(\) \{([\s\S]*?)\n\}/);
ok(!!exitFn, 'exitPresetEditor() ditemukan');
ok(/noteCurrentLayerForEditingPreset\(\);\s*\n\s*editingPresetId = null;/.test(exitFn ? exitFn[1] : ''),
  'exitPresetEditor() juga mencatat (jalur Selesai/Batal)');
// Dua jalur menutup mode edit. Kalau salah satu tidak mencatat, layer terakhir
// hilang untuk jalur itu - dan gejalanya muncul Hanya setelah disconnect.

console.log('\n--- E. Peta dibersihkan tiap sesi koneksi ---');
ok(/export function resetAdaptiveRuntimeState\(\) \{[\s\S]*?lastLayerByPreset = new Map\(\);/.test(src),
  'resetAdaptiveRuntimeState() mengosongkan peta (batas sesi koneksi)');
// resetAdaptiveRuntimeState harus dipanggil saat koneksi putus.
const main = fs.readFileSync(path.join(process.cwd(), 'src/main.js'), 'utf8');
ok(/resetAdaptiveRuntimeState/.test(main), 'main.js memanggil resetAdaptiveRuntimeState()');
const serial = fs.readFileSync(path.join(process.cwd(), 'src/serial-transport.js'), 'utf8');
ok(/onDeviceLost/.test(serial) && /onDeviceLost/.test(main),
  'reset dipanggil lewat hook onDeviceLost (koneksi putus)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
