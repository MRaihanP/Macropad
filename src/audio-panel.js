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

function $(id) {
  return document.getElementById(id);
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
  function applyMicPre() {
    const settings = {
      micBoost: Number($('micBoost')?.value || 200) / 100,
      noiseGateEnabled: !!$('noiseGateEnabled')?.checked,
      noiseGateThreshold: Number($('noiseGateThreshold')?.value || -45),
      noiseGateAttackMs: 5.0,
      noiseGateReleaseMs: 30.0,
      noiseGateRatio: 10.0,
      compressorEnabled: !!$('compressorEnabled')?.checked,
      compressorThreshold: -25.0,
      compressorRatio: Number($('compressorRatio')?.value || 4),
      compressorMakeupGain: 3.0,
      limiterEnabled: !!$('limiterEnabled')?.checked,
      limiterCeiling: -0.5,
      equalizerEnabled: !!$('equalizerEnabled')?.checked,
      equalizerLow: Number($('eqLow')?.value || 0),
      equalizerMid: Number($('eqMid')?.value || 0),
      equalizerHigh: Number($('eqHigh')?.value || 0),
    };
    withError(setAudioMicPre(settings));
    soundLog('mic filter applied', 'info');
  }

  // Slider: update label + auto-apply
  bindRangeLabel('micBoost', 'micBoostVal', (v) => (v / 100).toFixed(1) + '×');
  bindRangeLabel('noiseGateThreshold', 'noiseGateThresholdVal', (v) => v + ' dB');
  bindRangeLabel('compressorRatio', 'compressorRatioVal', (v) => v + ':1');
  bindRangeLabel('eqLow', 'eqLowVal', (v) => v + ' dB');
  bindRangeLabel('eqMid', 'eqMidVal', (v) => v + ' dB');
  bindRangeLabel('eqHigh', 'eqHighVal', (v) => v + ' dB');

  // Auto-apply on every slider/toggle change (debounced)
  const micPreControls = [
    'micBoost', 'noiseGateEnabled', 'noiseGateThreshold',
    'compressorEnabled', 'compressorRatio',
    'limiterEnabled', 'equalizerEnabled', 'eqLow', 'eqMid', 'eqHigh',
  ];
  for (const id of micPreControls) {
    const el = $(id);
    if (!el) continue;
    const event = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(event, () => debounce('micpre:' + id, applyMicPre, 150));
  }
}

// ---- Meter ----
const meterState = { mic: 0, sfx: 0, master: 0 };
let meterLoopStarted = false;

function paintMeter(id, value) {
  const node = $(id);
  if (!node) return;
  const shaped = Math.min(1, Math.sqrt(Math.max(0, value)));
  node.style.width = (shaped * 100).toFixed(1) + '%';
}

function startMeterLoop() {
  if (meterLoopStarted) return;
  meterLoopStarted = true;

  onAudioLevels((levels) => {
    meterState.mic = Math.max(levels.mic || 0, meterState.mic * 0.55);
    meterState.sfx = Math.max(levels.sfx || 0, meterState.sfx * 0.55);
    meterState.master = Math.max(levels.master || 0, meterState.master * 0.55);
  });

  const tick = () => {
    // Halaman Settings bisa tersembunyi; jangan buang CPU untuk meter yang
    // tidak terlihat.
    if ($('micMeter')?.offsetParent) {
      paintMeter('micMeter', meterState.mic);
      paintMeter('sfxMeter', meterState.sfx);
      paintMeter('masterMeter', meterState.master);
      paintMeter('monitorMeter', meterState.master);
      meterState.mic *= 0.9;
      meterState.sfx *= 0.9;
      meterState.master *= 0.9;
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
