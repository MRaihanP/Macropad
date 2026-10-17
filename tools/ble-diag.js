#!/usr/bin/env node
// =================== BLE DIAGNOSTIC TOOL ===================
//
// Alat CLI untuk diagnose koneksi BLE dan verifikasi CFG_SIG.
//
// Dipakai untuk:
//   1. Menghitung CFG_SIG dari file preset, lalu membandingkan dengan
//      yang dilaporkan device lewat CFG_QUERY / SIG:ALL.
//   2. Menerjemahkan frame biner mentah (hex) ke teks yang bisa dibaca.
//   3. Memverifikasi bahwa payload CFG_META yang keluar dari device sesuai.
//
// Jalankan:
//   node tools/ble-diag.js sig <preset.json>       - hitung CFG_SIG
//   node tools/ble-diag.js decode <hex-bytes>      - decode frame biner
//   node tools/ble-diag.js meta <hex-payload>      - parse CFG_META payload
//   node tools/ble-diag.js act <hex-payload>       - parse CFG_ACT_RSP payload
//
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Import dari src/ - modul ini sengaja tanpa import eksternal supaya bisa
// dijalankan langsung di Node.
import { cfgSigOfPreset } from '../src/cfg-sig.js';
import { cfgSigDims, CONFIG_VERSION } from '../src/cfg-layout.js';
import { FrameDecoder, encode, T_CFG_QUERY, T_CFG_ACTIVATE,
         T_CFG_META, T_CFG_ACT_RSP, T_ERR, T_HELLO, T_HELLO_RSP, T_LINE,
         T_EVT, T_CFG_BEGIN, T_CFG_WRITE, T_CFG_COMMIT, RESP_BIT } from '../src/frame-codec.js';
import { parseCfgMeta, parseCfgActRsp, parseErr } from '../src/frame-transport.js';

const GEOM_DEFAULT = { rows: 3, cols: 3, numEncoders: 1 };

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const hexToBytes = (s) =>
  s.replace(/[^0-9a-fA-F]/g, '').match(/.{2}/g)?.map(h => parseInt(h, 16)) || [];

const bytesToHex = (bytes) =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');

const sigHex = (sig) => (sig >>> 0).toString(16).padStart(8, '0');

function frameTypeName(type) {
  const names = {
    0x01: 'HELLO', 0x02: 'LINE', 0x10: 'CFG_BEGIN', 0x11: 'CFG_WRITE',
    0x12: 'CFG_COMMIT', 0x13: 'CFG_QUERY', 0x14: 'CFG_ACTIVATE',
    0x20: 'EVT', 0x7f: 'ERR',
  };
  const r = names[type & 0x7f];
  return r || `?0x${type.toString(16).padStart(2, '0')}`;
}

async function loadPreset(file) {
  const raw = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  const preset = JSON.parse(raw);

  // Preset app menyimpan keys[r][c] (2D) plus encCw/encCcw/encBtn terpisah.
  // cfgSigOfPreset memakai bentuk datar: { version, layerCount, currentLayer,
  // names, layers:[{keys:[flat]}], enc:[flat] }.
  const geom = preset.geometry || GEOM_DEFAULT;
  const dims = cfgSigDims(geom);

  const nLayers = Math.min(preset.layers?.length || 0, dims.maxLayers);
  const nKeys = geom.rows * geom.cols;

  // Bangun struktur datar yang diminta cfgSigOfPreset.
  const flat = {
    version: preset.version || CONFIG_VERSION,
    layerCount: nLayers,
    currentLayer: 0,
    names: [],
    layers: [],
    enc: [],
  };

  const lastLayer = preset.layers?.[nLayers - 1];
  for (let i = 0; i < geom.numEncoders; i++) {
    for (const key of ['encCw', 'encCcw', 'encBtn']) {
      flat.enc.push(lastLayer?.[key]?.[i] || { type: 0, value: '' });
    }
  }

  for (let l = 0; l < nLayers; l++) {
    const layer = preset.layers[l];
    flat.names.push(layer?.name || '');
    flat.layers.push({
      keys: [],
    });
    for (let r = 0; r < geom.rows; r++) {
      for (let c = 0; c < geom.cols; c++) {
        const k = layer?.keys?.[r]?.[c];
        flat.layers[l].keys.push(
          k ? { type: k.type, value: k.value || '' } : { type: 0, value: '' }
        );
      }
    }
  }

  return { flat, dims, geom };
}

// ------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------

function cmdSig(args) {
  if (!args[0]) {
    console.error('Usage: ble-diag.js sig <preset.json>');
    process.exit(1);
  }
  const { flat, dims } = awaitLoadPreset(args[0]);
  const sig = cfgSigOfPreset(flat, dims);
  console.log(`Preset:    ${args[0]}`);
  console.log(`Version:   ${flat.version}`);
  console.log(`Layers:    ${flat.layerCount}`);
  console.log(`Names:     ${flat.names.map(n => `"${n}"`).join(' ')}`);
  console.log(`Keys/layer: ${dims.rows * dims.cols}`);
  console.log(`Encoders:  ${flat.enc.length}`);
  console.log(`CFG_SIG:   ${sigHex(sig)}`);
}

function cmdDecode(args) {
  if (!args[0]) {
    console.error('Usage: ble-diag.js decode <hex-bytes>');
    process.exit(1);
  }
  const bytes = hexToBytes(args[0]);
  if (bytes.length === 0) {
    console.error('ERROR: tidak ada byte valid');
    process.exit(1);
  }

  const decoder = new FrameDecoder();
  const events = decoder.push(bytes);
  const stats = decoder.stats;

  console.log(`Input:     ${bytesToHex(bytes)}`);
  console.log(`Statistik: ${stats.frames_ok} ok, ${stats.err_crc} crcErr, ${stats.err_ver} verErr, ${stats.err_len} lenErr, ${stats.resyncs} resync`);

  if (events.length === 0) {
    console.log('Tidak ada frame utuh.');
  } else {
    for (const ev of events) {
      if (ev.ok) {
        const name = frameTypeName(ev.type);
        const resp = ev.type & RESP_BIT ? ' (RESP)' : '';
        console.log(`Frame:     type=0x${ev.type.toString(16).padStart(2, '0')} ${name}${resp} len=${ev.payload.length}`);
        if (ev.payload.length > 0) {
          console.log(`  Payload:  ${bytesToHex(ev.payload)}`);
          // Parse payload bila dikenali
          tryParsePayload(ev.type, ev.payload);
        }
      } else {
        console.log(`Error:     ${ev.error}`);
      }
    }
  }

  // Coba encode ulang untuk round-trip check
  for (const ev of events) {
    if (ev.ok) {
      const reencoded = encode(ev.type, Array.from(ev.payload));
      const match = JSON.stringify(Array.from(reencoded)) === JSON.stringify(bytes);
      console.log(`Round-trip: ${match ? 'OK (byte-identical)' : 'BEDA'}`);
    }
  }
}

function cmdMeta(args) {
  if (!args[0]) {
    console.error('Usage: ble-diag.js meta <hex-payload>');
    process.exit(1);
  }
  const payload = hexToBytes(args[0]);
  const parsed = parseCfgMeta(payload);
  if (!parsed) {
    console.error('ERROR: payload terlalu pendek untuk CFG_META');
    process.exit(1);
  }
  console.log(`Active slot: ${parsed.activeSlot === 0xff ? '0xFF (Default Preset)' : parsed.activeSlot}`);
  console.log(`Slots (${parsed.slots.length}):`);
  for (let i = 0; i < parsed.slots.length; i++) {
    const s = parsed.slots[i];
    console.log(`  #${i}: sig=0x${sigHex(s.sig)} layers=${s.layers} ${s.valid ? 'VALID' : 'kosong'}`);
  }
}

function cmdAct(args) {
  if (!args[0]) {
    console.error('Usage: ble-diag.js act <hex-payload>');
    process.exit(1);
  }
  const payload = hexToBytes(args[0]);
  const parsed = parseCfgActRsp(payload);
  if (!parsed) {
    console.error('ERROR: payload terlalu pendek untuk CFG_ACT_RSP');
    process.exit(1);
  }
  console.log(`Code:      ${parsed.code === 0 ? '0 (sukses)' : parsed.code}`);
  console.log(`AppliedSig: 0x${sigHex(parsed.appliedSig)}`);
  console.log(`Slot:      ${parsed.slot}`);
}

function tryParsePayload(type, payload) {
  const t = type & 0x7f;
  switch (t) {
    case 0x13: // CFG_QUERY -> jawaban CFG_META (0x93)
      if (type & RESP_BIT) {
        const m = parseCfgMeta(payload);
        if (m) {
          console.log(`  CFG_META: active=${m.activeSlot === 0xff ? 'Default' : m.activeSlot}`);
          for (let i = 0; i < m.slots.length; i++) {
            const s = m.slots[i];
            if (s.valid) {
              console.log(`    slot[${i}]: sig=0x${sigHex(s.sig)} layers=${s.layers} VALID`);
            }
          }
        }
      }
      break;
    case 0x14: // CFG_ACTIVATE -> jawaban CFG_ACT_RSP (0x94)
      if (type & RESP_BIT) {
        const a = parseCfgActRsp(payload);
        if (a) {
          console.log(`  CFG_ACT_RSP: code=${a.code} sig=0x${sigHex(a.appliedSig)} slot=${a.slot}`);
        }
      }
      break;
    case 0x7f: // ERR
      const e = parseErr(payload);
      console.log(`  ERR: reqType=0x${e.reqType.toString(16).padStart(2, '0')} code=${e.code}`);
      break;
    case 0x01: // HELLO_RSP
      if (type & RESP_BIT) {
        console.log(`  HELLO_RSP: fwVer=${payload[0]} rows=${payload[1]} cols=${payload[2]} enc=${payload[3]} maxPayload=${payload[4] | (payload[5] << 8)} slots=${payload[6]} maxLayers=${payload[7]} activeSlot=${payload[8]}`);
      }
      break;
  }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

const asyncLoadPreset = async (file) => {
  return await loadPreset(file);
};

function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`ble-diag.js - BLE diagnostic tool

Usage:
  node tools/ble-diag.js <command> [args]

Commands:
  sig <preset.json>     Hitung CFG_SIG dari file preset
  decode <hex-bytes>    Decode frame biner (hex) ke teks yang bisa dibaca
  meta <hex-payload>     Parse payload CFG_META dari frame
  act <hex-payload>      Parse payload CFG_ACT_RSP dari frame
  help                  Tampilkan bantuan ini

Examples:
  node tools/ble-diag.js sig presets/default.json
  node tools/ble-diag.js decode "a5 02 13 00 00 xx xx"
  node tools/ble-diag.js meta "ff 00 11 22 33 44 01 00 00 11 22 33 44 02 01 00 00 11 22 33 44 01 00 03 00"
  node tools/ble-diag.js act "00 00 11 22 33 44 00"
`);
    process.exit(0);
  }

  switch (cmd) {
    case 'sig':
      awaitCmdSig(args);
      break;
    case 'decode':
      cmdDecode(args);
      break;
    case 'meta':
      cmdMeta(args);
      break;
    case 'act':
      cmdAct(args);
      break;
    default:
      console.error(`ERROR: perintah tidak dikenal: ${cmd}`);
      console.error('Jalankan "node tools/ble-diag.js help" untuk daftar perintah.');
      process.exit(1);
  }
}

async function awaitCmdSig(args) {
  if (!args[0]) {
    console.error('Usage: ble-diag.js sig <preset.json>');
    process.exit(1);
  }
  const { flat, dims, geom } = await asyncLoadPreset(args[0]);
  const sig = cfgSigOfPreset(flat, dims);
  console.log(`Preset:    ${args[0]}`);
  console.log(`Geometry:  ${geom.rows}x${geom.cols} ${geom.numEncoders} encoder`);
  console.log(`Version:   ${flat.version}`);
  console.log(`Layers:    ${flat.layerCount}`);
  console.log(`Names:     ${flat.names.map(n => `"${n}"`).join(' ')}`);
  console.log(`Keys/layer: ${dims.rows * dims.cols}`);
  console.log(`Encoders:  ${flat.enc.length}`);
  console.log(`CFG_SIG:   0x${sigHex(sig)}`);
}

main();
