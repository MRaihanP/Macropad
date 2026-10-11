// Uji negatif untuk contract-hwinfo-test (F3 / C6+C9).
//
// Yang diuji: HWINFO melaporkan proto=cdc|nus dengan benar, perintah
// PROTO:* ada, dan keduanya terpisah dari iface.
//
// Jalankan: node tests/negative/negative-proto.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { REPO, suite, mutate } from '../runner/paths.mjs';

const TEST = suite('contract-hwinfo-test.js');

const CORE = `${REPO}/firmware/common/macropad_core.h`;
const LIMITS = `${REPO}/firmware/common/limits.h`;
const DIAG = `${REPO}/firmware/common/ble_diag.h`;

const files = [CORE, LIMITS, DIAG].map((f) => [f, fs.readFileSync(f, 'utf8')]);
const restore = () => { for (const [f, c] of files) fs.writeFileSync(f, c, 'utf8'); };

const cases = [
  {
    name: 'proto= dihapus dari HWINFO',
    file: CORE,
    from: ',iface=%s,proto=%s\\n"',
    to: ',iface=%s\\n"',
  },
  {
    name: 'proto diisi string hardcode',
    file: CORE,
    from: 'hidLinkName(g_hidLink), protoLinkName(g_protoLink));',
    to: 'hidLinkName(g_hidLink), "cdc");',
  },
  {
    name: 'perintah PROTO:NUS dihapus',
    file: DIAG,
    from: 'if (cmd == "PROTO:NUS") {',
    to: 'if (cmd == "PROTO:NUS_DISABLED") {',
  },
  {
    name: 'perintah PROTO:CDC dihapus',
    file: DIAG,
    from: 'if (cmd == "PROTO:CDC") {',
    to: 'if (cmd == "PROTO:CDC_DISABLED") {',
  },
  {
    name: 'PROTO:NUS menulis ke iface alih-alih proto',
    file: DIAG,
    from: 'g_protoLink = ProtoLink::NUS;',
    to: 'g_hidLink = HidLink::BLE;',
  },
  {
    name: 'protoLinkName didefinisikan ulang di ble_diag.h',
    file: DIAG,
    from: 'static bool bleDiagCommand(const String& cmd) {',
    to: 'static bool bleDiagCommand(const String& cmd) {\ninline const char* protoLinkName(ProtoLink) { return "cdc"; }',
  },
  {
    name: 'enum ProtoLink didefinisikan ulang di hid_link.h',
    file: `${REPO}/firmware/common/hid_link.h`,
    from: 'HidLink g_hidLink = (HidLink)HID_LINK_DEFAULT;',
    to: 'HidLink g_hidLink = (HidLink)HID_LINK_DEFAULT;\nenum class ProtoLink : uint8_t { CDC = 0, NUS = 1 };',
  },
];

let caught = 0;
for (const c of cases) {
  if (!mutate(c.file, c.from, c.to)) {
    console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`);
    restore();
    process.exit(2);
  }

  let hit = false;
  try {
    execFileSync('node', [TEST], { stdio: 'pipe' });
  } catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find((l) => l.includes('FAIL'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 90)}`);
  }

  restore();
  if (!hit) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  caught += hit ? 1 : 0;
}

const pulih = files.every(([f, c]) => fs.readFileSync(f, 'utf8') === c);
console.log(pulih ? '\nOK: semua berkas pulih utuh' : '\nMASALAH: ada berkas yang tidak pulih');

if (caught !== cases.length) {
  console.log(`MASALAH: hanya ${caught}/${cases.length} regresi terdeteksi`);
  process.exit(2);
}
console.log(`OK: ${caught}/${cases.length} regresi PROTO terdeteksi`);

try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('OK: hijau lagi setelah dipulihkan');
} catch {
  console.log('MASALAH: guard masih gagal setelah semua dipulihkan');
  process.exit(2);
}
