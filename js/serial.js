/**
 * @file serial.js
 * @brief 现代 Web Serial 硬件串口驱动与高保真虚拟电机下位机仿真器
 * @version 0x01 (支持 0x81/0x82 协议与扭矩闭环状态机)
 */

(function (global) {
    'use strict';

    class SerialManager {
        constructor(options = {}) {
            this.baudRate = options.baudRate || 115200;
            this.onData = options.onData || (() => {});
            this.onStatusChange = options.onStatusChange || (() => {});
            this.onLog = options.onLog || (() => {});

            this.port = null;
            this.reader = null;
            this.writer = null;
            this.keepReading = false;
            this.isConnected = false;

            // 虚拟硬件仿真器状态机
            this.isMocking = false;
            this.mockTimer = null;
            this.mockSeq = 0;

            // 仿真参数与控制量
            this.mockState = {
                vTarget: 0.0,
                vCurrent: 0.0,
                torqueTarget: 0.0,
                torqueCurrent: 0.0,
                torqueEnabled: false,
                feedbackValid: true,
                pidIntegral: 0.0,
                pidPrevError: 0.0,
                ramParams: {
                    1: 1.0,    // Kp
                    2: 0.05,   // Ki
                    3: 0.01,   // Kd
                    4: 0.01,   // Q
                    5: 0.01,   // R
                    6: 3.0     // TorqueLimit
                },
                flashParams: {
                    1: 1.0,
                    2: 0.05,
                    3: 0.01,
                    4: 0.01,
                    5: 0.01,
                    6: 3.0
                }
            };
        }

        static isSupported() {
            return 'serial' in navigator;
        }

        async connect(baudRate = this.baudRate) {
            if (!SerialManager.isSupported()) {
                throw new Error('当前浏览器不支持 Web Serial API，请使用 Google Chrome 或 Edge 89+');
            }

            if (this.isMocking) {
                this.stopMock();
            }

            try {
                this.port = await navigator.serial.requestPort();
                await this.port.open({
                    baudRate: baudRate,
                    dataBits: 8,
                    stopBits: 1,
                    parity: 'none',
                    flowControl: 'none',
                    bufferSize: 4096
                });
                try {
                    if (this.port.setSignals) {
                        await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
                    }
                } catch (_) {}

                this.isConnected = true;
                this.keepReading = true;
                this.baudRate = baudRate;

                this.onStatusChange({ connected: true, baudRate: this.baudRate, type: 'hardware' });
                this.onLog('info', `已成功连接串口 (波特率: ${this.baudRate} 8N1)`);

                this._readLoop();
                return true;
            } catch (err) {
                this.isConnected = false;
                this.onStatusChange({ connected: false });
                if (err.name !== 'NotFoundError') {
                    this.onLog('error', `串口连接失败: ${err.message}`);
                }
                throw err;
            }
        }

        async disconnect() {
            this.keepReading = false;

            if (this.isMocking) {
                this.stopMock();
                return;
            }

            try {
                if (this.reader) {
                    await this.reader.cancel();
                    this.reader = null;
                }
                if (this.writer) {
                    this.writer.releaseLock();
                    this.writer = null;
                }
                if (this.port) {
                    await this.port.close();
                    this.port = null;
                }
            } catch (err) {
                this.onLog('warn', `关闭串口时捕获: ${err.message}`);
            } finally {
                this.isConnected = false;
                this.onStatusChange({ connected: false });
                this.onLog('info', '串口已安全断开');
            }
        }

        /**
         * 发送二进制帧数据
         * @param {Uint8Array} data 
         */
        async send(data) {
            if (this.isMocking) {
                this._handleMockReceive(data);
                return true;
            }

            if (!this.isConnected || !this.port || !this.port.writable) {
                throw new Error('串口未连接，无法发送数据');
            }

            try {
                const writer = this.port.writable.getWriter();
                await writer.write(data);
                writer.releaseLock();
                return true;
            } catch (err) {
                this.onLog('error', `发送数据异常: ${err.message}`);
                throw err;
            }
        }

        async _readLoop() {
            while (this.port && this.port.readable && this.keepReading) {
                try {
                    this.reader = this.port.readable.getReader();
                    while (this.keepReading) {
                        const { value, done } = await this.reader.read();
                        if (done) break;
                        if (value && value.length > 0) {
                            this.onData(value);
                        }
                    }
                } catch (err) {
                    if (this.keepReading) {
                        this.onLog('error', `读取串口数据流错误: ${err.message}`);
                    }
                } finally {
                    if (this.reader) {
                        try {
                            this.reader.releaseLock();
                        } catch (_) {}
                        this.reader = null;
                    }
                }
            }

            if (this.isConnected) {
                this.isConnected = false;
                this.onStatusChange({ connected: false });
                this.onLog('warn', '串口已从系统断开');
            }
        }

        /**
         * 启动虚拟硬件仿真器
         */
        startMock() {
            if (this.isConnected) {
                this.disconnect();
            }
            this.isMocking = true;

            // 复位仿真运行态
            this.mockState.vTarget = 0.0;
            this.mockState.vCurrent = 0.0;
            this.mockState.torqueTarget = 0.0;
            this.mockState.torqueCurrent = 0.0;
            this.mockState.torqueEnabled = false;
            this.mockState.feedbackValid = true;
            this.mockState.pidIntegral = 0.0;
            this.mockState.pidPrevError = 0.0;
            this.mockSeq = 0;

            this.onStatusChange({ connected: true, type: 'mock' });
            this.onLog('info', '已启动【虚拟电机与下位机仿真器】(支持 0x81 测量与 0x82 闭环应答)');

            // 50ms 一帧 (20Hz 遥测反馈)
            this.mockTimer = setInterval(() => {
                const ms = this.mockState;

                // 若扭矩闭环开启，执行外环扭矩前馈 + PID 计算 (最新下位机固件架构)
                if (ms.torqueEnabled && ms.feedbackValid) {
                    const kp = ms.ramParams[1] || 1.0;
                    const ki = ms.ramParams[2] || 0.05;
                    const kd = ms.ramParams[3] || 0.01;

                    // 最新规范：前馈 Vff = min(T / 0.5, 18V)，动态电压上限增加 +0.5V 裕量避免电压不足
                    const torquePerVolt = 0.5;
                    const vff = ms.torqueTarget > 0 ? Math.min(ms.torqueTarget / torquePerVolt, MotorProtocol.MAX_VOLTAGE) : 0.0;
                    const voltageLimit = ms.torqueTarget > 0 ? Math.min(vff + 0.5, MotorProtocol.MAX_VOLTAGE) : 0.0;

                    const err = ms.torqueTarget - ms.torqueCurrent;
                    ms.pidIntegral = Math.max(-voltageLimit, Math.min(voltageLimit, ms.pidIntegral + ki * err));
                    const dErr = err - ms.pidPrevError;
                    ms.pidPrevError = err;

                    const pidOut = kp * err + ms.pidIntegral + kd * dErr + vff;
                    ms.vTarget = Math.max(0.0, Math.min(voltageLimit, pidOut));
                }

                // 一阶惯性电压过渡仿真
                const vAlpha = 0.15;
                ms.vCurrent += (ms.vTarget - ms.vCurrent) * vAlpha;
                const vNoise = (Math.random() - 0.5) * 0.006;
                const finalV = Math.max(0.0, ms.vCurrent + vNoise);

                // 扭矩物理仿真模型 (电磁扭矩 + 惯性阻尼 + ADS1220 热噪声)
                const targetTorque = finalV > 0.05 ? (finalV * 0.42 + Math.sin(Date.now() / 500) * 0.12) : 0.0;
                ms.torqueCurrent += (targetTorque - ms.torqueCurrent) * 0.18;
                const tNoise = (Math.random() - 0.5) * 0.015;
                const finalT = Math.max(0.0, ms.torqueCurrent + tNoise);

                // 打包并下发 0x81 测量反馈帧
                const frame = new Uint8Array(MotorProtocol.FRAME_SIZE);
                frame[0] = MotorProtocol.HEADER;
                frame[1] = MotorProtocol.VERSION;
                frame[2] = MotorProtocol.TYPE_FEEDBACK;
                frame[3] = (this.mockSeq++) & 0xFF;

                const dv = new DataView(frame.buffer);
                dv.setFloat32(4, finalV, true);
                dv.setFloat32(8, finalT, true);

                const crc = MotorProtocol.calcCrc16(frame, 12);
                frame[12] = crc & 0xFF;
                frame[13] = (crc >>> 8) & 0xFF;

                this.onData(frame);
            }, 50);
        }

        stopMock() {
            if (!this.isMocking) return;
            if (this.mockTimer) {
                clearInterval(this.mockTimer);
                this.mockTimer = null;
            }
            this.isMocking = false;
            this.onStatusChange({ connected: false });
            this.onLog('info', '已关闭虚拟模拟器');
        }

        /**
         * 虚拟硬件处理上位机发送的下行控制帧并生成 0x82 应答
         */
        _handleMockReceive(data) {
            if (!data || data.length !== MotorProtocol.FRAME_SIZE) return;
            if (data[0] !== MotorProtocol.HEADER || data[1] !== MotorProtocol.VERSION) return;

            // 校验 CRC
            const crcExp = MotorProtocol.calcCrc16(data, 12);
            const dvIn = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const crcAct = dvIn.getUint16(12, true);
            if (crcExp !== crcAct) return;

            const cmdType = data[2];
            const seq = data[3];
            const ms = this.mockState;

            let result = MotorProtocol.Result.Ok;
            let respVal = 0.0;

            const mp = MotorProtocol;

            switch (cmdType) {
                case mp.CommandType.SetVoltage: {
                    const reqV = dvIn.getFloat32(4, true);
                    const reserved = dvIn.getUint32(8, true);
                    if (reserved !== 0 || !Number.isFinite(reqV) || reqV < 0.0 || reqV > 18.0) {
                        result = mp.Result.InvalidValue;
                    } else if (reqV === 0.0) {
                        // 软件停止
                        ms.torqueEnabled = false;
                        ms.vTarget = 0.0;
                        ms.pidIntegral = 0.0;
                        result = mp.Result.Ok;
                        respVal = 0.0;
                    } else if (ms.torqueEnabled) {
                        // 扭矩闭环运行中，禁止非零手动电压
                        result = mp.Result.ModeConflict;
                        respVal = 0.0;
                    } else {
                        ms.vTarget = reqV;
                        result = mp.Result.Ok;
                        respVal = reqV;
                    }
                    break;
                }

                case mp.CommandType.SetTorque: {
                    const reqT = dvIn.getFloat32(4, true);
                    const reserved = dvIn.getUint32(8, true);
                    const limit = ms.ramParams[6] || 3.0;
                    if (reserved !== 0 || !Number.isFinite(reqT) || reqT < 0.0 || reqT > limit) {
                        result = mp.Result.InvalidValue;
                    } else {
                        ms.torqueTarget = reqT;
                        result = mp.Result.Ok;
                        respVal = reqT;
                    }
                    break;
                }

                case mp.CommandType.SetTorqueEnabled: {
                    const enableArg = dvIn.getUint32(4, true);
                    const reserved = dvIn.getUint32(8, true);
                    if (reserved !== 0 || (enableArg !== 0 && enableArg !== 1)) {
                        result = mp.Result.InvalidValue;
                    } else if (enableArg === 1) {
                        if (!ms.feedbackValid) {
                            result = mp.Result.NotReady;
                        } else {
                            ms.torqueEnabled = true;
                            ms.pidIntegral = 0.0;
                            ms.pidPrevError = 0.0;
                            result = mp.Result.Ok;
                            respVal = 1.0;
                        }
                    } else {
                        ms.torqueEnabled = false;
                        ms.vTarget = 0.0;
                        ms.pidIntegral = 0.0;
                        result = mp.Result.Ok;
                        respVal = 0.0;
                    }
                    break;
                }

                case mp.CommandType.SetParameter: {
                    const paramId = dvIn.getUint32(4, true);
                    const val = dvIn.getFloat32(8, true);
                    if (paramId < 1 || paramId > 6 || !Number.isFinite(val)) {
                        result = mp.Result.InvalidValue;
                    } else if (paramId === 5 && val <= 0) { // R > 0
                        result = mp.Result.InvalidValue;
                    } else if (paramId === 6 && val <= 0) { // Limit > 0
                        result = mp.Result.InvalidValue;
                    } else if (val < 0) {
                        result = mp.Result.InvalidValue;
                    } else {
                        ms.ramParams[paramId] = val;
                        if (paramId === 6) {
                            ms.torqueTarget = Math.min(ms.torqueTarget, val);
                        }
                        // 复位 PID
                        ms.pidIntegral = 0.0;
                        ms.pidPrevError = 0.0;
                        result = mp.Result.Ok;
                        respVal = val;
                    }
                    break;
                }

                case mp.CommandType.GetParameter: {
                    const paramId = dvIn.getUint32(4, true);
                    const reserved = dvIn.getUint32(8, true);
                    if (reserved !== 0 || paramId < 1 || paramId > 6) {
                        result = mp.Result.InvalidValue;
                    } else {
                        result = mp.Result.Ok;
                        respVal = ms.ramParams[paramId] !== undefined ? ms.ramParams[paramId] : 0.0;
                    }
                    break;
                }

                case mp.CommandType.SaveParameters: {
                    const first = dvIn.getUint32(4, true);
                    const second = dvIn.getUint32(8, true);
                    if (first !== 0 || second !== 0) {
                        result = mp.Result.InvalidValue;
                    } else if (ms.torqueEnabled || ms.vTarget > 0.05) {
                        result = mp.Result.OutputActive;
                        respVal = 0.0;
                    } else {
                        // 模拟持久化到 Flash
                        ms.flashParams = Object.assign({}, ms.ramParams);
                        result = mp.Result.Ok;
                        respVal = 0.0; // StorageCode.Ok = 0
                    }
                    break;
                }

                case mp.CommandType.GetState: {
                    const first = dvIn.getUint32(4, true);
                    const second = dvIn.getUint32(8, true);
                    if (first !== 0 || second !== 0) {
                        result = mp.Result.InvalidValue;
                    } else {
                        result = mp.Result.Ok;
                        respVal = ms.torqueTarget;
                    }
                    break;
                }

                default:
                    return; // 未知命令丢弃
            }

            // 打包 0x82 命令应答帧
            const respFrame = new Uint8Array(mp.FRAME_SIZE);
            respFrame[0] = mp.HEADER;
            respFrame[1] = mp.VERSION;
            respFrame[2] = mp.TYPE_COMMAND_RESPONSE;
            respFrame[3] = seq;

            const dvOut = new DataView(respFrame.buffer);
            const statusWord = (result & 0xFF) |
                               ((ms.torqueEnabled ? 1 : 0) << 8) |
                               ((ms.feedbackValid ? 1 : 0) << 9) |
                               ((cmdType & 0xFF) << 16);
            dvOut.setUint32(4, statusWord, true);
            dvOut.setFloat32(8, respVal, true);

            const crc = mp.calcCrc16(respFrame, 12);
            respFrame[12] = crc & 0xFF;
            respFrame[13] = (crc >>> 8) & 0xFF;

            // 异步延迟 2ms 回传（模拟真实下位机应答时延）
            setTimeout(() => {
                this.onData(respFrame);
            }, 2);
        }
    }

    global.SerialManager = SerialManager;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this)));
