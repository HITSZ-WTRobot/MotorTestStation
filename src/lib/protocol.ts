/**
 * @file protocol.ts
 * @brief STM32 电机测控与闭环调试通信协议编解码器与流式解包器 (TypeScript 严格类型版)
 * @version 0x01 (双向固定 14 字节小端对齐，CRC-16/CCITT-FALSE)
 */

export const HEADER = 0xa5;
export const VERSION = 0x01;
export const FRAME_SIZE = 14;
export const MAX_VOLTAGE = 18.0;

export const TYPE_FEEDBACK = 0x81;
export const TYPE_COMMAND_RESPONSE = 0x82;

export const CommandType = {
  SetVoltage: 0x01,
  SetTorque: 0x02,
  SetTorqueEnabled: 0x03,
  SetParameter: 0x10,
  GetParameter: 0x11,
  SaveParameters: 0x12,
  GetState: 0x13,
} as const;

export type CommandTypeCode = (typeof CommandType)[keyof typeof CommandType];

export const CommandNames: Record<number, string> = {
  0x01: 'SetVoltage',
  0x02: 'SetTorque',
  0x03: 'SetTorqueEnabled',
  0x10: 'SetParameter',
  0x11: 'GetParameter',
  0x12: 'SaveParameters',
  0x13: 'GetState',
};

export const ParameterId = {
  Kp: 1,
  Ki: 2,
  Kd: 3,
  ProcessNoise: 4,
  MeasurementNoise: 5,
  TorqueLimit: 6,
} as const;

export interface ParameterMeta {
  id: number;
  name: string;
  shortName: string;
  label: string;
  description: string;
  defaultVal: number;
  min: number;
  step: number;
  decimals: number;
}

export const PARAMETER_META_LIST: ParameterMeta[] = [
  {
    id: 1,
    name: 'Kp',
    shortName: '1. Kp',
    label: '比例增益 Kp',
    description: '扭矩 PID 比例增益 (TIM3 100Hz)',
    defaultVal: 1.0,
    min: 0.0,
    step: 0.1,
    decimals: 2,
  },
  {
    id: 2,
    name: 'Ki',
    shortName: '2. Ki',
    label: '积分增益 Ki',
    description: '扭矩 PID 离散积分增益 (不含dt)',
    defaultVal: 0.05,
    min: 0.0,
    step: 0.01,
    decimals: 2,
  },
  {
    id: 3,
    name: 'Kd',
    shortName: '3. Kd',
    label: '微分增益 Kd',
    description: '扭矩 PID 离散微分增益',
    defaultVal: 0.01,
    min: 0.0,
    step: 0.01,
    decimals: 2,
  },
  {
    id: 4,
    name: 'ProcessNoise',
    shortName: '4. Q (Process)',
    label: '过程噪声 Q',
    description: '卡尔曼过程噪声方差 (越大越跟随)',
    defaultVal: 0.01,
    min: 0.0,
    step: 0.001,
    decimals: 4,
  },
  {
    id: 5,
    name: 'MeasurementNoise',
    shortName: '5. R (Measure)',
    label: '测量噪声 R',
    description: '卡尔曼测量噪声方差 (>0，越大越平滑)',
    defaultVal: 0.01,
    min: 0.0001,
    step: 0.001,
    decimals: 4,
  },
  {
    id: 6,
    name: 'TorqueLimit',
    shortName: '6. TorqueLimit',
    label: '扭矩上限幅值',
    description: '允许的目标扭矩幅值上限 (N·m)',
    defaultVal: 3.0,
    min: 0.1,
    step: 0.5,
    decimals: 2,
  },
];

export const Result = {
  Ok: 0,
  InvalidValue: 1,
  NotReady: 2,
  ModeConflict: 3,
  OutputActive: 4,
  StorageError: 5,
  HardwareError: 6,
} as const;

export const ResultNames: Record<number, string> = {
  0: 'Ok (成功)',
  1: 'InvalidValue (数值非法/越界)',
  2: 'NotReady (未就绪/无有效扭矩反馈)',
  3: 'ModeConflict (模式冲突/闭环中禁止非零电压)',
  4: 'OutputActive (输出未停止/拒绝保存)',
  5: 'StorageError (Flash 存储错误)',
  6: 'HardwareError (硬件错误/启停失败)',
};

export const StorageCodeNames: Record<number, string> = {
  0: 'Ok (写入成功)',
  1: 'NotFound (未找到有效记录)',
  2: 'InvalidLayout (存储布局错误)',
  3: 'InvalidParameters (参数校验未通过)',
  4: 'OutputActive (输出处于运行状态)',
  5: 'UnlockFailed (Flash解锁失败)',
  6: 'EraseFailed (扇区擦除失败)',
  7: 'ProgramFailed (编程写入失败)',
  8: 'VerifyFailed (回读校验不匹配)',
  9: 'LockFailed (Flash上锁失败)',
};

const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let curr = (i << 8) & 0xffff;
  for (let j = 0; j < 8; j++) {
    if (curr & 0x8000) {
      curr = ((curr << 1) ^ 0x1021) & 0xffff;
    } else {
      curr = (curr << 1) & 0xffff;
    }
  }
  CRC_TABLE[i] = curr;
}

export function calcCrc16(buffer: Uint8Array, length = buffer.length): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >>> 8) ^ buffer[i]) & 0xff];
  }
  return crc & 0xffff;
}

export function bytesToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function finishFrame(frame: Uint8Array): Uint8Array {
  const crc = calcCrc16(frame, 12);
  frame[12] = crc & 0xff;
  frame[13] = (crc >>> 8) & 0xff;
  return frame;
}

export function encodeSetVoltage(voltage: number, sequence = 0): Uint8Array {
  const v = Math.max(0.0, Math.min(MAX_VOLTAGE, Number(voltage) || 0.0));
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = HEADER;
  frame[1] = VERSION;
  frame[2] = CommandType.SetVoltage;
  frame[3] = sequence & 0xff;
  const view = new DataView(frame.buffer);
  view.setFloat32(4, v, true);
  view.setUint32(8, 0, true);
  return finishFrame(frame);
}

export function encodeSetTorque(torque: number, sequence = 0): Uint8Array {
  const t = Math.max(0.0, Number(torque) || 0.0);
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = HEADER;
  frame[1] = VERSION;
  frame[2] = CommandType.SetTorque;
  frame[3] = sequence & 0xff;
  const view = new DataView(frame.buffer);
  view.setFloat32(4, t, true);
  view.setUint32(8, 0, true);
  return finishFrame(frame);
}

export function encodeSetTorqueEnabled(enabled: boolean, sequence = 0): Uint8Array {
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = HEADER;
  frame[1] = VERSION;
  frame[2] = CommandType.SetTorqueEnabled;
  frame[3] = sequence & 0xff;
  const view = new DataView(frame.buffer);
  view.setUint32(4, enabled ? 1 : 0, true);
  view.setUint32(8, 0, true);
  return finishFrame(frame);
}

export function encodeSetParameter(parameterId: number, value: number, sequence = 0): Uint8Array {
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = HEADER;
  frame[1] = VERSION;
  frame[2] = CommandType.SetParameter;
  frame[3] = sequence & 0xff;
  const view = new DataView(frame.buffer);
  view.setUint32(4, parameterId, true);
  view.setFloat32(8, Number(value) || 0.0, true);
  return finishFrame(frame);
}

export function encodeGetParameter(parameterId: number, sequence = 0): Uint8Array {
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = HEADER;
  frame[1] = VERSION;
  frame[2] = CommandType.GetParameter;
  frame[3] = sequence & 0xff;
  const view = new DataView(frame.buffer);
  view.setUint32(4, parameterId, true);
  view.setUint32(8, 0, true);
  return finishFrame(frame);
}

export function encodeSaveParameters(sequence = 0): Uint8Array {
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = HEADER;
  frame[1] = VERSION;
  frame[2] = CommandType.SaveParameters;
  frame[3] = sequence & 0xff;
  const view = new DataView(frame.buffer);
  view.setUint32(4, 0, true);
  view.setUint32(8, 0, true);
  return finishFrame(frame);
}

export function encodeGetState(sequence = 0): Uint8Array {
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = HEADER;
  frame[1] = VERSION;
  frame[2] = CommandType.GetState;
  frame[3] = sequence & 0xff;
  const view = new DataView(frame.buffer);
  view.setUint32(4, 0, true);
  view.setUint32(8, 0, true);
  return finishFrame(frame);
}

export interface DecodedFeedbackFrame {
  valid: true;
  type: 'feedback';
  seq: number;
  voltage: number;
  torque: number;
  rawBytes: Uint8Array;
  timestamp: number;
}

export interface DecodedResponseFrame {
  valid: true;
  type: 'response';
  seq: number;
  result: number;
  resultName: string;
  torqueEnabled: boolean;
  feedbackValid: boolean;
  originalCmdType: number;
  originalCmdName: string;
  value: number;
  rawBytes: Uint8Array;
  timestamp: number;
}

export interface DecodedErrorFrame {
  valid: false;
  error: string;
  rawBytes: Uint8Array;
}

export type DecodedFrame = DecodedFeedbackFrame | DecodedResponseFrame | DecodedErrorFrame;

export function decodeFrame(frame: Uint8Array): DecodedFrame | null {
  if (!frame || frame.length !== FRAME_SIZE) return null;
  if (frame[0] !== HEADER || frame[1] !== VERSION) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const expectedCrc = calcCrc16(frame, 12);
  const actualCrc = view.getUint16(12, true);

  if (expectedCrc !== actualCrc) {
    return {
      valid: false,
      error: `CRC校验不匹配 (期望 0x${expectedCrc.toString(16).padStart(4, '0').toUpperCase()}, 实际 0x${actualCrc.toString(16).padStart(4, '0').toUpperCase()})`,
      rawBytes: new Uint8Array(frame),
    };
  }

  const type = frame[2];
  const seq = frame[3];

  if (type === TYPE_FEEDBACK) {
    const voltage = view.getFloat32(4, true);
    const torque = view.getFloat32(8, true);
    return {
      valid: true,
      type: 'feedback',
      seq,
      voltage: Number.isFinite(voltage) ? voltage : 0.0,
      torque: Number.isFinite(torque) ? torque : 0.0,
      rawBytes: new Uint8Array(frame),
      timestamp: performance.now(),
    };
  } else if (type === TYPE_COMMAND_RESPONSE) {
    const statusWord = view.getUint32(4, true);
    const result = statusWord & 0xff;
    const torqueEnabled = Boolean(statusWord & (1 << 8));
    const feedbackValid = Boolean(statusWord & (1 << 9));
    const originalCmdType = (statusWord >> 16) & 0xff;
    const value = view.getFloat32(8, true);

    return {
      valid: true,
      type: 'response',
      seq,
      result,
      resultName: ResultNames[result] || `Unknown (${result})`,
      torqueEnabled,
      feedbackValid,
      originalCmdType,
      originalCmdName:
        CommandNames[originalCmdType] || `0x${originalCmdType.toString(16).padStart(2, '0')}`,
      value: Number.isFinite(value) ? value : 0.0,
      rawBytes: new Uint8Array(frame),
      timestamp: performance.now(),
    };
  }

  return null;
}

export class StreamUnpacker {
  private buffer = new Uint8Array(2048);
  private length = 0;

  public stats = {
    validFrames: 0,
    feedbackFrames: 0,
    responseFrames: 0,
    crcErrors: 0,
    syncDrops: 0,
  };

  constructor(
    private handlers: {
      onFeedback?: (fb: DecodedFeedbackFrame) => void;
      onResponse?: (resp: DecodedResponseFrame) => void;
      onError?: (err: DecodedErrorFrame) => void;
    }
  ) {}

  public feed(chunk: Uint8Array) {
    if (!chunk || chunk.length === 0) return;

    if (this.length + chunk.length > this.buffer.length) {
      if (this.buffer.length >= 8192) {
        const keep = Math.min(this.length, 14);
        if (keep > 0) {
          this.buffer.copyWithin(0, this.length - keep, this.length);
        }
        this.length = keep;
      } else {
        const newCap = Math.min(8192, Math.max(this.buffer.length * 2, this.length + chunk.length + 512));
        const newBuf = new Uint8Array(newCap);
        newBuf.set(this.buffer.subarray(0, this.length), 0);
        this.buffer = newBuf;
      }
    }

    this.buffer.set(chunk, this.length);
    this.length += chunk.length;

    let searchIdx = 0;
    while (searchIdx <= this.length - FRAME_SIZE) {
      if (this.buffer[searchIdx] !== HEADER) {
        searchIdx++;
        this.stats.syncDrops++;
        continue;
      }

      if (this.buffer[searchIdx + 1] !== VERSION) {
        searchIdx++;
        this.stats.syncDrops++;
        continue;
      }

      const msgType = this.buffer[searchIdx + 2];
      if (msgType !== TYPE_FEEDBACK && msgType !== TYPE_COMMAND_RESPONSE) {
        searchIdx++;
        this.stats.syncDrops++;
        continue;
      }

      const candidate = this.buffer.subarray(searchIdx, searchIdx + FRAME_SIZE);
      const decoded = decodeFrame(candidate);

      if (!decoded) {
        searchIdx++;
        continue;
      }

      if (!decoded.valid) {
        this.stats.crcErrors++;
        this.handlers.onError?.(decoded);
        searchIdx++;
        continue;
      }

      this.stats.validFrames++;
      if (decoded.type === 'feedback') {
        this.stats.feedbackFrames++;
        this.handlers.onFeedback?.(decoded);
      } else if (decoded.type === 'response') {
        this.stats.responseFrames++;
        this.handlers.onResponse?.(decoded);
      }

      searchIdx += FRAME_SIZE;
    }

    if (searchIdx > 0) {
      const remain = this.length - searchIdx;
      if (remain > 0) {
        this.buffer.copyWithin(0, searchIdx, this.length);
      }
      this.length = remain;
    }
  }

  public reset() {
    this.length = 0;
    this.stats.validFrames = 0;
    this.stats.feedbackFrames = 0;
    this.stats.responseFrames = 0;
    this.stats.crcErrors = 0;
    this.stats.syncDrops = 0;
  }
}
