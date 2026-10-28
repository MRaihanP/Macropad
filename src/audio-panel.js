// ==================== AUDIO PANEL (SETTINGS) ====================
//
// Panel ini hanya mengirim command ke audio engine Rust dan menampilkan
// snapshot/level yang dikirim balik. Tidak ada Web Audio di sini.

import { t, registerRerender } from './i18n.js';
import {
  initAudioClient,
  listAudioDevices,
  setAudioOutput,
  setAudioMonitor,
  setAudioMic,
  setAudioMicPre,
  setAudioGain,
  setAudioMute,
  setAudioMode,
  setAudioBuffer,
  playTestTone,
  onAudioState,
  onAudioLevels,
  refreshAudioState,
} from './audio-client.js';
import { soundLog } from './soundboard.js';

let devices = { inputs: [], outputs: [] };
let lastState = null;
let lastDeviceKey = '';
let activeSlider = null;
const debounceTimers = new Map();

// Kontrol mic pre yang punya nilai di UI. Field lain (ratio gate, threshold
// compressor, ceiling limiter) tetap disimpan di `micPre` supaya tidak hilang
// saat salah satu kontrol diubah.
const MIC_PRE_CONTROLS = [
  'micBoostDb',
  'humNotch',
  'noiseGateEnabled',
  'noiseGateThreshold',
  'noiseGateHold',
  'noiseGateAttack',
  'noiseGateRelease',
  'noiseGateRange',
  'noiseGateHysteresis',
  'compressorEnabled',
  'compressorRatio',
  'limiterEnabled',
  'equalizerEnabled',
  'eqLow',
  'eqMid',
  'eqHigh',
];

// Fallback sebelum snapshot pertama. Nilainya harus sama dengan
// MicSettings::default() di Rust.
const DEFAULT_MIC_PRE = {
  micBoostDb: 6,
  humNotchHz: 0,
  noiseGateEnabled: false,
  noiseGateThreshold: -45,
  noiseGateAttackMs: 8,
  noiseGateReleaseMs: 220,
  noiseGateHoldMs: 150,
  noiseGateHysteresisDb: 6,
  noiseGateRangeDb: -50,
  noiseGateRatio: 10,
  compressorEnabled: false,
  compressorThreshold: -25,
  compressorRatio: 4,
  compressorMakeupGain: 3,
  limiterEnabled: true,
  limiterCeiling: -0.5,
  limiterReleaseMs: 50,
  equalizerEnabled: false,
  equalizerLow: 0,
  equalizerMid: 0,
  equalizerHigh: 0,
};

let micPre = { ...DEFAULT_MIC_PRE };
let noiseLearn = null;

function $(id) {
  return document.getElementById(id);
}

function formatDb(value) {
  const number = Number(value) || 0;
  return (number > 0 ? '+' : '') + number.toFixed(1) + ' dB';
}

/// Label boost: dB dan faktor linear, mis. `+6.0 dB (2.0×)`.
function formatBoostLabel(value) {
  const db = Number(value) || 0;
  const linear = Math.pow(10, db / 20);
  return (db > 0 ? '+' : '') + db.toFixed(1) + ' dB (' + linear.toFixed(1) + '×)';
}

function formatMs(value) {
  return Math.round(Number(value) || 0) + ' ms';
}

/// Tulis nilai `micPre` ke kontrol. Dipakai saat snapshot pertama/periodik
/// datang; tidak memicu command.
function refreshMicLabels() {
  if ($('micBoostDbVal')) $('micBoostDbVal').textContent = formatBoostLabel(micPre.micBoostDb);
  if ($('noiseGateThresholdVal')) {
    $('noiseGateThresholdVal').textContent = Math.round(Number(micPre.noiseGateThreshold)) + ' dB';
  }
  if ($('noiseGateHoldVal')) $('noiseGateHoldVal').textContent = formatMs(micPre.noiseGateHoldMs);
  if ($('noiseGateAttackVal')) $('noiseGateAttackVal').textContent = formatMs(micPre.noiseGateAttackMs);
  if ($('noiseGateReleaseVal')) $('noiseGateReleaseVal').textContent = formatMs(micPre.noiseGateReleaseMs);
  if ($('noiseGateRangeVal')) $('noiseGateRangeVal').textContent = Math.round(Number(micPre.noiseGateRangeDb)) + ' dB';
  if ($('noiseGateHysteresisVal')) $('noiseGateHysteresisVal').textContent = Math.round(Number(micPre.noiseGateHysteresisDb)) + ' dB';
  if ($('compressorRatioVal')) {
    $('compressorRatioVal').textContent = Number(micPre.compressorRatio).toFixed(1) + ':1';
  }
  if ($('eqLowVal')) $('eqLowVal').textContent = formatDb(micPre.equalizerLow);
  if ($('eqMidVal')) $('eqMidVal').textContent = formatDb(micPre.equalizerMid);
  if ($('eqHighVal')) $('eqHighVal').textContent = formatDb(micPre.equalizerHigh);
}

function syncMicPre(pre) {
  if (!pre) return;
  micPre = { ...micPre, ...pre };

  const setSlider = (id, value) => {
    const node = $(id);
    if (node) node.value = String(value);
  };
  const setCheck = (id, value) => {
    const node = $(id);
    if (node) node.checked = !!value;
  };

  setSlider('micBoostDb', Number(micPre.micBoostDb ?? 6));
  setSlider('humNotch', Number(micPre.humNotchHz ?? 0));
  setSlider('noiseGateThreshold', Math.round(Number(micPre.noiseGateThreshold ?? -45)));
  setSlider('noiseGateHold', Number(micPre.noiseGateHoldMs ?? 150));
  setSlider('noiseGateAttack', Number(micPre.noiseGateAttackMs ?? 8));
  setSlider('noiseGateRelease', Number(micPre.noiseGateReleaseMs ?? 220));
  setSlider('noiseGateRange', Number(micPre.noiseGateRangeDb ?? -50));
  setSlider('noiseGateHysteresis', Number(micPre.noiseGateHysteresisDb ?? 6));
  setSlider('compressorRatio', Number(micPre.compressorRatio ?? 4));
  setSlider('eqLow', Number(micPre.equalizerLow ?? 0));
  setSlider('eqMid', Number(micPre.equalizerMid ?? 0));
  setSlider('eqHigh', Number(micPre.equalizerHigh ?? 0));
  setCheck('noiseGateEnabled', micPre.noiseGateEnabled);
  setCheck('compressorEnabled', micPre.compressorEnabled);
  setCheck('limiterEnabled', micPre.limiterEnabled);
  setCheck('equalizerEnabled', micPre.equalizerEnabled);

  refreshMicLabels();
  updateGateLed();
}

/// Baca kontrol UI lalu gabungkan ke `micPre`. Field yang tidak ada di UI
/// dipertahankan dari snapshot/preset terakhir.
function readMicPre() {
  const value = (id, fallback) => {
    const node = $(id);
    return node ? Number(node.value) : fallback;
  };
  micPre = {
    ...micPre,
    micBoostDb: value('micBoostDb', 6),
    humNotchHz: value('humNotch', 0),
    noiseGateEnabled: !!$('noiseGateEnabled')?.checked,
    noiseGateThreshold: value('noiseGateThreshold', -45),
    noiseGateHoldMs: value('noiseGateHold', 150),
    noiseGateAttackMs: value('noiseGateAttack', 8),
    noiseGateReleaseMs: value('noiseGateRelease', 220),
    noiseGateRangeDb: value('noiseGateRange', -50),
    noiseGateHysteresisDb: value('noiseGateHysteresis', 6),
    compressorEnabled: !!$('compressorEnabled')?.checked,
    compressorRatio: value('compressorRatio', 4),
    limiterEnabled: !!$('limiterEnabled')?.checked,
    equalizerEnabled: !!$('equalizerEnabled')?.checked,
    equalizerLow: value('eqLow', 0),
    equalizerMid: value('eqMid', 0),
    equalizerHigh: value('eqHigh', 0),
  };
  return micPre;
}

/// Kirim `micPre` ke engine. Dipakai oleh auto-apply dan tombol Learn.
function applyMicPreNow() {
  withError(setAudioMicPre(readMicPre()));
}

// ---- Learn noise floor ----
// Gate memakai envelope sidechain sebagai `gateInDb`. Selama 3 detik UI
// mengumpulkan ~90 frame (30 Hz), mengambil median, lalu menambah 9 dB
// headroom supaya noise tidak menyentuh ambang.
const LEARN_MS = 3000;
const LEARN_HEADROOM_DB = 9;

function startNoiseLearn() {
  if (noiseLearn) return;
  const button = $('noiseGateLearn');
  const status = $('noiseGateLearnStatus');
  noiseLearn = { samples: [], startedAt: performance.now() };
  if (button) button.disabled = true;
  if (status) {
    status.textContent = 'Mendengar 3 detik — diam…';
    status.classList.add('busy');
  }
}

function finishNoiseLearn() {
  const learn = noiseLearn;
  noiseLearn = null;
  const button = $('noiseGateLearn');
  const status = $('noiseGateLearnStatus');
  if (button) button.disabled = false;
  if (!learn) return;

  // Buang frame yang kena floor -120 (benar-benar sunyi).
  const samples = learn.samples.filter((db) => Number.isFinite(db) && db > -119.5);
  if (samples.length < 10) {
    if (status) {
      status.textContent = 'Gagal: tidak ada data';
      status.classList.remove('busy');
    }
    return;
  }

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const threshold = Math.max(-80, Math.min(-10, Math.round(median + LEARN_HEADROOM_DB)));

  if ($('noiseGateThreshold')) $('noiseGateThreshold').value = String(threshold);
  if ($('noiseGateEnabled')) $('noiseGateEnabled').checked = true;
  micPre.noiseGateThreshold = threshold;
  micPre.noiseGateEnabled = true;
  refreshMicLabels();
  updateGateLed();
  applyMicPreNow();

  if (status) {
    status.textContent = 'Threshold ' + threshold + ' dB';
    status.classList.remove('busy');
  }
}

function toast(message, type = 'error') {
  if (typeof window.toast === 'function') window.toast(message, type);
  else soundLog(message, type);
}

function debounce(key, fn, delay = 90) {
  const previous = debounceTimers.get(key);
  if (previous) clearTimeout(previous);
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      fn();
    }, delay)
  );
}

function setPercentLabel(id, value) {
  const node = $(id);
  if (node) node.textContent = Math.round(value * 100) + '%';
}

function fillSelect(select, items, current, autoLabel, input) {
  if (!select) return;
  select.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = autoLabel;
  select.appendChild(auto);

  let found = current === '' || current == null;
  for (const item of items) {
    if (item.is_input !== input) continue;
    const option = document.createElement('option');
    option.value = item.name;
    option.textContent = item.name + (item.is_default ? ' — default' : '');
    if (item.name === current) found = true;
    select.appendChild(option);
  }

  if (!found && current) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = current + ' — ' + t('audio.notFound');
    select.appendChild(option);
  }
  select.value = current || '';
}

function populateDevices() {
  fillSelect(
    $('audioOutputSelect'),
    devices.outputs,
    lastState?.cableDevice || '',
    t('audio.autoCable'),
    false
  );
  fillSelect(
    $('audioMonitorSelect'),
    devices.outputs,
    lastState?.monitorDevice || '',
    t('audio.defaultOutput'),
    false
  );
  fillSelect(
    $('audioMicSelect'),
    devices.inputs,
    lastState?.micDevice || '',
    t('audio.defaultInput'),
    true
  );
}

function chip(node, text, kind) {
  if (!node) return;
  node.textContent = text;
  node.className = 'audio-chip ' + kind;
}

function findStream(state, role) {
  return (state?.streams || []).find((stream) => stream.role === role);
}

function renderStatus(state) {
  const grid = $('audioStatusGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const roles = [
    ['cable', t('audio.roleCable')],
    ['monitor', t('audio.roleMonitor')],
    ['mic', t('audio.roleMic')],
  ];

  for (const [role, label] of roles) {
    const stream = findStream(state, role) || {
      role,
      device: '',
      sample_rate: 0,
      channels: 0,
      format: '',
      state: 'stopped',
      underruns: 0,
      error: null,
    };

    const row = document.createElement('div');
    row.className = 'audio-status-row';

    const roleNode = document.createElement('span');
    roleNode.className = 'audio-status-role';
    roleNode.textContent = label;

    const deviceNode = document.createElement('span');
    deviceNode.className = 'audio-status-device';
    deviceNode.textContent = stream.device || '—';
    deviceNode.title = stream.device || '';

    const metaNode = document.createElement('span');
    metaNode.className = 'audio-status-meta';
    metaNode.textContent = stream.state === 'running'
      ? `${stream.sample_rate} Hz · ${stream.channels}ch · ${stream.format}`
      : '—';

    const stateNode = document.createElement('span');
    const running = stream.state === 'running';
    stateNode.className = 'audio-status-state ' + (running ? 'ok' : 'err');
    stateNode.textContent = running ? t('audio.running') : t('audio.stopped');

    const underrunNode = document.createElement('span');
    underrunNode.className = 'audio-status-underrun';
    underrunNode.textContent = String(stream.underruns || 0);
    underrunNode.title = t('audio.underruns');

    row.append(roleNode, deviceNode, metaNode, stateNode, underrunNode);
    grid.appendChild(row);

    if (stream.error && !running) {
      const error = document.createElement('div');
      error.className = 'audio-status-error';
      error.textContent = stream.error;
      grid.appendChild(error);
    }
  }
}

function applyState(state) {
  if (!state) return;
  lastState = state;

  const outputSelect = $('audioOutputSelect');
  if (outputSelect && document.activeElement !== outputSelect) {
    outputSelect.value = state.cableDevice || '';
  }
  const monitorSelect = $('audioMonitorSelect');
  if (monitorSelect && document.activeElement !== monitorSelect) {
    monitorSelect.value = state.monitorDevice || '';
  }
  const micSelect = $('audioMicSelect');
  if (micSelect && document.activeElement !== micSelect) {
    micSelect.value = state.micDevice || '';
  }

  if ($('audioMonitorToggle')) $('audioMonitorToggle').checked = !!state.monitorEnabled;
  if ($('audioMicToggle')) $('audioMicToggle').checked = !!state.micEnabled;
  if ($('audioMicMute')) $('audioMicMute').checked = !!state.micMuted;
  if ($('audioSfxMute')) $('audioSfxMute').checked = !!state.sfxMuted;
  if ($('audioPlayMode')) $('audioPlayMode').value = state.mode || 'interrupt';

  if (activeSlider !== 'micGain' && $('micGain')) $('micGain').value = Math.round((state.micGain ?? 1) * 100);
  if (activeSlider !== 'sfxGain' && $('sfxGain')) $('sfxGain').value = Math.round((state.sfxGain ?? 1) * 100);
  if (activeSlider !== 'masterGain' && $('masterGain')) $('masterGain').value = Math.round((state.masterGain ?? 1) * 100);
  if (activeSlider !== 'monitorVolume' && $('monitorVolume')) {
    $('monitorVolume').value = Math.round((state.monitorVolume ?? 1) * 100);
  }

  setPercentLabel('micGainVal', (state.micGain ?? 1));
  setPercentLabel('sfxGainVal', (state.sfxGain ?? 1));
  setPercentLabel('masterGainVal', (state.masterGain ?? 1));
  setPercentLabel('monitorVolumeVal', (state.monitorVolume ?? 1));

  if ($('audioBufferSelect')) {
    const value = String(state.bufferMs ?? 0);
    const select = $('audioBufferSelect');
    if (![...select.options].some((option) => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value + ' ms';
      select.appendChild(option);
    }
    select.value = value;
  }

  // Jangan timpa kontrol mic yang sedang difokus/drag: snapshot periodik
  // datang tiap 2 detik dan bisa membalik nilai yang baru diubah.
  const micFocused = MIC_PRE_CONTROLS.some((id) => document.activeElement === $(id));
  if (!micFocused) syncMicPre(state.micPre);

  const cable = findStream(state, 'cable');
  if (!state.cablePresent) {
    chip($('cableChip'), t('audio.cableMissing'), 'err');
  } else if (cable?.state === 'running') {
    chip($('cableChip'), t('audio.cableOk'), 'ok');
  } else {
    chip($('cableChip'), t('audio.cableError'), 'warn');
  }

  const anyRunning = (state.streams || []).some((stream) => stream.state === 'running');
  chip(
    $('audioEngineChip'),
    anyRunning ? t('audio.engineActive') : t('audio.engineIdle'),
    anyRunning ? 'ok' : 'warn'
  );

  const monitor = findStream(state, 'monitor');
  const monitorChip = $('monitorChip');
  if (monitorChip) {
    if (!state.monitorEnabled) chip(monitorChip, t('audio.monitorOff'), 'muted');
    else if (monitor?.state === 'running') chip(monitorChip, t('audio.monitorOn'), 'ok');
    else chip(monitorChip, t('audio.monitorError'), 'warn');
  }

  renderStatus(state);
}

function sliderPercent(id) {
  const node = $(id);
  return node ? Number(node.value) / 100 : 0;
}

function bindSlider(id, labelId, bus) {
  const slider = $(id);
  if (!slider) return;
  slider.addEventListener('pointerdown', () => { activeSlider = id; });
  slider.addEventListener('pointerup', () => { activeSlider = null; });
  slider.addEventListener('blur', () => { activeSlider = null; });
  // Sinkronkan snapshot setelah user melepas slider (state gain tidak
  // dipancarkan lewat event supaya tidak membanjiri UI saat drag).
  slider.addEventListener('change', () => {
    activeSlider = null;
    refreshAudioState().catch(() => {});
  });
  slider.addEventListener('input', () => {
    activeSlider = id;
    setPercentLabel(labelId, Number(slider.value) / 100);
    debounce('gain:' + bus, () => {
      setAudioGain(bus, Number(slider.value) / 100).catch((error) => {
        toast(t('audio.commandFailed', { error }), 'error');
      });
    });
  });
}

/// Update label value real-time untuk slider non-persentase (mis. dB, ratio).
function bindRangeLabel(id, labelId, formatter) {
  const slider = $(id);
  const label = $(labelId);
  if (!slider || !label) return;
  label.textContent = formatter(Number(slider.value));
  slider.addEventListener('input', () => {
    label.textContent = formatter(Number(slider.value));
  });
}

function withError(promise, fallback = 'audio.commandFailed') {
  return promise.catch((error) => {
    toast(t(fallback, { error }), 'error');
    soundLog('audio command gagal: ' + error, 'error');
    refreshAudioState().catch(() => {});
  });
}

function bindControls() {
  const outputSelect = $('audioOutputSelect');
  if (outputSelect) {
    outputSelect.addEventListener('change', () => {
      withError(setAudioOutput(outputSelect.value));
    });
  }

  const monitorSelect = $('audioMonitorSelect');
  const monitorToggle = $('audioMonitorToggle');
  const applyMonitor = () => {
    withError(
      setAudioMonitor(
        monitorSelect?.value || '',
        !!monitorToggle?.checked,
        sliderPercent('monitorVolume')
      )
    );
  };
  monitorSelect?.addEventListener('change', applyMonitor);
  monitorToggle?.addEventListener('change', applyMonitor);

  const micSelect = $('audioMicSelect');
  const micToggle = $('audioMicToggle');
  const applyMic = () => {
    withError(
      setAudioMic(
        micSelect?.value || '',
        !!micToggle?.checked,
        sliderPercent('micGain')
      )
    );
  };
  micSelect?.addEventListener('change', applyMic);
  micToggle?.addEventListener('change', applyMic);

  const sfxMute = $('audioSfxMute');
  sfxMute?.addEventListener('change', () => {
    withError(setAudioMute('sfx', !!sfxMute.checked));
  });

  const micMute = $('audioMicMute');
  micMute?.addEventListener('change', () => {
    withError(setAudioMute('mic', !!micMute.checked));
  });

  const mode = $('audioPlayMode');
  mode?.addEventListener('change', () => {
    withError(setAudioMode(mode.value));
  });

  const buffer = $('audioBufferSelect');
  buffer?.addEventListener('change', () => {
    withError(setAudioBuffer(Number(buffer.value)));
  });

  $('btnTestToneCable')?.addEventListener('click', () => {
    withError(playTestTone('cable', 440, 3000));
    soundLog('test tone → CABLE (440 Hz, 3s)', 'info');
  });
  $('btnTestToneMonitor')?.addEventListener('click', () => {
    withError(playTestTone('monitor', 440, 3000));
    soundLog('test tone → monitor (440 Hz, 3s)', 'info');
  });
  $('btnTestToneBoth')?.addEventListener('click', () => {
    withError(playTestTone('both', 440, 3000));
    soundLog('test tone → CABLE + monitor (440 Hz, 3s)', 'info');
  });

  $('btnAudioClearLog')?.addEventListener('click', () => {
    const box = $('audioDebugLog');
    if (box) box.textContent = '';
  });

  $('btnAudioRefreshDevices')?.addEventListener('click', async () => {
    try {
      devices = (await listAudioDevices()) || { inputs: [], outputs: [] };
      if (!Array.isArray(devices.inputs)) devices.inputs = [];
      if (!Array.isArray(devices.outputs)) devices.outputs = [];
      lastDeviceKey = '';
      populateDevices();
      await refreshAudioState();
      soundLog('device list refreshed', 'info');
    } catch (error) {
      withError(Promise.reject(error));
    }
  });

  bindSlider('micGain', 'micGainVal', 'mic');
  bindSlider('sfxGain', 'sfxGainVal', 'sfx');
  bindSlider('masterGain', 'masterGainVal', 'master');
  bindSlider('monitorVolume', 'monitorVolumeVal', 'monitor');

  // ---- Mic Preprocessing Filter Controls (auto-apply on change) ----
  // Slider: update label + auto-apply
  bindRangeLabel('micBoostDb', 'micBoostDbVal', formatBoostLabel);
  bindRangeLabel('noiseGateThreshold', 'noiseGateThresholdVal', (v) => Math.round(v) + ' dB');
  bindRangeLabel('noiseGateHold', 'noiseGateHoldVal', formatMs);
  bindRangeLabel('noiseGateAttack', 'noiseGateAttackVal', formatMs);
  bindRangeLabel('noiseGateRelease', 'noiseGateReleaseVal', formatMs);
  bindRangeLabel('noiseGateRange', 'noiseGateRangeVal', (v) => Math.round(v) + ' dB');
  bindRangeLabel('noiseGateHysteresis', 'noiseGateHysteresisVal', (v) => Math.round(v) + ' dB');
  bindRangeLabel('compressorRatio', 'compressorRatioVal', (v) => Number(v).toFixed(1) + ':1');
  bindRangeLabel('eqLow', 'eqLowVal', formatDb);
  bindRangeLabel('eqMid', 'eqMidVal', formatDb);
  bindRangeLabel('eqHigh', 'eqHighVal', formatDb);

  // Auto-apply on every slider/toggle/select change (debounced)
  for (const id of MIC_PRE_CONTROLS) {
    const el = $(id);
    if (!el) continue;
    const event = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(event, () =>
      debounce('micpre:' + id, () => {
        applyMicPreNow();
        soundLog('mic filter applied', 'info');
      }, 150)
    );
  }

  $('noiseGateLearn')?.addEventListener('click', startNoiseLearn);
}

// ---- Meter ----
const meterState = { mic: 0, sfx: 0, master: 0, micInDb: -100, gateOpen: false, compGr: 0, limiterGr: 0 };
let meterLoopStarted = false;

function paintMeter(id, value) {
  const node = $(id);
  if (!node) return;
  const shaped = Math.min(1, Math.sqrt(Math.max(0, value)));
  node.style.width = (shaped * 100).toFixed(1) + '%';
}

/// Bar gain reduction (0..maxDb). Beda dengan level meter: tidak perlu
/// kurva sqrt karena rentangnya sudah kecil.
function paintGainReduction(id, value, maxDb) {
  const node = $(id);
  if (!node) return;
  const ratio = Math.min(1, Math.max(0, value / maxDb));
  node.style.width = (ratio * 100).toFixed(1) + '%';
}

function updateGateLed() {
  const led = $('gateLed');
  if (!led) return;
  const enabled = !!micPre?.noiseGateEnabled;
  led.classList.toggle('disabled', !enabled);
  led.classList.toggle('on', enabled && meterState.gateOpen);
}

function startMeterLoop() {
  if (meterLoopStarted) return;
  meterLoopStarted = true;

  onAudioLevels((levels) => {
    meterState.mic = Math.max(levels.mic || 0, meterState.mic * 0.55);
    meterState.sfx = Math.max(levels.sfx || 0, meterState.sfx * 0.55);
    meterState.master = Math.max(levels.master || 0, meterState.master * 0.55);
    if (typeof levels.micInDb === 'number') meterState.micInDb = levels.micInDb;
    meterState.gateOpen = !!levels.gateOpen;
    meterState.compGr = Math.max(levels.compGrDb || 0, meterState.compGr);
    meterState.limiterGr = Math.max(levels.limiterGrDb || 0, meterState.limiterGr);
    updateGateLed();

    if (noiseLearn) {
      const gateDb = Number(levels.gateInDb);
      if (Number.isFinite(gateDb)) noiseLearn.samples.push(gateDb);
      if (performance.now() - noiseLearn.startedAt >= LEARN_MS) finishNoiseLearn();
    }
  });

  const tick = () => {
    // Halaman Settings bisa tersembunyi; jangan buang CPU untuk meter yang
    // tidak terlihat.
    if ($('micMeter')?.offsetParent) {
      paintMeter('micMeter', meterState.mic);
      paintMeter('sfxMeter', meterState.sfx);
      paintMeter('masterMeter', meterState.master);
      paintMeter('monitorMeter', meterState.master);
      paintGainReduction('compGrMeter', meterState.compGr, 24);
      paintGainReduction('limiterGrMeter', meterState.limiterGr, 12);

      const inputDb = $('micInDb');
      if (inputDb) {
        inputDb.textContent =
          meterState.micInDb <= -99 ? '-∞ dB' : meterState.micInDb.toFixed(1) + ' dB';
      }

      meterState.mic *= 0.9;
      meterState.sfx *= 0.9;
      meterState.master *= 0.9;
      meterState.compGr *= 0.85;
      meterState.limiterGr *= 0.85;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function initAudioPanel() {
  await initAudioClient();
  try {
    devices = (await listAudioDevices()) || { inputs: [], outputs: [] };
    if (!Array.isArray(devices.inputs)) devices.inputs = [];
    if (!Array.isArray(devices.outputs)) devices.outputs = [];
  } catch (error) {
    devices = { inputs: [], outputs: [] };
    console.error('[audio] gagal enumerate device:', error);
  }

  populateDevices();
  bindControls();
  startMeterLoop();

  onAudioState((state) => {
    lastState = state;
    if (!document.getElementById('audioMicSelect')) return;

    // Jangan rebuild <option> saat user sedang membuka dropdown; status
    // periodik (2 dtk) tidak boleh menutup menu yang sedang dipakai.
    const key = [state?.cableDevice, state?.monitorDevice, state?.micDevice].join('|');
    const selectFocused = ['audioOutputSelect', 'audioMonitorSelect', 'audioMicSelect'].some(
      (id) => document.activeElement === document.getElementById(id)
    );
    if (!selectFocused && key !== lastDeviceKey) {
      lastDeviceKey = key;
      populateDevices();
    }
    applyState(state);
  });

  registerRerender(() => {
    populateDevices();
    if (lastState) applyState(lastState);
  });

  try {
    await refreshAudioState();
  } catch (error) {
    console.error('[audio] state awal gagal:', error);
  }
}
