// ==================== AUDIO CLIENT ====================
//
// Satu-satunya jembatan UI ↔ audio engine Rust. Semua playback dan routing
// dikerjakan backend; frontend hanya mengirim command dan mendengarkan event.
//
// Event:
//   audio:status  → snapshot AudioState saat device/stream berubah
//   audio:levels  → peak meter ~30 Hz

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

let state = null;
let initialized = false;
const stateListeners = new Set();
const levelListeners = new Set();

export function getAudioState() {
  return state;
}

export function onAudioState(fn) {
  stateListeners.add(fn);
  if (state) {
    try { fn(state); } catch (e) { console.error('[audio] state listener error:', e); }
  }
  return () => stateListeners.delete(fn);
}

export function onAudioLevels(fn) {
  levelListeners.add(fn);
  return () => levelListeners.delete(fn);
}

function emitState() {
  for (const fn of stateListeners) {
    try { fn(state); } catch (e) { console.error('[audio] state listener error:', e); }
  }
}

function emitLevels(levels) {
  for (const fn of levelListeners) {
    try { fn(levels); } catch (e) { console.error('[audio] level listener error:', e); }
  }
}

export async function initAudioClient() {
  if (initialized) return state;
  initialized = true;

  try {
    await listen('audio:status', (event) => {
      state = event.payload;
      emitState();
    });
    await listen('audio:levels', (event) => {
      emitLevels(event.payload);
    });
  } catch (e) {
    console.warn('[audio] event listener tidak tersedia:', e);
  }

  try {
    state = await invoke('audio_state');
    emitState();
  } catch (e) {
    console.error('[audio] gagal ambil state awal:', e);
  }
  return state;
}

export function refreshAudioState() {
  return invoke('audio_state').then((next) => {
    state = next;
    emitState();
    return next;
  });
}

export function listAudioDevices() {
  return invoke('audio_devices');
}

export function setAudioOutput(device) {
  return invoke('audio_set_output', { device });
}

export function setAudioMonitor(device, enabled, volume) {
  return invoke('audio_set_monitor', { device, enabled, volume });
}

export function setAudioMic(device, enabled, gain) {
  return invoke('audio_set_mic', { device, enabled, gain });
}

export function setAudioMicPre(settings) {
  return invoke('audio_set_mic_pre', { settings });
}

export function listMicPresets() {
  return invoke('audio_mic_presets');
}

export function applyMicPreset(id) {
  return invoke('audio_apply_mic_preset', { id });
}

export function setAudioGain(bus, value) {
  return invoke('audio_set_gain', { bus, value });
}

export function setAudioMute(bus, muted) {
  return invoke('audio_set_mute', { bus, muted });
}

export function setAudioMode(mode) {
  return invoke('audio_set_mode', { mode });
}

export function setAudioBuffer(ms) {
  return invoke('audio_set_buffer', { ms });
}

export function playTestTone(target, freq = 440, durationMs = 3000) {
  return invoke('audio_test_tone', { target, freq, durationMs });
}

export function playSoundById(id) {
  return invoke('audio_play', { id });
}

export function stopSounds(id = null) {
  return invoke('audio_stop', { id });
}
