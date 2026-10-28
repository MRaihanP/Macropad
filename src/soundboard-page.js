// ==================== HALAMAN SOUNDBOARD ====================
//
// Library suara: pencarian, filter tag/favorit, warna, volume per suara,
// trim non-destruktif, preview, rename, dan delete. Semua data berasal dari
// Rust (sounds.json); halaman ini hanya memanggil command lewat soundboard.js.

import { t, registerRerender } from './i18n.js';
import { el, log } from './dom.js';
import { showPromptModal, clipUtf8 } from './ui-modal.js';
import {
  getSoundList,
  loadSoundList,
  onSoundListChanged,
  playSound,
  stopSound,
  pickSoundFiles,
  pickSoundFolder,
  renameSound,
  deleteSound,
  updateSoundMeta,
  importSoundData,
  probeSound,
} from './soundboard.js';

const COLORS = [
  '#4ecdc4',
  '#f2a154',
  '#e8604c',
  '#7c9cf2',
  '#c792ea',
  '#86d0a0',
  '#ff9f70',
  '#f7d154',
];

const state = {
  query: '',
  tag: '',
  favOnly: false,
  expanded: null,
  trim: null,
  busy: false,
};

const TRIM_MIN_MS = 50;

const volumeTimers = new Map();
let initialized = false;

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
  if (value >= 1024) return Math.round(value / 1024) + ' KB';
  return value + ' B';
}

function formatSeconds(ms) {
  const value = Number(ms) || 0;
  return (value / 1000).toFixed(2) + ' s';
}

function isTrimmed(entry) {
  return (entry.trimStartMs || 0) > 0 || (entry.trimEndMs || 0) > 0;
}

/// Rentang trim untuk ditampilkan di kartu. `trimEndMs == 0` berarti sampai
/// akhir file, jadi pakai durasi kalau sudah diketahui.
function trimRangeLabel(entry) {
  const start = entry.trimStartMs || 0;
  const end = entry.trimEndMs > 0 ? entry.trimEndMs : entry.durationMs || 0;
  return formatSeconds(start) + '–' + (end > 0 ? formatSeconds(end) : '…');
}

function findSound(id) {
  return getSoundList().find((sound) => sound.id === id);
}

function scheduleVolume(id, value) {
  const previous = volumeTimers.get(id);
  if (previous) clearTimeout(previous);
  volumeTimers.set(
    id,
    setTimeout(() => {
      volumeTimers.delete(id);
      persistVolume(id, value);
    }, 250)
  );
}

async function persistVolume(id, value) {
  try {
    const updated = await updateSoundMeta(id, { volume: value });
    const entry = findSound(id);
    if (entry) Object.assign(entry, updated);
  } catch (error) {
    log(t('sb.saveFailed', { error }), 'err');
    await loadSoundList();
  }
}

function flushVolume(id, value) {
  const pending = volumeTimers.get(id);
  if (pending) clearTimeout(pending);
  volumeTimers.delete(id);
  return persistVolume(id, value);
}

// ---- Render ----

function refreshTagFilter() {
  const select = el('sbTagFilter');
  if (!select) return;

  const tags = [...new Set(getSoundList().flatMap((sound) => sound.tags || []))].sort((a, b) =>
    a.localeCompare(b)
  );
  select.innerHTML = '';

  const all = document.createElement('option');
  all.value = '';
  all.textContent = t('sb.allTags');
  select.appendChild(all);

  for (const tag of tags) {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    select.appendChild(option);
  }

  if (state.tag && !tags.includes(state.tag)) state.tag = '';
  select.value = state.tag;
}

function matches(entry) {
  if (state.favOnly && !entry.favorite) return false;
  if (state.tag && !(entry.tags || []).includes(state.tag)) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  if (entry.name.toLowerCase().includes(query)) return true;
  return (entry.tags || []).some((tag) => tag.toLowerCase().includes(query));
}

function actionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small ' + className;
  button.textContent = label;
  button.onclick = onClick;
  return button;
}

function buildEditPanel(entry) {
  const panel = document.createElement('div');
  panel.className = 'sb-edit';

  const label = document.createElement('label');
  label.className = 'sb-edit-label';
  label.textContent = t('sb.tagsLabel');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sb-tag-input';
  input.value = (entry.tags || []).join(', ');
  input.placeholder = t('sb.tagsPlaceholder');
  input.maxLength = 240;
  label.appendChild(input);
  panel.appendChild(label);

  const colorRow = document.createElement('div');
  colorRow.className = 'sb-color-row';
  const colorLabel = document.createElement('span');
  colorLabel.className = 'sb-edit-label';
  colorLabel.textContent = t('sb.colorLabel');
  colorRow.appendChild(colorLabel);

  let selectedColor = entry.color || '';

  const swatches = document.createElement('div');
  swatches.className = 'sb-swatches';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'sb-swatch sb-swatch-clear';
  clear.textContent = '×';
  clear.title = t('sb.noColor');
  clear.setAttribute('aria-label', t('sb.noColor'));
  clear.onclick = () => {
    selectedColor = '';
    syncSwatches();
  };
  swatches.appendChild(clear);

  const syncSwatches = () => {
    for (const node of swatches.querySelectorAll('.sb-swatch')) {
      const value = node.dataset.color || '';
      const active = value === selectedColor;
      node.classList.toggle('on', active);
      node.setAttribute('aria-pressed', String(active));
    }
  };

  for (const color of COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'sb-swatch';
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.title = color;
    swatch.setAttribute('aria-label', color);
    swatch.onclick = () => {
      selectedColor = color;
      syncSwatches();
    };
    swatches.appendChild(swatch);
  }

  colorRow.appendChild(swatches);
  panel.appendChild(colorRow);

  const actions = document.createElement('div');
  actions.className = 'sb-edit-actions';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'small primary';
  save.textContent = t('sb.saveMeta');

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'small';
  cancel.textContent = t('sb.cancel');
  cancel.onclick = () => {
    state.expanded = null;
    render();
  };

  save.onclick = async () => {
    save.disabled = true;
    try {
      const tags = input.value.split(',').map((tag) => tag.trim()).filter(Boolean);
      const updated = await updateSoundMeta(entry.id, { tags, color: selectedColor });
      Object.assign(entry, updated);
      state.expanded = null;
      render();
      log(t('sb.metaSaved', { name: entry.name }), 'ok');
    } catch (error) {
      log(t('sb.saveFailed', { error }), 'err');
    } finally {
      save.disabled = false;
    }
  };

  actions.append(save, cancel);
  panel.appendChild(actions);

  syncSwatches();
  return panel;
}

/// Panel trim: pilih rentang dengan dua slider. Perubahan disimpan otomatis
/// saat slider dilepas; preview memutar hasil trim yang tersimpan. Decode
/// tetap dilakukan di backend, jadi slider hanya mengubah metadata.
function buildTrimPanel(entry) {
  const panel = document.createElement('div');
  panel.className = 'sb-trim';

  const duration = Math.max(0, Math.round(entry.durationMs || 0));
  if (duration <= 0) {
    const measuring = document.createElement('div');
    measuring.className = 'hint';
    measuring.textContent = t('sb.trimProbing');
    panel.appendChild(measuring);
    return panel;
  }

  const minGap = Math.min(TRIM_MIN_MS, Math.max(1, Math.floor(duration / 2)));
  let start = Math.min(Math.max(0, Math.round(entry.trimStartMs || 0)), duration - minGap);
  let end = entry.trimEndMs > 0 ? Math.min(Math.round(entry.trimEndMs), duration) : duration;
  if (end - start < minGap) end = Math.min(duration, start + minGap);
  if (end <= start) {
    start = Math.max(0, duration - minGap);
    end = duration;
  }

  let savedStart = Math.round(entry.trimStartMs || 0);
  let savedEnd = entry.trimEndMs > 0 ? Math.min(Math.round(entry.trimEndMs), duration) : duration;
  const dirty = () => start !== savedStart || end !== savedEnd;

  const bar = document.createElement('div');
  bar.className = 'sb-trim-bar';
  bar.setAttribute('aria-hidden', 'true');
  const selection = document.createElement('div');
  selection.className = 'sb-trim-sel';
  bar.appendChild(selection);

  const info = document.createElement('div');
  info.className = 'hint sb-trim-info';

  const makeRow = (labelText, min, max, value) => {
    const row = document.createElement('div');
    row.className = 'sb-trim-row';

    const label = document.createElement('span');
    label.className = 'sb-trim-label';
    label.textContent = labelText;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'sb-trim-slider';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = '10';
    slider.value = String(value);
    slider.setAttribute('aria-label', labelText);

    const readout = document.createElement('span');
    readout.className = 'sb-trim-value';

    row.append(label, slider, readout);
    return { row, slider, readout };
  };

  const startRow = makeRow(t('sb.trimStart'), 0, Math.max(0, end - minGap), start);
  const endRow = makeRow(t('sb.trimEnd'), Math.min(duration, start + minGap), duration, end);

  const actions = document.createElement('div');
  actions.className = 'sb-trim-actions';

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'small primary';
  preview.textContent = '▶ ' + t('sb.preview');

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'small';
  reset.textContent = t('sb.trimReset');

  const hint = document.createElement('span');
  hint.className = 'hint sb-trim-hint';
  hint.textContent = t('sb.trimHint');

  const paint = () => {
    startRow.slider.max = String(Math.max(0, end - minGap));
    endRow.slider.min = String(Math.min(duration, start + minGap));
    startRow.slider.value = String(start);
    endRow.slider.value = String(end);
    startRow.readout.textContent = formatSeconds(start);
    endRow.readout.textContent = formatSeconds(end);
    startRow.slider.setAttribute('aria-valuetext', formatSeconds(start));
    endRow.slider.setAttribute('aria-valuetext', formatSeconds(end));

    const left = (start / duration) * 100;
    const width = Math.max(0, ((end - start) / duration) * 100);
    selection.style.left = left + '%';
    selection.style.width = width + '%';

    info.textContent = t('sb.trimInfo', {
      total: formatSeconds(duration),
      length: formatSeconds(end - start),
    });
    reset.disabled = !dirty();
  };

  const applyServer = (updated) => {
    Object.assign(entry, updated);
    savedStart = Math.round(updated.trimStartMs || 0);
    savedEnd = updated.trimEndMs > 0 ? Math.round(updated.trimEndMs) : duration;
    start = savedStart;
    end = savedEnd;
    paint();
  };

  let queue = Promise.resolve();
  const commit = () => {
    queue = queue.then(async () => {
      if (!dirty()) return;
      try {
        const updated = await updateSoundMeta(entry.id, {
          trimStartMs: start,
          trimEndMs: end >= duration ? 0 : end,
        });
        applyServer(updated);
      } catch (error) {
        log(t('sb.saveFailed', { error }), 'err');
        start = savedStart;
        end = savedEnd;
        paint();
      }
    });
    return queue;
  };

  startRow.slider.addEventListener('input', () => {
    const maxStart = Math.max(0, end - minGap);
    start = Math.min(maxStart, Math.max(0, Number(startRow.slider.value) || 0));
    paint();
  });
  endRow.slider.addEventListener('input', () => {
    const minEnd = Math.min(duration, start + minGap);
    end = Math.min(duration, Math.max(minEnd, Number(endRow.slider.value) || 0));
    paint();
  });
  startRow.slider.addEventListener('change', commit);
  endRow.slider.addEventListener('change', commit);

  preview.onclick = async () => {
    await commit();
    await playSound(entry.id);
  };

  reset.onclick = () => {
    start = 0;
    end = duration;
    paint();
    commit();
  };

  actions.append(preview, reset, hint);
  panel.append(bar, startRow.row, endRow.row, info, actions);
  paint();
  return panel;
}

function buildCard(entry) {
  const card = document.createElement('article');
  card.className = 'sb-card';
  if (entry.color) card.style.setProperty('--sb-color', entry.color);

  const head = document.createElement('div');
  head.className = 'sb-card-head';

  const fav = document.createElement('button');
  fav.type = 'button';
  fav.className = 'sb-fav' + (entry.favorite ? ' on' : '');
  fav.textContent = '★';
  fav.title = t('sb.favorite');
  fav.setAttribute('aria-pressed', String(!!entry.favorite));
  fav.setAttribute('aria-label', t('sb.favorite'));
  fav.onclick = async () => {
    try {
      const updated = await updateSoundMeta(entry.id, { favorite: !entry.favorite });
      Object.assign(entry, updated);
      render();
    } catch (error) {
      log(t('sb.saveFailed', { error }), 'err');
    }
  };

  const title = document.createElement('div');
  title.className = 'sb-title';
  const name = document.createElement('div');
  name.className = 'sb-name';
  name.textContent = entry.name;
  name.title = entry.name;
  const meta = document.createElement('div');
  meta.className = 'sb-sub';
  const metaParts = [];
  if (entry.durationMs > 0) metaParts.push(formatSeconds(entry.durationMs));
  metaParts.push(formatSize(entry.size));
  meta.textContent = metaParts.join(' · ');
  if (isTrimmed(entry)) {
    const badge = document.createElement('span');
    badge.className = 'sb-trimmed';
    badge.textContent = '✂ ' + trimRangeLabel(entry);
    meta.append(document.createTextNode(' · '), badge);
  }
  title.append(name, meta);

  const dot = document.createElement('span');
  dot.className = 'sb-dot';
  dot.title = entry.color || t('sb.noColor');

  head.append(fav, title, dot);

  const tags = document.createElement('div');
  tags.className = 'sb-tags';
  if ((entry.tags || []).length > 0) {
    for (const tag of entry.tags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sb-tag';
      chip.textContent = tag;
      chip.title = t('sb.filterByTag', { tag });
      chip.onclick = () => {
        state.tag = tag;
        const select = el('sbTagFilter');
        if (select) select.value = tag;
        render();
      };
      tags.appendChild(chip);
    }
  } else {
    const empty = document.createElement('span');
    empty.className = 'sb-tags-empty';
    empty.textContent = t('sb.noTags');
    tags.appendChild(empty);
  }

  const controls = document.createElement('div');
  controls.className = 'sb-controls';

  const play = actionButton('▶', 'sb-play', async () => {
    card.classList.add('playing');
    setTimeout(() => card.classList.remove('playing'), 1200);
    await playSound(entry.id);
  });
  play.title = t('sb.preview');
  play.setAttribute('aria-label', t('sb.preview'));

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'sb-vol';
  slider.min = '0';
  slider.max = '200';
  slider.step = '5';
  slider.value = String(Math.round((entry.volume ?? 1) * 100));
  slider.title = t('sb.volumeHint');
  slider.setAttribute('aria-label', t('sb.volume'));

  const value = document.createElement('span');
  value.className = 'sb-vol-val';
  value.textContent = slider.value + '%';

  slider.addEventListener('input', () => {
    value.textContent = slider.value + '%';
    entry.volume = Number(slider.value) / 100;
    scheduleVolume(entry.id, entry.volume);
  });
  slider.addEventListener('change', () => {
    entry.volume = Number(slider.value) / 100;
    flushVolume(entry.id, entry.volume);
  });

  controls.append(play, slider, value);

  const actions = document.createElement('div');
  actions.className = 'sb-actions';

  const edit = actionButton(t('sb.editMeta'), 'sb-edit-btn', () => {
    state.expanded = state.expanded === entry.id ? null : entry.id;
    if (state.expanded) state.trim = null;
    render();
  });
  edit.setAttribute('aria-expanded', String(state.expanded === entry.id));

  const trim = actionButton('✂ ' + t('sb.trim'), 'sb-trim-btn', async () => {
    const open = state.trim !== entry.id;
    state.trim = open ? entry.id : null;
    if (open) state.expanded = null;
    render();
    if (!open || entry.durationMs > 0) return;
    // Library lama belum punya durasi; ukur sekali lalu simpan.
    try {
      const updated = await probeSound(entry.id);
      Object.assign(entry, updated);
      render();
    } catch (error) {
      log(t('sb.trimProbeFailed', { error }), 'err');
      state.trim = null;
      render();
    }
  });
  trim.setAttribute('aria-expanded', String(state.trim === entry.id));

  const rename = actionButton(t('sb.rename'), 'sb-rename-btn', async () => {
    const next = await showPromptModal(
      t('sb.renameTitle'),
      t('sb.renameLabel'),
      clipUtf8(entry.name)
    );
    if (next === null) return;
    const name = next.trim();
    if (!name || name === entry.name) return;
    const done = await renameSound(entry.id, clipUtf8(name));
    if (done) render();
  });

  const remove = actionButton(t('sb.delete'), 'sb-delete-btn', async () => {
    const removed = await deleteSound(entry.id);
    if (removed) render();
  });

  actions.append(edit, trim, rename, remove);

  card.append(head, tags, controls, actions);
  if (state.expanded === entry.id) card.appendChild(buildEditPanel(entry));
  if (state.trim === entry.id) card.appendChild(buildTrimPanel(entry));
  return card;
}

function render() {
  const grid = el('sbGrid');
  if (!grid) return;

  refreshTagFilter();

  const all = getSoundList();
  const list = all
    .filter(matches)
    .sort(
      (a, b) =>
        Number(!!b.favorite) - Number(!!a.favorite) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

  grid.innerHTML = '';
  for (const entry of list) grid.appendChild(buildCard(entry));

  const count = el('sbCount');
  if (count) {
    count.textContent = list.length === all.length
      ? t('sb.countAll', { n: all.length })
      : t('sb.countFiltered', { shown: list.length, total: all.length });
  }

  const empty = el('sbEmpty');
  if (empty) {
    empty.style.display = list.length === 0 ? 'block' : 'none';
    empty.textContent = all.length === 0 ? t('sb.empty') : t('sb.emptyFiltered');
  }
}

// ---- Import / drag-drop ----

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['sbImportFiles', 'sbImportFolder']) {
    const button = el(id);
    if (button) button.disabled = busy;
  }
}

async function runImport(kind) {
  if (state.busy) return;
  setBusy(true);
  try {
    const imported = kind === 'folder' ? await pickSoundFolder() : await pickSoundFiles();
    if (imported.length > 0) log(t('sb.imported', { n: imported.length }), 'ok');
    render();
  } catch (error) {
    log(t('sb.importFailed', { error }), 'err');
  } finally {
    setBusy(false);
  }
}

async function handleDrop(files) {
  if (state.busy) return;
  const picked = [...(files || [])];
  if (picked.length === 0) return;

  setBusy(true);
  try {
    const imported = await importSoundData(picked);
    if (imported.length > 0) {
      log(t('sb.imported', { n: imported.length }), 'ok');
    } else {
      log(t('sb.dropNothing'), 'err');
    }
    render();
  } catch (error) {
    log(t('sb.importFailed', { error }), 'err');
  } finally {
    setBusy(false);
  }
}

function bindDropZone() {
  const page = el('page-soundboard');
  if (!page) return;

  const setOver = (over) => {
    page.classList.toggle('dragover', over);
    const zone = el('sbDropZone');
    if (zone) zone.classList.toggle('dragover', over);
  };

  page.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(true);
  });
  page.addEventListener('dragleave', (event) => {
    if (event.target === page) setOver(false);
  });
  page.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    const files = event.dataTransfer && event.dataTransfer.files;
    await handleDrop(files);
  });
}

// ---- Init ----

function bindControls() {
  const search = el('sbSearch');
  if (search) {
    search.addEventListener('input', () => {
      state.query = search.value || '';
      render();
    });
  }

  const tagFilter = el('sbTagFilter');
  if (tagFilter) {
    tagFilter.addEventListener('change', () => {
      state.tag = tagFilter.value || '';
      render();
    });
  }

  const fav = el('sbFavFilter');
  if (fav) {
    fav.addEventListener('change', () => {
      state.favOnly = !!fav.checked;
      render();
    });
  }

  el('sbImportFiles')?.addEventListener('click', () => runImport('files'));
  el('sbImportFolder')?.addEventListener('click', () => runImport('folder'));
  el('sbRefresh')?.addEventListener('click', async () => {
    await loadSoundList();
    render();
  });
  el('sbStop')?.addEventListener('click', () => stopSound());

  bindDropZone();
}

export async function initSoundboardPage() {
  if (initialized) return;
  if (!el('page-soundboard')) return;
  initialized = true;

  bindControls();
  onSoundListChanged(() => render());
  registerRerender(() => render());

  document.addEventListener('page:change', (event) => {
    if (event.detail === 'soundboard') {
      loadSoundList().then(render).catch(() => {});
    }
  });

  await loadSoundList();
  render();
}
