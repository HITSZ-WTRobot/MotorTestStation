/**
 * @file app.js
 * @brief 电机上位机 UI 事件绑定、数据流交互与生命周期胶水层
 * @version 2.4 (区分设定值与已生效目标 · 6参数完整网格 · 示波器参考线 · 迟到应答防护)
 */

(function () {
    'use strict';

    // 状态管理：严格区分本地待下发设定值 (Draft) 与下位机已接受生效值 (Applied)
    let draftTargetV = 0.0;
    let appliedTargetV = 0.0;

    let draftTargetTorque = 0.0;
    let appliedTargetTorque = 0.0;

    let currentTorqueLimit = 3.0;
    let isTorqueEnabled = false;
    let isFeedbackValid = false;
    let activeMode = 'voltage'; // 'voltage' | 'torque'
    let deviceSyncPending = false;

    // 帧率与极值统计
    let liveFpsCounter = 0;
    let lastFpsTime = performance.now();
    let currentFps = 0;
    let txFrameCount = 0;

    let vMinObserved = Infinity;
    let vMaxObserved = -Infinity;
    let tMaxObserved = -Infinity;

    // 参数 RAM 缓存 (6项下位机参数，均按 IEEE 754 float32 存储)
    const ramParams = {
        1: Math.fround(1.0),   // Kp
        2: Math.fround(0.05),  // Ki
        3: Math.fround(0.01),  // Kd
        4: Math.fround(0.01),  // Q
        5: Math.fround(0.01),  // R
        6: Math.fround(3.0)    // TorqueLimit
    };

    /**
     * @class RequestQueue
     * @brief 串行请求队列（单请求在途，支持超时记录与迟到应答识别，防止序号复用混淆）
     */
    class RequestQueue {
        constructor(sendFn, onLog, onTimeoutState) {
            this.sendFn = sendFn;
            this.onLog = onLog;
            this.onTimeoutState = onTimeoutState;
            this.queue = [];
            this.inFlight = null;
            this.timer = null;
            this.seq = 0;
            this.timedOutHistory = []; // 记录近期超时的 { seq, cmdType, time }
        }

        nextSeq() {
            // 避免快速复用近期刚超时且可能仍在下位机 FIFO 中的序号
            for (let attempt = 0; attempt < 256; attempt++) {
                const candidate = this.seq;
                this.seq = (this.seq + 1) & 0xFF;
                const conflict = this.timedOutHistory.some(item => item.seq === candidate);
                if (!conflict) return candidate;
            }
            const s = this.seq;
            this.seq = (this.seq + 1) & 0xFF;
            return s;
        }

        enqueue(cmdType, frameEncoder, timeoutMs = 500) {
            return new Promise((resolve, reject) => {
                const seq = this.nextSeq();
                const frame = frameEncoder(seq);
                this.queue.push({
                    cmdType,
                    seq,
                    frame,
                    timeoutMs,
                    resolve,
                    reject,
                    createdAt: performance.now()
                });
                this.processNext();
            });
        }

        async processNext() {
            if (this.inFlight || this.queue.length === 0) return;

            const req = this.queue.shift();
            this.inFlight = req;

            try {
                await this.sendFn(req.frame);
                txFrameCount++;
                if (el.statTxFrames) el.statTxFrames.textContent = txFrameCount;

                const hex = MotorProtocol.bytesToHex(req.frame);
                this.onLog('tx', `[TX #${req.seq}] ${MotorProtocol.CommandNames[req.cmdType] || req.cmdType} | ${hex}`);

                // 启动超时监控
                this.timer = setTimeout(() => {
                    const elapsed = Math.round(performance.now() - req.createdAt);
                    this.timedOutHistory.push({
                        seq: req.seq,
                        cmdType: req.cmdType,
                        time: performance.now()
                    });
                    if (this.timedOutHistory.length > 32) {
                        this.timedOutHistory.shift();
                    }

                    this.onLog('warn', `[请求超时] 命令 ${MotorProtocol.CommandNames[req.cmdType] || req.cmdType} (seq=${req.seq}) 在 ${elapsed}ms 内未收到应答，状态保持未知`);
                    this.inFlight = null;
                    if (typeof this.onTimeoutState === 'function') {
                        this.onTimeoutState(req);
                    }
                    req.reject(new Error(`Timeout after ${elapsed}ms`));
                    this.processNext();
                }, req.timeoutMs);
            } catch (err) {
                this.inFlight = null;
                req.reject(err);
                this.processNext();
            }
        }

        handleResponse(resp) {
            // 1. 检查是否匹配当前在途请求 (同时核对序号与原操作码)
            if (this.inFlight) {
                if (this.inFlight.seq === resp.seq && this.inFlight.cmdType === resp.originalCmdType) {
                    clearTimeout(this.timer);
                    this.timer = null;
                    const req = this.inFlight;
                    this.inFlight = null;
                    req.resolve(resp);
                    this.processNext();
                    return 'matched';
                }
            }

            // 2. 检查是否为之前已超时请求的迟到应答
            const lateIdx = this.timedOutHistory.findIndex(
                item => item.seq === resp.seq && item.cmdType === resp.originalCmdType
            );
            if (lateIdx !== -1) {
                this.timedOutHistory.splice(lateIdx, 1);
                this.onLog('warn', `[迟到应答已忽略] 收到已超时请求 #${resp.seq} (${resp.originalCmdName}) 的迟到应答，请点击“刷新状态”重新同步`);
                return 'late';
            }

            return 'unmatched';
        }

        clear() {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            if (this.inFlight) {
                this.inFlight.reject(new Error('Queue cleared'));
                this.inFlight = null;
            }
            while (this.queue.length > 0) {
                const r = this.queue.shift();
                r.reject(new Error('Queue cleared'));
            }
            this.timedOutHistory = [];
        }
    }

    // DOM 元素引用
    const el = {
        baudSelect: document.getElementById('baudSelect'),
        btnConnect: document.getElementById('btnConnect'),
        btnDisconnect: document.getElementById('btnDisconnect'),
        btnMock: document.getElementById('btnMock'),
        btnQueryState: document.getElementById('btnQueryState'),
        statusDot: document.getElementById('statusDot'),
        statusText: document.getElementById('statusText'),

        // 控制组一：电压驱动
        sliderVoltage: document.getElementById('sliderVoltage'),
        inputVoltage: document.getElementById('inputVoltage'),
        displayTargetVal: document.getElementById('displayTargetVal'),
        appliedVoltageVal: document.getElementById('appliedVoltageVal'),
        voltageSyncTag: document.getElementById('voltageSyncTag'),
        btnStepDec: document.getElementById('btnStepDec'),
        btnStepInc: document.getElementById('btnStepInc'),
        quickStepBtns: document.querySelectorAll('#mode-pane-voltage .quick-step-btn'),
        presetChips: document.querySelectorAll('.preset-chip:not(.torque-chip)'),
        btnSend: document.getElementById('btnSend'),
        btnEstop: document.getElementById('btnEstop'),
        chkAutoSync: document.getElementById('chkAutoSync'),
        voltageConflictNotice: document.getElementById('voltageConflictNotice'),

        // 控制组二：扭矩闭环
        pillTorqueLoop: document.getElementById('pillTorqueLoop'),
        pillFeedbackValid: document.getElementById('pillFeedbackValid'),
        pillTorqueLimit: document.getElementById('pillTorqueLimit'),
        displayTargetTorque: document.getElementById('displayTargetTorque'),
        appliedTorqueVal: document.getElementById('appliedTorqueVal'),
        torqueSyncTag: document.getElementById('torqueSyncTag'),
        sliderTorque: document.getElementById('sliderTorque'),
        inputTorque: document.getElementById('inputTorque'),
        btnStepTorqueDec: document.getElementById('btnStepTorqueDec'),
        btnStepTorqueInc: document.getElementById('btnStepTorqueInc'),
        torquePresetChips: document.querySelectorAll('.preset-chip.torque-chip'),
        btnSetTorque: document.getElementById('btnSetTorque'),
        btnEnableTorque: document.getElementById('btnEnableTorque'),
        btnDisableTorque: document.getElementById('btnDisableTorque'),
        btnStopTorque: document.getElementById('btnStopTorque'),

        // 扭矩上限控制与动态电压上限显示
        inputTorqueLimit: document.getElementById('inputTorqueLimit'),
        btnStepLimitDec: document.getElementById('btnStepLimitDec'),
        btnStepLimitInc: document.getElementById('btnStepLimitInc'),
        btnSetTorqueLimit: document.getElementById('btnSetTorqueLimit'),
        dispTorqueVmax: document.getElementById('dispTorqueVmax'),
        dispTorqueVff: document.getElementById('dispTorqueVff'),
        dispDraftCeilingHint: document.getElementById('dispDraftCeilingHint'),

        // 下位机 6 项完整参数面板 (Kp, Ki, Kd, Q, R, TorqueLimit)
        paramInputs: {
            1: document.getElementById('paramKp'),
            2: document.getElementById('paramKi'),
            3: document.getElementById('paramKd'),
            4: document.getElementById('paramQ'),
            5: document.getElementById('paramR'),
            6: document.getElementById('paramLimit')
        },
        paramRamBadges: {
            1: document.getElementById('ramKp'),
            2: document.getElementById('ramKi'),
            3: document.getElementById('ramKd'),
            4: document.getElementById('ramQ'),
            5: document.getElementById('ramR'),
            6: document.getElementById('ramLimit')
        },
        btnReadParams: document.getElementById('btnReadParams'),
        btnApplyParams: document.getElementById('btnApplyParams'),
        btnSaveFlash: document.getElementById('btnSaveFlash'),
        flashSaveBadge: document.getElementById('flashSaveBadge'),

        // 大屏数显与进度条
        dispVoltage: document.getElementById('dispVoltage'),
        dispVoltageMin: document.getElementById('dispVoltageMin'),
        dispVoltageMax: document.getElementById('dispVoltageMax'),
        dispTorque: document.getElementById('dispTorque'),
        dispTorqueMax: document.getElementById('dispTorqueMax'),
        dispTorqueLimit: document.getElementById('dispTorqueLimit'),
        meterBarV: document.getElementById('meterBarV'),
        meterBarT: document.getElementById('meterBarT'),

        // 链路统计
        statRxFrames: document.getElementById('statRxFrames'),
        statTxFrames: document.getElementById('statTxFrames'),
        statFps: document.getElementById('statFps'),
        statCrcErrors: document.getElementById('statCrcErrors'),

        // 示波器控制
        chkShowTargetRef: document.getElementById('chkShowTargetRef'),
        selectScopePoints: document.getElementById('selectScopePoints'),
        btnPauseChart: document.getElementById('btnPauseChart'),
        btnClearChart: document.getElementById('btnClearChart'),
        btnExportCsv: document.getElementById('btnExportCsv'),

        // 日志终端
        logTerminal: document.getElementById('logTerminal'),
        btnClearLog: document.getElementById('btnClearLog'),
        chkShowHex: document.getElementById('chkShowHex'),
        chkPauseLog: document.getElementById('chkPauseLog')
    };

    // 1. 初始化示波器
    const scope = new RealtimeScope('scopeCanvas', { maxPoints: 500 });

    // 2. 初始化请求队列
    const reqQueue = new RequestQueue(
        (frame) => serial.send(frame),
        (level, msg) => log(level, msg),
        () => {
            // 请求超时后，标记状态为未知，停止自动同步，提示用户刷新状态
            if (el.pillTorqueLoop) {
                el.pillTorqueLoop.className = 'status-pill warning';
                el.pillTorqueLoop.innerHTML = '▲ 闭环状态: <strong>通信超时/未知</strong>';
            }
        }
    );

    // 3. 初始化解包器 (同时接收 0x81 与 0x82)
    const unpacker = new MotorProtocol.StreamUnpacker({
        onFeedback: (fb) => {
            handleFeedbackFrame(fb);
        },
        onResponse: (resp) => {
            handleResponseFrame(resp);
        },
        onError: (err) => {
            log('error', `[CRC校验失败] ${err.error || '数据帧损坏'}`);
            if (el.statCrcErrors) {
                el.statCrcErrors.textContent = unpacker.stats.crcErrors;
                el.statCrcErrors.style.color = '#dc2626';
            }
        }
    });

    // 4. 初始化串口驱动
    const serial = new SerialManager({
        baudRate: 115200,
        onData: (chunk) => {
            unpacker.feed(chunk);
        },
        onStatusChange: (status) => {
            updateConnectionUI(status);
            if (status.connected) {
                deviceSyncPending = true;
                log('info', '已建立物理串口链路，等待收到下位机首帧有效遥测后再执行参数同步...');
            } else {
                deviceSyncPending = false;
                reqQueue.clear();
            }
        },
        onLog: (level, msg) => {
            log(level, msg);
        }
    });

    function updateConnectionUI(status) {
        if (!status.connected) {
            el.statusDot.className = 'status-dot';
            // 严格遵守 HANDOFF.md §1：断开串口不会自动停机，不能显示成“已停机”
            const hadActiveOutput = isTorqueEnabled || appliedTargetV > 0.01;
            el.statusText.textContent = hadActiveOutput
                ? '串口已断开 (注意: 下位机未自动停机!)'
                : '未连接 (串口断开)';
            el.btnConnect.style.display = 'inline-flex';
            el.btnDisconnect.style.display = 'none';
            el.btnMock.style.display = 'inline-flex';
            el.btnMock.classList.remove('btn-danger');
            el.btnMock.classList.add('btn-outline');
            el.btnMock.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14h2v2h-2v-2zm0-10h2v8h-2V6z"/>
                </svg>
                仿真模式 (Mock)
            `;
            if (el.pillTorqueLoop) {
                el.pillTorqueLoop.className = 'status-pill disabled';
                el.pillTorqueLoop.innerHTML = '○ 扭矩闭环: <strong>未连接/未知</strong>';
            }
            if (el.pillFeedbackValid) {
                el.pillFeedbackValid.className = 'status-pill disabled';
                el.pillFeedbackValid.innerHTML = '○ 传感器反馈: <strong>未连接</strong>';
            }
            // 恢复本地控件可操作态
            setVoltageControlsLocked(false);
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

    function setVoltageControlsLocked(locked) {
        if (el.voltageConflictNotice) {
            el.voltageConflictNotice.style.display = locked ? 'flex' : 'none';
        }
        if (el.btnSend) {
            el.btnSend.disabled = locked;
            if (locked) {
                el.btnSend.classList.add('disabled');
                el.btnSend.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                    </svg>
                    闭环中已锁定 (禁止非零电压)
                `;
            } else {
                el.btnSend.classList.remove('disabled');
                el.btnSend.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                    </svg>
                    下发电压目标
                `;
            }
        }
        if (el.sliderVoltage) el.sliderVoltage.disabled = locked;
        if (el.inputVoltage) el.inputVoltage.disabled = locked;
        if (el.btnStepDec) el.btnStepDec.disabled = locked;
        if (el.btnStepInc) el.btnStepInc.disabled = locked;
        if (el.quickStepBtns) {
            el.quickStepBtns.forEach(b => { b.disabled = locked; });
        }
        if (el.presetChips) {
            el.presetChips.forEach(chip => { chip.disabled = locked; });
        }
    }

    function updateLoopStatusUI(torqueEnabled, feedbackValid) {
        isTorqueEnabled = torqueEnabled;
        isFeedbackValid = feedbackValid;

        if (el.pillTorqueLoop) {
            if (torqueEnabled) {
                el.pillTorqueLoop.className = 'status-pill active';
                el.pillTorqueLoop.innerHTML = '● 扭矩闭环: <strong>运行中</strong>';
            } else {
                el.pillTorqueLoop.className = 'status-pill disabled';
                el.pillTorqueLoop.innerHTML = '○ 扭矩闭环: <strong>已关闭</strong>';
            }
        }

        if (el.pillFeedbackValid) {
            if (feedbackValid) {
                el.pillFeedbackValid.className = 'status-pill active';
                el.pillFeedbackValid.innerHTML = '● 反馈就绪: <strong>正常</strong>';
            } else {
                el.pillFeedbackValid.className = 'status-pill warning';
                el.pillFeedbackValid.innerHTML = '▲ 反馈就绪: <strong>未就绪</strong>';
            }
        }

        // 更新开启/关闭闭环按钮的视觉状态
        if (el.btnEnableTorque) {
            el.btnEnableTorque.innerHTML = torqueEnabled ? '● 闭环运行中' : '▶ 开启闭环';
        }

        // 扭矩闭环开启时，物理级互锁手动电压控制区
        setVoltageControlsLocked(torqueEnabled);
        syncScopeTargets();
    }

    function syncScopeTargets() {
        const torquePerVolt = 0.5;
        const vFf = appliedTargetTorque > 0 ? Math.min(appliedTargetTorque / torquePerVolt, 18.0) : 0.0;
        const vMax = appliedTargetTorque > 0 ? Math.min(vFf + 0.5, 18.0) : 0.0;

        scope.setTargets({
            mode: activeMode,
            vTarget: appliedTargetV,
            tTarget: appliedTargetTorque,
            vCeiling: vMax,
            torqueEnabled: isTorqueEnabled
        });
    }

    function handleFeedbackFrame(fb) {
        liveFpsCounter++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            currentFps = liveFpsCounter;
            liveFpsCounter = 0;
            lastFpsTime = now;
            if (el.statFps) el.statFps.textContent = `${currentFps} Hz`;
        }

        // 连接后首帧有效遥测到达，自动同步下位机状态与 6 项 RAM 参数
        if (deviceSyncPending) {
            deviceSyncPending = false;
            syncDeviceState();
        }

        if (el.dispVoltage) el.dispVoltage.textContent = fb.voltage.toFixed(3);
        if (el.dispTorque) el.dispTorque.textContent = fb.torque.toFixed(3);

        if (el.meterBarV) {
            const vPct = Math.max(0, Math.min(100, (fb.voltage / 18.0) * 100));
            el.meterBarV.style.width = vPct.toFixed(1) + '%';
        }
        if (el.meterBarT) {
            const tPct = Math.max(0, Math.min(100, (fb.torque / currentTorqueLimit) * 100));
            el.meterBarT.style.width = tPct.toFixed(1) + '%';
        }

        if (fb.voltage < vMinObserved) vMinObserved = fb.voltage;
        if (fb.voltage > vMaxObserved) vMaxObserved = fb.voltage;
        if (Math.abs(fb.torque) > tMaxObserved) tMaxObserved = Math.abs(fb.torque);

        if (el.dispVoltageMin) el.dispVoltageMin.textContent = vMinObserved === Infinity ? '--' : vMinObserved.toFixed(2);
        if (el.dispVoltageMax) el.dispVoltageMax.textContent = vMaxObserved === -Infinity ? '--' : vMaxObserved.toFixed(2);
        if (el.dispTorqueMax) el.dispTorqueMax.textContent = tMaxObserved === -Infinity ? '--' : tMaxObserved.toFixed(2);

        scope.pushData(fb.voltage, fb.torque, now);

        if (el.statRxFrames) el.statRxFrames.textContent = unpacker.stats.validFrames;
        if (el.statCrcErrors) el.statCrcErrors.textContent = unpacker.stats.crcErrors;

        // 仅当勾选“打印周期测量帧 (0x81)”时才打印高频反馈，避免冲走关键命令与应答日志
        if (el.chkShowHex && el.chkShowHex.checked) {
            const hex = MotorProtocol.bytesToHex(fb.rawBytes);
            log('rx', `[RX 0x81 #${fb.seq}] V=${fb.voltage.toFixed(3)}V T=${fb.torque.toFixed(3)}N·m | ${hex}`);
        }
    }

    function handleResponseFrame(resp) {
        const matchState = reqQueue.handleResponse(resp);
        if (matchState === 'late') {
            return;
        }

        updateLoopStatusUI(resp.torqueEnabled, resp.feedbackValid);

        const hex = MotorProtocol.bytesToHex(resp.rawBytes);
        const level = resp.result === MotorProtocol.Result.Ok ? 'info' : 'warn';
        log(level, `[RSP 0x82 #${resp.seq}] 原命令=${resp.originalCmdName} | 结果=${resp.resultName} | 返回值=${resp.value.toFixed(4)} | 闭环=${resp.torqueEnabled ? '开启' : '关闭'} 反馈=${resp.feedbackValid ? '有效' : '未就绪'} | ${hex}`);
    }

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

        while (el.logTerminal.childNodes.length > 250) {
            el.logTerminal.removeChild(el.logTerminal.firstChild);
        }

        if (!el.chkPauseLog || !el.chkPauseLog.checked) {
            el.logTerminal.scrollTop = el.logTerminal.scrollHeight;
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // --- 业务控制层 ---

    async function syncDeviceState() {
        log('info', '正在从下位机同步当前运行状态与 6 项 RAM 参数...');
        try {
            // 1. 读取当前扭矩目标与状态位 (GetState 0x13)
            const stResp = await reqQueue.enqueue(MotorProtocol.CommandType.GetState, (seq) => MotorProtocol.encodeGetState(seq));
            if (stResp.result === MotorProtocol.Result.Ok) {
                appliedTargetTorque = Math.fround(stResp.value);
                setTorqueTargetUI(appliedTargetTorque, false);
                updateTorqueSyncBadge();
            }

            // 2. 逐项读取 6 个参数 (GetParameter 0x11)
            for (let id = 1; id <= 6; id++) {
                const pResp = await reqQueue.enqueue(MotorProtocol.CommandType.GetParameter, (seq) => MotorProtocol.encodeGetParameter(id, seq));
                if (pResp.result === MotorProtocol.Result.Ok) {
                    const fVal = Math.fround(pResp.value);
                    ramParams[id] = fVal;
                    updateParamRowUI(id, fVal);
                    if (id === 6) {
                        applyTorqueLimitToUI(fVal);
                    }
                }
            }

            log('info', '已成功同步下位机全部状态与 6 项配置参数 (RAM)');
        } catch (err) {
            log('warn', `同步下位机配置未完全完成: ${err.message}`);
        }
    }

    function applyTorqueLimitToUI(limitVal) {
        currentTorqueLimit = limitVal;
        if (el.inputTorqueLimit) el.inputTorqueLimit.value = limitVal.toFixed(2);
        if (el.sliderTorque) el.sliderTorque.max = limitVal;
        if (el.pillTorqueLimit) el.pillTorqueLimit.textContent = `上限: ${limitVal.toFixed(2)} N·m`;
        if (el.dispTorqueLimit) el.dispTorqueLimit.textContent = `${limitVal.toFixed(2)} N·m`;
    }

    function updateParamRowUI(id, val) {
        const decimals = (id === 4 || id === 5) ? 4 : 2;
        if (el.paramRamBadges[id]) {
            el.paramRamBadges[id].textContent = val.toFixed(decimals);
        }
        if (el.paramInputs[id]) {
            el.paramInputs[id].value = val.toFixed(decimals);
            const card = el.paramInputs[id].closest('.param-card');
            if (card) card.classList.remove('dirty');
        }
    }

    function updateVoltageSyncBadge() {
        if (el.appliedVoltageVal) {
            el.appliedVoltageVal.textContent = `${appliedTargetV.toFixed(2)} V`;
        }
        if (el.voltageSyncTag) {
            const isSynced = Math.abs(draftTargetV - appliedTargetV) < 0.005;
            el.voltageSyncTag.className = isSynced ? 'synced-badge' : 'pending-badge';
            el.voltageSyncTag.textContent = isSynced ? '✓ 已下发同步' : '● 待点击下发';
        }
        syncScopeTargets();
    }

    function updateTorqueSyncBadge() {
        if (el.appliedTorqueVal) {
            el.appliedTorqueVal.textContent = `${appliedTargetTorque.toFixed(3)} N·m`;
        }
        if (el.torqueSyncTag) {
            const isSynced = Math.abs(draftTargetTorque - appliedTargetTorque) < 0.001;
            el.torqueSyncTag.className = isSynced ? 'synced-badge' : 'pending-badge';
            el.torqueSyncTag.textContent = isSynced ? '✓ 已下发同步' : '● 待下发确认';
        }
        updateDynamicVoltageCeilingUI(appliedTargetTorque, draftTargetTorque);
        syncScopeTargets();
    }

    async function sendTargetVoltage(v) {
        const fVal = Math.fround(Math.max(0.0, Math.min(MotorProtocol.MAX_VOLTAGE, Number(v) || 0.0)));
        if (isTorqueEnabled && fVal > 0.0) {
            log('warn', '下发被拒绝：当前扭矩闭环处于开启状态，禁止发送非零手动电压');
            return false;
        }

        try {
            const resp = await reqQueue.enqueue(MotorProtocol.CommandType.SetVoltage, (seq) => MotorProtocol.encodeSetVoltage(fVal, seq));
            if (resp.result === MotorProtocol.Result.Ok) {
                appliedTargetV = Math.fround(resp.value);
                if (fVal === 0.0) {
                    // 0V 软件停机同时关闭扭矩闭环
                    updateLoopStatusUI(false, resp.feedbackValid);
                }
                updateVoltageSyncBadge();
                log('info', `电压目标已生效: ${appliedTargetV.toFixed(2)} V`);
                return true;
            } else {
                log('warn', `电压设置未生效: ${resp.resultName}`);
                return false;
            }
        } catch (err) {
            log('error', `设置电压异常: ${err.message}`);
            return false;
        }
    }

    async function sendTargetTorque(t) {
        const fVal = Math.fround(Math.max(0.0, Number(t) || 0.0));
        try {
            const resp = await reqQueue.enqueue(MotorProtocol.CommandType.SetTorque, (seq) => MotorProtocol.encodeSetTorque(fVal, seq));
            if (resp.result === MotorProtocol.Result.Ok) {
                appliedTargetTorque = Math.fround(resp.value);
                setTorqueTargetUI(appliedTargetTorque, false);
                updateTorqueSyncBadge();
                log('info', `下位机已接受目标扭矩: ${appliedTargetTorque.toFixed(3)} N·m`);
                return true;
            } else {
                log('warn', `设置扭矩目标被拒绝: ${resp.resultName}`);
                return false;
            }
        } catch (err) {
            log('error', `下发扭矩目标异常: ${err.message}`);
            return false;
        }
    }

    async function sendSetTorqueLimit(val) {
        const limitVal = Math.fround(parseFloat(val));
        if (!Number.isFinite(limitVal) || limitVal <= 0) {
            alert('扭矩上限必须为大于 0 的有效数值');
            return;
        }
        try {
            const resp = await reqQueue.enqueue(MotorProtocol.CommandType.SetParameter, (seq) => MotorProtocol.encodeSetParameter(6, limitVal, seq));
            if (resp.result === MotorProtocol.Result.Ok) {
                const appliedLimit = Math.fround(resp.value);
                ramParams[6] = appliedLimit;
                applyTorqueLimitToUI(appliedLimit);
                updateParamRowUI(6, appliedLimit);

                // 固件交接规范：降低上限会立即钳位选定目标，须调用 GetState 刷新下位机被钳位的真实目标
                const stResp = await reqQueue.enqueue(MotorProtocol.CommandType.GetState, (seq) => MotorProtocol.encodeGetState(seq));
                if (stResp.result === MotorProtocol.Result.Ok) {
                    appliedTargetTorque = Math.fround(stResp.value);
                    setTorqueTargetUI(appliedTargetTorque, false);
                    updateTorqueSyncBadge();
                }
                log('info', `扭矩安全上限已更新为: ${appliedLimit.toFixed(2)} N·m，当前已接受目标: ${appliedTargetTorque.toFixed(3)} N·m`);
            } else {
                log('warn', `设置扭矩上限失败: ${resp.resultName}`);
            }
        } catch (err) {
            log('error', `设置扭矩上限异常: ${err.message}`);
        }
    }

    /**
     * 开启或关闭扭矩闭环 (遵循 HANDOFF.md §6：开启前先下发用户确认的目标扭矩)
     */
    async function setTorqueLoopEnabled(enabled) {
        try {
            if (enabled) {
                // 先下发当前用户确认的目标扭矩，等待成功应答后再开启闭环
                const targetOk = await sendTargetTorque(draftTargetTorque);
                if (!targetOk) {
                    log('warn', '目标扭矩下发未成功，已中止开启扭矩闭环');
                    return;
                }
            }

            const resp = await reqQueue.enqueue(MotorProtocol.CommandType.SetTorqueEnabled, (seq) => MotorProtocol.encodeSetTorqueEnabled(enabled, seq));
            if (resp.result === MotorProtocol.Result.Ok) {
                if (!enabled) {
                    appliedTargetV = 0.0;
                    updateVoltageSyncBadge();
                }
                log('info', `扭矩闭环已成功${enabled ? '【开启】' : '【关闭】'}`);
            } else {
                log('warn', `扭矩闭环切换失败: ${resp.resultName}`);
            }
        } catch (err) {
            log('error', `切换闭环异常: ${err.message}`);
        }
    }

    async function executeSafeSaveFlash() {
        if (!serial.isConnected && !serial.isMocking) {
            alert('请先连接串口或启动仿真模式再执行保存');
            return;
        }

        if (!confirm('【停机安全保存】将严格按交接规范执行：\n1. 发送停止指令 (0V) 关闭输出与扭矩闭环并等待应答\n2. 逐项写入已修改的 RAM 参数 (含 Kp/Ki/Kd/Q/R/Limit)\n3. 发送 SaveParameters 持久化到下位机 Flash\n\n确认立即执行吗？')) {
            return;
        }

        if (el.btnSaveFlash) {
            el.btnSaveFlash.disabled = true;
            el.btnSaveFlash.textContent = '正在保存到 Flash...';
        }
        if (el.flashSaveBadge) {
            el.flashSaveBadge.textContent = '保存中...';
            el.flashSaveBadge.style.color = 'var(--accent-amber)';
        }

        let step = 'stop';
        try {
            // 步骤 1: 发送 SetVoltage(0) 确保不论手动电压还是扭矩闭环均彻底停机
            log('info', '【保存流程 1/4】发送软件停止指令 (SetVoltage 0V)，等待停机应答...');
            const stopResp = await reqQueue.enqueue(MotorProtocol.CommandType.SetVoltage, (seq) => MotorProtocol.encodeSetVoltage(0.0, seq));
            if (stopResp.result !== MotorProtocol.Result.Ok) {
                throw new Error(`停止输出失败: ${stopResp.resultName}`);
            }
            appliedTargetV = 0.0;
            updateVoltageSyncBadge();

            // 步骤 2: 逐项检查并写入全部 6 个参数中发生变化的项
            step = 'write_ram';
            log('info', '【保存流程 2/4】正在核对并将已修改参数逐项写入下位机 RAM...');
            let limitChanged = false;
            for (let id = 1; id <= 6; id++) {
                const inputEl = el.paramInputs[id];
                if (inputEl) {
                    const newVal = Math.fround(parseFloat(inputEl.value));
                    if (Number.isFinite(newVal) && Math.abs(newVal - ramParams[id]) > 1e-6) {
                        const pResp = await reqQueue.enqueue(MotorProtocol.CommandType.SetParameter, (seq) => MotorProtocol.encodeSetParameter(id, newVal, seq));
                        if (pResp.result !== MotorProtocol.Result.Ok) {
                            throw new Error(`写入参数 ${MotorProtocol.ParameterNames[id].name} 失败: ${pResp.resultName}`);
                        }
                        const appliedVal = Math.fround(pResp.value);
                        ramParams[id] = appliedVal;
                        updateParamRowUI(id, appliedVal);
                        if (id === 6) {
                            applyTorqueLimitToUI(appliedVal);
                            limitChanged = true;
                        }
                    }
                }
            }

            if (limitChanged) {
                const stResp = await reqQueue.enqueue(MotorProtocol.CommandType.GetState, (seq) => MotorProtocol.encodeGetState(seq));
                if (stResp.result === MotorProtocol.Result.Ok) {
                    appliedTargetTorque = Math.fround(stResp.value);
                    setTorqueTargetUI(appliedTargetTorque, false);
                    updateTorqueSyncBadge();
                }
            }

            // 步骤 3: 发送 SaveParameters (0x12)，超时 3000ms
            step = 'save_flash';
            log('info', '【保存流程 3/4】发送 SaveParameters 命令擦写持久化到 Flash (超时 3s)...');
            const saveResp = await reqQueue.enqueue(
                MotorProtocol.CommandType.SaveParameters,
                (seq) => MotorProtocol.encodeSaveParameters(seq),
                3000
            );

            const storageCode = Math.round(saveResp.value);
            const storageMsg = MotorProtocol.StorageCodeNames[storageCode] || `Code ${storageCode}`;

            if (saveResp.result === MotorProtocol.Result.Ok && storageCode === 0) {
                log('info', `【保存流程 4/4】🎉 Flash 保存成功！(存储状态: ${storageMsg})`);
                if (el.flashSaveBadge) {
                    el.flashSaveBadge.textContent = '✓ 已保存到下位机 Flash';
                    el.flashSaveBadge.style.color = 'var(--color-success)';
                }
                alert('🎉 下位机全部 6 项参数已成功持久化保存到 Flash！');
            } else {
                throw new Error(`Flash 存储返回异常: Result=${saveResp.resultName}, 存储码=${storageMsg}`);
            }
        } catch (err) {
            log('error', `保存中止: ${err.message}`);
            if (el.flashSaveBadge) {
                if (step === 'save_flash' && String(err.message).includes('Timeout')) {
                    // 严格遵循 HANDOFF.md §6 line 201：保存应答丢失时显示“结果未知”，提示人工确认，禁止盲目重试
                    el.flashSaveBadge.textContent = '⚠️ 结果未知 (请人工核对)';
                    el.flashSaveBadge.style.color = 'var(--color-warning)';
                } else {
                    el.flashSaveBadge.textContent = '✕ 保存未完成';
                    el.flashSaveBadge.style.color = 'var(--color-error)';
                }
            }
            alert(`保存未完成: ${err.message}`);
        } finally {
            if (el.btnSaveFlash) {
                el.btnSaveFlash.disabled = false;
                el.btnSaveFlash.textContent = '💾 停机安全保存到 Flash';
            }
        }
    }

    // 节流实时下发 (仅当用户主动勾选“实时下发”时生效)
    let autoSyncThrottleTimer = null;
    function triggerAutoSyncVoltage(val) {
        if (!el.chkAutoSync || !el.chkAutoSync.checked) return;
        if (autoSyncThrottleTimer) return;
        autoSyncThrottleTimer = setTimeout(() => {
            autoSyncThrottleTimer = null;
            sendTargetVoltage(draftTargetV);
        }, 50); // 20Hz 节流
    }

    function setVoltageValue(v, forceSend = false) {
        let val = Number(v);
        if (!Number.isFinite(val)) val = 0.0;
        val = Math.max(0.0, Math.min(MotorProtocol.MAX_VOLTAGE, val));
        val = Math.round(val * 100) / 100;

        draftTargetV = val;
        if (el.sliderVoltage) el.sliderVoltage.value = val;
        if (el.inputVoltage) el.inputVoltage.value = val.toFixed(2);
        if (el.displayTargetVal) el.displayTargetVal.textContent = `${val.toFixed(2)} V`;

        if (el.presetChips) {
            el.presetChips.forEach(chip => {
                const pVal = Number(chip.getAttribute('data-val'));
                if (Math.abs(pVal - val) < 0.05) {
                    chip.classList.add('active');
                } else {
                    chip.classList.remove('active');
                }
            });
        }

        updateVoltageSyncBadge();

        if (forceSend) {
            sendTargetVoltage(val);
        } else {
            triggerAutoSyncVoltage(val);
        }
    }

    /**
     * 按下位机已接受的当前目标计算前馈 Vff 与动态电压上限 Vmax (遵循 HANDOFF.md §4 line 120)
     */
    function updateDynamicVoltageCeilingUI(acceptedTorque, previewDraftTorque) {
        const torquePerVolt = 0.5;
        const tAccepted = Math.max(0.0, Number(acceptedTorque) || 0.0);
        const vFf = tAccepted > 0 ? Math.min(tAccepted / torquePerVolt, 18.0) : 0.0;
        const vMax = tAccepted > 0 ? Math.min(vFf + 0.5, 18.0) : 0.0;

        if (el.dispTorqueVmax) {
            el.dispTorqueVmax.textContent = `${vMax.toFixed(2)} V`;
        }
        if (el.dispTorqueVff) {
            el.dispTorqueVff.textContent = `${vFf.toFixed(2)} V`;
        }

        if (el.dispDraftCeilingHint) {
            const tDraft = Math.max(0.0, Number(previewDraftTorque) || 0.0);
            if (Math.abs(tDraft - tAccepted) >= 0.001) {
                const draftVff = tDraft > 0 ? Math.min(tDraft / torquePerVolt, 18.0) : 0.0;
                const draftVmax = tDraft > 0 ? Math.min(draftVff + 0.5, 18.0) : 0.0;
                el.dispDraftCeilingHint.style.display = 'block';
                el.dispDraftCeilingHint.textContent = `👉 待下发设定 (${tDraft.toFixed(3)} N·m) 预计: Vff = ${draftVff.toFixed(2)} V, Vmax = ${draftVmax.toFixed(2)} V`;
            } else {
                el.dispDraftCeilingHint.style.display = 'none';
            }
        }
    }

    function setTorqueTargetUI(t, forceSend = false) {
        let val = Number(t);
        if (!Number.isFinite(val)) val = 0.0;
        val = Math.max(0.0, Math.min(currentTorqueLimit, val));
        val = Math.round(val * 1000) / 1000;

        draftTargetTorque = val;
        if (el.sliderTorque) el.sliderTorque.value = val;
        if (el.inputTorque) el.inputTorque.value = val.toFixed(3);
        if (el.displayTargetTorque) el.displayTargetTorque.textContent = `${val.toFixed(3)} N·m`;

        if (el.torquePresetChips) {
            el.torquePresetChips.forEach(chip => {
                const pVal = Number(chip.getAttribute('data-val'));
                if (Math.abs(pVal - val) < 0.05) {
                    chip.classList.add('active');
                } else {
                    chip.classList.remove('active');
                }
            });
        }

        updateTorqueSyncBadge();

        if (forceSend) {
            sendTargetTorque(val);
        }
    }

    function setupEventListeners() {
        // 模式二选一切换 (手动电压 vs 扭矩闭环)
        const modeBtns = document.querySelectorAll('.mode-toggle-btn');
        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetMode = btn.getAttribute('data-mode');
                activeMode = targetMode;
                modeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const card = document.getElementById('primaryControlCard');
                const paneV = document.getElementById('mode-pane-voltage');
                const paneT = document.getElementById('mode-pane-torque');

                if (targetMode === 'voltage') {
                    if (paneV) paneV.classList.add('active');
                    if (paneT) paneT.classList.remove('active');
                    if (card) {
                        card.classList.add('group-voltage');
                        card.classList.remove('group-torque');
                    }
                    log('info', '已切换到【手动电压驱动模式】');
                } else {
                    if (paneV) paneV.classList.remove('active');
                    if (paneT) paneT.classList.add('active');
                    if (card) {
                        card.classList.remove('group-voltage');
                        card.classList.add('group-torque');
                    }
                    log('info', '已切换到【扭矩闭环控制模式】');
                }
                syncScopeTargets();
            });
        });

        // 串口连接/断开
        if (el.btnConnect) {
            el.btnConnect.addEventListener('click', async () => {
                const baud = parseInt(el.baudSelect.value, 10) || 115200;
                try {
                    await serial.connect(baud);
                } catch (_) {}
            });
        }

        if (el.btnDisconnect) {
            el.btnDisconnect.addEventListener('click', async () => {
                await serial.disconnect();
                el.btnMock.style.display = 'inline-flex';
            });
        }

        // 模拟器切换
        if (el.btnMock) {
            el.btnMock.addEventListener('click', () => {
                if (serial.isMocking) {
                    serial.stopMock();
                } else {
                    serial.startMock();
                }
            });
        }

        // 主动查询状态 (GetState 0x13)
        if (el.btnQueryState) {
            el.btnQueryState.addEventListener('click', async () => {
                try {
                    const resp = await reqQueue.enqueue(MotorProtocol.CommandType.GetState, (seq) => MotorProtocol.encodeGetState(seq));
                    if (resp.result === MotorProtocol.Result.Ok) {
                        appliedTargetTorque = Math.fround(resp.value);
                        updateTorqueSyncBadge();
                        log('info', `[状态刷新] 当前已选定扭矩目标=${appliedTargetTorque.toFixed(3)} N·m, 闭环=${resp.torqueEnabled ? '开启' : '关闭'}, 反馈=${resp.feedbackValid ? '有效' : '未就绪'}`);
                    }
                } catch (err) {
                    log('error', `查询状态失败: ${err.message}`);
                }
            });
        }

        // 控制组 1: 电压交互
        if (el.sliderVoltage) {
            el.sliderVoltage.addEventListener('input', (e) => setVoltageValue(e.target.value, false));
            el.sliderVoltage.addEventListener('change', (e) => {
                const autoSend = Boolean(el.chkAutoSync && el.chkAutoSync.checked);
                setVoltageValue(e.target.value, autoSend);
            });
        }

        if (el.inputVoltage) {
            el.inputVoltage.addEventListener('change', (e) => {
                const autoSend = Boolean(el.chkAutoSync && el.chkAutoSync.checked);
                setVoltageValue(e.target.value, autoSend);
            });
            el.inputVoltage.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') setVoltageValue(e.target.value, true);
            });
        }

        if (el.btnStepDec) {
            el.btnStepDec.addEventListener('click', () => {
                const autoSend = Boolean(el.chkAutoSync && el.chkAutoSync.checked);
                setVoltageValue(draftTargetV - 0.2, autoSend);
            });
        }
        if (el.btnStepInc) {
            el.btnStepInc.addEventListener('click', () => {
                const autoSend = Boolean(el.chkAutoSync && el.chkAutoSync.checked);
                setVoltageValue(draftTargetV + 0.2, autoSend);
            });
        }

        if (el.presetChips) {
            el.presetChips.forEach(chip => {
                chip.addEventListener('click', () => {
                    const v = parseFloat(chip.getAttribute('data-val'));
                    const autoSend = Boolean(el.chkAutoSync && el.chkAutoSync.checked);
                    setVoltageValue(v, autoSend);
                });
            });
        }

        if (el.btnSend) {
            el.btnSend.addEventListener('click', () => sendTargetVoltage(draftTargetV));
        }

        if (el.btnEstop) {
            el.btnEstop.addEventListener('click', () => {
                setVoltageValue(0.0, true);
                log('warn', '【执行软件停机】下发目标电压 0.00 V');
            });
        }

        // 控制组 2: 扭矩与限幅交互
        if (el.sliderTorque) {
            el.sliderTorque.addEventListener('input', (e) => setTorqueTargetUI(e.target.value, false));
            el.sliderTorque.addEventListener('change', (e) => setTorqueTargetUI(e.target.value, false));
        }

        if (el.inputTorque) {
            el.inputTorque.addEventListener('change', (e) => setTorqueTargetUI(e.target.value, false));
            el.inputTorque.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') setTorqueTargetUI(e.target.value, true);
            });
        }

        if (el.btnStepTorqueDec) {
            el.btnStepTorqueDec.addEventListener('click', () => setTorqueTargetUI(draftTargetTorque - 0.1, false));
        }
        if (el.btnStepTorqueInc) {
            el.btnStepTorqueInc.addEventListener('click', () => setTorqueTargetUI(draftTargetTorque + 0.1, false));
        }

        if (el.torquePresetChips) {
            el.torquePresetChips.forEach(chip => {
                chip.addEventListener('click', () => {
                    const t = parseFloat(chip.getAttribute('data-val'));
                    setTorqueTargetUI(t, false);
                });
            });
        }

        if (el.btnSetTorque) {
            el.btnSetTorque.addEventListener('click', () => sendTargetTorque(draftTargetTorque));
        }

        if (el.btnEnableTorque) {
            el.btnEnableTorque.addEventListener('click', () => setTorqueLoopEnabled(true));
        }

        if (el.btnDisableTorque) {
            el.btnDisableTorque.addEventListener('click', () => setTorqueLoopEnabled(false));
        }

        if (el.btnStopTorque) {
            el.btnStopTorque.addEventListener('click', () => {
                sendTargetVoltage(0.0);
                log('warn', '【执行紧急软件停机】发送 0.00V 关闭扭矩闭环并停止 PWM');
            });
        }

        // 扭矩上限幅值交互 (与参数面板 ID 6 双向联动)
        if (el.inputTorqueLimit) {
            el.inputTorqueLimit.addEventListener('input', () => {
                if (el.paramInputs[6]) {
                    el.paramInputs[6].value = el.inputTorqueLimit.value;
                    el.paramInputs[6].dispatchEvent(new Event('input'));
                }
            });
        }
        if (el.btnStepLimitDec) {
            el.btnStepLimitDec.addEventListener('click', () => {
                const cur = parseFloat(el.inputTorqueLimit.value) || currentTorqueLimit;
                const next = Math.max(0.1, cur - 0.5);
                sendSetTorqueLimit(next);
            });
        }
        if (el.btnStepLimitInc) {
            el.btnStepLimitInc.addEventListener('click', () => {
                const cur = parseFloat(el.inputTorqueLimit.value) || currentTorqueLimit;
                const next = Math.min(10.0, cur + 0.5);
                sendSetTorqueLimit(next);
            });
        }
        if (el.btnSetTorqueLimit) {
            el.btnSetTorqueLimit.addEventListener('click', () => {
                const val = parseFloat(el.inputTorqueLimit.value);
                if (Number.isFinite(val) && val > 0) {
                    sendSetTorqueLimit(val);
                }
            });
        }

        // 6 项完整参数面板交互
        if (el.btnReadParams) {
            el.btnReadParams.addEventListener('click', () => syncDeviceState());
        }

        Object.keys(el.paramInputs).forEach(idStr => {
            const id = Number(idStr);
            const input = el.paramInputs[id];
            if (input) {
                input.addEventListener('input', () => {
                    if (id === 6 && el.inputTorqueLimit) {
                        el.inputTorqueLimit.value = input.value;
                    }
                    const card = input.closest('.param-card');
                    if (card) {
                        const fInput = Math.fround(parseFloat(input.value));
                        const isDiff = Number.isFinite(fInput) && Math.abs(fInput - ramParams[id]) > 1e-6;
                        if (isDiff) {
                            card.classList.add('dirty');
                            if (el.flashSaveBadge) {
                                el.flashSaveBadge.textContent = '● 存在未应用改动';
                                el.flashSaveBadge.style.color = 'var(--accent-amber)';
                            }
                        } else {
                            card.classList.remove('dirty');
                        }
                    }
                });
            }
        });

        if (el.btnApplyParams) {
            el.btnApplyParams.addEventListener('click', async () => {
                log('info', '正在将本地修改参数逐项写入下位机 RAM...');
                let anyWritten = false;
                let limitUpdated = false;
                for (let id = 1; id <= 6; id++) {
                    const input = el.paramInputs[id];
                    if (input) {
                        const val = Math.fround(parseFloat(input.value));
                        if (Number.isFinite(val) && Math.abs(val - ramParams[id]) > 1e-6) {
                            try {
                                const resp = await reqQueue.enqueue(MotorProtocol.CommandType.SetParameter, (seq) => MotorProtocol.encodeSetParameter(id, val, seq));
                                if (resp.result === MotorProtocol.Result.Ok) {
                                    const appliedVal = Math.fround(resp.value);
                                    ramParams[id] = appliedVal;
                                    updateParamRowUI(id, appliedVal);
                                    anyWritten = true;
                                    if (id === 6) {
                                        applyTorqueLimitToUI(appliedVal);
                                        limitUpdated = true;
                                    }
                                    log('info', `参数 ${MotorProtocol.ParameterNames[id].name} 已写入 RAM: ${appliedVal}`);
                                } else {
                                    log('warn', `参数 ${MotorProtocol.ParameterNames[id].name} 写入失败: ${resp.resultName}`);
                                }
                            } catch (err) {
                                log('error', `写入参数异常: ${err.message}`);
                            }
                        }
                    }
                }
                if (limitUpdated) {
                    try {
                        const stResp = await reqQueue.enqueue(MotorProtocol.CommandType.GetState, (seq) => MotorProtocol.encodeGetState(seq));
                        if (stResp.result === MotorProtocol.Result.Ok) {
                            appliedTargetTorque = Math.fround(stResp.value);
                            setTorqueTargetUI(appliedTargetTorque, false);
                            updateTorqueSyncBadge();
                        }
                    } catch (_) {}
                }
                if (anyWritten && el.flashSaveBadge) {
                    el.flashSaveBadge.textContent = 'RAM 已应用 (未写Flash)';
                    el.flashSaveBadge.style.color = 'var(--accent-cyan)';
                }
            });
        }

        if (el.btnSaveFlash) {
            el.btnSaveFlash.addEventListener('click', () => executeSafeSaveFlash());
        }

        // 示波器控制交互
        if (el.chkShowTargetRef) {
            el.chkShowTargetRef.addEventListener('change', (e) => {
                scope.setShowTargetRef(e.target.checked);
            });
        }

        if (el.selectScopePoints) {
            el.selectScopePoints.addEventListener('change', (e) => {
                scope.setMaxPoints(e.target.value);
                log('info', `示波器采样窗口已调整为 ${e.target.value} 点`);
            });
        }

        if (el.btnPauseChart) {
            el.btnPauseChart.addEventListener('click', () => {
                const paused = scope.togglePause();
                el.btnPauseChart.classList.toggle('btn-primary', paused);
                el.btnPauseChart.innerHTML = paused ? `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                    恢复采样
                ` : `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                    </svg>
                    暂停采样
                `;
            });
        }

        if (el.btnClearChart) {
            el.btnClearChart.addEventListener('click', () => {
                scope.clear();
                vMinObserved = Infinity;
                vMaxObserved = -Infinity;
                tMaxObserved = -Infinity;
                if (el.dispVoltageMin) el.dispVoltageMin.textContent = '--';
                if (el.dispVoltageMax) el.dispVoltageMax.textContent = '--';
                if (el.dispTorqueMax) el.dispTorqueMax.textContent = '--';
                log('info', '示波器历史波形与统计极值已清空');
            });
        }

        if (el.btnExportCsv) {
            el.btnExportCsv.addEventListener('click', () => {
                const csv = scope.exportCsv();
                if (!csv) {
                    alert('当前尚无波形数据可导出');
                    return;
                }
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `motor_telemetry_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                log('info', '已导出采样数据 CSV 文件 (含目标与限幅参考列)');
            });
        }

        if (el.btnClearLog) {
            el.btnClearLog.addEventListener('click', () => {
                if (el.logTerminal) el.logTerminal.innerHTML = '';
            });
        }
    }

    window.addEventListener('DOMContentLoaded', () => {
        setupEventListeners();
        updateVoltageSyncBadge();
        updateTorqueSyncBadge();
        log('info', '上位机控制系统 v2.4 已就绪，等待连接硬件串口 (USART3 115200 8N1)');
    });

})();
