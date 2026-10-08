// Tabel terjemahan English.
//
// Struktur: 'kunci': 'teks'. Placeholder {nama} diganti oleh t() saat pemanggilan,
// bukan di sini - supaya satu string bisa dipakai ulang untuk beberapa nilai.
//
// Kunci harus PERSIS sama dengan id.js; i18n-test.js membandingkan keduanya.
//
// Catatan penerjemahan: istilah "Knob", "Layer", "Preset", dan "Native App"
// sengaja dibiarkan dalam bahasa Inggris karena itulah yang tertulis di device
// dan di dokumentasi - mengorbankan konsistensi demi kesesuaian dengan device.
export const en = {

'nav.home': 'Home',
'nav.adaptive': 'Adaptive Key Bind',
'nav.rgb': 'RGB Setting',
'nav.settings': 'Settings',
'sidebar.toggle': 'Show/hide panel',

// ---- Header / status koneksi ----
'header.subtitle': 'ESP32-S3 · 3×3 matrix + encoder · Native App',
'header.autostart': 'Run at Windows startup',
'header.refreshPorts': 'Rescan serial ports',
'header.notConnected': 'Not connected',
'header.battery': 'Battery',
'header.connect': 'Connect',

// ---- Halaman Home ----
'home.editingPreset': 'Editing preset:',
'home.editDone': '✓ Done & Save',
'home.cancel': 'Cancel',
'home.meta.device': 'Device',
'home.meta.matrix': 'Matrix',
'home.meta.knob': 'Knob',
'home.meta.activePreset': 'Active Preset',
'home.layoutTitle': 'Key Layout',
'home.layer': 'Layer',
'home.addLayer': '+ Layer',
'home.deleteLayer': '− Delete',
'home.renameLayer': '✎ Rename',
'home.load': 'Load',
'home.reset': 'Reset',
'home.save': 'Save',
'home.log': 'Log',
'home.logLabel': 'Activity log',

// ---- Panel editor binding ----
'editor.title': 'Edit Binding',
'editor.type.0': 'NONE — empty',
'editor.type.1': 'KEY — a single character',
'editor.type.2': 'COMBO — key combination',
'editor.type.3': 'TEXT — long text',
'editor.type.4': 'CONSUMER — media/volume',
'editor.type.5': 'APP — launch an app (via companion)',
'editor.valuePlaceholder': 'e.g. a / CTRL+C / hello world',
'editor.consumer.VOLUP': 'Vol +',
'editor.consumer.VOLDOWN': 'Vol −',
'editor.consumer.MUTE': 'Mute',
'editor.consumer.PLAYPAUSE': 'Play/Pause',
'editor.consumer.NEXT': 'Next',
'editor.consumer.PREV': 'Prev',
'editor.apply': 'Apply to device',
'editor.recordHint': 'Records automatically: just press the physical keys, each key is joined with "+". Backspace = delete the last token, Delete = clear everything. Media keys (volume/play) are detected directly.',

// ---- Pemilih aplikasi ----
'appPicker.searchPlaceholder': 'Search apps...',
'appPicker.addExe': '+ Add .exe',
'appPicker.rescan': '↻ Rescan',
'appPicker.rescanEvery': 'Rescan every',
'appPicker.days': '{n} days',
'appPicker.hint': 'APP actions are executed by the companion app on this PC (runs in the tray). If it is not running, the device types the app name via Windows Search instead.',

// ---- Halaman Adaptive Key Bind ----
'adaptive.subtitle': 'Switch presets automatically when a given app becomes the active window.',
'adaptive.enableFeature': 'Enable feature',
'adaptive.addPreset': '+ Add preset',

// ---- Halaman Setting ----
'settings.subtitle': 'Companion app settings.',
'settings.globalFeatures': 'Global Features',
'settings.adaptiveName': 'Adaptive Key Bind',
'settings.adaptiveHint': 'Switch presets automatically based on the active app.',
'settings.rgbName': 'RGB',
'settings.rgbHint': 'Connect an RGB-capable device to change this.',
'settings.notifications': 'Notifications',
'settings.notifyBasicName': 'Basic notifications',
'settings.notifyBasicHint': 'Connection, layer switches, and preset switches.',
'settings.notifyKeysName': 'Per-key notifications',
'settings.notifyKeysHint': 'Pressed keys and knobs. Shown for 1 second.',
'settings.notifyBatteryName': 'Battery notifications',
'settings.notifyBatteryHint': 'Charging started, charging finished, low battery, and critical battery.',
'settings.notifyTestName': 'Test notifications',
'settings.notifyTestHint': 'Show a sample notification on screen.',
'settings.notifyTestButton': 'Test',
'settings.power': 'Power (wireless)',
'settings.sleepName': 'Automatic sleep',
'settings.sleepHint': 'Only available while a FINAL device is connected.',
'settings.sleep.off': 'Off',
'settings.sleep.minutes': '{n} minutes',
// Bahasa / i18n
'settings.language': 'Language',
'settings.languageHint': 'Interface and notifications. Initially follows your Windows language.',

// ---- Halaman RGB ----
'rgb.subtitle': 'Per-key lighting. These settings are controlled through the companion app.',
'rgb.enable': 'Enable RGB',
'rgb.mapTitle': 'RGB map — click a key to set its colour',
'rgb.knobHint': 'Knobs are not shown here; focus the key grid instead.',
'rgb.lighting': 'Lighting',
'rgb.brightness': 'Brightness',
'rgb.brightnessHint': '100% in the app = the firmware’s safe maximum (about 60% LED PWM).',
'rgb.speed': 'Speed',
'rgb.keyColor': 'Key colour',
'rgb.keyColorHint': 'Changing a key’s colour automatically switches to Custom Per Key mode.',
'rgb.lightingMode': 'Lighting Mode',
'rgb.lightingModeHint': 'Colour used by lighting modes that support one.',
'rgb.save': 'Save to device',
'rgb.reset': 'Reset to defaults',
};
