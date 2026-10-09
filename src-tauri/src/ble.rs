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
    GattCommunicationStatus, GattWriteOption,
};
use windows::Devices::Bluetooth::BluetoothLEDevice;
use windows::Devices::Enumeration::{DeviceInformation, DeviceWatcher};
use windows::Storage::Streams::{DataReader, DataWriter};
use windows::Foundation::TypedEventHandler;
use windows::core::{GUID, HSTRING, IInspectable};

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

pub struct BleTransport {
    device: Option<BluetoothLEDevice>,
    tx_char: Option<GattCharacteristic>,
    rx_char: Option<GattCharacteristic>,
    rx_buffer: Arc<Mutex<VecDeque<u8>>>,
    connected: bool,
    // WinRT event token di windows 0.61 bertipe i64 (bukan EventRegistrationToken).
    value_changed_token: Option<i64>,
}

impl BleTransport {
    pub fn new() -> Self {
        Self {
            device: None,
            tx_char: None,
            rx_char: None,
            rx_buffer: Arc::new(Mutex::new(VecDeque::new())),
            connected: false,
            value_changed_token: None,
        }
    }

    // Scan untuk device MacroPad (mencari service UUID).
    // Sinkron: tidur 5 detik sambil DeviceWatcher mengumpulkan device,
    // lalu berhenti dan mengembalikan hasilnya.
    pub fn scan() -> Result<Vec<DeviceInformation>, String> {
        // Gunakan AQS filter untuk service UUID.
        // {:?} pada GUID memformat "6E400001-B5A3-..." (AQS case-insensitive).
        let selector = format!("System.Devices.Aep.ProtocolId:{{{:?}}}", MACROPAD_SERVICE_UUID);
        let watcher = DeviceInformation::CreateWatcherAqsFilter(&HSTRING::from(selector))
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

        watcher
            .Start()
            .map_err(|e| format!("Gagal start watcher: {}", e))?;

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

        Ok(devices)
    }

    // Connect ke device lewat DeviceInformation. Sinkron.
    pub fn connect(&mut self, device_info: &DeviceInformation) -> Result<(), String> {
        let id = device_info
            .Id()
            .map_err(|e| format!("Gagal get device id: {}", e))?;
        let device = block_on_winrt(BluetoothLEDevice::FromIdAsync(&id))
            .map_err(|e| format!("Gagal connect BLE: {}", e))?;

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
        let tx_char = tx_chars
            .Characteristics()
            .map_err(|e| format!("Gagal get TX characteristics: {}", e))?
            .GetAt(0)
            .map_err(|e| format!("Gagal ambil TX characteristic: {}", e))?;

        // Dapatkan RX characteristic (notify)
        let rx_chars = block_on_winrt(service.GetCharacteristicsForUuidAsync(MACROPAD_RX_UUID))
            .map_err(|e| format!("Gagal get RX char: {}", e))?;
        let rx_char = rx_chars
            .Characteristics()
            .map_err(|e| format!("Gagal get RX characteristics: {}", e))?
            .GetAt(0)
            .map_err(|e| format!("Gagal ambil RX characteristic: {}", e))?;

        // Subscribe notifications
        let buffer = self.rx_buffer.clone();
        let handler = TypedEventHandler::<GattCharacteristic, BleGattEvent>::new(
            move |_sender, args| {
                if let Some(args) = &*args {
                    if let Ok(value) = args.CharacteristicValue() {
                        if let Ok(reader) = DataReader::FromBuffer(&value) {
                            if let Ok(len) = reader.UnconsumedBufferLength() {
                                let mut bytes = vec![0u8; len as usize];
                                if reader.ReadBytes(&mut bytes).is_ok() {
                                    if let Ok(mut buf) = buffer.lock() {
                                        for b in bytes {
                                            buf.push_back(b);
                                        }
                                    }
                                }
                            }
                        }
                    }
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

        self.device = Some(device);
        self.tx_char = Some(tx_char);
        self.rx_char = Some(rx_char);
        self.value_changed_token = Some(token);
        self.connected = true;

        ble_log!("Connected to MacroPad");
        Ok(())
    }

    pub fn disconnect(&mut self) {
        if let (Some(rx_char), Some(token)) = (self.rx_char.take(), self.value_changed_token.take()) {
            // Hapus langganan event ValueChanged (bukan memanggil ValueChanged lagi).
            let _ = rx_char.RemoveValueChanged(token);
        }
        self.device = None;
        self.tx_char = None;
        self.rx_char = None;
        self.connected = false;
        ble_log!("Disconnected");
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn available(&self) -> i32 {
        self.rx_buffer.lock().map(|buf| buf.len() as i32).unwrap_or(0)
    }

    pub fn read(&mut self) -> i32 {
        self.rx_buffer
            .lock()
            .map(|mut buf| buf.pop_front().map(|b| b as i32).unwrap_or(-1))
            .unwrap_or(-1)
    }

    pub fn write(&mut self, data: &[u8]) -> Result<usize, String> {
        if let Some(tx_char) = &self.tx_char {
            let writer = DataWriter::new().map_err(|e| format!("Gagal create DataWriter: {}", e))?;
            writer
                .WriteBytes(data)
                .map_err(|e| format!("Gagal write bytes: {}", e))?;
            let buffer = writer
                .DetachBuffer()
                .map_err(|e| format!("Gagal detach buffer: {}", e))?;

            let result = block_on_winrt(
                tx_char
                    .WriteValueWithOptionAsync(&buffer, GattWriteOption::WriteWithoutResponse),
            )
            .map_err(|e| format!("BLE write failed: {}", e))?;

            if result == GattCommunicationStatus::Success {
                Ok(data.len())
            } else {
                Err(format!("BLE write failed: {:?}", result))
            }
        } else {
            Err("Not connected".to_string())
        }
    }

    // Disiapkan supaya BleTransport lengkap sebagai transport
    // (USB memakai flush untuk mengosongkan buffer TX serial).
    #[allow(dead_code)]
    pub fn flush(&mut self) {
        // BLE tidak butuh flush eksplisit
    }
}
