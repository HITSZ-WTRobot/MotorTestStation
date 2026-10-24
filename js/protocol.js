/**
 * @file protocol.js
 * @brief STM32 电机测控与闭环调试通信协议编解码器与流式解包器
 * @version 0x01 (匹配 Motor_test 最新下位机协议与 HANDOFF.md 规范)
 *
 * 协议规范（双向固定 14 字节小端对齐，CRC-16/CCITT-FALSE）：
 * [0] 帧头 0xA5
 * [1] 版本 0x01
 * [2] 操作码 / 消息类型 (下行 0x01~0x13，上行 0x81/0x82)
 * [3] 序列号 (0~255)
 * [4~7] word0 (小端 uint32 / float32)
 * [8~11] word1 (小端 uint32 / float32)
 * [12~13] CRC16 (低字节在前，小端)
 */

(function (global) {
    'use strict';

    const HEADER = 0xA5;
    const VERSION = 0x01;
    const FRAME_SIZE = 14;
    const MAX_VOLTAGE = 18.0;

    // 上行类型
    const TYPE_FEEDBACK = 0x81;
    const TYPE_COMMAND_RESPONSE = 0x82;

    // 下行命令类型
    const CommandType = Object.freeze({
        SetVoltage: 0x01,
        SetTorque: 0x02,
        SetTorqueEnabled: 0x03,
        SetParameter: 0x10,
        GetParameter: 0x11,
        SaveParameters: 0x12,
        GetState: 0x13
    });

    const CommandNames = Object.freeze({
        0x01: 'SetVoltage',
        0x02: 'SetTorque',
        0x03: 'SetTorqueEnabled',
        0x10: 'SetParameter',
        0x11: 'GetParameter',
        0x12: 'SaveParameters',
        0x13: 'GetState'
    });

    // 参数 ID
    const ParameterId = Object.freeze({
        Kp: 1,
        Ki: 2,
        Kd: 3,
        ProcessNoise: 4,      // Q
        MeasurementNoise: 5,  // R
        TorqueLimit: 6
    });

    const ParameterNames = Object.freeze({
        1: { name: 'Kp', label: '比例增益 Kp', default: 1.0, min: 0.0, step: 0.1 },
        2: { name: 'Ki', label: '积分增益 Ki (100Hz)', default: 0.0, min: 0.0, step: 0.01 },
        3: { name: 'Kd', label: '微分增益 Kd', default: 0.0, min: 0.0, step: 0.01 },
        4: { name: 'ProcessNoise', label: '过程噪声 Q', default: 0.01, min: 0.0, step: 0.001 },
        5: { name: 'MeasurementNoise', label: '测量噪声 R', default: 0.01, min: 0.0001, step: 0.001 },
        6: { name: 'TorqueLimit', label: '扭矩上限幅值', default: 3.0, min: 0.1, step: 0.5 }
    });

    // 应答状态码
    const Result = Object.freeze({
        Ok: 0,
        InvalidValue: 1,
        NotReady: 2,
        ModeConflict: 3,
        OutputActive: 4,
        StorageError: 5,
        HardwareError: 6
    });

    const ResultNames = Object.freeze({
        0: 'Ok (成功)',
        1: 'InvalidValue (数值非法/越界)',
        2: 'NotReady (未就绪/无有效扭矩反馈)',
        3: 'ModeConflict (模式冲突/闭环中禁止手动电压)',
        4: 'OutputActive (输出未停止/拒绝保存)',
        5: 'StorageError (Flash 存储错误)',
        6: 'HardwareError (硬件错误/启停失败)'
    });

    // 存储错误码
    const StorageCodeNames = Object.freeze({
        0: 'Ok (写入成功)',
        1: 'NotFound (未找到有效记录)',
        2: 'InvalidLayout (存储布局错误)',
        3: 'InvalidParameters (参数校验未通过)',
        4: 'OutputActive (输出处于运行状态)',
        5: 'UnlockFailed (Flash解锁失败)',
        6: 'EraseFailed (扇区擦除失败)',
        7: 'ProgramFailed (编程写入失败)',
        8: 'VerifyFailed (回读校验不匹配)',
        9: 'LockFailed (Flash上锁失败)'
    });

    // CRC-16/CCITT-FALSE 预计算查找表
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

    function calcCrc16(buffer, length = buffer.length) {
        let crc = 0xFFFF;
        for (let i = 0; i < length; i++) {
            crc = (((crc << 8) & 0xFFFF) ^ CRC_TABLE[((crc >>> 8) ^ buffer[i]) & 0xFF]);
        }
        return crc & 0xFFFF;
    }

    function bytesToHex(arr) {
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    }

    /**
     * 辅助完成帧打包 (前12字节计算CRC并置入12~13)
     */
    function finishFrame(frame) {
        const crc = calcCrc16(frame, 12);
        frame[12] = crc & 0xFF;        // 低字节在前
        frame[13] = (crc >>> 8) & 0xFF; // 高字节在后
        return frame;
    }

    // --- 下行命令打包函数 ---

    /**
     * 0x01 SetVoltage: 设置手动输出目标电压 (0.0 ~ 18.0 V)
     */
    function encodeSetVoltage(voltage, sequence = 0) {
        const v = Math.max(0.0, Math.min(MAX_VOLTAGE, Number(voltage) || 0.0));
        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = CommandType.SetVoltage;
        frame[3] = (sequence & 0xFF);
        const view = new DataView(frame.buffer);
        view.setFloat32(4, v, true);
        view.setUint32(8, 0, true);
        return finishFrame(frame);
    }

    /**
     * 0x02 SetTorque: 设置扭矩目标幅值 (0.0 ~ TorqueLimit)
     */
    function encodeSetTorque(torque, sequence = 0) {
        const t = Math.max(0.0, Number(torque) || 0.0);
        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = CommandType.SetTorque;
        frame[3] = (sequence & 0xFF);
        const view = new DataView(frame.buffer);
        view.setFloat32(4, t, true);
        view.setUint32(8, 0, true);
        return finishFrame(frame);
    }

    /**
     * 0x03 SetTorqueEnabled: 开启 (1) / 关闭 (0) 扭矩闭环
     */
    function encodeSetTorqueEnabled(enabled, sequence = 0) {
        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = CommandType.SetTorqueEnabled;
        frame[3] = (sequence & 0xFF);
        const view = new DataView(frame.buffer);
        view.setUint32(4, enabled ? 1 : 0, true);
        view.setUint32(8, 0, true);
        return finishFrame(frame);
    }

    /**
     * 0x10 SetParameter: 写入下位机 RAM 参数
     */
    function encodeSetParameter(parameterId, value, sequence = 0) {
        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = CommandType.SetParameter;
        frame[3] = (sequence & 0xFF);
        const view = new DataView(frame.buffer);
        view.setUint32(4, parameterId, true);
        view.setFloat32(8, Number(value) || 0.0, true);
        return finishFrame(frame);
    }

    /**
     * 0x11 GetParameter: 读取下位机当前 RAM 参数
     */
    function encodeGetParameter(parameterId, sequence = 0) {
        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = CommandType.GetParameter;
        frame[3] = (sequence & 0xFF);
        const view = new DataView(frame.buffer);
        view.setUint32(4, parameterId, true);
        view.setUint32(8, 0, true);
        return finishFrame(frame);
    }

    /**
     * 0x12 SaveParameters: 将当前 RAM 参数持久化到下位机 Flash
     */
    function encodeSaveParameters(sequence = 0) {
        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = CommandType.SaveParameters;
        frame[3] = (sequence & 0xFF);
        const view = new DataView(frame.buffer);
        view.setUint32(4, 0, true);
        view.setUint32(8, 0, true);
        return finishFrame(frame);
    }

    /**
     * 0x13 GetState: 查询当前选定扭矩目标与状态
     */
    function encodeGetState(sequence = 0) {
        const frame = new Uint8Array(FRAME_SIZE);
        frame[0] = HEADER;
        frame[1] = VERSION;
        frame[2] = CommandType.GetState;
        frame[3] = (sequence & 0xFF);
        const view = new DataView(frame.buffer);
        view.setUint32(4, 0, true);
        view.setUint32(8, 0, true);
        return finishFrame(frame);
    }

    // --- 上行帧解码函数 ---

    /**
     * 通用上行帧解码器 (支持 0x81 测量反馈与 0x82 命令应答)
     * @param {Uint8Array} frame 
     * @returns {object|null}
     */
    function decodeFrame(frame) {
        if (!frame || frame.length !== FRAME_SIZE) return null;
        if (frame[0] !== HEADER || frame[1] !== VERSION) return null;

        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        const expectedCrc = calcCrc16(frame, 12);
        const actualCrc = view.getUint16(12, true);

        if (expectedCrc !== actualCrc) {
            return {
                valid: false,
                error: `CRC校验不匹配 (期望 0x${expectedCrc.toString(16).padStart(4, '0').toUpperCase()}, 实际 0x${actualCrc.toString(16).padStart(4, '0').toUpperCase()})`,
                rawBytes: new Uint8Array(frame)
            };
        }

        const type = frame[2];
        const seq = frame[3];

        if (type === TYPE_FEEDBACK) {
            // 0x81 测量反馈帧
            const voltage = view.getFloat32(4, true);
            const torque = view.getFloat32(8, true);
            return {
                valid: true,
                type: 'feedback',
                seq: seq,
                voltage: Number.isFinite(voltage) ? voltage : 0.0,
                torque: Number.isFinite(torque) ? torque : 0.0,
                rawBytes: new Uint8Array(frame),
                timestamp: performance.now()
            };
        } else if (type === TYPE_COMMAND_RESPONSE) {
            // 0x82 命令应答帧
            const statusWord = view.getUint32(4, true);
            const result = statusWord & 0xFF;
            const torqueEnabled = Boolean(statusWord & (1 << 8));
            const feedbackValid = Boolean(statusWord & (1 << 9));
            const originalCmdType = (statusWord >> 16) & 0xFF;
            const value = view.getFloat32(8, true);

            return {
                valid: true,
                type: 'response',
                seq: seq,
                result: result,
                resultName: ResultNames[result] || `Unknown (${result})`,
                torqueEnabled: torqueEnabled,
                feedbackValid: feedbackValid,
                originalCmdType: originalCmdType,
                originalCmdName: CommandNames[originalCmdType] || `0x${originalCmdType.toString(16).padStart(2, '0')}`,
                value: Number.isFinite(value) ? value : 0.0,
                rawBytes: new Uint8Array(frame),
                timestamp: performance.now()
            };
        }

        return null;
    }

    /**
     * @class StreamUnpacker
     * @brief 流式串口分片解包器（具备自动重同步与双向帧路由）
     */
    class StreamUnpacker {
        constructor(handlers = {}) {
            this.onFeedback = handlers.onFeedback || handlers; // 兼容旧版单一回调
            this.onResponse = handlers.onResponse || null;
            this.onError = handlers.onError || null;

            this.buffer = new Uint8Array(2048);
            this.length = 0;

            this.stats = {
                validFrames: 0,
                feedbackFrames: 0,
                responseFrames: 0,
                crcErrors: 0,
                syncDrops: 0
            };
        }

        feed(chunk) {
            if (!chunk || chunk.length === 0) return;

            // 扩容保护
            if (this.length + chunk.length > this.buffer.length) {
                const newCap = Math.max(this.buffer.length * 2, this.length + chunk.length + 512);
                const newBuf = new Uint8Array(newCap);
                newBuf.set(this.buffer.subarray(0, this.length), 0);
                this.buffer = newBuf;
            }

            this.buffer.set(chunk, this.length);
            this.length += chunk.length;

            let searchIdx = 0;
            while (searchIdx <= this.length - FRAME_SIZE) {
                // 搜索帧头 0xA5
                if (this.buffer[searchIdx] !== HEADER) {
                    searchIdx++;
                    this.stats.syncDrops++;
                    continue;
                }

                // 检查版本号
                if (this.buffer[searchIdx + 1] !== VERSION) {
                    searchIdx++;
                    this.stats.syncDrops++;
                    continue;
                }

                // 检查是否为有效上行消息类型 (0x81 或 0x82)
                const msgType = this.buffer[searchIdx + 2];
                if (msgType !== TYPE_FEEDBACK && msgType !== TYPE_COMMAND_RESPONSE) {
                    searchIdx++;
                    this.stats.syncDrops++;
                    continue;
                }

                // 提取候选 14 字节
                const candidate = this.buffer.subarray(searchIdx, searchIdx + FRAME_SIZE);
                const decoded = decodeFrame(candidate);

                if (!decoded) {
                    searchIdx++;
                    continue;
                }

                if (!decoded.valid) {
                    this.stats.crcErrors++;
                    if (this.onError) this.onError(decoded);
                    searchIdx++; // CRC 错误向后滑动重新搜索
                    continue;
                }

                // 合法帧路由
                this.stats.validFrames++;
                if (decoded.type === 'feedback') {
                    this.stats.feedbackFrames++;
                    if (typeof this.onFeedback === 'function') {
                        this.onFeedback(decoded);
                    }
                } else if (decoded.type === 'response') {
                    this.stats.responseFrames++;
                    if (typeof this.onResponse === 'function') {
                        this.onResponse(decoded);
                    }
                }

                searchIdx += FRAME_SIZE;
            }

            // 整理剩余半帧数据
            if (searchIdx > 0) {
                const remain = this.length - searchIdx;
                if (remain > 0) {
                    this.buffer.copyWithin(0, searchIdx, this.length);
                }
                this.length = remain;
            }
        }

        reset() {
            this.length = 0;
            this.stats.validFrames = 0;
            this.stats.feedbackFrames = 0;
            this.stats.responseFrames = 0;
            this.stats.crcErrors = 0;
            this.stats.syncDrops = 0;
        }
    }

    const MotorProtocol = {
        HEADER,
        VERSION,
        FRAME_SIZE,
        MAX_VOLTAGE,
        TYPE_FEEDBACK,
        TYPE_COMMAND_RESPONSE,
        CommandType,
        CommandNames,
        ParameterId,
        ParameterNames,
        Result,
        ResultNames,
        StorageCodeNames,
        calcCrc16,
        bytesToHex,
        encodeSetVoltage,
        encodeSetTorque,
        encodeSetTorqueEnabled,
        encodeSetParameter,
        encodeGetParameter,
        encodeSaveParameters,
        encodeGetState,
        decodeFrame,
        StreamUnpacker
    };

    global.MotorProtocol = MotorProtocol;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this)));
