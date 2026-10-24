/**
 * @file transport.ts
 * @brief 三端通用串口传输引擎 (Tauri Native Rust SerialPort + Web Serial API + 高保真下位机仿真器)
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  HEADER,
  VERSION,
  FRAME_SIZE,
  MAX_VOLTAGE,
  TYPE_FEEDBACK,
  TYPE_COMMAND_RESPONSE,
  CommandType,
  CommandNames,
  Result,
  calcCrc16,
  bytesToHex,
  type DecodedResponseFrame,
} from './protocol';

export interface SerialPortInfo {
  portName: string;
  label: string;
  portType: string;
  manufacturer?: string | null;
  product?: string | null;
}

export interface PlatformInfo {
  os: string;
  arch: string;
  family: string;
  isTauri: boolean;
}

interface WebSerialReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

interface WebSerialWriter {
  write(data: Uint8Array): Promise<void>;
  releaseLock(): void;
}

interface WebSerialPort {
  open(options: {
    baudRate: number;
    dataBits: number;
    stopBits: number;
    parity: string;
    flowControl: string;
    bufferSize: number;
  }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readable?: {
    getReader(): WebSerialReader;
  } | null;
  writable?: {
    getWriter(): WebSerialWriter;
  } | null;
}

interface NavigatorWithSerial {
  serial?: {
    requestPort(): Promise<WebSerialPort>;
  };
}

function formatError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export async function getPlatformInfo(): Promise<PlatformInfo> {
  if (isTauriEnvironment()) {
    try {
      const info = await invoke<{ os: string; arch: string; family: string }>('get_platform_info');
      return { ...info, isTauri: true };
    } catch {
      return { os: 'windows', arch: 'x86_64', family: 'windows', isTauri: true };
    }
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const os = ua.includes('mac') ? 'macos' : ua.includes('linux') ? 'linux' : 'windows';
  return { os, arch: 'web', family: 'web', isTauri: false };
}

export async function listNativeSerialPorts(): Promise<SerialPortInfo[]> {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke<SerialPortInfo[]>('list_serial_ports');
  } catch (err: unknown) {
    console.warn('Failed to list native serial ports:', err);
    return [];
  }
}

export type LogLevel = 'tx' | 'rx' | 'info' | 'warn' | 'error';

export class TransportManager {
  public mode: 'disconnected' | 'native' | 'webserial' | 'mock' = 'disconnected';
  public isConnected = false;

  private webPort: WebSerialPort | null = null;
  private webReader: WebSerialReader | null = null;
  private keepWebReading = false;
  private unlistenRx: (() => void) | null = null;
  private unlistenDisconnect: (() => void) | null = null;

  // 虚拟下位机仿真器状态机
  private mockTimer: number | undefined = undefined;
  private mockSeq = 0;
  private mockState = {
    vTarget: 0.0,
    vCurrent: 0.0,
    torqueTarget: 0.0,
    torqueCurrent: 0.0,
    torqueEnabled: false,
    feedbackValid: true,
    pidIntegral: 0.0,
    pidPrevError: 0.0,
    ramParams: {
      1: 1.0,
      2: 0.05,
      3: 0.01,
      4: 0.01,
      5: 0.01,
      6: 3.0,
    } as Record<number, number>,
    flashParams: {
      1: 1.0,
      2: 0.05,
      3: 0.01,
      4: 0.01,
      5: 0.01,
      6: 3.0,
    } as Record<number, number>,
  };

  constructor(
    private callbacks: {
      onData: (chunk: Uint8Array) => void;
      onStatusChange: (status: {
        connected: boolean;
        mode: 'disconnected' | 'native' | 'webserial' | 'mock';
        label: string;
      }) => void;
      onLog: (level: LogLevel, message: string) => void;
    }
  ) {}

  /**
   * 1. Tauri 原生桌面串口连接 (Windows COMx / macOS /dev/cu.* / Linux /dev/ttyUSB*)
   */
  public async connectNative(portName: string, baudRate: number): Promise<void> {
    if (!portName) {
      throw new Error('请先选择要连接的串口设备');
    }
    await this.disconnect();

    this.unlistenRx = await listen<number[]>('serial-rx-chunk', (event) => {
      if (event.payload && event.payload.length > 0) {
        this.callbacks.onData(new Uint8Array(event.payload));
      }
    });

    this.unlistenDisconnect = await listen<string>('serial-disconnected', (event) => {
      this.callbacks.onLog('error', event.payload || '物理串口意外断开');
      this.cleanupListeners();
      this.isConnected = false;
      this.mode = 'disconnected';
      this.callbacks.onStatusChange({
        connected: false,
        mode: 'disconnected',
        label: '串口异常断开',
      });
    });

    try {
      await invoke('open_serial_port', { portName, baudRate });
      this.isConnected = true;
      this.mode = 'native';
      this.callbacks.onStatusChange({
        connected: true,
        mode: 'native',
        label: `已连接 ${portName} (${baudRate} 8N1)`,
      });
      this.callbacks.onLog('info', `已通过原生驱动打开串口 ${portName} @ ${baudRate} bps (DTR/RTS 已置位)`);
    } catch (err: unknown) {
      this.cleanupListeners();
      const msg = formatError(err);
      this.callbacks.onLog('error', msg);
      throw new Error(msg);
    }
  }

  /**
   * 2. 浏览器 Web Serial API 连接 (Web 端兼容)
   */
  public async connectWebSerial(baudRate: number): Promise<void> {
    const nav = typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorWithSerial) : undefined;
    if (!nav?.serial) {
      throw new Error('当前环境不支持 Web Serial API，请使用桌面版原生串口或 Chrome/Edge 浏览器');
    }
    await this.disconnect();

    try {
      this.webPort = await nav.serial.requestPort();
      await this.webPort.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 4096,
      });

      try {
        if (this.webPort.setSignals) {
          await this.webPort.setSignals({ dataTerminalReady: true, requestToSend: true });
        }
      } catch {}

      this.isConnected = true;
      this.keepWebReading = true;
      this.mode = 'webserial';
      this.callbacks.onStatusChange({
        connected: true,
        mode: 'webserial',
        label: `WebSerial (${baudRate} 8N1)`,
      });
      this.callbacks.onLog('info', `已通过 Web Serial 连接硬件 (${baudRate} 8N1)`);

      this.readWebSerialLoop();
    } catch (err: unknown) {
      const errName = err instanceof Error ? err.name : '';
      if (errName !== 'NotFoundError') {
        this.callbacks.onLog('error', `Web Serial 连接失败: ${formatError(err)}`);
      }
      throw err;
    }
  }

  private async readWebSerialLoop() {
    while (this.webPort && this.webPort.readable && this.keepWebReading) {
      try {
        this.webReader = this.webPort.readable.getReader();
        while (this.keepWebReading) {
          const { value, done } = await this.webReader.read();
          if (done) break;
          if (value && value.length > 0) {
            this.callbacks.onData(value);
          }
        }
      } catch (err: unknown) {
        if (this.keepWebReading) {
          this.callbacks.onLog('error', `读取串口流异常: ${formatError(err)}`);
        }
      } finally {
        if (this.webReader) {
          try {
            this.webReader.releaseLock();
          } catch {}
          this.webReader = null;
        }
      }
    }

    if (this.isConnected && this.mode === 'webserial') {
      this.isConnected = false;
      this.mode = 'disconnected';
      this.callbacks.onStatusChange({
        connected: false,
        mode: 'disconnected',
        label: '串口已断开',
      });
    }
  }

  /**
   * 3. 启动高保真虚拟下位机模拟器 (Mock Mode)
   */
  public async startMock(): Promise<void> {
    await this.disconnect();

    this.mockState.vTarget = 0.0;
    this.mockState.vCurrent = 0.0;
    this.mockState.torqueTarget = 0.0;
    this.mockState.torqueCurrent = 0.0;
    this.mockState.torqueEnabled = false;
    this.mockState.feedbackValid = true;
    this.mockState.pidIntegral = 0.0;
    this.mockState.pidPrevError = 0.0;
    this.mockSeq = 0;

    this.isConnected = true;
    this.mode = 'mock';
    this.callbacks.onStatusChange({
      connected: true,
      mode: 'mock',
      label: '虚拟下位机运行中 (20Hz)',
    });
    this.callbacks.onLog(
      'info',
      '已启动【高保真 STM32 虚拟下位机仿真器】(支持前馈 Vff=T/0.5、动态上限 Vmax=Vff+0.5V 与 6 参数读写)'
    );

    this.mockTimer = window.setInterval(() => {
      const ms = this.mockState;

      if (ms.torqueEnabled && ms.feedbackValid) {
        if (ms.torqueTarget === 0.0) {
          ms.pidIntegral = 0.0;
          ms.pidPrevError = 0.0;
          ms.vTarget = 0.0;
        } else {
          const kp = ms.ramParams[1] ?? 1.0;
          const ki = ms.ramParams[2] ?? 0.05;
          const kd = ms.ramParams[3] ?? 0.01;

          const torquePerVolt = 0.5;
          const vff = Math.min(ms.torqueTarget / torquePerVolt, MAX_VOLTAGE);
          const voltageLimit = Math.min(vff + 0.5, MAX_VOLTAGE);

          const err = ms.torqueTarget - ms.torqueCurrent;
          ms.pidIntegral = Math.max(-voltageLimit, Math.min(voltageLimit, ms.pidIntegral + ki * err));
          const dErr = err - ms.pidPrevError;
          ms.pidPrevError = err;

          const pidOut = kp * err + ms.pidIntegral + kd * dErr + vff;
          ms.vTarget = Math.max(0.0, Math.min(voltageLimit, pidOut));
        }
      }

      const vAlpha = 0.16;
      ms.vCurrent += (ms.vTarget - ms.vCurrent) * vAlpha;
      const vNoise = (Math.random() - 0.5) * 0.005;
      const finalV = Math.max(0.0, ms.vCurrent + vNoise);

      const targetTorque =
        finalV > 0.04 ? finalV * 0.44 + Math.sin(Date.now() / 500) * 0.08 : 0.0;
      ms.torqueCurrent += (targetTorque - ms.torqueCurrent) * 0.18;
      const tNoise = (Math.random() - 0.5) * 0.012;
      const finalT = Math.max(0.0, ms.torqueCurrent + tNoise);

      const frame = new Uint8Array(FRAME_SIZE);
      frame[0] = HEADER;
      frame[1] = VERSION;
      frame[2] = TYPE_FEEDBACK;
      frame[3] = this.mockSeq++ & 0xff;

      const dv = new DataView(frame.buffer);
      dv.setFloat32(4, finalV, true);
      dv.setFloat32(8, finalT, true);

      const crc = calcCrc16(frame, 12);
      frame[12] = crc & 0xff;
      frame[13] = (crc >>> 8) & 0xff;

      this.callbacks.onData(frame);
    }, 50);
  }

  public async disconnect(): Promise<void> {
    if (this.mode === 'mock') {
      clearInterval(this.mockTimer);
      this.mockTimer = undefined;
      this.isConnected = false;
      this.mode = 'disconnected';
      this.callbacks.onStatusChange({
        connected: false,
        mode: 'disconnected',
        label: '未连接 (仿真已停止)',
      });
      this.callbacks.onLog('info', '已停止虚拟下位机仿真器');
      return;
    }

    if (this.mode === 'native') {
      this.cleanupListeners();
      try {
        await invoke('close_serial_port');
      } catch {}
      this.isConnected = false;
      this.mode = 'disconnected';
      this.callbacks.onStatusChange({
        connected: false,
        mode: 'disconnected',
        label: '未连接 (串口已关闭)',
      });
      this.callbacks.onLog('info', '原生串口已安全关闭');
      return;
    }

    if (this.mode === 'webserial') {
      this.keepWebReading = false;
      try {
        if (this.webReader) {
          await this.webReader.cancel();
          this.webReader = null;
        }
        if (this.webPort) {
          await this.webPort.close();
          this.webPort = null;
        }
      } catch {}
      this.isConnected = false;
      this.mode = 'disconnected';
      this.callbacks.onStatusChange({
        connected: false,
        mode: 'disconnected',
        label: '未连接 (串口已断开)',
      });
      this.callbacks.onLog('info', 'Web Serial 串口已安全断开');
    }
  }

  private cleanupListeners() {
    if (this.unlistenRx) {
      this.unlistenRx();
      this.unlistenRx = null;
    }
    if (this.unlistenDisconnect) {
      this.unlistenDisconnect();
      this.unlistenDisconnect = null;
    }
  }

  public async send(data: Uint8Array): Promise<void> {
    if (!this.isConnected) {
      throw new Error('串口未连接，请先连接硬件或开启仿真模式');
    }

    if (this.mode === 'mock') {
      this.handleMockCommand(data);
      return;
    }

    if (this.mode === 'native') {
      await invoke('write_serial_frame', { data: Array.from(data) });
      return;
    }

    if (this.mode === 'webserial' && this.webPort && this.webPort.writable) {
      const writer = this.webPort.writable.getWriter();
      await writer.write(data);
      writer.releaseLock();
      return;
    }

    throw new Error('当前传输通道不可写');
  }

  private handleMockCommand(data: Uint8Array) {
    if (!data || data.length !== FRAME_SIZE) return;
    if (data[0] !== HEADER || data[1] !== VERSION) return;

    const crcExp = calcCrc16(data, 12);
    const dvIn = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const crcAct = dvIn.getUint16(12, true);
    if (crcExp !== crcAct) return;

    const cmdType = data[2];
    const seq = data[3];
    const ms = this.mockState;

    let result: number = Result.Ok;
    let respVal = 0.0;

    switch (cmdType) {
      case CommandType.SetVoltage: {
        const reqV = dvIn.getFloat32(4, true);
        const reserved = dvIn.getUint32(8, true);
        if (reserved !== 0 || !Number.isFinite(reqV) || reqV < 0.0 || reqV > MAX_VOLTAGE) {
          result = Result.InvalidValue;
        } else if (reqV === 0.0) {
          ms.torqueEnabled = false;
          ms.vTarget = 0.0;
          ms.pidIntegral = 0.0;
          result = Result.Ok;
          respVal = 0.0;
        } else if (ms.torqueEnabled) {
          result = Result.ModeConflict;
          respVal = 0.0;
        } else {
          ms.vTarget = reqV;
          result = Result.Ok;
          respVal = reqV;
        }
        break;
      }

      case CommandType.SetTorque: {
        const reqT = dvIn.getFloat32(4, true);
        const reserved = dvIn.getUint32(8, true);
        const limit = ms.ramParams[6] ?? 3.0;
        if (reserved !== 0 || !Number.isFinite(reqT) || reqT < 0.0 || reqT > limit) {
          result = Result.InvalidValue;
        } else {
          ms.torqueTarget = reqT;
          result = Result.Ok;
          respVal = reqT;
        }
        break;
      }

      case CommandType.SetTorqueEnabled: {
        const enableArg = dvIn.getUint32(4, true);
        const reserved = dvIn.getUint32(8, true);
        if (reserved !== 0 || (enableArg !== 0 && enableArg !== 1)) {
          result = Result.InvalidValue;
        } else if (enableArg === 1) {
          if (!ms.feedbackValid) {
            result = Result.NotReady;
          } else {
            ms.torqueEnabled = true;
            ms.pidIntegral = 0.0;
            ms.pidPrevError = 0.0;
            result = Result.Ok;
            respVal = 1.0;
          }
        } else {
          ms.torqueEnabled = false;
          ms.vTarget = 0.0;
          ms.pidIntegral = 0.0;
          result = Result.Ok;
          respVal = 0.0;
        }
        break;
      }

      case CommandType.SetParameter: {
        const paramId = dvIn.getUint32(4, true);
        const val = dvIn.getFloat32(8, true);
        if (paramId < 1 || paramId > 6 || !Number.isFinite(val)) {
          result = Result.InvalidValue;
        } else if ((paramId === 5 || paramId === 6) && val <= 0) {
          result = Result.InvalidValue;
        } else if (val < 0) {
          result = Result.InvalidValue;
        } else {
          ms.ramParams[paramId] = Math.fround(val);
          if (paramId === 6) {
            ms.torqueTarget = Math.min(ms.torqueTarget, ms.ramParams[6]);
          }
          ms.pidIntegral = 0.0;
          ms.pidPrevError = 0.0;
          result = Result.Ok;
          respVal = ms.ramParams[paramId];
        }
        break;
      }

      case CommandType.GetParameter: {
        const paramId = dvIn.getUint32(4, true);
        const reserved = dvIn.getUint32(8, true);
        if (reserved !== 0 || paramId < 1 || paramId > 6) {
          result = Result.InvalidValue;
        } else {
          result = Result.Ok;
          respVal = ms.ramParams[paramId] ?? 0.0;
        }
        break;
      }

      case CommandType.SaveParameters: {
        const first = dvIn.getUint32(4, true);
        const second = dvIn.getUint32(8, true);
        if (first !== 0 || second !== 0) {
          result = Result.InvalidValue;
        } else if (ms.torqueEnabled || ms.vTarget > 0.0) {
          result = Result.OutputActive;
          respVal = 0.0;
        } else {
          ms.flashParams = { ...ms.ramParams };
          result = Result.Ok;
          respVal = 0.0;
        }
        break;
      }

      case CommandType.GetState: {
        const first = dvIn.getUint32(4, true);
        const second = dvIn.getUint32(8, true);
        if (first !== 0 || second !== 0) {
          result = Result.InvalidValue;
        } else {
          result = Result.Ok;
          respVal = ms.torqueTarget;
        }
        break;
      }

      default:
        return;
    }

    const respFrame = new Uint8Array(FRAME_SIZE);
    respFrame[0] = HEADER;
    respFrame[1] = VERSION;
    respFrame[2] = TYPE_COMMAND_RESPONSE;
    respFrame[3] = seq;

    const dvOut = new DataView(respFrame.buffer);
    const statusWord =
      (result & 0xff) |
      ((ms.torqueEnabled ? 1 : 0) << 8) |
      ((ms.feedbackValid ? 1 : 0) << 9) |
      ((cmdType & 0xff) << 16);
    dvOut.setUint32(4, statusWord, true);
    dvOut.setFloat32(8, respVal, true);

    const crc = calcCrc16(respFrame, 12);
    respFrame[12] = crc & 0xff;
    respFrame[13] = (crc >>> 8) & 0xff;

    window.setTimeout(() => {
      this.callbacks.onData(respFrame);
    }, 2);
  }
}

interface QueuedRequest {
  cmdType: number;
  seq: number;
  frame: Uint8Array;
  timeoutMs: number;
  resolve: (resp: DecodedResponseFrame) => void;
  reject: (err: Error) => void;
  createdAt: number;
}

export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private inFlight: QueuedRequest | null = null;
  private timer: number | undefined = undefined;
  private seq = 0;
  private timedOutHistory: Array<{ seq: number; cmdType: number; time: number }> = [];

  constructor(
    private sendFn: (frame: Uint8Array) => Promise<void>,
    private onLog: (level: LogLevel, msg: string) => void,
    private onTxIncrement: () => void,
    private onTimeoutWarning?: () => void
  ) {}

  private nextSeq(): number {
    for (let attempt = 0; attempt < 256; attempt++) {
      const candidate = this.seq;
      this.seq = (this.seq + 1) & 0xff;
      if (!this.timedOutHistory.some((item) => item.seq === candidate)) {
        return candidate;
      }
    }
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return s;
  }

  public enqueue(
    cmdType: number,
    frameEncoder: (seq: number) => Uint8Array,
    timeoutMs = 500
  ): Promise<DecodedResponseFrame> {
    const { promise, resolve, reject } = Promise.withResolvers<DecodedResponseFrame>();
    const seq = this.nextSeq();
    const frame = frameEncoder(seq);
    this.queue.push({
      cmdType,
      seq,
      frame,
      timeoutMs,
      resolve,
      reject,
      createdAt: performance.now(),
    });
    this.processNext();
    return promise;
  }

  private async processNext() {
    if (this.inFlight || this.queue.length === 0) return;

    const req = this.queue.shift()!;
    this.inFlight = req;

    try {
      await this.sendFn(req.frame);
      this.onTxIncrement();
      const hex = bytesToHex(req.frame);
      this.onLog('tx', `[TX #${req.seq}] ${CommandNames[req.cmdType] || req.cmdType} | ${hex}`);

      this.timer = window.setTimeout(() => {
        const elapsed = Math.round(performance.now() - req.createdAt);
        this.timedOutHistory.push({
          seq: req.seq,
          cmdType: req.cmdType,
          time: performance.now(),
        });
        if (this.timedOutHistory.length > 32) {
          this.timedOutHistory.shift();
        }
        this.onLog(
          'warn',
          `[请求超时] 命令 ${CommandNames[req.cmdType] || req.cmdType} (seq=${req.seq}) 在 ${elapsed}ms 内未收到应答`
        );
        this.inFlight = null;
        this.onTimeoutWarning?.();
        req.reject(new Error(`Timeout after ${elapsed}ms`));
        this.processNext();
      }, req.timeoutMs);
    } catch (err: unknown) {
      this.inFlight = null;
      req.reject(err instanceof Error ? err : new Error(formatError(err)));
      this.processNext();
    }
  }

  public handleResponse(resp: DecodedResponseFrame): 'matched' | 'late' | 'unmatched' {
    if (this.inFlight) {
      if (this.inFlight.seq === resp.seq && this.inFlight.cmdType === resp.originalCmdType) {
        clearTimeout(this.timer);
        this.timer = undefined;
        const req = this.inFlight;
        this.inFlight = null;
        req.resolve(resp);
        this.processNext();
        return 'matched';
      }
    }

    const lateIdx = this.timedOutHistory.findIndex(
      (item) => item.seq === resp.seq && item.cmdType === resp.originalCmdType
    );
    if (lateIdx !== -1) {
      this.timedOutHistory.splice(lateIdx, 1);
      this.onLog(
        'warn',
        `[迟到应答已忽略] 收到超时请求 #${resp.seq} (${resp.originalCmdName}) 的迟到应答，请刷新状态`
      );
      return 'late';
    }

    return 'unmatched';
  }

  public clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) {
      this.inFlight.reject(new Error('Queue cleared'));
      this.inFlight = null;
    }
    while (this.queue.length > 0) {
      const r = this.queue.shift()!;
      r.reject(new Error('Queue cleared'));
    }
    this.timedOutHistory = [];
  }
}
