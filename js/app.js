/**
 * @file app.js
 * @brief 电机上位机 UI 事件绑定、数据流交互与生命周期胶水层
 */

(function () {
    'use strict';

    // 状态量
    let currentTargetV = 0.0;
    let sequenceCounter = 0;
    let liveFpsCounter = 0;
    let lastFpsTime = performance.now();
    let currentFps = 0;

    // 极值统计
    let vMinObserved = Infinity;
    let vMaxObserved = -Infinity;
    let tMaxObserved = -Infinity;

    // DOM 元素引用
    const el = {
        baudSelect: document.getElementById('baudSelect'),
        btnConnect: document.getElementById('btnConnect'),
        btnDisconnect: document.getElementById('btnDisconnect'),
        btnMock: document.getElementById('btnMock'),
        statusDot: document.getElementById('statusDot'),
        statusText: document.getElementById('statusText'),

        sliderVoltage: document.getElementById('sliderVoltage'),
        inputVoltage: document.getElementById('inputVoltage'),
        displayTargetVal: document.getElementById('displayTargetVal'),
        btnStepDec: document.getElementById('btnStepDec'),
        btnStepInc: document.getElementById('btnStepInc'),
        presetChips: document.querySelectorAll('.preset-chip'),
        btnSend: document.getElementById('btnSend'),
        btnEstop: document.getElementById('btnEstop'),
        chkAutoSync: document.getElementById('chkAutoSync'),

        dispVoltage: document.getElementById('dispVoltage'),
        dispVoltageMin: document.getElementById('dispVoltageMin'),
        dispVoltageMax: document.getElementById('dispVoltageMax'),
        dispTorque: document.getElementById('dispTorque'),
        dispTorqueMax: document.getElementById('dispTorqueMax'),

        statRxFrames: document.getElementById('statRxFrames'),
        statTxFrames: document.getElementById('statTxFrames'),
        statFps: document.getElementById('statFps'),
        statCrcErrors: document.getElementById('statCrcErrors'),

        btnPauseChart: document.getElementById('btnPauseChart'),
        btnClearChart: document.getElementById('btnClearChart'),
        btnExportCsv: document.getElementById('btnExportCsv'),

        logTerminal: document.getElementById('logTerminal'),
        btnClearLog: document.getElementById('btnClearLog'),
        chkShowHex: document.getElementById('chkShowHex')
    };

    let txFrameCount = 0;

    // 1. 初始化示波器
    const scope = new RealtimeScope('scopeCanvas', { maxPoints: 500 });

    // 2. 初始化解包器
    const unpacker = new MotorProtocol.StreamUnpacker(
        // 收到合法反馈帧回调
        (feedback) => {
            handleFeedbackFrame(feedback);
        },
        // 解包 CRC 错误回调
        (err) => {
            log('error', `[CRC校验失败] ${err.error || '数据帧损坏'}`);
            el.statCrcErrors.textContent = unpacker.stats.crcErrors;
            el.statCrcErrors.style.color = '#ef4444';
        }
    );

    // 3. 初始化串口驱动
    const serial = new SerialManager({
        baudRate: 115200,
        onData: (chunk) => {
            unpacker.feed(chunk);
        },
        onStatusChange: (status) => {
            updateConnectionUI(status);
        },
        onLog: (level, msg) => {
            log(level, msg);
        }
    });

    /**
     * 更新顶部连接指示器
     */
    function updateConnectionUI(status) {
        if (!status.connected) {
            el.statusDot.className = 'status-dot';
            el.statusText.textContent = '未连接 (串口断开)';
            el.btnConnect.style.display = 'inline-flex';
            el.btnDisconnect.style.display = 'none';
            el.btnMock.classList.remove('btn-danger');
            el.btnMock.classList.add('btn-outline');
            el.btnMock.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14h2v2h-2v-2zm0-10h2v8h-2V6z"/>
                </svg>
                仿真模式 (Mock)
            `;
        } else if (status.type === 'mock') {
            el.statusDot.className = 'status-dot mocking';
            el.statusText.textContent = '虚拟仿真运行中 (20Hz)';
            el.btnConnect.style.display = 'none';
            el.btnDisconnect.style.display = 'none';
            el.btnMock.classList.remove('btn-outline');
            el.btnMock.classList.add('btn-danger');
            el.btnMock.textContent = '停止仿真';
        } else {
            el.statusDot.className = 'status-dot connected';
            el.statusText.textContent = `已连接硬件 (${status.baudRate || 115200} 8N1)`;
            el.btnConnect.style.display = 'none';
            el.btnDisconnect.style.display = 'inline-flex';
            el.btnMock.style.display = 'none';
        }
    }

    /**
     * 处理合法上行反馈帧
     */
    function handleFeedbackFrame(fb) {
        liveFpsCounter++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            currentFps = liveFpsCounter;
            liveFpsCounter = 0;
            lastFpsTime = now;
            el.statFps.textContent = `${currentFps} Hz`;
        }

        // 更新数值大屏
        el.dispVoltage.textContent = fb.voltage.toFixed(3);
        el.dispTorque.textContent = fb.torque.toFixed(3);

        // 极值跟踪
        if (fb.voltage < vMinObserved) vMinObserved = fb.voltage;
        if (fb.voltage > vMaxObserved) vMaxObserved = fb.voltage;
        if (Math.abs(fb.torque) > tMaxObserved) tMaxObserved = Math.abs(fb.torque);

        el.dispVoltageMin.textContent = vMinObserved === Infinity ? '--' : vMinObserved.toFixed(2);
        el.dispVoltageMax.textContent = vMaxObserved === -Infinity ? '--' : vMaxObserved.toFixed(2);
        el.dispTorqueMax.textContent = tMaxObserved === -Infinity ? '--' : tMaxObserved.toFixed(2);

        // 推送给示波器实时绘图
        scope.pushData(fb.voltage, fb.torque, now);

        // 更新统计计数
        el.statRxFrames.textContent = unpacker.stats.validFrames;
        el.statCrcErrors.textContent = unpacker.stats.crcErrors;

        // 条件打印十六进制
        if (el.chkShowHex && el.chkShowHex.checked) {
            const hex = MotorProtocol.bytesToHex(fb.rawBytes);
            log('rx', `[RX #${fb.seq}] V=${fb.voltage.toFixed(3)}V T=${fb.torque.toFixed(3)}Nm | ${hex}`);
        }
    }

    /**
     * 记录并滚动终端日志
     */
    function log(level, message) {
        if (!el.logTerminal) return;
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

        const entry = document.createElement('div');
        entry.className = `log-entry ${level}`;

        const dirTag = level === 'tx' ? '[TX]' : level === 'rx' ? '[RX]' : `[${level.toUpperCase()}]`;

        entry.innerHTML = `
            <span class="time">${timeStr}</span>
            <span class="dir">${dirTag}</span>
            <span class="content">${escapeHtml(message)}</span>
        `;

        el.logTerminal.appendChild(entry);

        // 维持最多 200 条避免内存膨胀
        while (el.logTerminal.childNodes.length > 200) {
            el.logTerminal.removeChild(el.logTerminal.firstChild);
        }

        el.logTerminal.scrollTop = el.logTerminal.scrollHeight;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * 下发目标电压控制帧
     */
    async function sendTargetVoltage(voltage) {
        let v = Number(voltage);
        if (!Number.isFinite(v)) v = 0.0;
        v = Math.max(0.0, Math.min(MotorProtocol.MAX_VOLTAGE, v));

        const seq = (sequenceCounter++) & 0xFF;
        const frame = MotorProtocol.encodeSetVoltage(v, seq);

        try {
            await serial.send(frame);
            txFrameCount++;
            el.statTxFrames.textContent = txFrameCount;
            const hex = MotorProtocol.bytesToHex(frame);
            log('tx', `[设置电压] 目标值=${v.toFixed(2)}V (seq=${seq}) | ${hex}`);
        } catch (err) {
            log('error', `发送失败: ${err.message}`);
        }
    }

    // 节流实时下发 (针对滑动条拖拽时的实时同步)
    let autoSyncThrottleTimer = null;
    function triggerAutoSync(val) {
        if (!el.chkAutoSync || !el.chkAutoSync.checked) return;
        if (autoSyncThrottleTimer) return;
        autoSyncThrottleTimer = setTimeout(() => {
            autoSyncThrottleTimer = null;
            sendTargetVoltage(val);
        }, 50); // 20Hz 节奏，不阻塞串口
    }

    /**
     * 设置并同步界面的目标电压值
     */
    function setTargetValue(v, triggerSend = false) {
        let val = Number(v);
        if (!Number.isFinite(val)) val = 0.0;
        val = Math.max(0.0, Math.min(MotorProtocol.MAX_VOLTAGE, val));
        val = Math.round(val * 100) / 100; // 两位小数

        currentTargetV = val;
        el.sliderVoltage.value = val;
        el.inputVoltage.value = val.toFixed(2);
        el.displayTargetVal.textContent = `${val.toFixed(2)} V`;

        // 更新预设高亮
        el.presetChips.forEach(chip => {
            const pVal = Number(chip.getAttribute('data-val'));
            if (Math.abs(pVal - val) < 0.05) {
                chip.classList.add('active');
            } else {
                chip.classList.remove('active');
            }
        });

        if (triggerSend) {
            sendTargetVoltage(val);
        } else {
            triggerAutoSync(val);
        }
    }

    // 事件绑定
    function setupEventListeners() {
        // 串口连接/断开
        el.btnConnect.addEventListener('click', async () => {
            const baud = parseInt(el.baudSelect.value, 10) || 115200;
            try {
                await serial.connect(baud);
            } catch (_) {}
        });

        el.btnDisconnect.addEventListener('click', async () => {
            await serial.disconnect();
            el.btnMock.style.display = 'inline-flex';
        });

        // 模拟器切换
        el.btnMock.addEventListener('click', () => {
            if (serial.isMocking) {
                serial.stopMock();
            } else {
                serial.startMock();
            }
        });

        // 滑块改变
        el.sliderVoltage.addEventListener('input', (e) => {
            setTargetValue(e.target.value, false);
        });

        el.sliderVoltage.addEventListener('change', (e) => {
            setTargetValue(e.target.value, true);
        });

        // 输入框改变
        el.inputVoltage.addEventListener('change', (e) => {
            setTargetValue(e.target.value, false);
        });

        el.inputVoltage.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                setTargetValue(e.target.value, true);
            }
        });

        // 步进微调按钮 (±0.1V, 按住可快速微调)
        el.btnStepDec.addEventListener('click', () => {
            setTargetValue(currentTargetV - 0.2, true);
        });

        el.btnStepInc.addEventListener('click', () => {
            setTargetValue(currentTargetV + 0.2, true);
        });

        // 预设快捷档位
        el.presetChips.forEach(chip => {
            chip.addEventListener('click', () => {
                const val = chip.getAttribute('data-val');
                setTargetValue(val, true);
            });
        });

        // 发送按钮
        el.btnSend.addEventListener('click', () => {
            sendTargetVoltage(currentTargetV);
        });

        // 一键急停 (0.0 V)
        el.btnEstop.addEventListener('click', () => {
            setTargetValue(0.0, true);
            log('warn', '🚨 已触发一键急停，紧急下发目标 0.00 V');
        });

        // 示波器控制
        el.btnPauseChart.addEventListener('click', () => {
            const paused = scope.togglePause();
            el.btnPauseChart.innerHTML = paused ? `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                继续运行
            ` : `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
                暂停采样
            `;
            el.btnPauseChart.style.borderColor = paused ? '#ef4444' : '';
        });

        el.btnClearChart.addEventListener('click', () => {
            scope.clear();
            vMinObserved = Infinity;
            vMaxObserved = -Infinity;
            tMaxObserved = -Infinity;
            el.dispVoltageMin.textContent = '--';
            el.dispVoltageMax.textContent = '--';
            el.dispTorqueMax.textContent = '--';
            log('info', '示波器历史曲线与极值已清空');
        });

        el.btnExportCsv.addEventListener('click', () => {
            const csv = scope.exportCsv();
            if (!csv) {
                alert('暂无记录数据可导出');
                return;
            }
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `motor_telemetry_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            log('success', '已成功导出示波器 CSV 采样记录');
        });

        // 清空日志
        el.btnClearLog.addEventListener('click', () => {
            el.logTerminal.innerHTML = '';
        });
    }

    // 页面初始化
    function init() {
        setTargetValue(0.0, false);
        setupEventListeners();

        log('info', '电机上位机调试台已就绪 (协议: 14字节小端 / CRC-16/CCITT-FALSE)');
        if (!SerialManager.isSupported()) {
            log('warn', '注意：当前浏览器不支持 Web Serial API。您可点击右上角【仿真模式】测试所有波形与交互，连接真实硬件请使用 Chrome/Edge。');
        } else {
            log('info', '检测到 Web Serial 支持，插上 USB-TTL 串口后点击【连接串口】即可开始。');
        }
    }

    window.addEventListener('DOMContentLoaded', init);

})();
