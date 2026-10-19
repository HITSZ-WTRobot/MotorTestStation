/**
 * @file serial.js
 * @brief 串口硬件适配器 (Web Serial API) 与 虚拟单片机仿真器 (Mock Motor)
 */

(function (global) {
    'use strict';

    class SerialManager {
        constructor(options = {}) {
            this.port = null;
            this.reader = null;
            this.writer = null;
            this.keepReading = false;
            this.isConnected = false;
            this.isMocking = false;

            this.onData = options.onData || (() => {});
            this.onLog = options.onLog || (() => {});
            this.onStatusChange = options.onStatusChange || (() => {});

            this.baudRate = options.baudRate || 115200;
            this.mockTimer = null;
            this.mockTargetV = 0.0;
            this.mockCurrentV = 0.0;
            this.mockTorque = 0.0;
            this.mockSeq = 0;
        }

        /**
         * 检测当前浏览器是否支持 Web Serial API
         */
        static isSupported() {
            return typeof navigator !== 'undefined' && 'serial' in navigator;
        }

        /**
         * 请求用户授权并连接物理串口
         * @param {number} baudRate 波特率 (默认 115200)
         */
        async connect(baudRate = 115200) {
            if (this.isMocking) {
                this.stopMock();
            }

            if (!SerialManager.isSupported()) {
                throw new Error('当前浏览器不支持 Web Serial API。请使用最新版 Google Chrome、Microsoft Edge 或 Opera 浏览器。');
            }

            this.baudRate = baudRate;
            try {
                this.port = await navigator.serial.requestPort();
                await this.port.open({
                    baudRate: this.baudRate,
                    dataBits: 8,
                    stopBits: 1,
                    parity: 'none',
                    flowControl: 'none',
                    bufferSize: 4096
                });

                this.isConnected = true;
                this.keepReading = true;
                this.onStatusChange({ connected: true, type: 'hardware', port: this.port, baudRate: this.baudRate });
                this.onLog('success', `串口已成功开启 (波特率: ${this.baudRate} 8N1)`);

                this._readLoop();
                return true;
            } catch (err) {
                this.isConnected = false;
                this.onStatusChange({ connected: false });
                if (err.name === 'NotFoundError') {
                    this.onLog('info', '用户取消了串口选择');
                } else {
                    this.onLog('error', `串口连接失败: ${err.message}`);
                    throw err;
                }
                return false;
            }
        }

        /**
         * 关闭串口连接
         */
        async disconnect() {
            if (this.isMocking) {
                this.stopMock();
                return;
            }

            this.keepReading = false;
            try {
                if (this.reader) {
                    await this.reader.cancel();
                    this.reader = null;
                }
                if (this.writer) {
                    await this.writer.close();
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
         * 发送二进制数据
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

        /**
         * 读取循环
         */
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
         * 启动虚拟硬件模拟器模式（便于脱机调试）
         */
        startMock() {
            if (this.isConnected) {
                this.disconnect();
            }
            this.isMocking = true;
            this.mockTargetV = 0.0;
            this.mockCurrentV = 0.0;
            this.mockTorque = 0.0;
            this.mockSeq = 0;

            this.onStatusChange({ connected: true, type: 'mock' });
            this.onLog('info', '已启动【虚拟电机模拟器】模式 (仿真 20Hz 连续反馈)');

            // 50ms 一帧 (20Hz)
            this.mockTimer = setInterval(() => {
                // 一阶惯性电压过渡仿真: V_feedback 动态逼近 target
                const alpha = 0.12;
                this.mockCurrentV += (this.mockTargetV - this.mockCurrentV) * alpha;

                // 叠加微量传感器热噪声
                const vNoise = (Math.random() - 0.5) * 0.008;
                const finalV = Math.max(0, this.mockCurrentV + vNoise);

                // 扭矩物理仿真模型：阻尼扭矩 + 与电压相关的电磁扭矩 + 微量扰动
                const targetTorque = finalV > 0.1 ? (finalV * 0.45 + Math.sin(Date.now() / 400) * 0.3) : 0.0;
                this.mockTorque += (targetTorque - this.mockTorque) * 0.15;
                const tNoise = (Math.random() - 0.5) * 0.03;
                const finalT = this.mockTorque + tNoise;

                // 打包上行反馈帧
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

                // 模拟串口流入
                this.onData(frame);
            }, 50);
        }

        /**
         * 停止虚拟硬件模拟器
         */
        stopMock() {
            if (!this.isMocking) return;
            if (this.mockTimer) {
                clearInterval(this.mockTimer);
                this.mockTimer = null;
            }
            this.onStatusChange({ connected: false });
            this.onLog('info', '已关闭虚拟模拟器');
        }

        /**
         * 虚拟硬件处理上位机发送的下行控制帧
         */
        _handleMockReceive(data) {
            if (!data || data.length !== MotorProtocol.FRAME_SIZE) return;
            if (data[0] !== MotorProtocol.HEADER || data[1] !== MotorProtocol.VERSION || data[2] !== MotorProtocol.TYPE_SET_VOLTAGE) {
                return;
            }
            const expectedCrc = MotorProtocol.calcCrc16(data, 12);
            const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const actualCrc = dv.getUint16(12, true);
            if (expectedCrc === actualCrc) {
                const target = dv.getFloat32(4, true);
                if (Number.isFinite(target) && target >= 0 && target <= MotorProtocol.MAX_VOLTAGE) {
                    this.mockTargetV = target;
                }
            }
        }
    }

    global.SerialManager = SerialManager;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this)));
