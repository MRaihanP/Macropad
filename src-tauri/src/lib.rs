use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// Logging helper
pub fn log(msg: &str) {
    eprintln!("[LOG] {}", msg);
}
#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use windows::Win32::Foundation::{HWND, CloseHandle};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_NAME_WIN32,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IPersistFile, STGM};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::core::{PWSTR, PCWSTR, Interface};

// =================== BLE TRANSPORT ===================
mod ble;
use ble::{BleStats, BleTransport};

// =================== AUDIO ENGINE ===================
mod audio;
pub use audio::AudioEngine;
// Import command functions ke crate root agar #[tauri::command] macro-generated
// internals dapat di-resolve oleh generate_handler!.
use audio::{
    audio_devices, audio_play, audio_set_buffer, audio_set_gain, audio_set_mic, audio_set_mic_pre, audio_set_mode,
    audio_set_monitor, audio_set_mute, audio_set_output, audio_state, audio_stop, audio_test_tone,
};

// Codec frame protokol v2. Fase 1: sudah ada dan sudah diuji, tapi BELUM
// tersambung ke link BLE apa pun. Sengaja ditahan di sini supaya bisa diuji
// silang dengan firmware dan frontend tanpa perangkat.
pub mod frame;
// DeviceInformation dipakai di ble_worker untuk menyimpan hasil scan, sehingga
// connect() tidak perlu scan ulang. Objek WinRT ini tidak Send, jadi hanya
// boleh hidup di thread worker itu.
use windows::Devices::Enumeration::DeviceInformation;

// Trait transport untuk medium yang bisa dipakai dari thread mana
// pun (mis. USB serial). BLE TIDAK mengimplementasikan trait ini:
// objek WinRT-nya tidak bersifat Send, sehingga BleTransport
// dimiliki oleh satu thread worker khusus (lihat BleRequest).
pub trait Transport: Send + Sync {
    fn begin(&mut self) -> Result<bool, String>;
    fn is_connected(&self) -> bool;
    fn available(&self) -> i32;
    fn read(&mut self) -> i32;
    fn write(&mut self, data: &[u8]) -> Result<usize, String>;
    fn flush(&mut self);
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct AppEntry {
    name: String,
    id: String, // id = AppID, path .lnk (fallback scan), atau path .exe/.lnk (entri manual)
    #[serde(default)]
    custom: bool, // true = ditambahkan manual oleh user, tidak ikut terhapus saat rescan
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct AppData { apps: Vec<AppEntry>, custom: Vec<AppEntry>, scanned_at: u64, ttl_days: u32, consent: bool, autostart_init: bool }
impl Default for AppData {
    fn default() -> Self { Self { apps: Vec::new(), custom: Vec::new(), scanned_at: 0, ttl_days: 7, consent: false, autostart_init: false } }
}

#[derive(Serialize)]
struct AppsView { names: Vec<String>, custom: Vec<String>, scanned_at: u64, ttl_days: u32, consent: bool, stale: bool }

#[derive(Serialize)]
struct PickedExe { name: String, path: String }

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn data_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("apps.json"))
}

// load_data/save_data bisa dipanggil dari beberapa thread berbeda sekaligus
// (launch_app menulis d.apps sementara apps_rescan juga menulis). Tanpa lock, satu
// penulisan bisa menimpa hasil yang lain.
static DATA_LOCK: Mutex<()> = Mutex::new(());

fn load_data(app: &tauri::AppHandle) -> AppData {
    let _g = DATA_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match data_path(app) {
        Some(p) => match std::fs::read_to_string(&p) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(v) => v,
                Err(e) => {
                    // Dulu file korup diam-diam diganti default lalu ditimpa, jadi
                    // seluruh daftar aplikasi kustom hilang tanpa jejak.
                    eprintln!("[apps.json] rusak ({}), dicadangkan sebagai apps.json.corrupt", e);
                    let _ = std::fs::rename(&p, p.with_extension("json.corrupt"));
                    AppData::default()
                }
            },
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("[apps.json] gagal dibaca: {}", e);
                AppData::default()
            }
            Err(_) => AppData::default(),
        },
        None => AppData::default(),
    }
}

fn save_data(app: &tauri::AppHandle, d: &AppData) -> Result<(), String> {
    let _g = DATA_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let p = data_path(app).ok_or("path app data tidak tersedia")?;
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let s = serde_json::to_string(d).map_err(|e| e.to_string())?;
    // Tulis ke file sementara lalu rename: rename bersifat atomik di NTFS, jadi
    // apps.json tidak pernah terlihat setengah tertulis (power loss di tengah tulis).
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}
fn view_of(d: &AppData) -> AppsView {
    let age = now_secs().saturating_sub(d.scanned_at);
    // entri manual ditaruh dulu supaya menang saat namanya sama dengan hasil scan (sort stabil + dedup)
    let mut all: Vec<&AppEntry> = d.custom.iter().chain(d.apps.iter()).collect();
    all.sort_by_key(|a| a.name.to_lowercase());
    all.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    AppsView {
        names: all.iter().map(|a| a.name.clone()).collect(),
        custom: d.custom.iter().map(|a| a.name.clone()).collect(),
        scanned_at: d.scanned_at,
        ttl_days: d.ttl_days,
        consent: d.consent,
        stale: d.apps.is_empty() || age > (d.ttl_days as u64) * 86400,
    }
}

// Potong string maksimal `max` byte UTF-8 tanpa memotong di tengah karakter (batas nama di firmware = 47 byte)
fn clip_utf8(s: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if out.len() + ch.len_utf8() > max { break; }
        out.push(ch);
    }
    out
}

fn collect_lnk(dir: &Path, out: &mut Vec<AppEntry>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_lnk(&path, out);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("lnk"))
                .unwrap_or(false)
            {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    out.push(AppEntry { name: stem.to_string(), id: path.to_string_lossy().to_string(), custom: false });
                }
            }
        }
    }
}

// Cadangan kalau PowerShell gagal: baca shortcut Start Menu langsung
fn scan_lnk_fallback() -> Vec<AppEntry> {
    let mut out = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(a) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    for r in roots { collect_lnk(&r, &mut out); }
    out
}

fn scan_start_apps() -> Vec<AppEntry> {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-StartApps | ForEach-Object { $_.Name + [char]9 + $_.AppID }",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: jangan munculkan jendela console

    let mut apps: Vec<AppEntry> = match cmd.output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| {
                let l = l.trim().trim_start_matches('\u{feff}');
                let (name, id) = l.split_once('\t')?;
                let (name, id) = (name.trim(), id.trim());
                if name.is_empty() || id.is_empty() {
                    None
                } else {
                    Some(AppEntry { name: name.to_string(), id: id.to_string(), custom: false })
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    if apps.is_empty() { apps = scan_lnk_fallback(); }
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    apps
}

fn find_app(d: &AppData, name: &str) -> Result<AppEntry, String> {
    let n = name.trim().to_lowercase();
    if n.is_empty() { return Err("Nama aplikasi kosong".into()); }
    let all = || d.custom.iter().chain(d.apps.iter());
    // Cocokkan persis dulu.
    if let Some(a) = all().find(|a| a.name.to_lowercase() == n) { return Ok(a.clone()); }
    // Nama dari firmware bisa terpotong (batas 47 karakter), jadi cocokkan juga
    // awalannya. Dua syarat menjaga agar ini tidak jadi amplifier:
    //   1. prefix minimal 4 karakter - "sl" akan cocok dengan Slack, Spotify,
    //      Slackmate, dan banyak lagi;
    //   2. prefix harus unik - kalau lebih dari satu aplikasi cocok, jangan menebak
    //      diam-diam, karena perangkat yang sekadar mengirim baris acak akan membuat
    //      PC menjalankan program yang tidak pernah dipilih user.
    if n.chars().count() >= 4 {
        let hits: Vec<&AppEntry> = all().filter(|a| a.name.to_lowercase().starts_with(&n)).collect();
        if hits.len() == 1 { return Ok(hits[0].clone()); }
        if hits.len() > 1 {
            let names: Vec<&str> = hits.iter().take(4).map(|a| a.name.as_str()).collect();
            return Err(format!(
                "Nama \"{}\" tidak unik: cocok dengan {} aplikasi ({}). Pilih ulang di app.",
                name, hits.len(), names.join(", ")
            ));
        }
    }
    Err(format!("Aplikasi tidak ditemukan: {}", name))
}

fn launch_impl(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    let mut data = load_data(app);
    let mut found = find_app(&data, name);
    if found.is_err() && data.consent {
        // mungkin aplikasi baru diinstal: scan ulang sekali lalu coba lagi
        data.apps = scan_start_apps();
        data.scanned_at = now_secs();
        if let Err(e) = save_data(app, &data) { eprintln!("[apps] simpan gagal: {}", e); }
        found = find_app(&data, name);
    }
    let entry = found.map_err(|e| {
        if e.contains("tidak ditemukan") {
            format!("{} (buka app, pilih aplikasi lagi dan Scan ulang)", e)
        } else { e }
    })?;
    let target = if entry.custom {
        if !Path::new(&entry.id).exists() {
            return Err(format!("File tidak ditemukan: {} (mungkin dipindah atau disk belum terpasang)", entry.id));
        }
        entry.id.clone() // explorer.exe membuka .exe/.lnk langsung; UAC tetap muncul kalau app butuh admin
    } else if entry.id.to_lowercase().ends_with(".lnk") {
        entry.id.clone()
    } else {
        format!("shell:AppsFolder\\{}", entry.id)
    };
    Command::new("explorer.exe").arg(target).spawn().map_err(|e| e.to_string())?;
    Ok(entry.name)
}

// ==================== DETEKSI WINDOW AKTIF ====================
// async: dipoll sering oleh frontend; jangan jalan di main thread
#[tauri::command]
async fn get_foreground_exe() -> Option<String> {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() { return None; }
        let mut pid: u32 = 0;
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 { return None; }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len: u32 = buf.len() as u32;
        let pwstr = PWSTR(buf.as_mut_ptr());
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, pwstr, &mut len);
        let _ = CloseHandle(handle);
        if ok.is_err() { return None; }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        Path::new(&path).file_name().map(|f| f.to_string_lossy().to_string())
    }
}

// ==================== RESOLVE .lnk -> NAMA EXE ASLI ====================
fn resolve_lnk_target(lnk_path: &str) -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        let wide: Vec<u16> = lnk_path.encode_utf16().chain(std::iter::once(0)).collect();
        persist_file.Load(PCWSTR(wide.as_ptr()), STGM(0)).ok()?;
        let mut buf = [0u16; 512];
        let mut find_data = WIN32_FIND_DATAW::default();
        shell_link.GetPath(&mut buf, &mut find_data, 0).ok()?;
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let target = String::from_utf16_lossy(&buf[..end]);
        if target.is_empty() { return None; }
        Path::new(&target).file_name().map(|f| f.to_string_lossy().to_string())
    }
}

// Picker KHUSUS untuk binding preset (bukan app-launch) — cuma scan .lnk
// (skip UWP sesuai keputusan), tiap entry langsung bawa nama exe asli hasil resolve,
// supaya user bisa pilih tanpa app-nya pernah dibuka.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BindableApp { name: String, exe_name: String }

#[tauri::command]
async fn scan_bindable_apps() -> Vec<BindableApp> {
    tauri::async_runtime::spawn_blocking(|| {
        let lnk_entries = scan_lnk_fallback(); // sudah ada dari fitur App Launch
        lnk_entries
            .into_iter()
            .filter_map(|e| resolve_lnk_target(&e.id).map(|exe| BindableApp { name: e.name, exe_name: exe }))
            .collect()
    })
    .await
    .unwrap_or_default()
}

// ==================== PENYIMPANAN PRESET ====================
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PresetKeyAction {
    #[serde(rename = "type")]
    action_type: u8,
    value: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PresetLayer {
    name: String,
    keys: Vec<Vec<PresetKeyAction>>, // [row][col]
    enc_cw: Vec<PresetKeyAction>,    // satu per index knob
    enc_ccw: Vec<PresetKeyAction>,
    enc_btn: Vec<PresetKeyAction>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Preset {
    id: String,
    name: String,
    exe_name: String,
    enabled: bool,
    layers: Vec<PresetLayer>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PresetsFile {
    master_enabled: bool,
    presets: Vec<Preset>,
}

fn presets_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("presets.json"))
}

#[tauri::command]
fn presets_get(app: tauri::AppHandle) -> PresetsFile {
    presets_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn presets_save(app: tauri::AppHandle, data: PresetsFile) -> Result<(), String> {
    let p = presets_path(&app).ok_or("Gagal menentukan path data")?;
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let s = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    // Tulis atomik lewat file sementara + rename. Versi lama menulis langsung ke
    // presets.json, jadi power loss di tengah menulis meninggalkan file terpotong
    // yang berikutnya diam-diam dibaca sebagai default - semua preset hilang.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn apps_get(app: tauri::AppHandle) -> AppsView { view_of(&load_data(&app)) }

#[tauri::command]
fn apps_set_consent(app: tauri::AppHandle, value: bool) {
    let mut d = load_data(&app);
    d.consent = value;
    if let Err(e) = save_data(&app, &d) { eprintln!("[apps] simpan gagal: {}", e); }
}

#[tauri::command]
fn apps_set_ttl(app: tauri::AppHandle, days: u32) {
    let mut d = load_data(&app);
    d.ttl_days = days.max(1);
    if let Err(e) = save_data(&app, &d) { eprintln!("[apps] simpan gagal: {}", e); }
}

#[tauri::command]
async fn apps_rescan(app: tauri::AppHandle) -> Result<AppsView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = load_data(&app);
        d.apps = scan_start_apps();
        d.scanned_at = now_secs();
        if let Err(e) = save_data(&app, &d) { eprintln!("[apps] simpan gagal: {}", e); }
        view_of(&d)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn apps_pick_exe(app: tauri::AppHandle) -> Result<Option<PickedExe>, String> {
    // dialog blocking harus jalan di thread terpisah, bukan main thread
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<PickedExe>, String> {
        let picked = app
            .dialog()
            .file()
            .add_filter("Aplikasi (.exe, .lnk)", &["exe", "lnk"])
            .blocking_pick_file();
        let Some(fp) = picked else { return Ok(None) };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("App").to_string();
        Ok(Some(PickedExe { name, path: path.to_string_lossy().to_string() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn apps_add_custom(app: tauri::AppHandle, name: String, path: String) -> Result<(), String> {
    let name = clip_utf8(name.trim(), 47);
    if name.is_empty() { return Err("Nama tidak boleh kosong".into()); }
    let p = Path::new(&path);
    let ext_ok = p.extension().and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false);
    if !p.is_file() || !ext_ok { return Err("File harus .exe atau .lnk yang ada".into()); }
    let mut d = load_data(&app);
    d.custom.retain(|a| !a.name.eq_ignore_ascii_case(&name)); // nama sama = timpa
    d.custom.push(AppEntry { name, id: path, custom: true });
    if let Err(e) = save_data(&app, &d) { eprintln!("[apps] simpan gagal: {}", e); }
    Ok(())
}

#[tauri::command]
fn apps_remove_custom(app: tauri::AppHandle, name: String) {
    let mut d = load_data(&app);
    d.custom.retain(|a| !a.name.eq_ignore_ascii_case(&name));
    if let Err(e) = save_data(&app, &d) { eprintln!("[apps] simpan gagal: {}", e); }
}

#[tauri::command]
async fn launch_app(app: tauri::AppHandle, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch_impl(&app, &name))
        .await
        .map_err(|e| e.to_string())?
}

// ==================== SOUND BOARD ====================
// Soundboard: file audio disimpan di app_data_dir/sounds/ + metadata di
// sounds.json. Frontend baca file sebagai bytes via soundboard_read, decode
// & putar lewat Web Audio API (output ke system default audio device).
//
// Trigger: firmware kirim EVT:APP:SOUND:<id>, protocol-parser arahkan ke
// playSound(). Firmware tidak perlu tahu tentang soundboard (pakai type APP).

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SoundEntry {
    id: String,
    name: String,
    rel_path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    duration_ms: u32,
    /// Volume per suara (1.0 = 100%).
    #[serde(default = "default_sound_volume")]
    volume: f32,
    #[serde(default)]
    trim_start_ms: u32,
    #[serde(default)]
    trim_end_ms: u32,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    mode: Option<String>,
}

fn default_sound_volume() -> f32 {
    1.0
}

/// Patch metadata dari UI. Field yang tidak dikirim tidak diubah.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SoundMetaPatch {
    volume: Option<f32>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
    /// String kosong = hapus warna.
    color: Option<String>,
    /// Trim non-destruktif dalam milidetik. `0/0` = tanpa trim; akhir 0 =
    /// sampai akhir file.
    trim_start_ms: Option<u32>,
    trim_end_ms: Option<u32>,
}

/// File yang dikirim frontend lewat drag/drop (path asli tidak tersedia di
/// WebView2 saat drag-drop native Tauri dimatikan).
#[derive(Deserialize)]
struct ImportFileData {
    name: String,
    data: Vec<u8>,
}

const SOUND_TAG_MAX: usize = 8;
const SOUND_TAG_LEN: usize = 24;

/// Rapikan tag: trim, buang '#' di depan, batasi panjang/jumlah, dedupe
/// case-insensitive supaya "Meme" dan "meme" tidak tampil dua kali.
fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let tag = raw.trim().trim_start_matches('#').trim();
        if tag.is_empty() {
            continue;
        }
        let tag = clip_utf8(tag, SOUND_TAG_LEN).trim().to_string();
        if tag.is_empty() || out.iter().any(|existing| existing.eq_ignore_ascii_case(&tag)) {
            continue;
        }
        out.push(tag);
        if out.len() >= SOUND_TAG_MAX {
            break;
        }
    }
    out
}

/// Warna disimpan sebagai `#rrggbb`. String kosong berarti tanpa warna.
fn normalize_color(value: &str) -> Result<Option<String>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let hex = value.trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(Some(format!("#{}", hex.to_ascii_lowercase())))
    } else {
        Err(format!("warna tidak valid: {value} (pakai format #rrggbb)"))
    }
}

/// Validasi trim terhadap durasi yang diketahui. Nilai melewati durasi
/// dipotong, dan pemilihan seluruh file dinormalkan menjadi `0/0` (tanpa trim)
/// supaya kalau file diganti tidak menyisakan rentang yang salah.
fn normalize_trim(start_ms: u32, end_ms: u32, duration_ms: u32) -> Result<(u32, u32), String> {
    let start = if duration_ms > 0 {
        start_ms.min(duration_ms)
    } else {
        start_ms
    };
    let mut end = if duration_ms > 0 {
        end_ms.min(duration_ms)
    } else {
        end_ms
    };

    // end == 0 berarti "sampai akhir", jadi hanya nilai eksplisit yang diuji.
    if end > 0 && end <= start {
        return Err(format!(
            "trim tidak valid: akhir ({end} ms) harus setelah awal ({start} ms)"
        ));
    }
    if end == 0 && duration_ms > 0 && start >= duration_ms {
        return Err(format!(
            "trim tidak valid: awal ({start} ms) harus sebelum akhir ({duration_ms} ms)"
        ));
    }
    if start == 0 && duration_ms > 0 && end >= duration_ms {
        end = 0;
    }
    Ok((start, end))
}


#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct SoundData { sounds: Vec<SoundEntry> }

#[derive(Serialize, Clone)]
struct SoundView { sounds: Vec<SoundEntry> }

#[derive(Serialize)]
struct SoundBytes { id: String, data: Vec<u8> }

fn sounds_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sounds.json"))
}

fn sounds_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sounds"))
}

fn load_sounds(app: &tauri::AppHandle) -> SoundData {
    match sounds_path(app) {
        Some(p) => match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => SoundData::default(),
        },
        None => SoundData::default(),
    }
}

fn save_sounds(app: &tauri::AppHandle, d: &SoundData) -> Result<(), String> {
    let p = sounds_path(app).ok_or("path app data tidak tersedia")?;
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let s = serde_json::to_string(d).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Nama suara unik (dipakai juga sebagai id) supaya dua file dengan stem sama
/// tidak saling menimpa.
fn unique_sound_name(existing: &SoundData, stem: &str) -> String {
    let mut name = stem.to_string();
    let mut counter = 1;
    while existing.sounds.iter().any(|s| s.name == name) {
        if counter > 999 {
            break;
        }
        name = format!("{}_{}", stem, counter);
        counter += 1;
    }
    name
}

/// Panjang maksimum id sound yang didukung firmware.
/// Firmware memotong sound id yang dikirim via EVT:APP:SOUND:<id>,
/// jadi kita perlu memastikan id tidak melebihi ini saat import.
const MAX_SOUND_ID_LEN: usize = 32;

/// Path relatif unik di folder sounds. File yang namanya sama diberi akhiran
/// angka, bukan ditimpa.
fn unique_rel_path(dir: &Path, stem: &str, ext: &str) -> (String, PathBuf) {
    let mut rel = format!("{}.{}", stem, ext);
    let mut dest = dir.join(&rel);
    let mut counter = 1;
    while dest.exists() {
        rel = format!("{}_{}.{}", stem, counter, ext);
        dest = dir.join(&rel);
        counter += 1;
    }
    (rel, dest)
}

fn new_sound_entry(name: String, rel_path: String, size: u64, duration_ms: u32) -> SoundEntry {
    // id = rel_path tanpa extension — deterministik, persisten, tidak berubah
    // saat user rename atau ada collision nama di library.
    let id = rel_path.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(rel_path.clone());
    SoundEntry {
        id,
        name,
        rel_path,
        size,
        duration_ms,
        volume: 1.0,
        trim_start_ms: 0,
        trim_end_ms: 0,
        tags: Vec::new(),
        favorite: false,
        color: None,
        mode: None,
    }
}

/// Durasi untuk ditampilkan dan dipakai UI trim. Kegagalan probe tidak
/// menggagalkan import - entry tetap masuk dengan durasi 0 dan bisa di-probe
/// ulang saat panel trim dibuka.
fn probe_duration(path: &Path) -> u32 {
    match crate::audio::decode::probe_duration_ms(path) {
        Ok(ms) => ms,
        Err(err) => {
            eprintln!("[soundboard] gagal baca durasi {}: {}", path.display(), err);
            0
        }
    }
}

fn import_sound_file(app: &tauri::AppHandle, src: &Path) -> Result<SoundEntry, String> {
    let dir = sounds_dir(app).ok_or("gagal dapatkan folder sounds")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("sound");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("wav");
    // Potong stem agar id yang dihasilkan (dari rel_path) tidak melebihi
    // batas panjang firmware. unique_rel_path akan menambah counter jika collision.
    let stem = &stem[..stem.char_indices().nth(MAX_SOUND_ID_LEN).map_or(stem.len(), |(i, _)| i)];
    let (rel, dest) = unique_rel_path(&dir, stem, ext);
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let existing = load_sounds(app);
    let name = unique_sound_name(&existing, stem);
    let duration_ms = probe_duration(&dest);
    Ok(new_sound_entry(name, rel, size, duration_ms))
}

const AUDIO_EXTS: &[&str] = &["wav", "mp3", "ogg", "m4a", "flac", "aiff", "aif"];

fn collect_audio(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_audio(&path, out);
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if AUDIO_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                    out.push(path);
                }
            }
        }
    }
}

#[tauri::command]
fn soundboard_list(app: tauri::AppHandle) -> SoundView {
    SoundView { sounds: load_sounds(&app).sounds }
}

/// Ukur durasi file lalu simpan ke metadata. Dipakai library lama yang belum
/// punya `durationMs` dan saat panel trim dibuka. Trim lama ikut dirapikan
/// kalau ternyata melewati durasi sebenarnya.
#[tauri::command]
async fn soundboard_probe(app: tauri::AppHandle, id: String) -> Result<SoundEntry, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SoundEntry, String> {
        let dir = sounds_dir(&app).ok_or("gagal dapatkan folder sounds")?;
        let mut data = load_sounds(&app);

        let duration = {
            let entry = data
                .sounds
                .iter()
                .find(|sound| sound.id == id)
                .ok_or_else(|| format!("suara \"{id}\" tidak ditemukan"))?;
            let path = dir.join(&entry.rel_path);
            crate::audio::decode::probe_duration_ms(&path)?
        };

        let entry = data
            .sounds
            .iter_mut()
            .find(|sound| sound.id == id)
            .ok_or_else(|| format!("suara \"{id}\" tidak ditemukan"))?;
        entry.duration_ms = duration;
        let (start, end) =
            normalize_trim(entry.trim_start_ms, entry.trim_end_ms, duration).unwrap_or((0, 0));
        entry.trim_start_ms = start;
        entry.trim_end_ms = end;

        let updated = entry.clone();
        save_sounds(&app, &data)?;
        crate::audio::decode::invalidate(&id);
        Ok(updated)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Simpan metadata library (volume, tag, favorit, warna, trim). Perubahan
/// volume/trim meng-invalidate cache decode karena nilai itu dipanggang saat
/// decode (`Clip.gain` dan rentang sample).
#[tauri::command]
fn soundboard_update_meta(
    app: tauri::AppHandle,
    id: String,
    patch: SoundMetaPatch,
) -> Result<SoundEntry, String> {
    let mut data = load_sounds(&app);
    let entry = data
        .sounds
        .iter_mut()
        .find(|sound| sound.id == id)
        .ok_or_else(|| format!("suara \"{id}\" tidak ditemukan"))?;

    let _volume_changed = patch.volume.is_some();
    if let Some(volume) = patch.volume {
        if !volume.is_finite() {
            return Err("volume tidak valid".into());
        }
        entry.volume = volume.clamp(0.0, 4.0);
    }
    let trim_changed = patch.trim_start_ms.is_some() || patch.trim_end_ms.is_some();
    if trim_changed {
        let start = patch.trim_start_ms.unwrap_or(entry.trim_start_ms);
        let end = patch.trim_end_ms.unwrap_or(entry.trim_end_ms);
        let (start, end) = normalize_trim(start, end, entry.duration_ms)?;
        entry.trim_start_ms = start;
        entry.trim_end_ms = end;
    }
    if let Some(tags) = patch.tags {
        entry.tags = normalize_tags(tags);
    }
    if let Some(favorite) = patch.favorite {
        entry.favorite = favorite;
    }
    if let Some(color) = patch.color {
        entry.color = normalize_color(&color)?;
    }
    let updated = entry.clone();

    save_sounds(&app, &data)?;
    // Gain diterapkan di play-time (audio_play membaca entry.volume & meneruskan
    // ke mixer), jadi mengubah volume tidak memerlukan invalidate cache clip.
    // Hanya trim yang perlu invalidate karena memengaruhi sample hasil decode.
    if trim_changed {
        crate::audio::decode::invalidate(&id);
    }
    Ok(updated)
}

/// Import file yang di-drop ke webview. WebView2 tidak memberi path asli saat
/// drag-drop native Tauri dimatikan, jadi isi file dikirim sebagai bytes.
#[tauri::command]
async fn soundboard_import_data(
    app: tauri::AppHandle,
    files: Vec<ImportFileData>,
) -> Result<Vec<SoundEntry>, String> {
    const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SoundEntry>, String> {
        let dir = sounds_dir(&app).ok_or("gagal dapatkan folder sounds")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut data = load_sounds(&app);
        let mut imported = Vec::new();

        for file in files {
            if file.data.is_empty() {
                continue;
            }
            if file.data.len() > MAX_FILE_BYTES {
                eprintln!("[soundboard] lewati {}: file terlalu besar", file.name);
                continue;
            }
            let src = Path::new(&file.name);
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("sound");
            let stem = &stem[..stem.char_indices().nth(MAX_SOUND_ID_LEN).map_or(stem.len(), |(i, _)| i)];
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("wav")
                .to_ascii_lowercase();
            if !AUDIO_EXTS.iter().any(|e| e.eq_ignore_ascii_case(&ext)) {
                eprintln!("[soundboard] lewati {}: ekstensi tidak didukung", file.name);
                continue;
            }

            let (rel, dest) = unique_rel_path(&dir, stem, &ext);
            if let Err(err) = std::fs::write(&dest, &file.data) {
                eprintln!("[soundboard] gagal tulis {}: {}", dest.display(), err);
                continue;
            }
            let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            let name = unique_sound_name(&data, stem);
            let duration_ms = probe_duration(&dest);
            let entry = new_sound_entry(name, rel, size, duration_ms);
            data.sounds.push(entry.clone());
            imported.push(entry);
        }

        save_sounds(&app, &data)?;
        Ok(imported)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundboard_pick_files(app: tauri::AppHandle) -> Result<Vec<SoundEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SoundEntry>, String> {
        let picked = app
            .dialog()
            .file()
            .add_filter("Audio files", AUDIO_EXTS)
            .blocking_pick_files();
        let Some(files) = picked else { return Ok(Vec::new()) };
        let mut data = load_sounds(&app);
        let mut imported = Vec::new();
        for fp in files {
            let path = fp.into_path().map_err(|e| e.to_string())?;
            match import_sound_file(&app, &path) {
                Ok(entry) => { data.sounds.push(entry.clone()); imported.push(entry); }
                Err(e) => eprintln!("[soundboard] gagal import {}: {}", path.display(), e),
            }
        }
        if let Err(e) = save_sounds(&app, &data) {
            eprintln!("[soundboard] gagal simpan: {}", e);
        }
        Ok(imported)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundboard_pick_folder(app: tauri::AppHandle) -> Result<Vec<SoundEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SoundEntry>, String> {
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(fp) = picked else { return Ok(Vec::new()) };
        let folder = fp.into_path().map_err(|e| e.to_string())?;
        let mut files = Vec::new();
        collect_audio(&folder, &mut files);
        files.sort();
        let mut data = load_sounds(&app);
        let mut imported = Vec::new();
        for f in files {
            match import_sound_file(&app, &f) {
                Ok(entry) => { data.sounds.push(entry.clone()); imported.push(entry); }
                Err(e) => eprintln!("[soundboard] gagal import {}: {}", f.display(), e),
            }
        }
        if let Err(e) = save_sounds(&app, &data) {
            eprintln!("[soundboard] gagal simpan: {}", e);
        }
        Ok(imported)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn soundboard_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = sounds_dir(&app).ok_or("gagal dapatkan folder sounds")?;
    let mut data = load_sounds(&app);
    let len = data.sounds.len();
    data.sounds.retain(|s| {
        if s.id == id {
            let fpath = dir.join(&s.rel_path);
            if let Err(e) = std::fs::remove_file(&fpath) {
                eprintln!("[soundboard] gagal hapus {}: {}", fpath.display(), e);
            }
            crate::audio::decode::invalidate(&id);
            false
        } else { true }
    });
    if data.sounds.len() == len {
        return Err(format!("suara \"{}\" tidak ditemukan", id));
    }
    save_sounds(&app, &data)?;
    Ok(())
}

#[tauri::command]
fn soundboard_read(app: tauri::AppHandle, id: String) -> Result<SoundBytes, String> {
    let dir = sounds_dir(&app).ok_or("gagal dapatkan folder sounds")?;
    let data = load_sounds(&app);
    let entry = data.sounds.iter().find(|s| s.id == id)
        .ok_or(format!("suara \"{}\" tidak ditemukan", id))?;
    let fpath = dir.join(&entry.rel_path);
    let bytes = std::fs::read(&fpath)
        .map_err(|e| format!("gagal baca {}: {}", fpath.display(), e))?;
    Ok(SoundBytes { id: entry.id.clone(), data: bytes })
}

#[tauri::command]
fn soundboard_rename(app: tauri::AppHandle, id: String, new_name: String) -> Result<(), String> {
    let mut data = load_sounds(&app);
    let idx = data.sounds.iter().position(|s| s.id == id)
        .ok_or(format!("suara \"{}\" tidak ditemukan", id))?;
    // --- PATCH: Auto-numbering bila nama baru bentrok ---
    let final_name = if data.sounds.iter().any(|s| s.id != id && s.name == new_name) {
        let stem = new_name.clone();
        let mut counter = 1;
        loop {
            let candidate = format!("{}_{}", stem, counter);
            if !data.sounds.iter().any(|s| s.id != id && s.name == candidate) {
                break candidate;
            }
            counter += 1;
        }
    } else {
        new_name
    };
    // id di-set sama dengan final_name agar konsisten dengan nama di JSON,
    // tapi dipotong ke MAX_SOUND_ID_LEN karena firmware punya buffer limit.
    let id = final_name.char_indices().nth(MAX_SOUND_ID_LEN)
        .map(|(i, _)| final_name[..i].to_string())
        .unwrap_or(final_name.clone());
    data.sounds[idx].name = final_name;
    data.sounds[idx].id = id; // id ikut berubah saat rename
    save_sounds(&app, &data)?;
    Ok(())
}

// ==================== TRAY ====================
const MAIN_WINDOW: &str = "main";

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) { show_main(&app); }

#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) { let _ = w.hide(); }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) { app.exit(0); }

// ==================== AUTOSTART ====================
#[derive(Serialize)]
struct AutostartStatus { enabled: bool, available: bool }

// available = false di build debug (tauri dev): exe debug tidak boleh masuk startup Windows
// ==================== I18N ====================

/// Nama locale sistem operasi, mis. "id-ID" atau "en-US".
///
/// Dipakai i18n untuk memilih bahasa saat aplikasi pertama kali dibuka, jadi
/// user tidak perlu memilih bahasa lewat dialog tambahan.
///
/// `GetUserDefaultLocaleName` (bukan `GetSystemDefaultLocaleName`): yang pertama
/// mengikuti bahasa yang benar-benar dipilih user di Windows, yang kedua hanya
/// bahasa bawaan sistem. Untuk "pilih bahasa otomatis" hampir selalu yang
/// pertama yang benar - orang dengan Windows English tetapi bekerja dalam
/// bahasa Indonesia tetap ingin antarmuka berbahasa Indonesia.
///
/// Panjang buffer 85 cukup: LOCALE_NAME_MAX_LENGTH di Win32 = 85.
#[tauri::command]
fn system_locale() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85];
    // `unsafe` dibenarkan di sini: panjang buf diteruskan apa adanya ke API,
    // jadi fungsi ini tidak bisa menulis melewati batas buffer.
    let written = unsafe { GetUserDefaultLocaleName(&mut buf) };
    // 0 = berhasil. Negatif = gagal. Lebih besar dari 85 berarti buffer
    // kekecilan - praktis mustahil, tapi bail lebih aman daripada membaca
    // di luar jangkauan.
    if written <= 0 || written as usize >= buf.len() { return None; }
    let s = String::from_utf16_lossy(&buf[..written as usize]);
    Some(s.trim_end_matches('\0').to_string())
}

/// Dua huruf pertama locale sebagai kode bahasa.
/// "id-ID" -> "id", "en-US" -> "en", "en" -> "en".
///
/// Dipisah dari `system_locale` supaya murni (tidak menyentuh Windows) dan
/// bisa diuji langsung di unit test.
#[cfg(test)]
fn language_of(locale: &str) -> String {
    locale.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase()
}

#[tauri::command]
fn autostart_status(app: tauri::AppHandle) -> AutostartStatus {
    #[cfg(desktop)]
    {
        let enabled = app.autolaunch().is_enabled().unwrap_or(false);
        AutostartStatus { enabled, available: !cfg!(debug_assertions) }
    }
    #[cfg(not(desktop))]
    { let _ = app; AutostartStatus { enabled: false, available: false } }
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, value: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Autostart hanya bisa diatur dari build rilis (npm run tauri build)".into());
    }
    #[cfg(desktop)]
    {
        let m = app.autolaunch();
        let r = if value { m.enable() } else { m.disable() };
        r.map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    { let _ = (app, value); Err("Autostart tidak didukung di platform ini".into()) }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Buka Macro Pad Configurator", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Macro Pad Configurator")
        .menu(&menu)
        .show_menu_on_left_click(false) // klik kiri = buka jendela, klik kanan = menu
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => {
                match app.get_webview_window(MAIN_WINDOW) {
                    // Jendela terlihat: mungkin ada edit belum tersimpan, biar JS yang tanya dulu
                    Some(w) if w.is_visible().unwrap_or(false) => { let _ = w.emit("tray-quit", ()); }
                    // Jendela tersembunyi (di tray): tidak mungkin ada edit tertunda, langsung keluar
                    _ => app.exit(0),
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;
    Ok(())
}

// ==================== WATCHDOG PAINT JENDELA UTAMA ====================
//
// Jendela utama kadang PUTIH Total setelah aplikasi dijalankan ulang: JS di
// dalamnya tetap jalan (serial connect, log, preset switching), tapi renderer
// WebView2 tidak pernah menghasilkan frame. Penyebab umumnya webview instance
// sebelumnya belum sepenuhnya keluar saat yang baru start, sehingga profil
// WebView2 dipakai dua proses browser sekaligus dan renderer yang baru
// menggantung.
//
// Sinyal "JS hidup" tidak berguna di sini karena memang hidup; yang hilang
// adalah pelukisan. Karena itu paint-watch.js melaporkan lewat
// requestAnimationFrame - callback itu hanya jalan kalau browser benar-benar
// menghasilkan frame - dan Rust memakai laporan itu untuk memuat ulang
// jendela sendiri.
//
// reports: 0 = belum ada laporan, 1 = script jalan, 2 = frame pertama tampil.
static MAIN_PAINT_REPORT: AtomicU64 = AtomicU64::new(0);
static APP_STARTED: AtomicU64 = AtomicU64::new(0);

fn paint_report(level: u64) {
    // Hanya naik: reload memicu modul JS berjalan lagi dan melapor ulang.
    let _ = MAIN_PAINT_REPORT.fetch_max(level, Ordering::SeqCst);
    let started = APP_STARTED.load(Ordering::SeqCst);
    if level >= 2 && started != 0 {
        // Berguna waktu debug: dari situ kelihatan kalau jendela lambat render
        // tanpa harus menunggu sampai watchdog turun tangan.
        eprintln!("[main] jendela ter-paint pada t+{} ms", now_ms().saturating_sub(started));
    }
    if level >= 2 { paint_watch_stop(); }
}

#[tauri::command]
fn paint_script_ran() { paint_report(1); }

#[tauri::command]
fn paint_first_frame() { paint_report(2); }

// Berhenti watchdog begitu frame pertama benar-benar terlihat.
fn paint_watch_stop() {
    let _ = MAIN_PAINT_REPORT.fetch_max(3, Ordering::SeqCst);
}

//
//
// Satu thread ringan yang:
//   1. menunggu jendela utama benar-benar tampil (kalau app jalan lewat
//      autostart, jendela disembunyikan dan memang tidak ada frame - jangan
//      reload dalam kondisi itu),
//   2. memberi halaman waktu memuat dan melukis dirinya sendiri,
//   3. kalau frame pertama tidak pernah datang, muat ulang jendela.
fn spawn_paint_watchdog(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        // script saja yang mem-paint, jadi pastikan dulu tidak sedang autostart
        let mut shown = false;
        for _ in 0..20 {
            let visible = handle
                .get_webview_window(MAIN_WINDOW)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if visible {
                shown = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        // Autostart: tidak ada yang perlu diawasi, jendela memang disembunyikan.
        if !shown {
            return;
        }

        // Batas 3 percobaan. Cukup untuk kasus umum; kalau masih putih, systemic
        // dan reload tidak akan menolong.
        for attempt in 1..=3 {
            std::thread::sleep(Duration::from_millis(5000));
            if MAIN_PAINT_REPORT.load(Ordering::SeqCst) >= 3 {
                return;
            }
            let w = match handle.get_webview_window(MAIN_WINDOW) {
                Some(w) => w,
                None => return,
            };
            // Kalau jendela disembunyikan/di-minimize saat menunggu, jangan reload.
            if !w.is_visible().unwrap_or(false) {
                return;
            }
            let report = MAIN_PAINT_REPORT.load(Ordering::SeqCst);
            eprintln!(
                "[main] jendela belum ter-paint (laporan={}, percobaan={}) -> reload",
                report, attempt
            );
            let _ = w.reload();
        }
    });
}

// ==================== OVERLAY NOTIFIKASI ====================
// Jendela terpisah: transparan, tanpa dekorasi, always-on-top, tidak bisa fokus & klik tembus,
// jadi tidak mengganggu window apa pun di bawahnya. Konten digambar oleh overlay.html.
const OVERLAY_WINDOW: &str = "overlay";
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
static HIDE_AT: AtomicU64 = AtomicU64::new(0);      // kapan overlay boleh disembunyikan (ms epoch)
static HIDE_WATCHER: AtomicBool = AtomicBool::new(false);
static OVERLAY_INIT: Mutex<()> = Mutex::new(());    // cegah dua thread membuat overlay bersamaan
const EVENT_NOTIFY: &str = "overlay-notify";       // channel resmi Rust -> overlay.html

// Kapan jendela overlay dibuat (ms epoch) dan kapan terakhir ada percobaan
// pemulihan. Dipakai watchdog di bawah.
static OVERLAY_BORN: AtomicU64 = AtomicU64::new(0);
static OVERLAY_RETRY: AtomicU64 = AtomicU64::new(0);
static OVERLAY_RELOADS: AtomicU64 = AtomicU64::new(0);

// Halaman overlay butuh waktu untuk inisialisasi WebView2 + memuat script,
// jadi jangan ganggu sebelum grace period ini lewat.
const OVERLAY_LOAD_GRACE_MS: u64 = 4000;
// Jeda antar percobaan pemulihan: mencegah reload berulang tiap notifikasi
// (mis. saat user menekan banyak tombol dalam waktu singkat).
const OVERLAY_RETRY_COOLDOWN_MS: u64 = 10_000;

fn build_overlay(app: &tauri::AppHandle, strict: bool) -> Result<tauri::WebviewWindow, String> {
    let mut b = tauri::WebviewWindowBuilder::new(app, OVERLAY_WINDOW, tauri::WebviewUrl::App("overlay.html".into()))
        .title("Macropad Overlay")
        .inner_size(480.0, 90.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false);
    if strict { b = b.shadow(false).focused(false).focusable(false); }
    // Folder data WebView2 TERPISAH: dua webview yang berbagi folder harus berkonfigurasi sama,
    // sedangkan overlay ini transparan (beda dari jendela utama) => error 0x8007139F tanpa ini.
    if let Ok(dir) = app.path().app_local_data_dir() { b = b.data_directory(dir.join("overlay-webview")); }
    b.build().map_err(|e| e.to_string())
}

fn ensure_overlay(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(OVERLAY_WINDOW) { return Ok(w); }
    let _guard = OVERLAY_INIT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window(OVERLAY_WINDOW) { return Ok(w); }
    // Coba opsi lengkap dulu; kalau ditolak, ulangi dengan opsi minimal dan gabungkan pesan error
    let w = match build_overlay(app, true) {
        Ok(w) => w,
        Err(e1) => build_overlay(app, false).map_err(|e2| format!("{} | percobaan 2: {}", e1, e2))?,
    };
    // Catat waktu lahir supaya watchdog tahu kapan harus mulai curiga halaman
    // tidak akan pernah siap.
    OVERLAY_BORN.store(now_ms(), Ordering::SeqCst);
    let _ = w.set_ignore_cursor_events(true);
    Ok(w)
}

// ==================== PEMULIHAN HALAMAN OVERLAY ====================
//
// Gejala "notifikasi tidak muncul sama sekali" punya satu penyebab yang
// sangat mudah terjadi: halaman overlay.html gagal dimuat atau gagal
// menjalankan script-nya. Contoh di mode dev: jendela dibuat 3 detik setelah
// start, sementara vite masih mengoptimasi dependensi, jadi overlay.html
// sempat dijawab error/404. Overlay.js tidak pernah jalan, command
// `overlay_ready` tidak pernah dipanggil, jadi OVERLAY_READY tetap false
// SELAMANYA. Setiap notifikasi lalu diam-diam masuk antrean yang tidak
// pernah ditampilkan - jendela overlay tetap show/hide dengan isi kosong.
//
// Karena itu: begitu ada notifikasi sementara halaman belum siap, jangan
// cuma menunggu. Muat ulang halamannya. Kalau reload tidak menolong,
// buang jendela dan biarkan ensure_overlay() membuat yang baru.
fn recover_overlay_page(app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    if OVERLAY_READY.load(Ordering::SeqCst) { return; }

    let now = now_ms();
    let born = OVERLAY_BORN.load(Ordering::SeqCst);
    // Masih dalam grace period: webview mungkin sedang inisialisasi.
    if born == 0 || now < born + OVERLAY_LOAD_GRACE_MS { return; }
    // Masih dalam cooldown percobaan sebelumnya.
    if now < OVERLAY_RETRY.load(Ordering::SeqCst) + OVERLAY_RETRY_COOLDOWN_MS { return; }
    OVERLAY_RETRY.store(now, Ordering::SeqCst);

    // Halaman dianggap restart: emit berikutnya harus diantrekan, bukan
    // dikirim ke webview yang belum punya listener.
    OVERLAY_READY.store(false, Ordering::SeqCst);

    let percobaan = OVERLAY_RELOADS.fetch_add(1, Ordering::SeqCst) + 1;
    if percobaan == 1 {
        eprintln!(
            "[overlay] halaman belum siap {} ms setelah window dibuat, muat ulang",
            now - born
        );
        if let Err(e) = w.reload() {
            eprintln!("[overlay] reload gagal: {}", e);
        }
    } else {
        // Sudah dicoba reload dan tetap tidak siap: webview-nya yang rusak,
        // bukan halamannya. Buang jendela supaya dibuat ulang dengan webview
        // baru (ensure_overlay() dipanggil ulang oleh pemanggil).
        eprintln!(
            "[overlay] percobaan ke-{} tetap gagal, buat ulang jendela overlay",
            percobaan
        );
        let _ = w.destroy();
    }
    let _ = app;
}

// Antrean notifikasi yang belum bisa dikirim karena halaman overlay belum siap
// memasang listener-nya. Dulu ini ditangani dengan w.eval() yang menyuntik JS,
// sehingga teks device (yang berasal dari nilai macro di flash) ikut di-parse sebagai
// JavaScript. Sekarang lewat channel event resmi, jadi teks aman dan murni data.
static PENDING_NOTIFY: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());
static OVERLAY_READY: AtomicBool = AtomicBool::new(false);

fn deliver_overlay(w: &tauri::WebviewWindow, payload: &serde_json::Value) {
    if let Err(e) = w.emit(EVENT_NOTIFY, payload.clone()) {
        eprintln!("[overlay] emit gagal: {}", e);
    }
}

// Dipanggil overlay.html setelah listener-nya terpasang; sekaligus Functions drain
// antrean yang menumpuk selama halaman belum siap.
#[tauri::command]
fn overlay_ready(app: tauri::AppHandle) -> Result<(), String> {
    let w = ensure_overlay(&app)?;
    OVERLAY_READY.store(true, Ordering::SeqCst);
    // Halaman hidup lagi: reset penghitung pemulihan supaya kalau nanti rusak
    // lagi, tidak perlu menunggu cooldown yang sudah terpakai.
    OVERLAY_RELOADS.store(0, Ordering::SeqCst);
    OVERLAY_RETRY.store(0, Ordering::SeqCst);
    let queued = { let mut q = PENDING_NOTIFY.lock().unwrap_or_else(|e| e.into_inner()); std::mem::take(&mut *q) };
    if let Some(last) = queued.last() { deliver_overlay(&w, last); }
    Ok(())
}

// async: jalan di thread pool, BUKAN main thread, supaya tidak pernah memblokir UI/serial
#[tauri::command]
async fn notify(app: tauri::AppHandle, text: String, kind: String, hold: Option<u64>) -> Result<(), String> {
    let mut w = ensure_overlay(&app)?;
    let hold = hold.unwrap_or(3000).clamp(300, 10000);

    // Halaman overlay belum siap? Coba pulihkan (reload / buat ulang jendela).
    // Kalau jendela sempat dibuang, ambil handle yang baru.
    if !OVERLAY_READY.load(Ordering::SeqCst) {
        recover_overlay_page(&app, &w);
        w = ensure_overlay(&app)?;
    }

    // Posisi & show hanya saat overlay sedang tersembunyi (hindari show/hide beruntun)
    if !w.is_visible().unwrap_or(false) {
        if let (Ok(Some(m)), Ok(size)) = (app.primary_monitor(), w.outer_size()) {
            let x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, m.position().y));
        }
        // Jangan ditelan diam-diam: tanpa show() notifikasi benar-benar tidak terlihat.
        if let Err(e) = w.show() {
            eprintln!("[overlay] gagal menampilkan jendela: {}", e);
            return Err(format!("Gagal menampilkan overlay: {}", e));
        }
    }

    let payload = serde_json::json!({ "text": text, "kind": kind, "hold": hold });
    if OVERLAY_READY.load(Ordering::SeqCst) {
        deliver_overlay(&w, &payload);
    } else {
        // Belum ada listener: antrekan, dan batasi supaya tidak tumbuh tanpa batas
        // kalau overlay gagal dimuat.
        let mut q = PENDING_NOTIFY.lock().unwrap_or_else(|e| e.into_inner());
        // >= bukan >: pemeriksaan dilakukan SEBELUM push, jadi dengan "> 16"
        // antrean tumbuh jadi 17 entri - satu lebih dari yang dijanjikan.
        if q.len() >= 16 { q.remove(0); }
        q.push(payload);
    }

    // Satu watcher saja: sembunyikan jendela setelah animasi selesai (hold + muncul + menyusut + margin)
    HIDE_AT.store(now_ms() + hold + 2200, Ordering::SeqCst);
    if !HIDE_WATCHER.swap(true, Ordering::SeqCst) {
        let handle = app.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(250));
                if now_ms() >= HIDE_AT.load(Ordering::SeqCst) {
                    if let Some(w) = handle.get_webview_window(OVERLAY_WINDOW) { let _ = w.hide(); }
                    HIDE_WATCHER.store(false, Ordering::SeqCst);
                    break;
                }
            }
        });
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]

// ==================== BLE COMMANDS (Phase 10) ===================
// Objek WinRT (BluetoothLEDevice, GattCharacteristic, dst)
// berbasis IUnknown yang TIDAK bersifat Send, jadi tidak boleh
// menyeberang thread maupun disimpan di static. Seluruh state
// BLE dimiliki oleh satu thread worker khusus; command Tauri
// hanya mengirim pesan lewat channel dan menunggu balasan.
// Dulu ble_connect membuat transport lalu langsung dibuang,
// sehingga koneksi tidak pernah bertahan ke command berikutnya.

#[derive(Serialize)]
struct BleDeviceInfo {
    id: String,
    name: String,
    is_paired: bool,
}

enum BleRequest {
    Scan(tokio::sync::oneshot::Sender<Result<Vec<BleDeviceInfo>, String>>),
    Connect {
        id: String,
        resp: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    Disconnect(tokio::sync::oneshot::Sender<Result<(), String>>),
    /// Hard-reset BLE adapter state. Dipanggil saat reconnect gagal berulang
    /// akibat GATT cache corruption (sering setelah burst notifikasi gagal
    /// pada Windows). Ini melakukan:
    /// 1. Disconnect paksa (jika masih terhubung)
    /// 2. Clear semua internal state (service, chars, buffer)
    /// 3. Tunggu 3 detik agar Windows dapat melepas link dengan sempurna
    ResetAdapter(tokio::sync::oneshot::Sender<Result<(), String>>),
    Write {
        data: Vec<u8>,
        resp: tokio::sync::oneshot::Sender<Result<usize, String>>,
    },
    /// WriteWithoutResponse: cocok untuk CFG_WRITE (Fase 5). Tidak ada ack
    /// firmware, jadi kegagalan berarti burst control, bukan kegagalan link
    /// permanen. App yang menanggapi failure ini dengan throttle pacing.
    WriteNoAck {
        data: Vec<u8>,
        resp: tokio::sync::oneshot::Sender<Result<usize, String>>,
    },
    Read {
        max_len: usize,
        resp: tokio::sync::oneshot::Sender<Vec<u8>>,
    },
    IsConnected(tokio::sync::oneshot::Sender<bool>),
    Stats(tokio::sync::oneshot::Sender<BleStats>),
}

static BLE_TX: std::sync::OnceLock<std::sync::mpsc::Sender<BleRequest>> =
    std::sync::OnceLock::new();

fn ble_tx() -> std::sync::mpsc::Sender<BleRequest> {
    BLE_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<BleRequest>();
        std::thread::Builder::new()
            .name("ble-worker".into())
            .spawn(move || ble_worker(rx))
            .expect("gagal memulai thread BLE");
        tx
    })
    .clone()
}

// Thread pemilik seluruh objek WinRT BLE. WinRT membutuhkan
// COM terinisialisasi di thread ini.
fn ble_worker(rx: std::sync::mpsc::Receiver<BleRequest>) {
    // WinRT membutuhkan COM terinisialisasi di thread ini.
    // HRESULT diabaikan: thread mungkin sudah terinisialisasi.
    let _ = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
    };

    let mut transport: Option<BleTransport> = None;
    let shared_stats: std::sync::Arc<std::sync::Mutex<BleStats>> =
        std::sync::Arc::new(std::sync::Mutex::new(BleStats::default()));
    // DeviceInformation tidak Send, jadi tidak bisa disimpan di static atau
    // dikirim lewat channel ke thread lain. Tapi ia HARUS disimpan di thread
    // ini: connect() butuh DeviceInformation, dan tanpa cache satu-satunya
    // cara mendapatkannya adalah scan ulang 5 detik - yang gagal kalau
    // device sedang tidak advertising.
    let mut discovered: Vec<DeviceInformation> = Vec::new();
    while let Ok(req) = rx.recv() {
        match req {
            BleRequest::Scan(resp) => {
                // Ekstrak data yang bisa dikirim antar thread
                // (DeviceInformation sendiri tidak Send).
                let r = BleTransport::scan().map(|devices| {
                    discovered = devices;
                    discovered
                        .iter()
                        .map(|d| BleDeviceInfo {
                            id: d.Id().map(|s| s.to_string()).unwrap_or_default(),
                            name: d.Name().map(|s| s.to_string()).unwrap_or_default(),
                            is_paired: d
                                .Pairing()
                                .ok()
                                .and_then(|p| p.IsPaired().ok())
                                .unwrap_or(false),
                        })
                        .collect()
                });
                let _ = resp.send(r);
            }
            BleRequest::Connect { id, resp } => {
                // Pakai cache dari scan terakhir. Kalau belum pernah scan,
                // scan sekali di sini - lebih baik lambat daripada gagal.
                if discovered.is_empty() {
                    match BleTransport::scan() {
                        Ok(d) => discovered = d,
                        Err(e) => {
                            let _ = resp.send(Err(e));
                            continue;
                        }
                    }
                }

                let found = discovered
                    .iter()
                    .find(|d| d.Id().map(|s| s.to_string()).unwrap_or_default() == id)
                    .cloned();

                let r = match found {
                    None => Err(format!(
                        "Device {} tidak ada di hasil scan terakhir. \
                         Scan ulang lalu connect ulang.",
                        id
                    )),
                    Some(device_info) => {
                        // Runtuhkan transport yang sedang hidup SEBELUM membuat
                        // yang baru.
                        //
                        // Sebelumnya `transport = Some(t)` menimpa transport lama
                        // TANPA disconnect(): handler ValueChanged tidak pernah
                        // dilepas, CCCD tidak pernah dimatikan, handle service
                        // tidak pernah di-Close. Satu-sesi tertinggal per
                        // reconnect, dan connect berikutnya gagal
                        // karena Windows menahan handle yang sudah tidak dipakai.
                        //
                        // Di-drop tanpa disconnect() akan meninggalkan sesi
                        // WinRT yang menggantung, jadi pemanggilan eksplisit ini
                        // bukan sekadar formalitas.
                        if let Some(mut lama) = transport.take() {
                            lama.disconnect();
                        }
                        let mut t = BleTransport::with_stats(shared_stats.clone());
                        match t.connect(&device_info) {
                            Ok(()) => {
                                transport = Some(t);
                                log("[BLE] Connected via command");
                                Ok(())
                            }
                            Err(e) => Err(e),
                        }
                    }
                };
                let _ = resp.send(r);
            }
            BleRequest::Disconnect(resp) => {
                let r = match transport.take() {
                    Some(mut t) => {
                        t.disconnect();
                        Ok(())
                    }
                    None => Err("BLE tidak terhubung".to_string()),
                };
                let _ = resp.send(r);
            }
            BleRequest::Write { data, resp } => {
                let r = match transport.as_mut() {
                    Some(t) => t.write(&data),
                    None => Err("BLE tidak terhubung".to_string()),
                };
                let _ = resp.send(r);
            }
            BleRequest::WriteNoAck { data, resp } => {
                let r = match transport.as_mut() {
                    Some(t) => t.write_no_ack(&data),
                    None => Err("BLE tidak terhubung".to_string()),
                };
                let _ = resp.send(r);
            }
            BleRequest::Read { max_len, resp } => {
                let out = match transport.as_mut() {
                    Some(t) => t.read_bulk(max_len),
                    None => Vec::new(),
                };
                let _ = resp.send(out);
            }
            BleRequest::IsConnected(resp) => {
                let _ = resp.send(transport.as_ref().is_some_and(|t| t.is_connected()));
            }
            BleRequest::Stats(resp) => {
                // Angka DEFAULT kalau transport sudah lepas: laporan harus
                // tetap bisa diambil setelah disconnect, justru di saat itulah
                // angka terakhir paling dibutuhkan.
                let st = shared_stats.lock().map(|s| s.clone()).unwrap_or_default();
                let _ = resp.send(st);
            }
            BleRequest::ResetAdapter(resp) => {
                // Hard-reset: lepas koneksi paksa, clear semua state internal,
                // lalu tunggu agar Windows melepas link GATT dengan sempurna.
                //
                // Ini dipanggil setelah burst error baca/notifikasi gagal,
                // biasanya disebabkan oleh GATT cache corruption di Windows
                // yang tidak bisa diperbarui dengan disconnect biasa.
                transport.take();
                // Tunggu 3 detik agar Windows benar-benar melepas semua handle.
                // Tanpa jeda ini, connect berikutnya bisa gagal dengan
                // "service not found" atau "TX characteristic not registered".
                std::thread::sleep(std::time::Duration::from_millis(3000));
                let _ = resp.send(Ok(()));
            }
        }
    }
}

#[tauri::command]
async fn ble_scan() -> Result<Vec<BleDeviceInfo>, String> {
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::Scan(resp))
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ble_connect(id: String) -> Result<(), String> {
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::Connect { id, resp })
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ble_disconnect() -> Result<(), String> {
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::Disconnect(resp))
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ble_write(data: Vec<u8>) -> Result<usize, String> {
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::Write { data, resp })
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ble_write_no_ack(data: Vec<u8>) -> Result<usize, String> {
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::WriteNoAck { data, resp })
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ble_read(max_len: usize) -> Result<Vec<u8>, String> {
    let max_len = max_len.clamp(1, 4096);
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::Read { max_len, resp })
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    rx.await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ble_is_connected() -> bool {
    let (resp, rx) = tokio::sync::oneshot::channel();
    if ble_tx().send(BleRequest::IsConnected(resp)).is_err() {
        return false;
    }
    rx.await.unwrap_or(false)
}

/// Snapshot penghitung lapis LINK (L1).
///
/// Dibaca frontend untuk menyusun blok DIAG. Sengaja tidak bisa gagal: kalau
/// thread BLE tidak hidup, angka kosong dianggap "tidak ada koneksi", bukan
/// error - laporan harus selalu bisa ditampilkan, termasuk kondisi paling Buruk
/// yang justru paling perlu dilihat.
#[tauri::command]
async fn ble_stats() -> BleStats {
    let (resp, rx) = tokio::sync::oneshot::channel();
    if ble_tx().send(BleRequest::Stats(resp)).is_err() {
        return BleStats::default();
    }
    rx.await.unwrap_or_default()
}

#[tauri::command]
async fn ble_reset_adapter() -> Result<(), String> {
    // Hard-reset BLE adapter: lepas semua handle GATT dan tunggu Windows
    // melepas link dengan sempurna. Dipanggil setelah burst notifikasi gagal
    // untuk membersihkan GATT cache yang corrupt.
    //
    // Di Windows, disconnect biasa (ble_disconnect) tidak selalu melepas semua
    // handle WinRT — BluetoothLEDevice, GattDeviceService, GattCharacteristic
    // bisa tetap tertinggal, dan connect berikutnya dapat gagal dengan
    // "service not found" atau "TX characteristic not registered".
    //
    // Ini mengambil transport.take() (membuang semua handle) dan menunggu
    // 3 detik agar Windows dapat menyelesaikan proses internal cleanup.
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::ResetAdapter(resp))
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    rx.await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn ble_switch_interface(iface: String) -> Result<(), String> {
    // Kirim perintah IFACE:USB atau IFACE:BLE ke firmware.
    //
    // PENTING: newline WAJIB ikut terkirim. Firmware hanya menjalankan
    // handleSerialCommand() saat menerima '\n' (lihat macropad_core.h) -
    // tanpa newline, perintahnya menggantung di serialLine[] selamanya dan
    // tidak pernah diproses. Versi sebelumnya mengirim byte mentah tanpa
    // newline, jadi perintah ini diam-diam tidak pernah berpengaruh.
    let cmd = match iface.as_str() {
        "usb" => "IFACE:USB\n",
        "ble" => "IFACE:BLE\n",
        _ => return Err("Invalid interface. Use 'usb' or 'ble'".to_string()),
    };
    let (resp, rx) = tokio::sync::oneshot::channel();
    ble_tx()
        .send(BleRequest::Write {
            data: cmd.as_bytes().to_vec(),
            resp,
        })
        .map_err(|_| "Thread BLE tidak berjalan".to_string())?;
    let result = rx.await.map_err(|e| e.to_string())?;
    result.map(|_| ())
}



pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single instance harus didaftarkan PERTAMA. Peluncuran kedua cuma memunculkan jendela yang sudah ada.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }));
    }

    // Argumen --autostart ditambahkan plugin autostart saat Windows start: jalan diam-diam di tray
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])));
    }

    builder
        .setup(|app| {
            // Audio engine v2: satu thread pemilik semua stream cpal.
            app.manage(AudioEngine::new(app.handle().clone()));
            setup_tray(app)?;
            APP_STARTED.store(now_ms(), Ordering::SeqCst);
            // Self-heal jendela putih (lihat WATCHDOG PAINT di atas).
            spawn_paint_watchdog(app.handle().clone());
            // Overlay dibuat TERTUNDA di thread lain, setelah jendela utama selesai memuat WebView2-nya.
            // Membuat dua WebView2 bersamaan saat startup rawan membuat jendela utama putih/hitam & hang.
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(3000));
                    if let Err(e) = ensure_overlay(&h) {
                        // Di mode dev, 3 detik kadang belum cukup: vite masih bisa
                        // mengoptimasi dependensi dan overlay.html sempat dijawab error.
                        // Coba lagi supaya jendela siap jauh sebelum notifikasi pertama.
                        eprintln!("[overlay] gagal dibuat ({}), coba lagi 2,5 detik", e);
                        std::thread::sleep(Duration::from_millis(2500));
                        if let Err(e) = ensure_overlay(&h) {
                            eprintln!("[overlay] tetap gagal setelah dua percobaan: {}", e);
                        }
                    }
                });
            }

            // Aktif otomatis sekali saja setelah run pertama, hanya di build rilis.
            // Kalau user mematikan lewat toggle, autostart_init tetap true jadi tidak dinyalakan lagi.
            #[cfg(all(desktop, not(debug_assertions)))]
            {
                let handle = app.handle();
                let mut d = load_data(handle);
                let m = app.autolaunch();
                if !d.autostart_init {
                    if m.enable().is_ok() {
                        d.autostart_init = true;
                        if let Err(e) = save_data(handle, &d) { eprintln!("[apps] simpan gagal: {}", e); }
                    }
                } else if m.is_enabled().unwrap_or(false) {
                    let _ = m.enable(); // perbarui path exe di registry kalau app dipindah/diupdate
                }
            }

            // Window dibuat tersembunyi (visible: false di tauri.conf.json); tampilkan kecuali dijalankan dari autostart
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window(MAIN_WINDOW) { let _ = w.hide(); }
            } else {
                show_main(app.handle());
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_serialplugin::init())
        .invoke_handler(tauri::generate_handler![
            apps_get,
            apps_set_consent,
            apps_set_ttl,
            apps_rescan,
            apps_pick_exe,
            apps_add_custom,
            apps_remove_custom,
            launch_app,
            soundboard_list,
            soundboard_probe,
            soundboard_pick_files,
            soundboard_pick_folder,
            soundboard_delete,
            soundboard_read,
            soundboard_rename,
            soundboard_update_meta,
            soundboard_import_data,
            // Audio engine v2
            audio_devices,
            audio_state,
            audio_set_output,
            audio_set_monitor,
            audio_set_mic,
            audio_set_mic_pre,
            audio_set_gain,
            audio_set_mute,
            audio_set_mode,
            audio_set_buffer,
            audio_test_tone,
            audio_play,
            audio_stop,
            show_main_window,
            hide_to_tray,
            quit_app,
            autostart_status,
            autostart_set,
            system_locale,
            get_foreground_exe,
            scan_bindable_apps,
            presets_get,
            presets_save,
            notify,
            overlay_ready,
            paint_script_ran,
            paint_first_frame,
            // Phase 10 BLE commands
            ble_scan,
            ble_connect,
            ble_disconnect,
            ble_write,
            ble_write_no_ack,
            ble_read,
            ble_is_connected,
            ble_switch_interface,
            ble_stats,
            ble_reset_adapter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]

mod tests {
    use super::{
        find_app, language_of, normalize_color, normalize_tags, normalize_trim, system_locale,
        AppData, AppEntry, SOUND_TAG_LEN, SOUND_TAG_MAX,
    };

    fn e(name: &str) -> AppEntry {
        AppEntry { name: name.to_string(), id: format!("C:\\{}.lnk", name), custom: false }
    }

    fn data(names: &[&str]) -> AppData {
        AppData { apps: names.iter().map(|n| e(n)).collect(), ..Default::default() }
    }

    #[test]
    fn cocok_persis_selalu_menang() {
        let d = data(&["Notepad", "Notepad++"]);
        assert_eq!(find_app(&d, "notepad").unwrap().name, "Notepad");
        assert_eq!(find_app(&d, "Notepad++").unwrap().name, "Notepad++");
    }

    // Ini yang membuat prefix lama berbahaya: "sl" cocok dengan Slack sekaligus
    // Spotify, jadi perangkat yang mengirim baris acak bisa memilih salah satu.
    #[test]
    fn prefix_pendek_ditolak_bukan_menebak() {
        let d = data(&["Slack", "Spotify", "Slackmate"]);
        let r = find_app(&d, "sl");
        assert!(r.is_err(), "prefix 'sl' harus gagal, bukan menebak salah satu aplikasi");
    }

    #[test]
    fn prefix_yang_ambigu_menyebut_kandidatnya() {
        let d = data(&["Chrome", "Chromium", "Google Chrome"]);
        let e = find_app(&d, "Chro").unwrap_err();
        assert!(e.contains("tidak unik"), "pesan harus menjelaskan nama ambigu: {}", e);
        assert!(e.contains("Chrome"), "pesan harus menyebut kandidat: {}", e);
    }

    // Nama dari firmware bisa terpotong, jadi prefix >= 4 huruf tetap boleh dipakai
    // selama hasilnya tunggal.
    #[test]
    fn prefix_panjang_unik_diterima() {
        let d = data(&["Discord", "Steam"]);
        assert_eq!(find_app(&d, "Disc").unwrap().name, "Discord");
    }

    #[test]
    fn nama_kosong_ditolak() {
        let d = data(&["Notepad"]);
        assert!(find_app(&d, "   ").is_err());
    }

    #[test]
    fn aplikasi_tidak_ada_ditolak() {
        let d = data(&["Notepad"]);
        assert!(find_app(&d, "Zzzzz").is_err());
    }

    // ---- i18n: parsing locale ----

    #[test]
    fn locale_dipotong_ke_kode_bahasa() {
        assert_eq!(language_of("id-ID"), "id");
        assert_eq!(language_of("en-US"), "en");
        assert_eq!(language_of("en-GB"), "en");
        // Tanpa wilayah.
        assert_eq!(language_of("id"), "id");
        // Pemisah underscore juga dipakai sebagian Windows lama.
        assert_eq!(language_of("en_US"), "en");
        // Huruf besar harus dinormalkan, kalau tidak "EN-US" tidak akan cocok
        // dengan daftar bahasa yang tersimpan lowercase.
        assert_eq!(language_of("EN-US"), "en");
        assert_eq!(language_of("Id-ID"), "id");
    }

    #[test]
    fn locale_kosong_atau_aneh_tidak_panik() {
        // Tidak boleh panik: string kosong akan jadi "" dan pemanggil wajib
        //routing ke bahasa bawaan.
        assert_eq!(language_of(""), "");
        assert_eq!(language_of("-"), "");
        assert_eq!(language_of("123"), "123");
    }

    #[test]
    fn locale_windows_asli_terbaca() {
        // Menguji jalur Win32 sungguhan. Kalau API-nya berubah atau buffer 85
        // ternyata kekecilan, test ini gagal - bukan diam-diam mengembalikan
        // None yang membuat semua user dapat bahasa default.
        match system_locale() {
            Some(loc) => {
                assert!(!loc.is_empty(), "locale tidak boleh string kosong");
                assert!(!loc.contains('\0'), "terminator NUL belum dibuang");
                let lang = language_of(&loc);
                assert!(!lang.is_empty(), "kode bahasa tidak boleh kosong: {}", loc);
                // Bentuk BCP-47 yang diharapkan: xx atau xx-YY (huruf/hyphen).
                assert!(
                    lang.chars().all(|c| c.is_ascii_alphanumeric()),
                    "kode bahasa hanya boleh alfanumerik, dapat {:?}",
                    lang
                );
            }
            // Tidak mungkin terjadi di Windows modern, tapi kalau environment-nya
            // memang tidak punya locale tidak apa-apa - pemanggil sudah
            // menyiapkan bahasa bawaan.
            None => { /* diterima */ }
        }
    }

    // ---- soundboard: metadata library ----

    #[test]
    fn tag_dirapikan_dan_didedupe() {
        let tags = normalize_tags(vec![
            "  Meme ".into(),
            "#meme".into(),
            "".into(),
            "   ".into(),
            "Discord".into(),
            "discord".into(),
        ]);
        assert_eq!(tags, vec!["Meme", "Discord"]);
    }

    #[test]
    fn tag_dibatasi_jumlah_dan_panjang() {
        let banyak: Vec<String> = (0..20).map(|i| format!("tag-{i}")).collect();
        let tags = normalize_tags(banyak);
        assert_eq!(tags.len(), SOUND_TAG_MAX);

        // 24 byte ASCII; emoji multibyte tidak boleh terpotong di tengah char.
        let tags = normalize_tags(vec![format!("{}😀", "a".repeat(40))]);
        assert_eq!(tags.len(), 1);
        assert!(tags[0].len() <= SOUND_TAG_LEN);
        assert!(tags[0].chars().all(|c| c != '\u{FFFD}'));
    }

    #[test]
    fn warna_hex_divalidasi() {
        assert_eq!(normalize_color("#4ECDC4").unwrap(), Some("#4ecdc4".into()));
        assert_eq!(normalize_color("4ecdc4").unwrap(), Some("#4ecdc4".into()));
        assert_eq!(normalize_color("   ").unwrap(), None);
        assert!(normalize_color("#12345").is_err());
        assert!(normalize_color("teal").is_err());
    }

    // ---- soundboard: trim ----

    #[test]
    fn trim_penuh_dinormalkan_jadi_tanpa_trim() {
        // Memilih seluruh file sama dengan tidak trim; simpan 0/0 supaya file
        // yang diganti tidak mewarisi rentang lama.
        assert_eq!(normalize_trim(0, 10_000, 10_000).unwrap(), (0, 0));
        assert_eq!(normalize_trim(0, 0, 10_000).unwrap(), (0, 0));
    }

    #[test]
    fn trim_di_clamp_ke_durasi() {
        assert_eq!(normalize_trim(1_000, 99_000, 10_000).unwrap(), (1_000, 10_000));
        assert_eq!(normalize_trim(5_000, 0, 10_000).unwrap(), (5_000, 0));
        // Awal tepat di/lewat durasi berarti tidak ada audio yang tersisa.
        assert!(normalize_trim(10_000, 0, 10_000).is_err());
        assert!(normalize_trim(12_000, 0, 10_000).is_err());
    }

    #[test]
    fn trim_akhir_harus_setelah_awal() {
        assert!(normalize_trim(3_000, 1_000, 10_000).is_err());
        assert!(normalize_trim(3_000, 3_000, 10_000).is_err());
        // 0 berarti "sampai akhir", jadi awal 1 detik tetap valid.
        assert_eq!(normalize_trim(1_000, 0, 10_000).unwrap(), (1_000, 0));
    }

    #[test]
    fn trim_tanpa_durasi_tidak_menebak() {
        assert_eq!(normalize_trim(500, 2_500, 0).unwrap(), (500, 2_500));
        assert!(normalize_trim(2_500, 500, 0).is_err());
    }
}