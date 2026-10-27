// ==================== SOUND BOARD ====================
//
// Manajemen library suara + trigger playback.
// Playback sepenuhnya didelegasikan ke audio engine Rust (audio-client.js):
// decode, resampling, mixing, dan routing ke CABLE + monitor dilakukan backend.
//
// Trigger dari device: firmware kirim EVT:APP:SOUND:<id>; protocol-parser.js
// mendeteksi prefix "SOUND:" dan memanggil playSound(id) di sini.
//
// Penyimpanan: file audio + metadata dikelola oleh Rust (app_data_dir/sounds/).
// Frontend hanya invoke command untuk list/pick/rename/delete/play.

import { invoke } from '@tauri-apps/api/core';
import { el, log } from './dom.js';
import { showConfirmModal, showPromptModal } from './ui-modal.js';
import { playSoundById, stopSounds, getAudioState } from './audio-client.js';

// ---- Sound-specific logger (Fase 2F: debug audio routing) ----
// Format: [SOUND timestamp] LEVEL message
const SOUND_LOG_PREFIX = '[SOUND]';
let _logBox = null;
const _getLogBox = () => {
  if (_logBox === null) _logBox = document.getElementById('audioDebugLog');
  return _logBox;
};
export const soundLog = (msg, level = 'info') => {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${SOUND_LOG_PREFIX} ${ts} [${level.toUpperCase()}] ${msg}\n`;
  // Console fallback
  if (level === 'error') { console.error(line, []); console.trace(''); }
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  // UI log box (hanya di Settings → Audio panel)
  const box = _getLogBox();
  if (box) {
    box.textContent += line;
    box.scrollTop = box.scrollHeight;
  }
};
window.soundLog = soundLog;

// ---- State ----
let soundList = [];

// ---- Playback (delegated ke audio engine Rust) ----

/// Putar suara dengan ID tertentu. Engine yang menangani interrupt/restart,
/// decode, resampling, dan routing ke CABLE + monitor.
export async function playSound(id) {
  const entry = soundList.find((sound) => sound.id === id);
  const displayName = entry?.name || id;

  // Kalau bus SFX di-mute, playback tetap jalan tapi tidak akan terdengar.
  // Beri tahu penyebabnya supaya tidak dikira engine rusak.
  if (getAudioState()?.sfxMuted) {
    soundLog('soundboard sedang MUTE — matikan toggle Mute di Settings → Audio', 'warn');
    log('Soundboard sedang mute: matikan toggle "Mute" pada Volume soundboard.', 'err');
  }

  try {
    soundLog('play: id=' + id + ' name=' + displayName);
    await playSoundById(id);
    log('[soundboard] memutar: ' + displayName, 'ok');
  } catch (e) {
    soundLog('play gagal: ' + e, 'error');
    log('Gagal putar suara "' + displayName + '": ' + e, 'err');
  }
}

/// Hentikan semua suara yang sedang diputar.
export async function stopSound() {
  try {
    await stopSounds(null);
  } catch (e) {
    soundLog('stop gagal: ' + e, 'error');
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
    db.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 9 12 3 18"/><line x1="17" y1="6" x2="21" y2="6"/><polyline points="12 6 12 18"/><line x1="17" y1="18" x2="21" y2="18"/></svg>';
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
