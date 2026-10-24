/**
 * @file atoms.ts
 * @brief Jotai 原子化状态管理仓库 (覆盖三端适配、连接状态、控制模式、6参数与示波器遥测)
 */

import { atom } from 'jotai';
import type { SerialPortInfo, PlatformInfo, LogLevel } from '../lib/transport';

export type ThemeMode = 'cleanroom' | 'dark';
export type MobileTab = 'control' | 'scope' | 'params' | 'terminal';
export type ControlMode = 'voltage' | 'torque';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  dir: string;
  content: string;
}

// 1. 主题与三端响应式导航状态
export const themeAtom = atom<ThemeMode>('cleanroom');
export const mobileTabAtom = atom<MobileTab>('control');
export const platformInfoAtom = atom<PlatformInfo>({
  os: 'windows',
  arch: 'x64',
  family: 'windows',
  isTauri: false,
});

// 2. 串口与连接状态
export const serialPortsAtom = atom<SerialPortInfo[]>([]);
export const selectedPortAtom = atom<string>('');
export const baudRateAtom = atom<number>(115200);

export const connectionStatusAtom = atom<{
  connected: boolean;
  mode: 'disconnected' | 'native' | 'webserial' | 'mock';
  label: string;
  warning: boolean;
}>({
  connected: false,
  mode: 'disconnected',
  label: '未连接 (串口断开)',
  warning: false,
});

// 3. 主控模式与双参数状态 (严格区分设定值 Draft 与已生效值 Applied)
export const activeControlModeAtom = atom<ControlMode>('voltage');

// 手动电压模式参数 (参数1: 目标电压, 参数2: 步进微调)
export const draftVoltageAtom = atom<number>(0.0);
export const appliedVoltageAtom = atom<number>(0.0);
export const voltageStepDeltaAtom = atom<number>(0.2);
export const autoSyncVoltageAtom = atom<boolean>(false);

// 扭矩闭环模式参数 (参数1: 目标扭矩, 参数2: 扭矩上限)
export const draftTorqueAtom = atom<number>(0.0);
export const appliedTorqueAtom = atom<number>(0.0);
export const torqueEnabledAtom = atom<boolean>(false);
export const feedbackValidAtom = atom<boolean>(false);
export const commTimeoutWarningAtom = atom<boolean>(false);
export const torqueLimitAtom = atom<number>(3.0);

// 4. 下位机 6 项 RAM 参数与编辑草稿
export const ramParamsAtom = atom<Record<number, number>>({
  1: Math.fround(1.0),
  2: Math.fround(0.05),
  3: Math.fround(0.01),
  4: Math.fround(0.01),
  5: Math.fround(0.01),
  6: Math.fround(3.0),
});

export const draftParamsAtom = atom<Record<number, string>>({
  1: '1.00',
  2: '0.05',
  3: '0.01',
  4: '0.0100',
  5: '0.0100',
  6: '3.00',
});

export const flashSaveStatusAtom = atom<{
  text: string;
  tone: 'idle' | 'dirty' | 'applied' | 'saving' | 'saved' | 'unknown' | 'error';
}>({
  text: '未修改',
  tone: 'idle',
});

// 5. 实时遥测与统计计数
export const telemetryAtom = atom<{
  voltage: number;
  torque: number;
  vMin: number | null;
  vMax: number | null;
  tMax: number | null;
  fps: number;
  rxFrames: number;
  txFrames: number;
  crcErrors: number;
}>({
  voltage: 0.0,
  torque: 0.0,
  vMin: null,
  vMax: null,
  tMax: null,
  fps: 0,
  rxFrames: 0,
  txFrames: 0,
  crcErrors: 0,
});

// 6. 示波器与终端配置
export const scopeConfigAtom = atom<{
  maxPoints: number;
  showTargetRef: boolean;
  isPaused: boolean;
}>({
  maxPoints: 500,
  showTargetRef: true,
  isPaused: false,
});

export const logsAtom = atom<LogEntry[]>([]);
export const showRaw0x81Atom = atom<boolean>(false);
export const pauseLogScrollAtom = atom<boolean>(false);
