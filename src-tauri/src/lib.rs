use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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

#[derive(Serialize, Deserialize, Clone)]
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
fn load_data(app: &tauri::AppHandle) -> AppData {
    data_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn save_data(app: &tauri::AppHandle, d: &AppData) {
    if let Some(p) = data_path(app) {
        if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
        if let Ok(s) = serde_json::to_string(d) { let _ = std::fs::write(p, s); }
    }
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

fn find_app(d: &AppData, name: &str) -> Option<AppEntry> {
    let n = name.trim().to_lowercase();
    if n.is_empty() { return None; }
    let all = || d.custom.iter().chain(d.apps.iter());
    all()
        .find(|a| a.name.to_lowercase() == n)
        // nama dari firmware bisa terpotong (batas 47 karakter), jadi cocokkan juga awalannya
        .or_else(|| all().find(|a| a.name.to_lowercase().starts_with(&n)))
        .cloned()
}

fn launch_impl(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    let mut data = load_data(app);
    let mut found = find_app(&data, name);
    if found.is_none() && data.consent {
        // mungkin aplikasi baru diinstal: scan ulang sekali lalu coba lagi
        data.apps = scan_start_apps();
        data.scanned_at = now_secs();
        save_data(app, &data);
        found = find_app(&data, name);
    }
    let entry = found.ok_or_else(|| {
        format!("Aplikasi tidak ditemukan: {} (buka app, pilih aplikasi lagi dan Scan ulang)", name)
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
    if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
    let s = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    std::fs::write(p, s).map_err(|e| e.to_string())
}

#[tauri::command]
fn apps_get(app: tauri::AppHandle) -> AppsView { view_of(&load_data(&app)) }

#[tauri::command]
fn apps_set_consent(app: tauri::AppHandle, value: bool) {
    let mut d = load_data(&app);
    d.consent = value;
    save_data(&app, &d);
}

#[tauri::command]
fn apps_set_ttl(app: tauri::AppHandle, days: u32) {
    let mut d = load_data(&app);
    d.ttl_days = days.max(1);
    save_data(&app, &d);
}

#[tauri::command]
async fn apps_rescan(app: tauri::AppHandle) -> Result<AppsView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = load_data(&app);
        d.apps = scan_start_apps();
        d.scanned_at = now_secs();
        save_data(&app, &d);
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
    save_data(&app, &d);
    Ok(())
}

#[tauri::command]
fn apps_remove_custom(app: tauri::AppHandle, name: String) {
    let mut d = load_data(&app);
    d.custom.retain(|a| !a.name.eq_ignore_ascii_case(&name));
    save_data(&app, &d);
}

#[tauri::command]
async fn launch_app(app: tauri::AppHandle, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || launch_impl(&app, &name))
        .await
        .map_err(|e| e.to_string())?
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
    let _ = w.set_ignore_cursor_events(true);
    Ok(w)
}

// async: jalan di thread pool, BUKAN main thread, supaya tidak pernah memblokir UI/serial
#[tauri::command]
async fn notify(app: tauri::AppHandle, text: String, kind: String, hold: Option<u64>) -> Result<(), String> {
    let w = ensure_overlay(&app)?;
    let hold = hold.unwrap_or(3000).clamp(300, 10000);

    // Posisi & show hanya saat overlay sedang tersembunyi (hindari show/hide beruntun)
    if !w.is_visible().unwrap_or(false) {
        if let (Ok(Some(m)), Ok(size)) = (app.primary_monitor(), w.outer_size()) {
            let x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, m.position().y));
        }
        let _ = w.show();
    }

    // Masuk antrean di halaman overlay: aman walau halamannya belum selesai dimuat
    let payload = serde_json::json!({ "text": text, "kind": kind, "hold": hold });
    let _ = w.eval(&format!(
        "(window.__notifyQ=window.__notifyQ||[]).push({});window.__drain&&window.__drain();", payload));

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
            setup_tray(app)?;
            // Overlay dibuat TERTUNDA di thread lain, setelah jendela utama selesai memuat WebView2-nya.
            // Membuat dua WebView2 bersamaan saat startup rawan membuat jendela utama putih/hitam & hang.
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(3000));
                    let _ = ensure_overlay(&h);
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
                        save_data(handle, &d);
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
            show_main_window,
            hide_to_tray,
            quit_app,
            autostart_status,
            autostart_set,
            launch_app,
            get_foreground_exe,
            scan_bindable_apps,
            presets_get,
            presets_save,
            notify
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}