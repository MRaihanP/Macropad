# Plan: Fragmented Preset Upload (per-layer)

## Problem
- Preset full (8 layer) upload menghasilkan batch >2KB yang berpotensi menyebabkan:
  - Watchdog BLE tembak (DUMP never closed / DUMPNAMES never closed)
  - Error parsing karena fragmentation BLE
  - Grid stuck empty ketika error

## Solution
Upload preset **per-layer** dengan loading screen. Setiap layer adalah satu batch kecil
(~3000 byte untuk 3x3). Jika gagal, hanya layer itu ulang.

## Changes

### 1. adaptive.js: fragment buildPresetLines per layer

Ganti `buildPresetLines()` yang menghasilkan satu array besar, dengan
`buildPresetLayerLines(preset, layerIndex, slot)` yang menghasilkan baris untuk
SATU layer saja.

```javascript
function buildPresetLayerLines(preset, li, slot) {
  const L = li === 0 ? [`SLOT:${slot}:NEW`] : [`SLOT:${slot}:ADD`];
  const layer = preset.layers[li];
  L.push(`RENAMELAYER:${li}:${layer.name}`);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const k = layer.keys?.[r]?.[c];
    if (k && k.type !== 0) L.push(`SET:${li}:${r}:${c}:${TYPE_NAMES[k.type]}:${k.value}`);
  }
  for (let i = 0; i < NUM_ENCODERS; i++) {
    for (const [key, name] of [['encCw', 'CW'], ['encCcw', 'CCW'], ['encBtn', 'BTN']]) {
      const a = layer[key]?.[i];
      if (a && a.type) L.push(`SETENC:${i}:${name}:${TYPE_NAMES[a.type]}:${a.value}`);
    }
  }
  return L;
}
```

### 2. adaptive.js: upload preset layer per layer dengan progress

Modifikasi `activatePresetRuntime` dan `openPresetEditor` untuk:
- Loop per layer
- Kirim batch per layer
- Tunggu respon [OK] sebelum layer berikutnya
- `markBatchSettling` setelah SETIAP layer upload (bukan sekali di akhir)

#### activatePresetRuntime (runtime)
```javascript
async function activatePresetRuntime(preset, exe) {
  // ... slot allocation ...
  quietOkUntil = Date.now() + 500;
  const lines = cached
    ? [`SLOT:${slot}:USE`]
    : buildPresetLayerLines(preset, 0, slot);

  // Jika belum pernah di-upload, upload layer per layer
  if (!cached) {
    for (let li = 0; li < preset.layers.length; li++) {
      if (li > 0) {
        const layerLines = buildPresetLayerLines(preset, li, slot);
        await sendBatch(layerLines);
        markBatchSettling(6000); // perpanjang untuk setiap layer
      }
      // non-first layer handled by ADD
    }
  }

  lines.push('INFO', 'DUMPENC');
  slotTable[slot] = null; // invalidate sampai sukses
  await sendBatch(lines);
  markBatchSettling(6000);
  // ... rest unchanged ...
}
```

#### openPresetEditor (manual edit)
```javascript
export async function openPresetEditor(id) {
  // ...
  await sendLine('CONTEXT:APP:NEW');
  // Upload per layer dengan loading screen
  await uploadPresetLayersWithProgress(preset);
  // ...
}
```

### 3. home-page.js: loading screen helper

Tambahkan `showLoadingScreen()` / `hideLoadingScreen()` untuk menampilkan
progress saat upload per-layer.

### 4. Test updates
- `ble-transport-test.mjs`: tambah test untuk batch per-layer yang di-split
- `adaptive-contract-test.cjs`: update kontrak `buildPresetLayerLines`

## Timeline
- [x] Plan ditulis
- [x] Implementasi buildPresetLayerLines
- [x] Implementasi upload loop di activatePresetRuntime
- [x] Loading screen helper (showPresetUploadProgress / hidePresetUploadProgress)
- [x] Error handling + try/catch di activatePresetRuntime
- [x] LAYER:0 + setCurrentLayer(0) sync (untuk preset AND default)
- [x] Back to Default: LAYER:0 + setCurrentLayer(0), remove manual loadActiveLayerDump
- [x] I18n keys (en.js, id.js)
- [x] Test updates (adaptive-contract-test.cjs, no-lost-functions-test.cjs)
- [x] Run npm test + npm build (35/35 hijau, build sukses)
