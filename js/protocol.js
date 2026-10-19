/**
 * @file protocol.js
 * @brief 电机上位机通信协议编解码器与帧流解包器
 *
 * 协议规范（双向均为固定 14 字节小端对齐）：
 * 帧头(0xA5) + 版本(0x01) + 类型(0x01/0x81) + 序号(uint8) + Float32(4B) + Float32/保留(4B) + CRC16(2B)
 */

(function (global) {
    'use strict';

    const HEADER = 0xA5;
    const VERSION = 0x01;
    const TYPE_SET_VOLTAGE = 0x01;
    const TYPE_FEEDBACK = 0x81;
    const FRAME_SIZE = 14;
    const MAX_VOLTAGE = 18.0;

    // CRC-16/CCITT-FALSE 预计算 256 项查找表
    // Poly: 0x1021, Init: 0xFFFF, RefIn: false, RefOut: false, XorOut: 0x0000
    const CRC_TABLE = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
        let curr = (i << 8) & 0xFFFF;
        for (let j = 0; j < 8; j++) {
            if (curr & 0x8000) {
                curr = ((curr << 1) ^ 0x1021) & 0xFFFF;
            } else {
                curr = (curr << 1) & 0xFFFF;
            }
        }
        CRC_TABLE[i] = curr;
    }

    /**
     * 计算数据的 CRC16/CCITT-FALSE
     * @param {Uint8Array} buffer 
     * @param {number} length 
     * @returns {number} 16位无符号整数
     */
    function calcCrc16(buffer, length = buffer.length) {
        let crc = 0xFFFF;
        for (let i = 0; i < length; i++) {
            crc = (((crc << 8) & 0xFFFF) ^ CRC_TABLE[((crc >>> 8) ^ buffer[i]) & 0xFF]);
        }
        return crc & 0xFFFF;
    }

    /**
     * 将字节数组格式化为大写十六进制字符串（如 "A5 01 01 00 ..."）
     * @param {Uint8Array} arr 
     * @returns {string}
     */
    function bytesToHex(arr) {
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    }

    /**
     * 打包下行指令：设置目标输出电压
     * @param {number} targetVoltage 目标电压 (V, 范围 0.0 ~ 18.0)
     * @param {number} sequence 帧序号 (0 ~ 255)
     * @returns {Uint8Array} 14 字节的完整二进制帧
     */
    function encodeSetVoltage(targetVoltage, sequence = 0) {
        let v = Number(targetVoltage);
        if (!Number.isFinite(v)) v = 0.0;
        if (v < 0.0) v = 0.0;
        if (v > MAX_VOLTAGE) v = MAX_VOLTAGE;

        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = TYPE_SET_VOLTAGE;
        frame[3] = (sequence & 0xFF);

        const view = new DataView(frame.buffer);
        // 小端 Float32
        view.setFloat32(4, v, true);
        // 保留 4 字节为 0.0
        view.setFloat32(8, 0.0, true);

        // CRC 校验前 12 字节
        const crc = calcCrc16(frame, 12);
        frame[12] = crc & 0xFF;        // 低字节在前
        frame[13] = (crc >>> 8) & 0xFF; // 高字节在后

        return frame;
    }

    /**
     * 解码上行反馈帧（14 字节）
     * @param {Uint8Array} frame 
     * @returns {object|null}
     */
    function decodeFeedback(frame) {
        if (!frame || frame.length !== FRAME_SIZE) return null;
        if (frame[0] !== HEADER || frame[1] !== VERSION || frame[2] !== TYPE_FEEDBACK) {
            return null;
        }

        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        const expectedCrc = calcCrc16(frame, 12);
        const actualCrc = view.getUint16(12, true); // 小端读取

        if (expectedCrc !== actualCrc) {
            return {
                valid: false,
                error: `CRC mismatch (expected 0x${expectedCrc.toString(16).padStart(4, '0')}, got 0x${actualCrc.toString(16).padStart(4, '0')})`,
                rawBytes: new Uint8Array(frame)
            };
        }

        const seq = frame[3];
        const voltage = view.getFloat32(4, true);
        const torque = view.getFloat32(8, true);

        return {
            valid: true,
            seq: seq,
            voltage: Number.isFinite(voltage) ? voltage : 0.0,
            torque: Number.isFinite(torque) ? torque : 0.0,
            rawBytes: new Uint8Array(frame),
            timestamp: performance.now()
        };
    }

    /**
     * 流式帧解包器，可应对串口数据分片、粘包和前置噪声
     */
    class StreamUnpacker {
        constructor(onFrameCallback, onErrorCallback) {
            this.buffer = new Uint8Array(1024);
            this.bufferLen = 0;
            this.onFrame = onFrameCallback || (() => {});
            this.onError = onErrorCallback || (() => {});
            this.stats = {
                bytesReceived: 0,
                validFrames: 0,
                crcErrors: 0,
                discardedBytes: 0
            };
        }

        reset() {
            this.bufferLen = 0;
        }

        /**
         * 接收新流入的数据块
         * @param {Uint8Array} chunk 
         */
        feed(chunk) {
            if (!chunk || chunk.length === 0) return;
            this.stats.bytesReceived += chunk.length;

            // 扩展缓冲区容量如果需要
            if (this.bufferLen + chunk.length > this.buffer.length) {
                const newCap = Math.max(this.buffer.length * 2, this.bufferLen + chunk.length + 256);
                const nextBuf = new Uint8Array(newCap);
                nextBuf.set(this.buffer.subarray(0, this.bufferLen), 0);
                this.buffer = nextBuf;
            }

            this.buffer.set(chunk, this.bufferLen);
            this.bufferLen += chunk.length;

            // 循环寻找完整有效帧
            while (this.bufferLen >= FRAME_SIZE) {
                // 查找帧头 0xA5
                let headerIdx = -1;
                for (let i = 0; i < this.bufferLen; i++) {
                    if (this.buffer[i] === HEADER) {
                        headerIdx = i;
                        break;
                    }
                }

                if (headerIdx === -1) {
                    // 整个缓冲区中没有帧头，全为垃圾数据
                    this.stats.discardedBytes += this.bufferLen;
                    this.bufferLen = 0;
                    break;
                }

                if (headerIdx > 0) {
                    // 抛弃帧头前面的噪点字节
                    this.stats.discardedBytes += headerIdx;
                    this.buffer.copyWithin(0, headerIdx, this.bufferLen);
                    this.bufferLen -= headerIdx;
                }

                // 现在 buffer[0] 一定是 0xA5
                if (this.bufferLen < FRAME_SIZE) {
                    // 虽有帧头，但不足 14 字节，等待下次流数据拼接
                    break;
                }

                // 检查版本与消息类型初步过滤
                const ver = this.buffer[1];
                const type = this.buffer[2];

                if (ver !== VERSION || (type !== TYPE_FEEDBACK && type !== TYPE_SET_VOLTAGE)) {
                    // 不是合法协议帧，滑过该假帧头字节
                    this.stats.discardedBytes += 1;
                    this.buffer.copyWithin(0, 1, this.bufferLen);
                    this.bufferLen -= 1;
                    continue;
                }

                // 提取 14 字节候选帧进行校验
                const candidate = this.buffer.subarray(0, FRAME_SIZE);
                const decoded = decodeFeedback(candidate);

                if (decoded && decoded.valid) {
                    this.stats.validFrames++;
                    this.onFrame(decoded);
                    // 消耗这 14 字节
                    this.buffer.copyWithin(0, FRAME_SIZE, this.bufferLen);
                    this.bufferLen -= FRAME_SIZE;
                } else {
                    // CRC 校验错误
                    this.stats.crcErrors++;
                    this.onError(decoded || { error: 'Unknown frame error' });
                    // 滑过这 1 字节继续找下一个可能的帧头
                    this.stats.discardedBytes += 1;
                    this.buffer.copyWithin(0, 1, this.bufferLen);
                    this.bufferLen -= 1;
                }
            }
        }
    }

    // 导出到全局命名空间
    global.MotorProtocol = {
        HEADER,
        VERSION,
        TYPE_SET_VOLTAGE,
        TYPE_FEEDBACK,
        FRAME_SIZE,
        MAX_VOLTAGE,
        calcCrc16,
        bytesToHex,
        encodeSetVoltage,
        decodeFeedback,
        StreamUnpacker
    };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this)));
