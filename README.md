# 电机测控与调试上位机 (Motor Test Station Pro v2.4.1)

面向 STM32 电机测控与外环扭矩闭环系统的**跨平台桌面级 & 网页端解耦双栖上位机**。工程已彻底解耦为两大独立形态：
1. **原生桌面可执行程序（Desktop Workstation - `.exe` / macOS / Linux）**：位于项目根目录，基于 **Tauri v2 + Rust (`serialport`) + React 19 + TypeScript + Tailwind CSS v4 + Jotai** 构建。支持系统底层串口枚举、热插拔扫描、全屏/窗口化弹性自适应与高刷 60FPS 示波器。
2. **纯前端零依赖独立网页版（Web Standalone - `web/`）**：位于 `web/` 独立目录，采用原生 HTML5 + Web Serial API + 原生 Canvas，无需任何 Node.js/Rust 编译环境，Chromium 内核浏览器双击 `web/index.html` 即可直连。
---

## 一、核心架构与技术栈

| 层级 | 技术选型 | 核心职责 |
| :--- | :--- | :--- |
| **桌面容器与系统层** | **Tauri v2 + Rust (`serialport 4.7`)** | 原生跨平台编译（Windows `.exe` / macOS `.dmg` / Linux `.AppImage`），底层直接枚举系统串口（自动识别 USB VID/PID 与芯片型号），独立后台读取线程与事件推送，主动置位 DTR/RTS 唤醒串口芯片。 |
| **前端视图与组件层** | **React 19 + TypeScript + Tailwind v4 + shadcn/ui** | 精密实验室风格（Cleanroom White + Azure）与深空碳黑（Carbon Dark）一键切换；提供桌面宽屏双栏、平板分屏与窄窗底部导航三端响应式布局。 |
| **状态管理层** | **Jotai 原子化状态机** | 细粒度管理串口状态、设定值（Draft）与下位机已生效值（Applied）、扭矩闭环互锁、6 项 RAM 参数脏检查（Float32 对齐）及 60FPS 示波器状态。 |
| **通信协议与安全队列** | **Single-Flight 串行请求队列 + `StreamUnpacker`** | 严格匹配下位机 14 字节小端协议（CRC-16/CCITT-FALSE），单请求在途防止下位机 8 项 FIFO 溢出，内置超时追踪与迟到应答过滤。 |

---

## 二、核心功能特性

### 1. 三端跨平台与三态传输引擎
- **操作系统三端适配**：支持 **Windows (`.exe`)**、**macOS (`.app` / `.dmg`)**、**Linux (`.AppImage` / `.deb`)** 原生串口通信（`COMx`、`/dev/cu.*`、`/dev/ttyUSB*`），并内置 `.github/workflows/release.yml` 跨平台自动构建流水线。
- **视口形态三端适配**：
  - **桌面宽屏工作站（$\ge 1024\text{px}$）**：左侧 `460px` 宽幅双组控制台 + 右侧双通道数显大屏、60FPS 示波器与报文监视器。
  - **平板触控端（$768\text{px} \sim 1023\text{px}$）**：自适应网格与加宽触控滑轨。
  - **移动端 / 窄窗 IDE 伴侣模式（$< 1024\text{px}$）**：当与 Keil / VS Code / STM32CubeIDE 分屏并排调试时，自动启用底部四栏快捷导航（`主控台` / `示波器` / `6参数/Flash` / `报文终端`）。
- **内置高保真 STM32 虚拟下位机仿真器（Mock Mode）**：无硬件时一键启动，完整模拟下位机 TIM3 100Hz 外环扭矩 PID、前馈与动态限幅、6 参数 RAM/Flash 读写及 `0x81` / `0x82` 协议交互。

### 2. 单栏位双模式无缝切换与三重硬件互锁
- **【⚡ 手动电压模式】**：
  - **控制参数 1**：目标输出电压 `V_target`（`0.00 ~ 18.00 V` 滑块 + 8 档常用预设胶囊）。
  - **控制参数 2**：CNC 步进微调量（`±0.2V` 步进器 + `-1.0V / -0.5V / +1.5V / +1.0V` 快捷阶跃）。
  - **设定值 vs 已生效对比条**：实时区分本地待下发设定与下位机已确认生效电压，支持勾选“20Hz 节流实时自动下发”。
- **【🎯 扭矩闭环模式】**：
  - **控制参数 1**：目标扭矩幅值 `Torque_target`（`0.000 ~ Limit N·m` 机械金滑块 + `±0.1` 步进 + 7 档预设）。
  - **前馈与动态电压上限提示盒（$V_{\text{ff}}$ / $V_{\text{max}}$）**：按暂定标定比例 $1\text{ V} \leftrightarrow 0.5\text{ N}\cdot\text{m}$ 计算前馈基准 $V_{\text{ff}} = \min(T / 0.5, 18.0\text{ V})$，并叠加 **$+1.5\text{ V}$ 补偿裕量** 计算动态电压上限 $V_{\text{max}} = \min(V_{\text{ff}} + 1.5\text{ V}, 18.0\text{ V})$；当设定值尚未下发时提供实时预览。
  - **控制参数 2**：扭矩安全上限 `TorqueLimit`（在线调整下位机 ID 6 参数，降低上限后自动调用 `GetState` 刷新被钳位的真实目标）。
  - **三重防冲突互锁**：当扭矩闭环开启时，手动电压区自动物理置灰锁定（`🔒 闭环中已锁定`），仅保留红色的【软件停机 (0V)】始终可用。

### 3. 下位机 6 参数调优与停机安全保存到 Flash
- 对称 `2 × 3` 网格完整管理 6 项下位机参数：`1. Kp`、`2. Ki`、`3. Kd`、`4. Q (ProcessNoise)`、`5. R (MeasurementNoise)`、`6. TorqueLimit`。
- 严格遵循 `HANDOFF.md` 规定的 **4 步停机安全保存流程**：
  1. 发送 `SetVoltage(0)` 停止输出并关闭扭矩闭环，等待 `Result = Ok`；
  2. 逐项对比（Float32 精度）并将修改后的参数写入下位机 RAM；
  3. 发送 `SaveParameters (0x12)` 触发板载 Flash 擦写（3000ms 超时保护）；
  4. 校验 `0x82` 应答与 `StorageCode`，若超时明确标记为 `⚠️ 结果未知 (请人工核对)`。

### 4. 60 FPS 双通道示波器（含目标与限幅参考虚线）
- 实时绘制 `CH A: 实测输出电压 (V)` 与 `CH B: 实测机械扭矩 (N·m)`。
- 支持叠加 **目标与动态上限参考虚线**（`V 目标 / Vmax 限幅` 与 `T 目标`），支持 `250 / 500 / 1000 / 2000 点` 窗口缩放、十字准星 HUD 探针与一键导出 CSV（包含目标参考列）。

---

## 三、快速运行与构建指南

### 1. 两种形态的运行方式
- **形态 A (原生桌面端)**：直接双击运行根目录下的 **`MotorTestStation.exe`**。
- **形态 B (免安装网页版)**：直接用 Chrome / Edge 打开 **`web/index.html`**（或 `web/串口.html`）。
### 2. 开发者本地调试与构建命令
```bash
# 1. 安装前端依赖
npm install

# 2. 启动桌面端热重载开发模式 (Tauri + Vite)
npm run tauri dev

# 3. 编译前端生产包 (Web 部署)
npm run build:web

# 4. 编译独立原生桌面程序 (Windows .exe / macOS .dmg / Linux .AppImage)
npm run build:desktop

---

## 四、工程目录结构

```text
D:\omp\stm32dbg\motor test debug/
├── MotorTestStation.exe           # Windows 原生独立可执行程序 (.exe)
├── DESIGN.md                      # 实验室精密设计系统规范
├── package.json                   # 解耦编译脚本与依赖配置
├── vite.config.ts                 # Vite + React + Tailwind v4 构建配置
├── index.html                     # 桌面与现代 Web 客户端 HTML 模板
├── src/                           # 桌面主工程源码 (React 19 + TypeScript + Tailwind v4 + Jotai)
│   ├── App.tsx                    # 全屏与窗口化弹性响应主工作台
│   ├── index.css                  # Tailwind v4 主题与精密控件样式
│   ├── components/
│   │   ├── OscilloscopeCanvas.tsx # 60FPS 高清 High-DPI 双通道示波器
│   │   └── ui/                    # shadcn/ui 工业级交互控件
│   ├── lib/
│   │   ├── protocol.ts            # 14字节小端协议编解码器与流式解包器
│   │   └── transport.ts           # 跨平台传输抽象 (Tauri IPC / WebSerial / Mock) + 请求队列
│   └── store/
│       └── atoms.ts               # Jotai 全局响应式状态机
├── src-tauri/                     # Tauri v2 + Rust 跨平台桌面端后端
│   ├── Cargo.toml                 # Rust 依赖 (tauri v2, serialport 4.7)
│   ├── tauri.conf.json            # 窗口自适应、跨平台打包配置
│   └── src/
│       ├── lib.rs                 # 底层串口枚举、非阻塞读写、DTR/RTS 控制与事件推送
│       └── main.rs                # 桌面端程序主入口
├── web/                           # 【解耦独立网页端】零依赖纯前端免安装版
│   ├── index.html                 # 纯网页端入口 (双击 Chrome/Edge 直接运行)
│   ├── 串口.html                  # 中文别名入口
│   ├── README.md                  # 网页端专项使用说明
│   ├── css/
│   │   └── style.css              # 网页端样式源码
│   └── js/                        # 网页端核心 JavaScript 脚本
│       ├── protocol.js            # 协议解包与 CRC 校验
│       ├── serial.js              # Web Serial API 驱动与仿真器
│       ├── chart.js               # Canvas 示波器引擎
│       └── app.js                 # 网页端主调度逻辑
└── .github/workflows/
    └── release.yml                # Windows / macOS / Linux 三端自动化云端构建与发布流水线
```
