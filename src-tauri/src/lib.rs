use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfoDto {
    pub port_name: String,
    pub label: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfoDto {
    pub os: String,
    pub arch: String,
    pub family: String,
}

pub struct ActiveSerialConnection {
    pub writer: Box<dyn SerialPort>,
    pub stop_flag: Arc<AtomicBool>,
    pub port_name: String,
    pub baud_rate: u32,
}

#[derive(Default)]
pub struct SerialState {
    pub active: Mutex<Option<ActiveSerialConnection>>,
}

#[tauri::command]
fn get_platform_info() -> PlatformInfoDto {
    PlatformInfoDto {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
    }
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortInfoDto>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("枚举系统串口失败: {}", e))?;
    let mut list = Vec::with_capacity(ports.len());

    for p in ports {
        let (port_type, manufacturer, product, detail) = match &p.port_type {
            SerialPortType::UsbPort(usb) => {
                let desc = usb
                    .product
                    .as_deref()
                    .or(usb.manufacturer.as_deref())
                    .unwrap_or("USB-UART Adapter")
                    .to_string();
                (
                    format!("USB ({:04X}:{:04X})", usb.vid, usb.pid),
                    usb.manufacturer.clone(),
                    usb.product.clone(),
                    desc,
                )
            }
            SerialPortType::BluetoothPort => (
                "Bluetooth".to_string(),
                None,
                None,
                "Bluetooth Serial".to_string(),
            ),
            SerialPortType::PciPort => ("PCI".to_string(), None, None, "PCI UART".to_string()),
            SerialPortType::Unknown => ("Native".to_string(), None, None, "Serial Port".to_string()),
        };

        let label = format!("{} · {}", p.port_name, detail);
        list.push(SerialPortInfoDto {
            port_name: p.port_name,
            label,
            port_type,
            manufacturer,
            product,
        });
    }

    Ok(list)
}

#[tauri::command]
fn close_serial_port(state: State<'_, SerialState>) -> Result<(), String> {
    let mut guard = state
        .active
        .lock()
        .map_err(|_| "串口状态互斥锁异常".to_string())?;
    if let Some(conn) = guard.take() {
        conn.stop_flag.store(true, Ordering::SeqCst);
        // 等待读取线程自然退出并释放底层句柄
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

#[tauri::command]
fn open_serial_port(
    app: AppHandle,
    state: State<'_, SerialState>,
    port_name: String,
    baud_rate: u32,
) -> Result<(), String> {
    // 1. 若已有打开的串口连接，先安全通知停止
    {
        let mut guard = state
            .active
            .lock()
            .map_err(|_| "串口状态互斥锁异常".to_string())?;
        if let Some(conn) = guard.take() {
            conn.stop_flag.store(true, Ordering::SeqCst);
        }
    }

    // 2. 将物理串口打开操作放到独立工作线程，并设置 2000ms 硬超时保护
    // 彻底防止用户选错到非预期设备（如蓝牙串口 BTHENUM）导致 Windows 系统调用无限挂起造成界面未响应
    let port_name_for_thread = port_name.clone();
    let (tx_chan, rx_chan) = std::sync::mpsc::channel();

    thread::spawn(move || {
        let open_result = serialport::new(&port_name_for_thread, baud_rate)
            .data_bits(DataBits::Eight)
            .stop_bits(StopBits::One)
            .parity(Parity::None)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(20))
            .open();

        let _ = tx_chan.send(open_result);
    });

    let mut port = match rx_chan.recv_timeout(Duration::from_millis(2000)) {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            return Err(format!("无法打开串口 {}: {}", port_name, e));
        }
        Err(_) => {
            return Err(format!(
                "打开串口 {} 失败 (连接超时 2 秒未响应)！请检查是否选错了串口号（如蓝牙/未知设备）或该端口已被其他软件占用。",
                port_name
            ));
        }
    };
    // 主动置位 DTR / RTS，确保 CH340 / CP2102 / FT232 及隔离模块处于激活唤醒态
    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);

    let mut reader = port
        .try_clone()
        .map_err(|e| format!("克隆串口读取句柄失败: {}", e))?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop_flag);
    let thread_port_name = port_name.clone();

    thread::spawn(move || {
        let mut buf = [0u8; 256];
        while !thread_stop.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let chunk = buf[..n].to_vec();
                    let _ = app.emit("serial-rx-chunk", chunk);
                }
                Ok(_) => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // 正常读取超时，继续轮询
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                    continue;
                }
                Err(err) => {
                    if !thread_stop.load(Ordering::Relaxed) {
                        let _ = app.emit(
                            "serial-disconnected",
                            format!("串口 {} 意外断开: {}", thread_port_name, err),
                        );
                    }
                    break;
                }
            }
        }
    });

    let mut guard = state
        .active
        .lock()
        .map_err(|_| "串口状态互斥锁异常".to_string())?;
    *guard = Some(ActiveSerialConnection {
        writer: port,
        stop_flag,
        port_name,
        baud_rate,
    });

    Ok(())
}

#[tauri::command]
fn write_serial_frame(state: State<'_, SerialState>, data: Vec<u8>) -> Result<(), String> {
    let mut guard = state
        .active
        .lock()
        .map_err(|_| "串口状态互斥锁异常".to_string())?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "当前未打开物理串口，无法发送数据帧".to_string())?;

    conn.writer
        .write_all(&data)
        .map_err(|e| format!("串口写入失败: {}", e))?;
    let _ = conn.writer.flush();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            get_platform_info,
            list_serial_ports,
            open_serial_port,
            close_serial_port,
            write_serial_frame
        ])
        .run(tauri::generate_context!())
        .expect("error while running Motor Test Station Tauri application");
}
