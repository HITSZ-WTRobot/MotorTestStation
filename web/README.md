# 电机测控与调试上位机 (纯网页免安装独立版)

这是基于 **HTML5 + Web Serial API + 原生 Canvas** 开发的独立网页端串口调试上位机。

---

## 🌟 核心特性

- **零依赖与免安装**：无需安装任何 Node.js、Rust 或驱动环境，使用现代 Chromium 内核浏览器（Chrome、Edge 等）双击 `index.html`（或 `串口.html`）即可直接运行。
- **Web Serial API 原生直连**：浏览器直接调用操作系统底层串口驱动（支持 Windows `COMx`、macOS `/dev/cu.*`、Linux `/dev/ttyUSB*`）。
- **STM32 14 字节小端协议支持**：完整支持 CRC16/CCITT-FALSE 校验与 `StreamUnpacker` 流式分包器，具备断包自动重组与噪点纠错能力。
- **60 FPS 实时双通道示波器**：支持电压（CH-A）与扭矩（CH-B）实时曲线滚屏、准星探针 HUD 测量与 CSV 历史数据一键导出。
- **6 参数 RAM/Flash 调优与安全停机保存**：严格支持 $0\text{V}$ 停机前置保护与 Flash 烧录应答校验。
- **内置电机仿真器 (Mock Simulator)**：离线或无硬件时一键启动 20Hz 动态电机阻尼与惯性响应仿真。

---

## 📁 目录结构

```text
web/
├── index.html        # 单文件便携版上位机（内嵌完整 CSS 与 JS，直接双击运行）
├── 串口.html         # 便携版中文同名入口
├── css/
│   └── style.css     # 纯网页端样式源码
└── js/               # 纯网页端核心引擎源码
    ├── protocol.js   # 14字节小端协议编解码器与 StreamUnpacker
    ├── serial.js     # Web Serial API 串口驱动与 Mock 仿真器
    ├── chart.js      # 60FPS 双通道 Canvas 示波器引擎
    └── app.js        # 网页端交互与调度主控逻辑
```

---

## 🚀 运行方法

1. **直接双击** `web/index.html`（或 `web/串口.html`）；
2. 浏览器要求：Google Chrome $\ge 89$、Microsoft Edge $\ge 89$ 等支持 Web Serial API 的现代浏览器；
3. 点击顶部【连接串口】并在弹出的系统端口列表中选择 STM32 USB-TTL 串口即可开始测控。
