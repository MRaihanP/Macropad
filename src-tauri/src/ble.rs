// =================== BLE TRANSPORT (WinRT GATT) ===================
//
// Implementasi BLE GATT client menggunakan WinRT APIs.
// Dipakai Phase 10 untuk menggantikan/menambah transport USB CDC.
//
// PENTING: objek WinRT (BluetoothLEDevice, GattCharacteristic, ...)
// berbasis IUnknown yang TIDAK bersifat Send, jadi tidak boleh
// menyeberang thread. Seluruh method BleTransport WAJIB dipanggil
// dari thread yang sama - dalam praktiknya thread worker BLE di
// lib.rs (BleRequest), yang juga menginisialisasi COM.
//
// Arsitektur:
//  - BleTransport: struct dengan method sinkron (mirip serial)
//  - Scan: menemukan device MacroPad via service UUID
//  - Connect: hubungkan ke GATT server, subscribe notifications
//  - Write: kirim command ke TX characteristic
//  - Notify: terima response/event via RX characteristic notification
//
// UUID MacroPad (harus sama di firmware dan app):
//  Service:        6e400001-b5a3-f393-e0a9-e50e24dcca9e (Nordic UART Service)
//  TX (write):     6e400002-b5a3-f393-e0a9-e50e24dcca9e
//  RX (notify):    6e400003-b5a3-f393-e0a9-e50e24dcca9e

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristic, GattClientCharacteristicConfigurationDescriptorValue,
    GattCommunicationStatus, GattDeviceService, GattWriteOption,
};
use windows::Devices::Bluetooth::BluetoothLEDevice;
use windows::Devices::Enumeration::{DeviceInformation, DeviceWatcher};
use windows::Storage::Streams::{DataReader, DataWriter};
use windows::Foundation::TypedEventHandler;
use windows::core::{GUID, IInspectable};

// Logging helper
macro_rules! ble_log {
    ($($arg:tt)*) => { eprintln!("[BLE] {}", format!($($arg)*)) };
}

// Type alias untuk mempermudah generic parameters (nama singkat agar tidak konflik dengan parser)
type BleGattEvent = windows::Devices::Bluetooth::GenericAttributeProfile::GattValueChangedEventArgs;

// Nordic UART Service UUID (disusun sebagai GUID windows-core).
// GUID::from_values(data1, data2, data3, data4).
const MACROPAD_SERVICE_UUID: GUID = GUID::from_values(
    0x6e40_0001,
    0xb5a3,
    0xf393,
    [0xe0, 0xa9, 0xe5, 0x0e, 0x24, 0xdc, 0xca, 0x9e],
);
const MACROPAD_TX_UUID: GUID = GUID::from_values(
    0x6e40_0002,
    0xb5a3,
    0xf393,
    [0xe0, 0xa9, 0xe5, 0x0e, 0x24, 0xdc, 0xca, 0x9e],
); // write (app -> device)
const MACROPAD_RX_UUID: GUID = GUID::from_values(
    0x6e40_0003,
    0xb5a3,
    0xf393,
    [0xe0, 0xa9, 0xe5, 0x0e, 0x24, 0xdc, 0xca, 0x9e],
); // notify (device -> app)

// Menjalankan operasi async WinRT secara sinkron lewat futures::executor.
// IAsyncOperation bisa di-await berkat windows-future; di sini kita
// block-on dari konteks sinkron (thread BLE worker).
fn block_on_winrt<T: windows::core::RuntimeType>(
    op: windows::core::Result<windows_future::IAsyncOperation<T>>,
) -> windows::core::Result<T> {
    futures::executor::block_on(async { op?.await })
}

/// Penghitung lapis LINK (L1), sisi host.
///
/// Semuanya dulu "tidak terlihat": notify yang datang lalu hilang diam-diam
/// ketika buffer penuh, dan write yang gagal tanpa laporan (app hanya melihat
/// "tidak sampai"). Sekarang semuanya bisa dibaca lewat `ble_stats`, jadi
/// keputusan "masalahnya di radio, di app, atau di device" diambil dari angka,
/// bukan dari mencoba-coba.
///
/// Angka dikumpulkan lewat Arc<Mutex<..>> karena handler notifikasi dijalankan
/// oleh thread WinRT, bukan thread worker BLE yang memegang &mut self.
#[derive(serde::Serialize, Clone, Default, Debug)]
pub struct BleStats {
    /// Berapa kali callback notifikasi benar-benar memberikan payload.
    pub notify_events: u64,
    /// Total byte notifikasi yang masuk ke rx_buffer.
    pub notify_bytes: u64,
    /// Byte yang DIBUANG karena rx_buffer penuh.
    ///
    /// Ini angka yang paling penting. Nilai > 0 berarti ada data yang hilang
    /// sebelum sampai ke app, dan penyebabnya hampir selalu app yang berhenti
    /// menarik (jendela ditutup / laptop tidur), bukan radio.
    pub rx_dropped_bytes: u64,
    /// Berapa kali overflow terjadi (bukan per byte).
    pub rx_overflow_events: u64,
    pub read_calls: u64,
    pub read_bytes: u64,
    pub write_calls: u64,
    pub write_bytes: u64,
    pub write_errors: u64,
    /// WriteWithoutResponse: dikirim ke characteristic TX tanpa menunggu
    /// ack firmware. Dipakai Fase 5 untuk CFG_WRITE sehingga host tidak
    /// menunggu ack per chunk (setiap ack = satu notifikasi RX yang
    /// memaksa device menyiapkan buffer, dan pada link BLE flak itu justru
    /// memicu 0x80650011 "Insufficient Resources" pada host).
    pub write_no_ack: u64,
    /// WriteWithoutResponse yang GAGAL — biasanya karena device buffer
    /// penuh atau link tidak sehat. Karena WWNOR tidak ada balasannya,
    /// counter ini adalah satu-satunya bukti bahwa byte tidak sampai.
    pub write_no_ack_dropped: u64,
    pub connect_count: u64,
    pub disconnect_count: u64,
    /// Notifikasi diterima saat buffer sudah >= batas. Indikasi app menarik
    /// data lebih lambat dari device mengirim, bukan link yang lambat.
    pub notify_while_buffered: u64,
    /// Episode overflow sedang berjalan (sudah dilog, belum selesai).
    /// Dipakai supaya satu episode = satu baris log.
    pub overflow_logged: bool,
}

// Batas keras rx_buffer. Dipindah ke luar fungsi karena dipakai oleh handler
// notifikasi (thread WinRT) sekaligus read_bulk (thread worker).
const RX_BUFFER_MAX: usize = 256 * 1024;

pub struct BleTransport {
    device: Option<BluetoothLEDevice>,
    service: Option<GattDeviceService>,
    tx_char: Option<GattCharacteristic>,
    rx_char: Option<GattCharacteristic>,
    rx_buffer: Arc<Mutex<VecDeque<u8>>>,
    stats: Arc<Mutex<BleStats>>,
    connected: bool,
    // WinRT event token di windows 0.61 bertipe i64 (bukan EventRegistrationToken).
    value_changed_token: Option<i64>,
}

// Membersihkan handle WinRT saat object di-drop.
//
// Tanpa ini, BleTransport yang diganti (mis. pada reconnect yang menyalakan
// transport baru SEBELUM yang lama diruntuhkan) meninggalkan semuanya:
//
//   - handler ValueChanged yang masih terpasang pada characteristic
//   - CCCD yang masih bernilai "notify" - device masih push ke characteristic
//     yang tidak lagi punya handler
//   - handle GATT service yang belum di-Close, sehingga Windows menahan
//     session dan connect berikutnya bisa gagal dengan sharing violation
//
// Semuanya menumpuk tiap reconnect, dan gejalanya muncul sebagai connect
// gagal dengan 0x800704C7 / "TX characteristic not registered" - pola yang
// persis sama dengan yang dicatat sebagai "racun Windows".
//
// Penting: disconnect() dipanggil DULU pada jalur normal, jadi pemanggilannya
// kedua di sini tidak merusak apa pun - field-nya sudah None.
impl Drop for BleTransport {
    fn drop(&mut self) {
        self.disconnect();
    }
}

impl BleTransport {
    pub fn new() -> Self {
        Self {
            device: None,
            service: None,
            tx_char: None,
            rx_char: None,
            rx_buffer: Arc::new(Mutex::new(VecDeque::new())),
            stats: Arc::new(Mutex::new(BleStats::default())),
            connected: false,
            value_changed_token: None,
        }
    }

    // Scan untuk device MacroPad (mencari service UUID).
    // Sinkron: tidur 5 detik sambil DeviceWatcher mengumpulkan device,
    // lalu berhenti dan mengembalikan hasilnya.
    pub fn scan() -> Result<Vec<DeviceInformation>, String> {
        // PENTING: AQS "System.Devices.Aep.ProtocolId" berisi GUID PROTOKOL,
        // bukan UUID service. Untuk BLE nilainya 00000e0c-0000-1000-8000-00805f9b34fb.
        // Memasang UUID service NUS ke sana tidak akan pernah cocok, sehingga
        // watcher tidak pernah memberi hasil apa pun.
        //
        // API yang benar adalah GattDeviceService::GetDeviceSelectorFromUuid(),
        // yang mengubah UUID service jadi string AQS yang memang bisa dipakai
        // DeviceInformation::CreateWatcherAqsFilter().
        let selector = GattDeviceService::GetDeviceSelectorFromUuid(MACROPAD_SERVICE_UUID)
            .map_err(|e| format!("Gagal menyusun AQS dari UUID service: {}", e))?;
        let watcher = DeviceInformation::CreateWatcherAqsFilter(&selector)
            .map_err(|e| format!("Gagal create watcher: {}", e))?;

        // Channel std biasa: watcher berhenti -> kirim hasil.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<DeviceInformation>>();
        let devices: Arc<Mutex<Vec<DeviceInformation>>> = Arc::new(Mutex::new(Vec::new()));
        let devices_clone = devices.clone();
        // Sender oneshot dikonsumsi oleh send(), tapi closure handler
        // bertipe FnMut (boleh dipanggil berkali-kali) -bungkus dalam
        // Option supaya cuma terkirim sekali.
        let tx = Arc::new(Mutex::new(Some(tx)));
        let tx_clone = tx.clone();

        // Closure handler WinRT menerima windows_core::Ref<'_, T>.
        // Ref deref ke Option<T> untuk tipe WinRT (T::Default = Option<T>).
        let added_handler = TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
            move |_watcher, info| {
                if let Some(info) = &*info {
                    devices_clone.lock().unwrap().push(info.clone());
                }
                Ok(())
            },
        );

        let stopped_handler = TypedEventHandler::<DeviceWatcher, IInspectable>::new(
            move |_watcher, _args| {
                // Watcher berhenti: kirim seluruh device yang terkumpul.
                let devices = devices.lock().unwrap().drain(..).collect();
                if let Some(tx) = tx_clone.lock().unwrap().take() {
                    let _ = tx.send(devices);
                }
                Ok(())
            },
        );

        let token_added = watcher
            .Added(&added_handler)
            .map_err(|e| format!("Gagal add handler: {}", e))?;
        let token_stopped = watcher
            .Stopped(&stopped_handler)
            .map_err(|e| format!("Gagal stop handler: {}", e))?;

        eprintln!(
            "[ble-trace] scan mulai: AQS selector={:?}",
            selector
        );
        watcher
            .Start()
            .map_err(|e| format!("Gagal start watcher: {}", e))?;
        eprintln!("[ble-trace] watcher berjalan, menunggu 5 detik");

        // Biarkan watcher berjalan 5 detik untuk menemukan device BLE di sekitar.
        thread::sleep(Duration::from_secs(5));

        // Stop() memicu event Stopped, yang mengirim hasil lewat channel `rx`.
        watcher.Stop().map_err(|e| format!("Gagal stop watcher: {}", e))?;

        // Tunggu event Stopped (dengan timeout pengaman supaya tidak hang
        // selamanya kalau Watcher tidak pernah berhenti).
        let devices = match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(devices) => devices,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                watcher.RemoveAdded(token_added).ok();
                watcher.RemoveStopped(token_stopped).ok();
                return Err("Waktu tunggu hasil scan BLE habis".to_string());
            }
            Err(e) => {
                return Err(format!("Channel hasil scan tertutup: {}", e));
            }
        };

        // Lepaskan handler sekarang setelah Stopped pasti sudah terkirim.
        watcher.RemoveAdded(token_added).ok();
        watcher.RemoveStopped(token_stopped).ok();

        // Tanpa baris ini, "scan tidak menemukan apa pun" sama sekali tidak
        // bisa dibedakan dari "device tidak ada di ruangan". Dua kemungkinan
        // yang butuh tindakan BERBEDA, dan salah satunya akan membuat user
        // mengantar-mendekatkan device tanpaLB解决问题.
        eprintln!(
            "[ble-trace] scan selesai: {} device ditemukan",
            devices.len()
        );
        for d in &devices {
            eprintln!(
                "[ble-trace]   - id={} nama={:?} paired={}",
                d.Id().map(|s| s.to_string()).unwrap_or_default(),
                d.Name().map(|s| s.to_string()).unwrap_or_default(),
                // Pairing().IsPaired() - d.Paired() tidak ada di DeviceInformation
                // dan gagal compile. Salin persis dari pemetaan di lib.rs.
                d.Pairing()
                    .ok()
                    .and_then(|p| p.IsPaired().ok())
                    .unwrap_or(false)
            );
        }

        Ok(devices)
    }

    // Connect ke device lewat DeviceInformation. Sinkron.
    pub fn connect(&mut self, device_info: &DeviceInformation) -> Result<(), String> {
        let id = device_info
            .Id()
            .map_err(|e| format!("Gagal get device id: {}", e))?;
        eprintln!("[ble-trace] connect ke id={}", id.to_string());
        let device = block_on_winrt(BluetoothLEDevice::FromIdAsync(&id))
            .map_err(|e| format!("Gagal connect BLE: {}", e))?;
        eprintln!("[ble-trace] FromIdAsync OK, status={:?}", device.ConnectionStatus());

        // Dapatkan service
        let services = block_on_winrt(device.GetGattServicesForUuidAsync(MACROPAD_SERVICE_UUID))
            .map_err(|e| format!("Gagal get services: {}", e))?;
        let service = services
            .Services()
            .map_err(|e| format!("Gagal get services list: {}", e))?
            .GetAt(0)
            .map_err(|e| format!("Gagal ambil service: {}", e))?;

        // Dapatkan TX characteristic (write)
        let tx_chars = block_on_winrt(service.GetCharacteristicsForUuidAsync(MACROPAD_TX_UUID))
            .map_err(|e| format!("Gagal get TX char: {}", e))?;
        let tx_list = tx_chars
            .Characteristics()
            .map_err(|e| format!("Gagal get TX characteristics: {}", e))?;
        // Koleksi kosong berarti service NUS ada tapi characteristic-nya belum
        // terdaftar dari sisi host. Ini terjadi kalau connect dijalankan saat
        // link lama belum benar-benar terlepas - Windows mengembalikan cache
        // GATT yang belum lengkap, dan GetAt(0) gagal dengan E_BOUNDS
        // (0x8000000B).
        //
        // Dicek eksplisit supaya pesannya menyebut penyebabnya, bukan sekadar
        // "index di luar jangkauan" yang tidak membantu sama sekali.
        if tx_list.Size().unwrap_or(0) == 0 {
            return Err(
                "Service NUS ditemukan tapi characteristic TX belum terdaftar \
                 (link BLE mungkin belum stabil dari percobaan sebelumnya). \
                 Tunggu sebentar lalu coba lagi."
                    .to_string(),
            );
        }
        let tx_char = tx_list
            .GetAt(0)
            .map_err(|e| format!("Gagal ambil TX characteristic: {}", e))?;

        // Dapatkan RX characteristic (notify)
        let rx_chars = block_on_winrt(service.GetCharacteristicsForUuidAsync(MACROPAD_RX_UUID))
            .map_err(|e| format!("Gagal get RX char: {}", e))?;
        let rx_list = rx_chars
            .Characteristics()
            .map_err(|e| format!("Gagal get RX characteristics: {}", e))?;
        if rx_list.Size().unwrap_or(0) == 0 {
            return Err(
                "Service NUS ditemukan tapi characteristic RX belum terdaftar \
                 (link BLE mungkin belum stabil dari percobaan sebelumnya). \
                 Tunggu sebentar lalu coba lagi."
                    .to_string(),
            );
        }
        let rx_char = rx_list
            .GetAt(0)
            .map_err(|e| format!("Gagal ambil RX characteristic: {}", e))?;
        eprintln!("[ble-trace] characteristic NUS TX + RX ditemukan");

        // Subscribe notifications
        let buffer = self.rx_buffer.clone();
        let stats = self.stats.clone();
        let handler = TypedEventHandler::<GattCharacteristic, BleGattEvent>::new(
            move |_sender, args| {
                if let Some(args) = &*args {
                    if let Ok(value) = args.CharacteristicValue() {
                        if let Ok(reader) = DataReader::FromBuffer(&value) {
                            if let Ok(len) = reader.UnconsumedBufferLength() {
                                let mut bytes = vec![0u8; len as usize];
                                if reader.ReadBytes(&mut bytes).is_ok() {
                                    if let Ok(mut st) = stats.lock() {
                                        st.notify_events += 1;
                                        st.notify_bytes += bytes.len() as u64;
                                        // Dicatat SEBELUM buffer penuh dicek, supaya
                                        // "notify datang saat antrean sudah panjang"
                                        // bisa dibedakan dari notify yang kemudian hilang.
                                        if buffer
                                            .lock()
                                            .map(|b| b.len() >= RX_BUFFER_MAX / 2)
                                            .unwrap_or(false)
                                        {
                                            st.notify_while_buffered += 1;
                                        }
                                    }
                                    if let Ok(mut buf) = buffer.lock() {
                                        // Batas keras. Tanpa ini, kalau frontend
                                        // berhenti mengambil (jendela ditutup,
                                        // laptop tidur) buffer tumbuh tanpa
                                        // akhir dan seluruh app ikut kehabisan
                                        // memori. Saat penuh, byte LAMA dibuang.
                                        //
                                        // PERUBAHAN: byte yang dibuang sekarang
                                        // DIHITUNG dan dilaporkan lewat ble_stats.
                                        // Sebelumnya ini terjadi tanpa jejak, jadi
                                        // data yang hilang sama sekali tidak bisa
                                        // dibedakan dari data yang tidak pernah
                                        // dikirim - padahal penyebabnya sama
                                        // sekali berbeda.
                                        let mut dropped = 0u64;
                                        while buf.len() + bytes.len() > RX_BUFFER_MAX
                                            && !buf.is_empty()
                                        {
                                            buf.pop_front();
                                            dropped += 1;
                                        }
                                        if dropped > 0 {
                                            let mut log_it = false;
                                            if let Ok(mut st) = stats.lock() {
                                                st.rx_dropped_bytes += dropped;
                                                st.rx_overflow_events += 1;
                                                // Log hanya pada overflow PERTAMA tiap
                                                // episode. Kalau dicatat tiap notifikasi,
                                                // panel log dibanjiri baris yang sama dan
                                                // baris yang penting justru tenggelam.
                                                if !st.overflow_logged {
                                                    st.overflow_logged = true;
                                                    log_it = true;
                                                }
                                            }
                                            if log_it {
                                                eprintln!(
                                                    "[ble-trace] RX BUFFER PENUH: episode dimulai, \
                                                     {} byte dibuang. App berhenti menarik data - \
                                                     ini sisi app/host, BUKAN radio.",
                                                    dropped
                                                );
                                            }
                                        } else if let Ok(mut st) = stats.lock() {
                                            // Episode selesai: buffer sudah kembali
                                            // normal, jadi episode berikutnya boleh
                                            // logged lagi.
                                            st.overflow_logged = false;
                                        }
                                        let preview: String = bytes
                                            .iter()
                                            .take(48)
                                            .map(|&b| {
                                                if (0x20..0x7f).contains(&b) { b as char } else { '.' }
                                            })
                                            .collect();
                                        eprintln!(
                                            "[ble-trace] NOTIFY masuk: {} byte \"{}\" (buffer={} byte)",
                                            bytes.len(),
                                            preview,
                                            buf.len()
                                        );
                                        for b in bytes {
                                            buf.push_back(b);
                                        }
                                    } else {
                                        // Log ini penting: mutex yang dipoison
                                        // membuat notify DILEWATI tanpa error ke
                                        // frontend, dan gejalanya persis sama
                                        // dengan "tidak menerima apa-apa".
                                        eprintln!("[ble-trace] NOTIFY masuk tapi GAGAL lock buffer (poisoned)");
                                    }
                                } else {
                                    eprintln!("[ble-trace] NOTIFY masuk tapi GAGAL baca byte");
                                }
                            } else {
                                eprintln!("[ble-trace] NOTIFY masuk tapi GAGAL ambil panjang");
                            }
                        } else {
                            eprintln!("[ble-trace] NOTIFY masuk tapi GAGAL buat DataReader");
                        }
                    } else {
                        eprintln!("[ble-trace] NOTIFY masuk tapi GAGAL ambil CharacteristicValue");
                    }
                } else {
                    eprintln!("[ble-trace] NOTIFY event tanpa args");
                }
                Ok(())
            },
        );

        let token = rx_char
            .ValueChanged(&handler)
            .map_err(|e| format!("Gagal register value changed: {}", e))?;
        block_on_winrt(
            rx_char
                .WriteClientCharacteristicConfigurationDescriptorAsync(
                    GattClientCharacteristicConfigurationDescriptorValue::Notify,
                ),
        )
        .map_err(|e| format!("Gagal enable notify: {}", e))?;
        // Titik paling penting untuk diagnostik: kalau baris ini tidak muncul,
        // masalahnya DI BAWAH companion app (pairing/CCCD/stack BT), dan tidak
        // ada yang bisa diperbaiki di repo ini. Kalau muncul tapi baris NOTIFY
        // di bawah tidak pernah datang, masalahnya advertising/subscribe.
        eprintln!("[ble-trace] notify DISUBSCRIBE-kan, siap menerima data dari device");

        self.device = Some(device);
        self.service = Some(service);
        self.tx_char = Some(tx_char);
        self.rx_char = Some(rx_char);
        self.value_changed_token = Some(token);
        self.connected = true;
        if let Ok(mut st) = self.stats.lock() {
            st.connect_count += 1;
        }

        ble_log!("Connected to MacroPad");
        Ok(())
    }

    /// Snapshot penghitung L1 untuk ditampilkan di panel log aplikasi.
    ///
    /// Sengaja-readonly: laporan harus bisa diambil KAPAN SAJA tanpa mengubah
    /// state koneksi. Kalau ini ikut disconnect, angka terakhir hilang tepat di
    /// saat paling dibutuhkan yaitu setelah link putus.
    pub fn stats(&self) -> BleStats {
        self.stats.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn disconnect(&mut self) {
        if let (Some(rx_char), Some(token)) = (self.rx_char.take(), self.value_changed_token.take()) {
            // Hapus langganan event ValueChanged (bukan memanggil ValueChanged lagi).
            let _ = rx_char.RemoveValueChanged(token);

            // Matikan notifikasi di sisi device juga (CCCD = None). Kalau tidak,
            // device masih mengira ada yang mendengarkan dan Windows tetap
            // mengirim notifikasi ke characteristic yang sudah dilepas handler-nya.
            let _ = block_on_winrt(
                rx_char.WriteClientCharacteristicConfigurationDescriptorAsync(
                    GattClientCharacteristicConfigurationDescriptorValue::None,
                ),
            );
        }

        // Tutup handle service GATT. Tanpa ini Windows bisa menahan handle
        // dan connect berikutnya bisa gagal dengan sharing violation.
        if let Some(service) = self.service.take() {
            let _ = service.Close();
        }

        self.device = None;
        self.tx_char = None;
        self.rx_char = None;
        self.connected = false;
        self.rx_buffer.lock().map(|mut b| b.clear()).ok();
        if let Ok(mut st) = self.stats.lock() {
            st.disconnect_count += 1;
            // Episode overflow ditutup supaya disconnect berikutnya mulai dari
            // log yang bersih, bukan melanjutkan episode yang sudah selesai.
            st.overflow_logged = false;
        }
        ble_log!("Disconnected");
    }

    pub fn is_connected(&self) -> bool {
        // WAJIB baca status link sungguhan dari Windows, bukan hanya flag
        // lokal. Flag lokal diset true saat connect() dan tidak pernah
        // disentuh lagi, sehingga kalau Windows memutus koneksi (device sleep,
        // BT dimatikan, jarak terlalu jauh) app masih mengira device tersambung
        // - semua write berikutnya diam-diam gagal dan tidak ada yang melapor.
        if !self.connected {
            return false;
        }
        match self.device.as_ref() {
            None => false,
            Some(d) => matches!(
                d.ConnectionStatus(),
                Ok(windows::Devices::Bluetooth::BluetoothConnectionStatus::Connected)
            ),
        }
    }

    /// Ambil sekaligus sebanyak mungkin, paling banyak `max_len` byte.
    ///
    /// Dipakai oleh command `ble_read`. Versi lama mengambil per-byte lewat
    /// read(), yang butuh satu round-trip WinRT untuk SETIAP byte - untuk
    /// jawaban DUMP yang ratusan byte, itu ratusan IPC call hanya untuk
    /// membaca satu baris protokol.
    ///
    /// Batas buffer RX sudah dipasang di sisi producer (handler notifikasi).
    pub fn read_bulk(&mut self, max_len: usize) -> Vec<u8> {
        let out: Vec<u8> = self
            .rx_buffer
            .lock()
            .map(|mut buf| {
                let take = buf.len().min(max_len);
                buf.drain(..take).collect()
            })
            .unwrap_or_default();
        if let Ok(mut st) = self.stats.lock() {
            st.read_calls += 1;
            st.read_bytes += out.len() as u64;
        }
        // Hanya log saat ADA isinya. Kalau log ditulis setiap panggilan,
        // loop 40 ms di frontend menghasilkan 25 baris/detik yang tidak
        // pernah informatif.
        if !out.is_empty() {
            let preview: String = out
                .iter()
                .take(48)
                .map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '.' })
                .collect();
            eprintln!("[ble-trace]   -> DIKIRIM ke app: {} byte \"{}\"", out.len(), preview);
        }
        out
    }

    pub fn write(&mut self, data: &[u8]) -> Result<usize, String> {
        // Dihitung SEBELUM cabang hasil, jadi write yang gagal karena tidak
        // connected juga tercatat. Write yang gagal tanpa jejak adalah alasan
        // paling sering "app mengira terkirim padahal tidak".
        if let Ok(mut st) = self.stats.lock() {
            st.write_calls += 1;
            st.write_bytes += data.len() as u64;
        }
        if let Some(tx_char) = &self.tx_char {
            let writer = DataWriter::new().map_err(|e| format!("Gagal create DataWriter: {}", e))?;
            writer
                .WriteBytes(data)
                .map_err(|e| format!("Gagal write bytes: {}", e))?;
            let buffer = writer
                .DetachBuffer()
                .map_err(|e| format!("Gagal detach buffer: {}", e))?;

            // WAJIB WriteWithResponse, bukan WriteWithoutResponse.
            //
            // WriteWithoutResponse tidak punya flow control: ATT packet bisa
            // hilang tanpa error sama sekali. Untuk data stream (event HID)
            // itu tidak masalah, tapi untuk PERINTAH protokol seperti
            // "SET:0:0:0:KEY:a" kehilangan packet berarti config tidak
            // tersimpan dan app tidak pernah tahu - desync senyap.
            //
            // Firmware mendeklarasikan NUS TX dengan WRITE | WRITE_NR
            // (ble_hid.h), jadi write-with-response pasti didukung.
            let result = block_on_winrt(
                tx_char.WriteValueWithOptionAsync(&buffer, GattWriteOption::WriteWithResponse),
            )
            .map_err(|e| format!("BLE write failed: {}", e))?;

            if result == GattCommunicationStatus::Success {
                Ok(data.len())
            } else {
                if let Ok(mut st) = self.stats.lock() {
                    st.write_errors += 1;
                }
                Err(format!("BLE write failed: {:?}", result))
            }
        } else {
            Err("Not connected".to_string())
        }
    }

    pub fn write_no_ack(&mut self, data: &[u8]) -> Result<usize, String> {
        // WriteWithoutResponse: tidak ada ack, jadi kegagalan biasanya
        // berarti link/device yang tidak sehat - bukan koneksi yang benar-benar
        // putus. Jangan biarkan satu write WWNOR gagal menghancurkan sesi;
        // cukup catat ke counter dan beri tahu app supaya ia bisa throttle.
        if let Ok(mut st) = self.stats.lock() {
            st.write_no_ack += 1;
            st.write_bytes += data.len() as u64;
        }
        if let Some(tx_char) = &self.tx_char {
            let writer = DataWriter::new().map_err(|e| format!("Gagal create DataWriter: {}", e))?;
            writer
                .WriteBytes(data)
                .map_err(|e| format!("Gagal write bytes: {}", e))?;
            let buffer = writer
                .DetachBuffer()
                .map_err(|e| format!("Gagal detach buffer: {}", e))?;
            // WriteWithoutResponse tidak mengharapkan GattCommunicationStatus
            // success sebagai konfirmasi - pada banyak stack, operasi ini
            // "berhasil" walhasil link sudah mulai putus asal queue host masih
            // menerima. Yang dibedakan di sini adalah apakah WinRT menolak
            // packet SEKALI LANGKAH (Insufficient Resources / link down).
            let result = block_on_winrt(
                tx_char.WriteValueWithOptionAsync(&buffer, GattWriteOption::WriteWithoutResponse),
            )
            .map_err(|e| format!("BLE write no-ack failed: {}", e))?;
            if result == GattCommunicationStatus::Success {
                Ok(data.len())
            } else {
                if let Ok(mut st) = self.stats.lock() {
                    st.write_no_ack_dropped += 1;
                }
                Err(format!("BLE write no-ack failed: {:?}", result))
            }
        } else {
            Err("Not connected".to_string())
        }
    }
}
