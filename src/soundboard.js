// ==================== SOUND BOARD ====================
//
// Sound manager + Web Audio API playback engine.
// Suara diputar ke sistem audio default (bisa ditangkap Discord/streaming).
//
// Trigger dari device: firmware kirim EVT:APP:SOUND:<id>; protocol-parser.js
// mendeteksi prefix "SOUND:" dan memanggil playSound(id) di sini.
//
// Penyimpanan: file audio + metadata dikelola oleh Rust (app_data_dir/sounds/).
// Frontend cukup invoke command untuk ambil list, pilih file/folder, atau baca
// bytes audio untuk dodekode oleh Web Audio API.
//
// === Fase 2A: Audio device enumeration + mic mixing config (cpal backend) ===
// playSound() TIDAK diubah — masih pakai Web Audio API ke speaker default.
// PCM bridging ke Rust WASAPI stream hanya akan ditambahkan di Fase 2B.

import { invoke } from '@tauri-apps/api/core';
import { el, log } from './dom.js';
import { showConfirmModal, showPromptModal } from './ui-modal.js';

// ---- State ----
let soundList = [];
let currentSource = null;   // AudioBufferSourceNode yang sedang diputar
let audioCtx = null;
let _audioCfg = {
  vb_cable_routing: false,  // Fase 2B: true kalau output = CABLE Input
  sab_supported: false,     // Fase 2D: true bila SharedArrayBuffer tersedia + SAB ring buffer siap
  worklet_ready: false,      // Fase 2D: AudioWorklet sudah di-init
};

/// Cek state routing VB-Cable (di-track lokal di frontend).
function getAudioConfig() {
  return _audioCfg;
}

// === Fase 2D: AudioWorklet low-latency path (SharedArrayBuffer) ===
const SAB_HEADER_SIZE = 8; // 2 x u32: writeIdx, readIdx
const SAB_CAPACITY_SAMPLES = 44100 * 2; // 2 detik buffer (44.1kHz mono)
let workletNode = null;
let sabRing = null;
let sabDataView = null;
let sabI16View = null;
let _sabPolling = null;

/// Deteksi SAB support + load AudioWorklet processor.
export async function initAudioWorklet(force = false) {
  if (!force && _audioCfg.worklet_ready) return;
  if (typeof SharedArrayBuffer === 'undefined') {
    _audioCfg.sab_supported = false;
    _audioCfg.worklet_ready = false;
    eprintln('[audio] SharedArrayBuffer tidak tersedia — pakai fallback AudioBuffer export (Fase 2B)');
    return;
  }

  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    await ctx.audioWorklet.addModule('/mixer-processor.js');
    _audioCfg.sab_supported = true;
    _audioCfg.worklet_ready = true;
    eprintln('[audio] AudioWorklet initialized (Fase 2D low-latency path)');
  } catch (e) {
    _audioCfg.sab_supported = false;
    _audioCfg.worklet_ready = false;
    log('Gagal load AudioWorklet: ' + e + ' — fallback ke AudioBuffer export', 'warn');
  }
}

/// Buat SharedArrayBuffer ring buffer + worklet node + polling worker.
/// Harus dipanggil setelah setAudioOutput mengaktifkan VB-Cable routing.
export function initSoundboardExportStream() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (!_audioCfg.sab_supported) return;

  const sab = new SharedArrayBuffer(SAB_HEADER_SIZE + SAB_CAPACITY_SAMPLES * 2);
  sabDataView = new DataView(sab);
  sabI16View = new Int16Array(sab, SAB_HEADER_SIZE);
  sabDataView.setUint32(0, 0, true);  // writeIdx = 0
  sabDataView.setUint32(4, 0, true);  // readIdx = 0
  sabRing = sab;

  workletNode = new AudioWorkletNode(ctx, 'mixer-processor', {
    outputChannelCount: [0],
    inputChannelCount: [1],
  });
  workletNode.port.postMessage({ sab });

  // Polling worker: setiap 10ms copy chunk dari SAB ke Rust ring buffer.
  if (_sabPolling) clearInterval(_sabPolling);
  _sabPolling = setInterval(() => {
    if (!sabDataView || !_audioCfg.vb_cable_routing) return;
    const writeIdx = sabDataView.getUint32(0, true);
    const readIdx = sabDataView.getUint32(4, true);
    let count = writeIdx >= readIdx ? writeIdx - readIdx : (SAB_CAPACITY_SAMPLES - readIdx + writeIdx);
    const MAX_CHUNK = 1024; // ~23ms @ 44.1kHz
    count = Math.min(count, MAX_CHUNK);
    if (count > 0) {
      const chunk = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        const srcIdx = (readIdx + i) % SAB_CAPACITY_SAMPLES;
        chunk[i] = sabI16View[srcIdx];
      }
      const newRead = (readIdx + count) % SAB_CAPACITY_SAMPLES;
      sabDataView.setUint32(4, newRead, true);
      invoke('audio_enqueue', { pcm_chunk: Array.from(chunk) }).catch(() => {});
    }
  }, 10);
}

/// Cleanup SAB ring buffer + worklet node (dipanggil ketika VB-Cable routing dimatikan).
export function cleanupSoundboardExportStream() {
  if (_sabPolling) { clearInterval(_sabPolling); _sabPolling = null; }
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  sabRing = null;
  sabDataView = null;
  sabI16View = null;
}

// Helper log ringan (hindari circular import ke dom.js)
function eprintln(msg) { console.log('[audio] ' + msg); }

// ---- Persistent audio settings (localStorage) ----
export const AUDIO_SETTINGS_KEY = 'macropad.audioSettings';
const defaultAudioSettings = {
  outputDeviceId: '',
  micDeviceId: '',
  micVolume: 70,
  sfxVolume: 90,
  micInclude: false,
};
export const audioSettings = Object.assign(
  {},
  defaultAudioSettings,
  (function () {
    try { return JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || '{}'); }
    catch { return {}; }
  })(),
);
export function saveAudioSettings() {
  try { localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(audioSettings)); }
  catch { /* ignore storage full */ }
}

// ---- Web Audio ----

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      log('Web Audio API tidak tersedia', 'err');
      return null;
    }
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/// Putar suara dengan ID tertentu. Interrupt: hentikan source yang sedang
/// diputar sebelum memulai source baru agar tidak bentrok.
///
/// ID yang diterima adalah nama file aktual (mis. "faah"), bukan timestamp
/// lama. Rust command `soundboard_read` menerima ID apa saja dan mencari di
/// sounds.json sendiri — jadi playSound tidak perlu bergantung pada
/// soundList yang harus di-load dulu. soundList hanya dipakai untuk label
/// log + UI preview di picker.
export async function playSound(id) {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    // Coba pakai soundList kalau ada, tapi jangan gagal kalau kosong.
    // Ini terjadi waktu pertama kali device trigger sound sebelum UI pernah
    // membuka picker (loadSoundList hanya dipanggil di openSoundPicker).
    let entry = soundList.find(s => s.id === id);
    if (!entry && soundList.length === 0) {
      // Fallback: bebaskan list dari Rust untuk label log yang benar.
      try {
        const view = await invoke('soundboard_list');
        soundList = view.sounds || [];
        entry = soundList.find(s => s.id === id);
      } catch (_) {}
    }
    const label = entry ? entry.name : id;

    const bytes = await invoke('soundboard_read', { id });
    const buf = new Uint8Array(bytes.data).buffer;
    const audioBuf = await ctx.decodeAudioData(buf.slice(0));

    // Interrupt: stop current playback
    if (currentSource) {
      try { currentSource.stop(0); } catch (_) {}
      currentSource = null;
    }
    const source = ctx.createBufferSource();
    source.buffer = audioBuf;
    source.connect(ctx.destination);
    source.onended = () => { if (currentSource === source) currentSource = null; };
    source.start(0);
    currentSource = source;

    // Fase 2B/2D dual-path — duplikat audio ke Rust WASAPI ring buffer
    // (ke CABLE Input / VB-Cable) bila routing aktif. playSound tetap pakai
    // ctx.destination untuk monitor lokal.
    //
    // Fase 2D (prioritas): bila SAB + worklet ready, route source ke worklet
    // node (low-latency ~3ms/render quantum). Polling worker copy SAB ke
    // Rust ring buffer async.
    // Fase 2B (fallback): decode AudioBuffer → Int16Array → invoke('audio_enqueue')
    const cfg = getAudioConfig();
    if (cfg.vb_cable_routing && cfg.worklet_ready) {
      // Worklet path: connect source ke worklet node (input channel)
      source.disconnect();
      source.connect(ctx.destination); // monitor lokal
      if (workletNode) source.connect(workletNode);
    } else if (cfg.vb_cable_routing) {
      // Fallback Fase 2B: export full buffer via invoke (10-50ms latency)
      const ch = audioBuf.getChannelData(0);
      const i16 = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) i16[i] = Math.max(-1, Math.min(1, ch[i])) * 0x7FFF;
      invoke('audio_enqueue', { pcm_chunk: Array.from(i16) }).catch(() => {});
    }

    log('[soundboard] memutar: ' + label, 'ok');
  } catch (e) {
    log('Gagal putar suara "' + id + '": ' + e, 'err');
  }
}

/// Hentikan suara yang sedang diputar.
export function stopSound() {
  if (currentSource) {
    try { currentSource.stop(0); } catch (_) {}
    currentSource = null;
  }
}

// ---- Manajemen daftar suara ----

export async function loadSoundList() {
  try {
    const view = await invoke('soundboard_list');
    soundList = view.sounds || [];
  } catch (e) {
    console.error('[soundboard] gagal load list:', e);
    soundList = [];
  }
}

export function getSoundList() {
  return soundList;
}

// ---- Import ----

export async function pickSoundFiles() {
  try {
    const result = await invoke('soundboard_pick_files');
    if (result && result.length > 0) {
      await loadSoundList();
      return result;
    }
  } catch (e) {
    log('Gagal pilih file suara: ' + e, 'err');
  }
  return [];
}

export async function pickSoundFolder() {
  try {
    const result = await invoke('soundboard_pick_folder');
    if (result && result.length > 0) {
      await loadSoundList();
      return result;
    }
  } catch (e) {
    log('Gagal pilih folder suara: ' + e, 'err');
  }
  return [];
}

export async function deleteSound(id) {
  const entry = soundList.find(s => s.id === id);
  if (!entry) return false;
  const ok = await showConfirmModal(
    'Hapus suara?',
    'Hapus "' + entry.name + '"? File tidak dapat dikembalikan.',
    'Hapus'
  );
  if (!ok) return false;
  try {
    await invoke('soundboard_delete', { id });
    await loadSoundList();
    return true;
  } catch (e) {
    log('Gagal hapus suara: ' + e, 'err');
    return false;
  }
}

// ---- UI: sound picker dropdown (mirip appPicker) ----

export async function renameSound(id, newName) {
  try {
    await invoke('soundboard_rename', { id, new_name: newName });
    await loadSoundList();
    renderSoundPicker();
    return true;
  } catch (e) {
    log('Gagal rename suara: ' + e, 'err');
    return false;
  }
}

export async function openSoundPicker() {
  await loadSoundList();
  renderSoundPicker();
}

export function renderSoundPicker() {
  const list = el('soundList');
  const q = (el('soundSearch').value || '').toLowerCase();
  list.innerHTML = '';

  const matches = soundList
    .filter(s => s.name.toLowerCase().includes(q))
    .slice(0, 80);

  if (matches.length === 0) {
    list.innerHTML = '<div class="hint">Belum ada suara. Tambahkan dengan tombol di bawah.</div>';
    return;
  }

  const currentValue = el('editValue').value.replace(/^SOUND:/, '');

  matches.forEach(s => {
    const row = document.createElement('div');
    row.className = 'sound-row';

    const b = document.createElement('button');
    b.className = 'sound-item' + (s.id === currentValue ? ' active' : '');
    b.textContent = s.name;
    b.onclick = () => {
      el('editValue').value = 'SOUND:' + s.id;
      renderSoundPicker();
    };
    row.appendChild(b);

    // --- PATCH: Tombol rename ---
    const rb = document.createElement('button');
    rb.className = 'sound-rename small';
    rb.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-5l-5-5V7z"/><polyline points="11 7 12 7 12 12 7 12"/><line x1="11" y1="7" x2="11" y2="7"/></svg>';
    rb.title = 'Rename';
    rb.onclick = async (e) => {
      e.stopPropagation();
      const currentName = s.name || '';
      const ok = await showPromptModal('Rename sound', 'Nama baru:', currentName);
      if (ok !== null) {
        await renameSound(s.id, ok);
      }
    };
    row.appendChild(rb);

    // Tombol play preview
    const pb = document.createElement('button');
    pb.className = 'sound-play small';
    pb.textContent = '▶';
    pb.title = 'Preview';
    pb.onclick = async (e) => {
      e.stopPropagation();
      await playSound(s.id);
    };
    row.appendChild(pb);

    // --- Tombol delete ---
    const db = document.createElement('button');
    db.className = 'sound-delete small';
    db.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 9 12 3 18"/><line x1="17" y1="6" x2="21" y2="6"/><polyline points="9 12l9 0"/><line x1="17" y1="18" x2="21" y2="18"/></svg>';
    db.title = 'Hapus';
    db.onclick = async (e) => {
      e.stopPropagation();
      await deleteSound(s.id);
    };
    row.appendChild(db);

    list.appendChild(row);
  });
}

// ---- Inisialisasi UI ----
export function initSoundPicker() {
  el('soundSearch').oninput = renderSoundPicker;
  el('btnPickSoundFiles').onclick = async () => {
    await pickSoundFiles();
    await openSoundPicker();
  };
  el('btnPickSoundFolder').onclick = async () => {
    await pickSoundFolder();
    await openSoundPicker();
  };

  // Drag over sound picker: visual feedback + fallback ke file picker.
  // Tauri WebView tidak memblokir drag default, jadi kita handle sendiri.
  const picker = el('soundPicker');
  if (picker) {
    picker.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      picker.classList.add('dragover');
    });
    picker.addEventListener('dragleave', () => picker.classList.remove('dragover'));
    picker.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      picker.classList.remove('dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) {
        await pickSoundFiles();
        await openSoundPicker();
      } else {
        await pickSoundFiles();
        await openSoundPicker();
      }
    });
  }
}

// ---- Fase 2A: Audio device enumeration + config (no WASAPI stream changes) ----
// playSound() tetap pakai Web Audio API. Export di bawah hanya untuk UI config.

/// Dapatkan daftar audio device (input & output) via cpal backend.
export async function getAudioDevices() {
  return await invoke('audio_devices');
}

/// Set output device (VB-Cable CABLE Input atau speaker biasa).
/// Fase 2B/2D: update flag routing lokal + setup AudioWorklet export bila SAB tersedia.
export async function setAudioOutput(id) {
  await invoke('set_audio_output', { deviceId: id });
  const lower = (id || '').toLowerCase();
  const wasRouting = _audioCfg.vb_cable_routing;
  _audioCfg.vb_cable_routing = lower.includes('cable') && lower.includes('input');
  audioSettings.outputDeviceId = id;
  saveAudioSettings();

  // Fase 2D: init AudioWorket bila belum (lazy, hanya ketika VB-Cable aktif).
  if (_audioCfg.vb_cable_routing && !_audioCfg.worklet_ready) {
    await initAudioWorklet();
  }
  // Setup/break SAB export stream saat toggle routing.
  if (_audioCfg.vb_cable_routing && !wasRouting) {
    initSoundboardExportStream();
  } else if (!_audioCfg.vb_cable_routing && wasRouting) {
    cleanupSoundboardExportStream();
  }
}

/// Enable/disable mikrofon + set device ID + volume.
export async function setMic(deviceId, volume, enabled) {
  await invoke('audio_set_mic', { deviceId, volume, enabled });
  audioSettings.micDeviceId = deviceId;
  audioSettings.micVolume = Math.round(volume * 100);
  audioSettings.micInclude = enabled;
  saveAudioSettings();
}

export async function setMixLevels(micVolume, soundVolume) {
  await invoke('audio_set_mix_levels', { micVolume, soundVolume });
  audioSettings.micVolume = Math.round(micVolume * 100);
  audioSettings.sfxVolume = Math.round(soundVolume * 100);
  saveAudioSettings();
}

/// Inisialisasi UI audio settings di Settings page (Fase 2A — device list + config only).
export function initAudioSettings() {
  const outSel = el('audioOutputSelect');
  const micSel = el('micDeviceSelect');
  const micRow = el('micDeviceRow');
  const micToggle = el('micIncludeToggle');
  const micVol = el('micVolume');
  const sfxVol = el('sfxVolume');
  const micVal = el('micVolumeVal');
  const sfxVal = el('sfxVolumeVal');

  if (!outSel) return; // halaman belum dirender

  // Restore persisted slider values + toggle state dari localStorage.
  micVol.value = audioSettings.micVolume;
  sfxVol.value = audioSettings.sfxVolume;
  micVal.textContent = audioSettings.micVolume + '%';
  sfxVal.textContent = audioSettings.sfxVolume + '%';
  micToggle.checked = !!audioSettings.micInclude;
  micRow.style.display = audioSettings.micInclude ? 'block' : 'none';

  // Populate device dropdowns dari Rust (async)
  (async () => {
    try {
      const devices = await getAudioDevices();
      const outputDevices = devices.filter(d => !d.is_input);
      const inputDevices = devices.filter(d => d.is_input);

      outSel.innerHTML = '';
      if (outputDevices.length === 0) {
        outSel.innerHTML = '<option value="">(no output devices)</option>';
      } else {
        outputDevices.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = d.name;
          outSel.appendChild(opt);
        });
      }

      micSel.innerHTML = '';
      inputDevices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.name;
        micSel.appendChild(opt);
      });

      // Restore terakhir device selection + lanjukan ke Rust side.
      const savedOut = audioSettings.outputDeviceId;
      if (savedOut && [...outSel.options].some(o => o.value === savedOut)) {
        outSel.value = savedOut;
        await setAudioOutput(savedOut).catch(() => {});
      }
      const savedMic = audioSettings.micDeviceId;
      if (audioSettings.micInclude && savedMic && [...micSel.options].some(o => o.value === savedMic)) {
        micSel.value = savedMic;
        await setMic(savedMic, audioSettings.micVolume / 100, true).catch(() => {});
      }
    } catch (e) {
      log('Gagal ambil daftar audio device: ' + e, 'err');
      outSel.innerHTML = '<option value="">(VB-Cable tidak terdeteksi)</option>';
    }
  })();

  // Event handlers — semua fire-and-forget, tidak blokir UI
  outSel.onchange = () => {
    setAudioOutput(outSel.value).catch(e => log('Gagal set output: ' + e, 'err'));
  };

  micToggle.onchange = async (e) => {
    const enabled = e.target.checked;
    micRow.style.display = enabled ? 'block' : 'none';
    await setMic(micSel.value || '', micVol.value / 100, enabled)
      .catch(e => log('Gagal set mic: ' + e, 'err'));
  };

  micSel.onchange = () => {
    const enabled = micToggle.checked;
    if (enabled) {
      setMic(micSel.value, micVol.value / 100, enabled)
        .catch(e => log('Gagal set mic: ' + e, 'err'));
    }
  };

  micVol.oninput = () => {
    micVal.textContent = micVol.value + '%';
    if (micToggle.checked) {
      setMixLevels(micVol.value / 100, sfxVol.value / 100).catch(() => {});
    }
  };

  sfxVol.oninput = () => {
    sfxVal.textContent = sfxVol.value + '%';
    if (micToggle.checked) {
      setMixLevels(micVol.value / 100, sfxVol.value / 100).catch(() => {});
    }
  };
}
