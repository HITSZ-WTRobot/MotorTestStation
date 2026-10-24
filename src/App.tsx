import * as React from 'react';
import { useAtom } from 'jotai';
import {
  Zap,
  Target,
  Settings2,
  Activity,
  RefreshCw,
  Play,
  Square,
  OctagonAlert,
  Download,
  Trash2,
  Pause,
  Save,
  Upload,
  DownloadCloud,
  Sun,
  Moon,
  Lock,
  Cpu,
  Terminal,
  Monitor,
  Sliders,
} from 'lucide-react';
import {
  themeAtom,
  mobileTabAtom,
  platformInfoAtom,
  serialPortsAtom,
  selectedPortAtom,
  baudRateAtom,
  connectionStatusAtom,
  activeControlModeAtom,
  draftVoltageAtom,
  appliedVoltageAtom,
  autoSyncVoltageAtom,
  draftTorqueAtom,
  appliedTorqueAtom,
  torqueEnabledAtom,
  feedbackValidAtom,
  commTimeoutWarningAtom,
  torqueLimitAtom,
  ramParamsAtom,
  draftParamsAtom,
  flashSaveStatusAtom,
  telemetryAtom,
  scopeConfigAtom,
  logsAtom,
  showRaw0x81Atom,
  pauseLogScrollAtom,
} from './store/atoms';
import {
  MAX_VOLTAGE,
  CommandType,
  PARAMETER_META_LIST,
  Result,
  StorageCodeNames,
  bytesToHex,
  encodeSetVoltage,
  encodeSetTorque,
  encodeSetTorqueEnabled,
  encodeSetParameter,
  encodeGetParameter,
  encodeSaveParameters,
  encodeGetState,
  StreamUnpacker,
} from './lib/protocol';
import {
  getPlatformInfo,
  listNativeSerialPorts,
  TransportManager,
  RequestQueue,
  type LogLevel,
} from './lib/transport';
import { Button } from './components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from './components/ui/card';
import { Badge } from './components/ui/badge';
import {
  OscilloscopeCanvas,
  type OscilloscopeHandle,
} from './components/OscilloscopeCanvas';

const VOLTAGE_PRESETS = [0.0, 3.3, 5.0, 8.0, 10.0, 12.0, 15.0, 18.0];
const TORQUE_PRESETS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0];

export function App() {
  const [theme, setTheme] = useAtom(themeAtom);
  const [mobileTab, setMobileTab] = useAtom(mobileTabAtom);
  const [platformInfo, setPlatformInfo] = useAtom(platformInfoAtom);

  const [serialPorts, setSerialPorts] = useAtom(serialPortsAtom);
  const [selectedPort, setSelectedPort] = useAtom(selectedPortAtom);
  const [baudRate, setBaudRate] = useAtom(baudRateAtom);
  const [connStatus, setConnStatus] = useAtom(connectionStatusAtom);

  const [activeMode, setActiveMode] = useAtom(activeControlModeAtom);

  const [draftVoltage, setDraftVoltage] = useAtom(draftVoltageAtom);
  const [appliedVoltage, setAppliedVoltage] = useAtom(appliedVoltageAtom);
  const [autoSyncVoltage, setAutoSyncVoltage] = useAtom(autoSyncVoltageAtom);

  const [draftTorque, setDraftTorque] = useAtom(draftTorqueAtom);
  const [appliedTorque, setAppliedTorque] = useAtom(appliedTorqueAtom);
  const [torqueEnabled, setTorqueEnabled] = useAtom(torqueEnabledAtom);
  const [feedbackValid, setFeedbackValid] = useAtom(feedbackValidAtom);
  const [commTimeoutWarning, setCommTimeoutWarning] = useAtom(commTimeoutWarningAtom);
  const [torqueLimit, setTorqueLimit] = useAtom(torqueLimitAtom);

  const [ramParams, setRamParams] = useAtom(ramParamsAtom);
  const [draftParams, setDraftParams] = useAtom(draftParamsAtom);
  const [flashSaveStatus, setFlashSaveStatus] = useAtom(flashSaveStatusAtom);

  const [telemetry, setTelemetry] = useAtom(telemetryAtom);
  const [scopeConfig, setScopeConfig] = useAtom(scopeConfigAtom);

  const [logs, setLogs] = useAtom(logsAtom);
  const [showRaw0x81, setShowRaw0x81] = useAtom(showRaw0x81Atom);
  const [pauseLogScroll, setPauseLogScroll] = useAtom(pauseLogScrollAtom);

  const scopeRef = React.useRef<OscilloscopeHandle | null>(null);
  const logContainerRef = React.useRef<HTMLDivElement | null>(null);
  const logIdCounter = React.useRef(1);

  const deviceSyncPendingRef = React.useRef(false);
  const fpsCounterRef = React.useRef({ count: 0, lastTime: performance.now(), fps: 0 });
  const showRaw0x81Ref = React.useRef(showRaw0x81);
  React.useEffect(() => {
    showRaw0x81Ref.current = showRaw0x81;
  }, [showRaw0x81]);

  const appliedRef = React.useRef({
    torqueEnabled: false,
    appliedVoltage: 0.0,
  });
  React.useEffect(() => {
    appliedRef.current = { torqueEnabled, appliedVoltage };
  }, [torqueEnabled, appliedVoltage]);

  const appendLog = React.useCallback(
    (level: LogLevel, message: string) => {
      const now = new Date();
      const timeStr =
        now.toTimeString().split(' ')[0] +
        '.' +
        String(now.getMilliseconds()).padStart(3, '0');
      const dir =
        level === 'tx' ? '[TX]' : level === 'rx' ? '[RX]' : `[${level.toUpperCase()}]`;
      const entryId = logIdCounter.current++;

      setLogs((prev) => {
        const next = [...prev, { id: entryId, time: timeStr, level, dir, content: message }];
        return next.length > 220 ? next.slice(next.length - 220) : next;
      });
    },
    [setLogs]
  );

  React.useEffect(() => {
    if (!pauseLogScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, pauseLogScroll]);

  const transportRef = React.useRef<TransportManager | null>(null);
  const reqQueueRef = React.useRef<RequestQueue | null>(null);
  const unpackerRef = React.useRef<StreamUnpacker | null>(null);

  const syncDeviceState = React.useCallback(async () => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue) return;

    appendLog('info', '正在从下位机同步当前运行状态与 6 项 RAM 参数...');
    try {
      const stResp = await reqQueue.enqueue(CommandType.GetState, (seq) =>
        encodeGetState(seq)
      );
      if (stResp.result === Result.Ok) {
        const fTarget = Math.fround(stResp.value);
        setAppliedTorque(fTarget);
        setDraftTorque(Number(fTarget.toFixed(3)));
      }

      const nextRam: Record<number, number> = {};
      const nextDraft: Record<number, string> = {};

      for (const meta of PARAMETER_META_LIST) {
        const pResp = await reqQueue.enqueue(CommandType.GetParameter, (seq) =>
          encodeGetParameter(meta.id, seq)
        );
        if (pResp.result === Result.Ok) {
          const fVal = Math.fround(pResp.value);
          nextRam[meta.id] = fVal;
          nextDraft[meta.id] = fVal.toFixed(meta.decimals);
          if (meta.id === 6) {
            setTorqueLimit(Number(fVal.toFixed(2)));
          }
        }
      }

      setRamParams((prev) => ({ ...prev, ...nextRam }));
      setDraftParams((prev) => ({ ...prev, ...nextDraft }));
      setFlashSaveStatus({ text: 'RAM 已同步', tone: 'idle' });
      appendLog('info', '已成功同步下位机全部状态与 6 项配置参数 (RAM)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('warn', `同步下位机配置未完全完成: ${msg}`);
    }
  }, [appendLog, setAppliedTorque, setDraftTorque, setTorqueLimit, setRamParams, setDraftParams, setFlashSaveStatus]);

  // 初始化协议解包器、请求队列与传输层
  React.useEffect(() => {
    const unpacker = new StreamUnpacker({
      onFeedback: (fb) => {
        const now = performance.now();
        fpsCounterRef.current.count++;
        if (now - fpsCounterRef.current.lastTime >= 1000) {
          fpsCounterRef.current.fps = fpsCounterRef.current.count;
          fpsCounterRef.current.count = 0;
          fpsCounterRef.current.lastTime = now;
        }

        if (deviceSyncPendingRef.current) {
          deviceSyncPendingRef.current = false;
          syncDeviceState();
        }

        scopeRef.current?.pushData(fb.voltage, fb.torque, now);

        setTelemetry((prev) => ({
          ...prev,
          voltage: fb.voltage,
          torque: fb.torque,
          vMin: prev.vMin === null ? fb.voltage : Math.min(prev.vMin, fb.voltage),
          vMax: prev.vMax === null ? fb.voltage : Math.max(prev.vMax, fb.voltage),
          tMax:
            prev.tMax === null
              ? Math.abs(fb.torque)
              : Math.max(prev.tMax, Math.abs(fb.torque)),
          fps: fpsCounterRef.current.fps,
          rxFrames: unpacker.stats.validFrames,
          crcErrors: unpacker.stats.crcErrors,
        }));

        if (showRaw0x81Ref.current) {
          const hex = bytesToHex(fb.rawBytes);
          appendLog(
            'rx',
            `[RX 0x81 #${fb.seq}] V=${fb.voltage.toFixed(3)}V T=${fb.torque.toFixed(3)}N·m | ${hex}`
          );
        }
      },
      onResponse: (resp) => {
        const matchState = reqQueueRef.current?.handleResponse(resp);
        if (matchState === 'late') return;

        setCommTimeoutWarning(false);
        setTorqueEnabled(resp.torqueEnabled);
        setFeedbackValid(resp.feedbackValid);

        const hex = bytesToHex(resp.rawBytes);
        const level: LogLevel = resp.result === Result.Ok ? 'info' : 'warn';
        appendLog(
          level,
          `[RSP 0x82 #${resp.seq}] 原命令=${resp.originalCmdName} | 结果=${resp.resultName} | 返回值=${resp.value.toFixed(4)} | 闭环=${resp.torqueEnabled ? '开启' : '关闭'} 反馈=${resp.feedbackValid ? '有效' : '未就绪'} | ${hex}`
        );
      },
      onError: (err) => {
        appendLog('error', `[CRC校验失败] ${err.error}`);
        setTelemetry((prev) => ({
          ...prev,
          crcErrors: unpacker.stats.crcErrors,
        }));
      },
    });

    const transport = new TransportManager({
      onData: (chunk) => unpacker.feed(chunk),
      onStatusChange: (st) => {
        if (!st.connected) {
          const hadActive =
            appliedRef.current.torqueEnabled || appliedRef.current.appliedVoltage > 0.01;
          setConnStatus({
            connected: false,
            mode: 'disconnected',
            label: hadActive
              ? '串口已断开 (注意: 下位机保持最后输出!)'
              : st.label,
            warning: hadActive,
          });
          deviceSyncPendingRef.current = false;
          reqQueueRef.current?.clear();
          setTorqueEnabled(false);
          setFeedbackValid(false);
        } else {
          setConnStatus({
            connected: true,
            mode: st.mode,
            label: st.label,
            warning: false,
          });
          deviceSyncPendingRef.current = true;
        }
      },
      onLog: (lvl, msg) => appendLog(lvl, msg),
    });

    const reqQueue = new RequestQueue(
      (frame) => transport.send(frame),
      (lvl, msg) => appendLog(lvl, msg),
      () =>
        setTelemetry((prev) => ({
          ...prev,
          txFrames: prev.txFrames + 1,
        })),
      () => setCommTimeoutWarning(true)
    );

    unpackerRef.current = unpacker;
    transportRef.current = transport;
    reqQueueRef.current = reqQueue;

    // 检测当前运行平台并扫描可用串口
    getPlatformInfo().then((info) => {
      setPlatformInfo(info);
      if (info.isTauri) {
        listNativeSerialPorts().then((ports) => {
          setSerialPorts(ports);
          if (ports.length > 0) {
            setSelectedPort(ports[0].portName);
          }
        });
      }
    });

    appendLog(
      'info',
      'Motor Test Station Pro v2.4 已就绪 (支持桌面原生串口、Web Serial 与高保真仿真器)'
    );

    return () => {
      transport.disconnect();
      reqQueue.clear();
    };
  }, [appendLog, setConnStatus, setPlatformInfo, setSerialPorts, setSelectedPort, setTelemetry, setTorqueEnabled, setFeedbackValid, setCommTimeoutWarning, syncDeviceState]);

  const handleRefreshPorts = async () => {
    const ports = await listNativeSerialPorts();
    setSerialPorts(ports);
    if (ports.length > 0 && !ports.some((p) => p.portName === selectedPort)) {
      setSelectedPort(ports[0].portName);
    }
    appendLog('info', `已扫描到 ${ports.length} 个系统串口设备`);
  };

  const handleConnectHardware = async () => {
    const transport = transportRef.current;
    if (!transport) return;
    try {
      if (platformInfo.isTauri) {
        if (!selectedPort) {
          const ports = await listNativeSerialPorts();
          setSerialPorts(ports);
          if (ports.length === 0) {
            alert('当前未检测到可用串口，请检查 USB-TTL 串口线是否已插入电脑，或点击【仿真模式】体验功能。');
            return;
          }
          await transport.connectNative(ports[0].portName, baudRate);
          setSelectedPort(ports[0].portName);
        } else {
          await transport.connectNative(selectedPort, baudRate);
        }
      } else {
        await transport.connectWebSerial(baudRate);
      }
    } catch {}
  };

  const handleDisconnect = async () => {
    await transportRef.current?.disconnect();
  };

  const handleToggleMock = async () => {
    const transport = transportRef.current;
    if (!transport) return;
    if (connStatus.mode === 'mock') {
      await transport.disconnect();
    } else {
      await transport.startMock();
    }
  };

  const handleQueryState = async () => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue) return;
    try {
      const resp = await reqQueue.enqueue(CommandType.GetState, (seq) =>
        encodeGetState(seq)
      );
      if (resp.result === Result.Ok) {
        const fTarget = Math.fround(resp.value);
        setAppliedTorque(fTarget);
        appendLog(
          'info',
          `[状态刷新] 当前已接受扭矩目标=${fTarget.toFixed(3)} N·m, 闭环=${resp.torqueEnabled ? '开启' : '关闭'}, 反馈=${resp.feedbackValid ? '有效' : '未就绪'}`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `查询状态失败: ${msg}`);
    }
  };

  // --- 电压控制操作 ---
  const sendTargetVoltage = React.useCallback(
    async (v: number) => {
      const reqQueue = reqQueueRef.current;
      if (!reqQueue) return false;
      const fVal = Math.fround(Math.max(0.0, Math.min(MAX_VOLTAGE, Number(v) || 0.0)));
      if (torqueEnabled && fVal > 0.0) {
        appendLog('warn', '下发被拒绝：当前扭矩闭环处于开启状态，禁止发送非零手动电压');
        return false;
      }

      try {
        const resp = await reqQueue.enqueue(CommandType.SetVoltage, (seq) =>
          encodeSetVoltage(fVal, seq)
        );
        if (resp.result === Result.Ok) {
          const accepted = Math.fround(resp.value);
          setAppliedVoltage(accepted);
          if (fVal === 0.0) {
            setTorqueEnabled(false);
          }
          appendLog('info', `电压目标已生效: ${accepted.toFixed(2)} V`);
          return true;
        } else {
          appendLog('warn', `电压设置未生效: ${resp.resultName}`);
          return false;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog('error', `设置电压异常: ${msg}`);
        return false;
      }
    },
    [appendLog, setAppliedVoltage, setTorqueEnabled, torqueEnabled]
  );

  const autoSyncTimerRef = React.useRef<number | undefined>(undefined);
  const updateVoltageDraft = (val: number, forceSend = false) => {
    const clamped = Math.round(Math.max(0.0, Math.min(MAX_VOLTAGE, Number(val) || 0.0)) * 100) / 100;
    setDraftVoltage(clamped);
    if (forceSend) {
      sendTargetVoltage(clamped);
    } else if (autoSyncVoltage) {
      if (autoSyncTimerRef.current === undefined) {
        autoSyncTimerRef.current = window.setTimeout(() => {
          autoSyncTimerRef.current = undefined;
          sendTargetVoltage(clamped);
        }, 50);
      }
    }
  };

  // --- 扭矩闭环操作 ---
  const sendTargetTorque = async (t: number): Promise<boolean> => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue) return false;
    const fVal = Math.fround(Math.max(0.0, Number(t) || 0.0));
    try {
      const resp = await reqQueue.enqueue(CommandType.SetTorque, (seq) =>
        encodeSetTorque(fVal, seq)
      );
      if (resp.result === Result.Ok) {
        const accepted = Math.fround(resp.value);
        setAppliedTorque(accepted);
        setDraftTorque(Number(accepted.toFixed(3)));
        appendLog('info', `下位机已接受目标扭矩: ${accepted.toFixed(3)} N·m`);
        return true;
      } else {
        appendLog('warn', `设置扭矩目标被拒绝: ${resp.resultName}`);
        return false;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `下发扭矩目标异常: ${msg}`);
      return false;
    }
  };

  const updateTorqueDraft = (val: number, forceSend = false) => {
    const clamped =
      Math.round(Math.max(0.0, Math.min(torqueLimit, Number(val) || 0.0)) * 1000) / 1000;
    setDraftTorque(clamped);
    if (forceSend) {
      sendTargetTorque(clamped);
    }
  };

  const handleSetTorqueLoopEnabled = async (enable: boolean) => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue) return;
    try {
      if (enable) {
        const ok = await sendTargetTorque(draftTorque);
        if (!ok) {
          appendLog('warn', '目标扭矩下发未成功，已中止开启扭矩闭环');
          return;
        }
      }
      const resp = await reqQueue.enqueue(CommandType.SetTorqueEnabled, (seq) =>
        encodeSetTorqueEnabled(enable, seq)
      );
      if (resp.result === Result.Ok) {
        if (!enable) {
          setAppliedVoltage(0.0);
        }
        appendLog('info', `扭矩闭环已成功${enable ? '【开启】' : '【关闭】'}`);
      } else {
        appendLog('warn', `扭矩闭环切换失败: ${resp.resultName}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `切换闭环异常: ${msg}`);
    }
  };

  const handleUpdateTorqueLimit = async (newLimit: number) => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue) return;
    const fLimit = Math.fround(newLimit);
    if (!Number.isFinite(fLimit) || fLimit <= 0) {
      alert('扭矩安全上限必须大于 0');
      return;
    }
    try {
      const resp = await reqQueue.enqueue(CommandType.SetParameter, (seq) =>
        encodeSetParameter(6, fLimit, seq)
      );
      if (resp.result === Result.Ok) {
        const appliedLimit = Math.fround(resp.value);
        setTorqueLimit(Number(appliedLimit.toFixed(2)));
        setRamParams((prev) => ({ ...prev, 6: appliedLimit }));
        setDraftParams((prev) => ({ ...prev, 6: appliedLimit.toFixed(2) }));

        // 降低上限后立即通过 GetState 刷新下位机被钳位的目标
        const stResp = await reqQueue.enqueue(CommandType.GetState, (seq) =>
          encodeGetState(seq)
        );
        if (stResp.result === Result.Ok) {
          const clampedTarget = Math.fround(stResp.value);
          setAppliedTorque(clampedTarget);
          setDraftTorque(Number(clampedTarget.toFixed(3)));
        }
        appendLog(
          'info',
          `扭矩安全上限已更新为: ${appliedLimit.toFixed(2)} N·m`
        );
      } else {
        appendLog('warn', `设置扭矩上限失败: ${resp.resultName}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `设置扭矩上限异常: ${msg}`);
    }
  };

  // --- 6参数读写与停机安全保存 ---
  const handleApplyParamsToRam = async () => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue) return;
    appendLog('info', '正在将本地修改参数逐项写入下位机 RAM...');
    let anyWritten = false;
    let limitUpdated = false;

    for (const meta of PARAMETER_META_LIST) {
      const rawVal = parseFloat(draftParams[meta.id] ?? '');
      const fVal = Math.fround(rawVal);
      if (Number.isFinite(fVal) && Math.abs(fVal - (ramParams[meta.id] ?? 0)) > 1e-6) {
        try {
          const resp = await reqQueue.enqueue(CommandType.SetParameter, (seq) =>
            encodeSetParameter(meta.id, fVal, seq)
          );
          if (resp.result === Result.Ok) {
            const appliedVal = Math.fround(resp.value);
            setRamParams((prev) => ({ ...prev, [meta.id]: appliedVal }));
            setDraftParams((prev) => ({
              ...prev,
              [meta.id]: appliedVal.toFixed(meta.decimals),
            }));
            anyWritten = true;
            if (meta.id === 6) {
              setTorqueLimit(Number(appliedVal.toFixed(2)));
              limitUpdated = true;
            }
            appendLog('info', `参数 ${meta.name} 已写入 RAM: ${appliedVal}`);
          } else {
            appendLog('warn', `参数 ${meta.name} 写入失败: ${resp.resultName}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog('error', `写入参数异常: ${msg}`);
        }
      }
    }

    if (limitUpdated) {
      try {
        const stResp = await reqQueue.enqueue(CommandType.GetState, (seq) =>
          encodeGetState(seq)
        );
        if (stResp.result === Result.Ok) {
          const clampedTarget = Math.fround(stResp.value);
          setAppliedTorque(clampedTarget);
          setDraftTorque(Number(clampedTarget.toFixed(3)));
        }
      } catch {}
    }

    if (anyWritten) {
      setFlashSaveStatus({ text: 'RAM 已应用 (未写Flash)', tone: 'applied' });
    }
  };

  const handleSafeSaveFlash = async () => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue || !connStatus.connected) {
      alert('请先连接串口或开启仿真模式再执行保存');
      return;
    }

    setFlashSaveStatus({ text: '正在保存...', tone: 'saving' });
    let step = 'stop';

    try {
      appendLog('info', '【保存流程 1/4】发送软件停止指令 (SetVoltage 0V)，等待停机应答...');
      const stopResp = await reqQueue.enqueue(CommandType.SetVoltage, (seq) =>
        encodeSetVoltage(0.0, seq)
      );
      if (stopResp.result !== Result.Ok) {
        throw new Error(`停止输出失败: ${stopResp.resultName}`);
      }
      setAppliedVoltage(0.0);
      setTorqueEnabled(false);

      step = 'write_ram';
      appendLog('info', '【保存流程 2/4】正在核对并将已修改参数逐项写入下位机 RAM...');
      let limitChanged = false;
      for (const meta of PARAMETER_META_LIST) {
        const fVal = Math.fround(parseFloat(draftParams[meta.id] ?? ''));
        if (Number.isFinite(fVal) && Math.abs(fVal - (ramParams[meta.id] ?? 0)) > 1e-6) {
          const pResp = await reqQueue.enqueue(CommandType.SetParameter, (seq) =>
            encodeSetParameter(meta.id, fVal, seq)
          );
          if (pResp.result !== Result.Ok) {
            throw new Error(`写入参数 ${meta.name} 失败: ${pResp.resultName}`);
          }
          const appliedVal = Math.fround(pResp.value);
          setRamParams((prev) => ({ ...prev, [meta.id]: appliedVal }));
          setDraftParams((prev) => ({
            ...prev,
            [meta.id]: appliedVal.toFixed(meta.decimals),
          }));
          if (meta.id === 6) {
            setTorqueLimit(Number(appliedVal.toFixed(2)));
            limitChanged = true;
          }
        }
      }

      if (limitChanged) {
        const stResp = await reqQueue.enqueue(CommandType.GetState, (seq) =>
          encodeGetState(seq)
        );
        if (stResp.result === Result.Ok) {
          const clampedTarget = Math.fround(stResp.value);
          setAppliedTorque(clampedTarget);
          setDraftTorque(Number(clampedTarget.toFixed(3)));
        }
      }

      step = 'save_flash';
      appendLog('info', '【保存流程 3/4】发送 SaveParameters 命令擦写持久化到 Flash (超时 3s)...');
      const saveResp = await reqQueue.enqueue(
        CommandType.SaveParameters,
        (seq) => encodeSaveParameters(seq),
        3000
      );

      const storageCode = Math.round(saveResp.value);
      const storageMsg = StorageCodeNames[storageCode] || `Code ${storageCode}`;

      if (saveResp.result === Result.Ok && storageCode === 0) {
        appendLog('info', `【保存流程 4/4】🎉 Flash 保存成功！(存储状态: ${storageMsg})`);
        setFlashSaveStatus({ text: '✓ 已保存到 Flash', tone: 'saved' });
      } else {
        throw new Error(`Flash 存储返回异常: Result=${saveResp.resultName}, 存储码=${storageMsg}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `保存中止: ${msg}`);
      if (step === 'save_flash' && msg.includes('Timeout')) {
        setFlashSaveStatus({ text: '⚠️ 结果未知 (请人工核对)', tone: 'unknown' });
      } else {
        setFlashSaveStatus({ text: '✕ 保存未完成', tone: 'error' });
      }
    }
  };

  const handleExportCsv = () => {
    const csv = scopeRef.current?.exportCsv();
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
    appendLog('info', '已导出采样数据 CSV 文件');
  };

  // 计算前馈与动态电压上限 (按已接受目标计算，并提供待下发预览)
  const acceptedVff = appliedTorque > 0 ? Math.min(appliedTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const acceptedVmax = appliedTorque > 0 ? Math.min(acceptedVff + 0.5, MAX_VOLTAGE) : 0.0;

  const draftVff = draftTorque > 0 ? Math.min(draftTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const draftVmax = draftTorque > 0 ? Math.min(draftVff + 0.5, MAX_VOLTAGE) : 0.0;

  const isVoltageSynced = Math.abs(draftVoltage - appliedVoltage) < 0.005;
  const isTorqueSynced = Math.abs(draftTorque - appliedTorque) < 0.001;

  const vMeterPct = Math.max(0, Math.min(100, (telemetry.voltage / MAX_VOLTAGE) * 100));
  const tMeterPct = Math.max(0, Math.min(100, (telemetry.torque / Math.max(0.1, torqueLimit)) * 100));

  const isDark = theme === 'dark';

  return (
    <div className={isDark ? 'dark' : ''}>
      <div
        className={`min-h-screen transition-colors duration-200 ${
          isDark
            ? 'bg-dark-grid text-slate-100'
            : 'bg-cleanroom-grid text-slate-900'
        } pb-16 lg:pb-6`}
      >
        {/* =================================================================
            1. 顶部控制台中控栏 (Top Cockpit Command Bar)
           ================================================================= */}
        <header className="sticky top-0 z-50 border-b border-slate-200/90 bg-white/95 backdrop-blur-md shadow-xs dark:border-slate-800 dark:bg-slate-900/95">
          <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
            {/* 左侧品牌与三端状态标识 */}
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-sky-700 text-white shadow-sm border border-sky-400/30">
                <Cpu className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold tracking-tight text-slate-900 dark:text-white">
                    MOTOR TEST STATION
                  </span>
                  <Badge variant="default">v2.4 PRO</Badge>
                  <Badge variant="neutral" className="hidden sm:inline-flex">
                    {platformInfo.isTauri
                      ? `${platformInfo.os.toUpperCase()} NATIVE`
                      : 'WEB RUNTIME'}
                  </Badge>
                </div>
                <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  STM32 实验室电机测控工作台 · 双向 14B · 前馈与动态限幅 (+0.5V)
                </div>
              </div>
            </div>

            {/* 右侧串口选择与操作工具栏 */}
            <div className="flex flex-wrap items-center gap-2">
              {/* 链路连接状态指示器 */}
              <div
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-mono tnum ${
                  connStatus.warning
                    ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-300'
                    : 'border-slate-200 bg-slate-100/80 text-slate-600 dark:border-slate-800 dark:bg-slate-800/70 dark:text-slate-300'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    !connStatus.connected
                      ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                      : connStatus.mode === 'mock'
                        ? 'bg-amber-500 animate-pulse shadow-[0_0_8px_rgba(245,158,11,0.6)]'
                        : 'bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]'
                  }`}
                />
                <span>{connStatus.label}</span>
              </div>

              {/* 原生桌面端显示串口枚举下拉框与扫描按钮 */}
              {platformInfo.isTauri && (
                <div className="flex items-center gap-1.5">
                  <select
                    value={selectedPort}
                    onChange={(e) => setSelectedPort(e.target.value)}
                    disabled={connStatus.connected}
                    title="选择物理串口设备"
                    className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-mono text-slate-800 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  >
                    {serialPorts.length === 0 ? (
                      <option value="">未检测到串口 (点击右侧扫描)</option>
                    ) : (
                      serialPorts.map((p) => (
                        <option key={p.portName} value={p.portName}>
                          {p.label}
                        </option>
                      ))
                    )}
                  </select>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleRefreshPorts}
                    disabled={connStatus.connected}
                    title="扫描/刷新系统串口列表"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}

              {/* 波特率选择 */}
              <select
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value))}
                disabled={connStatus.connected}
                title="串口波特率"
                className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-mono tnum text-slate-800 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value={115200}>115200 bps (标准)</option>
                <option value={921600}>921600 bps</option>
                <option value={460800}>460800 bps</option>
                <option value={230400}>230400 bps</option>
                <option value={57600}>57600 bps</option>
              </select>

              <Button
                variant="outline"
                onClick={handleQueryState}
                disabled={!connStatus.connected}
                title="发送 GetState (0x13) 查询下位机最新选定目标与闭环状态"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">刷新状态</span>
              </Button>

              {!connStatus.connected || connStatus.mode === 'mock' ? (
                <Button variant="default" onClick={handleConnectHardware}>
                  <Zap className="h-3.5 w-3.5" />
                  连接串口
                </Button>
              ) : (
                <Button variant="destructive" onClick={handleDisconnect}>
                  断开连接
                </Button>
              )}

              <Button
                variant={connStatus.mode === 'mock' ? 'destructive' : 'outline'}
                onClick={handleToggleMock}
                title="无硬件时启动高保真 STM32 虚拟下位机仿真器"
              >
                <Activity className="h-3.5 w-3.5" />
                {connStatus.mode === 'mock' ? '停止仿真' : '仿真模式 (Mock)'}
              </Button>

              {/* 极客白/深空暗色主题一键切换 */}
              <Button
                variant="outline"
                size="icon"
                onClick={() => setTheme(isDark ? 'cleanroom' : 'dark')}
                title={isDark ? '切换至纯白+淡蓝实验室主题' : '切换至深空暗黑仪器主题'}
              >
                {isDark ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4 text-sky-600" />}
              </Button>
            </div>
          </div>
        </header>

        {/* =================================================================
            2. 主工作区：支持桌面宽屏双栏、平板分屏与移动端自适应切换
           ================================================================= */}
        <main className="mx-auto grid max-w-[1800px] grid-cols-1 gap-5 p-4 sm:px-6 lg:grid-cols-[460px_1fr]">
          {/* ---------------------------------------------------------------
              左侧控制栏 (460px 宽幅控制台：组1模式切换 + 组2六参数调优)
             --------------------------------------------------------------- */}
          <aside
            className={`space-y-5 ${
              mobileTab === 'scope' || mobileTab === 'terminal' ? 'hidden lg:block' : 'block'
            }`}
          >
            {/* 栏位 1: 主运行控制单元 (单栏位通过按钮切换 手动电压 vs 扭矩闭环) */}
            <Card
              className={`border-t-4 ${
                activeMode === 'voltage' ? 'border-t-sky-600' : 'border-t-amber-500'
              } ${mobileTab === 'params' ? 'hidden lg:block' : 'block'}`}
            >
              <CardContent className="p-4 sm:p-5">
                {/* 模式二选一分段开关 */}
                <div className="mb-4 flex gap-1.5 rounded-lg border border-slate-200 bg-slate-100/90 p-1 dark:border-slate-800 dark:bg-slate-950">
                  <button
                    type="button"
                    onClick={() => setActiveMode('voltage')}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-md py-2 text-xs font-bold transition-all cursor-pointer ${
                      activeMode === 'voltage'
                        ? 'bg-white text-sky-600 shadow-xs border border-slate-200/80 dark:bg-slate-800 dark:text-sky-400 dark:border-slate-700'
                        : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                    }`}
                  >
                    <Zap className="h-3.5 w-3.5" />
                    ⚡ 手动电压模式
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveMode('torque')}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-md py-2 text-xs font-bold transition-all cursor-pointer ${
                      activeMode === 'torque'
                        ? 'bg-white text-amber-600 shadow-xs border border-slate-200/80 dark:bg-slate-800 dark:text-amber-400 dark:border-slate-700'
                        : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                    }`}
                  >
                    <Target className="h-3.5 w-3.5" />
                    🎯 扭矩闭环模式
                  </button>
                </div>

                {/* ================= 模式 A: 手动电压模式 ================= */}
                {activeMode === 'voltage' ? (
                  <div className="space-y-3.5">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <Badge variant="default">MODE · VOLTAGE</Badge>
                        <span className="text-sm font-bold">驱动输出控制单元</span>
                      </div>
                      <span className="font-mono text-lg font-extrabold text-sky-600 dark:text-sky-400 tnum">
                        {draftVoltage.toFixed(2)} V
                      </span>
                    </div>

                    {/* 设定值 vs 下位机已生效目标对比条 */}
                    <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50 px-3 py-1.5 text-xs font-mono tnum dark:border-slate-800 dark:bg-slate-950/60">
                      <span className="text-slate-500 dark:text-slate-400">
                        下位机已生效:{' '}
                        <strong className="text-slate-900 dark:text-white">
                          {appliedVoltage.toFixed(2)} V
                        </strong>
                      </span>
                      <Badge variant={isVoltageSynced ? 'success' : 'amber'}>
                        {isVoltageSynced ? '✓ 已下发同步' : '● 待点击下发'}
                      </Badge>
                    </div>

                    {torqueEnabled && (
                      <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/90 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
                        <Lock className="h-4 w-4 shrink-0 text-amber-600" />
                        <span>
                          扭矩闭环运行中，非零手动电压已物理互锁禁止发送 (ModeConflict)；如需手动调压请先关闭闭环或点击软件停机。
                        </span>
                      </div>
                    )}

                    {/* 控制参数 1: 目标输出电压 */}
                    <div className="rounded-lg border border-slate-200/90 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
                        <span>控制参数 1 · 目标输出电压 (0.0 ~ 18.0 V)</span>
                        <span className="font-mono text-[10px] text-slate-400">V_TARGET</span>
                      </div>
                      <div className="py-2">
                        <input
                          type="range"
                          min={0}
                          max={18}
                          step={0.05}
                          value={draftVoltage}
                          disabled={torqueEnabled}
                          onChange={(e) => updateVoltageDraft(parseFloat(e.target.value), false)}
                          className="slider-azure w-full bg-slate-200 dark:bg-slate-800"
                        />
                      </div>
                      <div className="mt-2 grid grid-cols-4 gap-1.5">
                        {VOLTAGE_PRESETS.map((v) => {
                          const isActive = Math.abs(draftVoltage - v) < 0.05;
                          return (
                            <button
                              key={v}
                              type="button"
                              disabled={torqueEnabled}
                              onClick={() => updateVoltageDraft(v, autoSyncVoltage)}
                              className={`rounded-md border py-1.5 font-mono text-xs font-semibold tnum transition-all cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
                                isActive
                                  ? 'border-sky-500 bg-sky-50 text-sky-700 font-bold shadow-2xs dark:bg-sky-950/60 dark:text-sky-300'
                                  : 'border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
                              }`}
                            >
                              {v.toFixed(1)} V
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 控制参数 2: 步进微调量 */}
                    <div className="rounded-lg border border-slate-200/90 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
                        <span>控制参数 2 · 步进微调量 (CNC 增量调节)</span>
                        <span className="font-mono text-[10px] text-slate-400">STEP DELTA</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          disabled={torqueEnabled}
                          onClick={() => updateVoltageDraft(draftVoltage - 0.2, autoSyncVoltage)}
                          className="w-14 font-mono font-bold"
                        >
                          -0.2V
                        </Button>
                        <input
                          type="number"
                          min={0}
                          max={18}
                          step={0.1}
                          value={draftVoltage}
                          disabled={torqueEnabled}
                          onChange={(e) => updateVoltageDraft(parseFloat(e.target.value), false)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') sendTargetVoltage(draftVoltage);
                          }}
                          className="h-9 flex-1 rounded-lg border border-slate-200 bg-white text-center font-mono text-sm font-bold tnum outline-none focus:border-sky-500 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900"
                        />
                        <Button
                          variant="outline"
                          disabled={torqueEnabled}
                          onClick={() => updateVoltageDraft(draftVoltage + 0.2, autoSyncVoltage)}
                          className="w-14 font-mono font-bold"
                        >
                          +0.2V
                        </Button>
                      </div>
                      <div className="mt-2 grid grid-cols-4 gap-1.5">
                        {[-1.0, -0.5, 0.5, 1.0].map((delta) => (
                          <button
                            key={delta}
                            type="button"
                            disabled={torqueEnabled}
                            onClick={() =>
                              updateVoltageDraft(draftVoltage + delta, autoSyncVoltage)
                            }
                            className="rounded border border-slate-200 bg-white py-1 font-mono text-[11px] font-semibold text-slate-500 hover:border-sky-300 hover:text-sky-600 cursor-pointer disabled:opacity-45 disabled:pointer-events-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
                          >
                            {delta > 0 ? `+${delta.toFixed(1)}V` : `${delta.toFixed(1)}V`}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 自动同步勾选 */}
                    <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none dark:text-slate-400">
                      <input
                        type="checkbox"
                        checked={autoSyncVoltage}
                        onChange={(e) => setAutoSyncVoltage(e.target.checked)}
                        className="accent-sky-600 rounded cursor-pointer"
                      />
                      <span>拖动滑块或点击预设/步进时自动下发 (20Hz 节流)</span>
                    </label>

                    {/* 下发与停机动作行 */}
                    <div className="flex gap-2.5 pt-1">
                      <Button
                        variant="default"
                        size="lg"
                        disabled={torqueEnabled}
                        onClick={() => sendTargetVoltage(draftVoltage)}
                        className="flex-1"
                      >
                        {torqueEnabled ? (
                          <>
                            <Lock className="h-4 w-4" />
                            闭环中已锁定 (禁止非零电压)
                          </>
                        ) : (
                          <>
                            <Zap className="h-4 w-4" />
                            下发电压目标
                          </>
                        )}
                      </Button>
                      <Button
                        variant="destructive"
                        size="lg"
                        onClick={() => {
                          updateVoltageDraft(0.0, true);
                          appendLog('warn', '【执行软件停机】下发目标电压 0.00 V');
                        }}
                        className="flex-1"
                      >
                        <OctagonAlert className="h-4 w-4" />
                        软件停机 (0V)
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* ================= 模式 B: 扭矩闭环模式 ================= */
                  <div className="space-y-3.5">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <Badge variant="amber">MODE · TORQUE</Badge>
                        <span className="text-sm font-bold">扭矩闭环控制单元</span>
                      </div>
                      <span className="font-mono text-lg font-extrabold text-amber-600 dark:text-amber-400 tnum">
                        {draftTorque.toFixed(3)} N·m
                      </span>
                    </div>

                    {/* 状态指示胶囊条 */}
                    <div className="grid grid-cols-3 gap-1.5 text-[11px] font-mono tnum">
                      <div
                        className={`flex items-center justify-center rounded-md border py-1.5 px-2 font-semibold ${
                          commTimeoutWarning
                            ? 'border-amber-300 bg-amber-50 text-amber-800'
                            : torqueEnabled
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 font-bold dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-800 dark:bg-slate-900'
                        }`}
                      >
                        {commTimeoutWarning
                          ? '▲ 状态未知'
                          : torqueEnabled
                            ? '● 闭环: 运行中'
                            : '○ 闭环: 已关闭'}
                      </div>
                      <div
                        className={`flex items-center justify-center rounded-md border py-1.5 px-2 font-semibold ${
                          feedbackValid
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 font-bold dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'border-amber-200 bg-amber-50/70 text-amber-700 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300'
                        }`}
                      >
                        {feedbackValid ? '● 反馈: 正常' : '▲ 反馈: 未就绪'}
                      </div>
                      <div className="flex items-center justify-center rounded-md border border-slate-200 bg-slate-100 py-1.5 px-2 font-semibold text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                        上限: {torqueLimit.toFixed(2)} N·m
                      </div>
                    </div>

                    {/* 已接受目标 vs 设定值对比条 */}
                    <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50 px-3 py-1.5 text-xs font-mono tnum dark:border-slate-800 dark:bg-slate-950/60">
                      <span className="text-slate-500 dark:text-slate-400">
                        设备已接受目标:{' '}
                        <strong className="text-slate-900 dark:text-white">
                          {appliedTorque.toFixed(3)} N·m
                        </strong>
                      </span>
                      <Badge variant={isTorqueSynced ? 'success' : 'amber'}>
                        {isTorqueSynced ? '✓ 已下发同步' : '● 待下发确认'}
                      </Badge>
                    </div>

                    {/* 控制参数 1: 目标扭矩幅值 */}
                    <div className="rounded-lg border border-slate-200/90 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
                        <span>控制参数 1 · 目标扭矩幅值 (0.0 ~ Limit)</span>
                        <span className="font-mono text-[10px] text-slate-400">TORQUE_TARGET</span>
                      </div>
                      <div className="py-2">
                        <input
                          type="range"
                          min={0}
                          max={torqueLimit}
                          step={0.05}
                          value={draftTorque}
                          onChange={(e) => updateTorqueDraft(parseFloat(e.target.value), false)}
                          className="slider-amber w-full bg-slate-200 dark:bg-slate-800"
                        />
                      </div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <Button
                          variant="outline"
                          onClick={() => updateTorqueDraft(draftTorque - 0.1, false)}
                          className="w-14 font-mono font-bold"
                        >
                          -0.1
                        </Button>
                        <input
                          type="number"
                          min={0}
                          max={torqueLimit}
                          step={0.05}
                          value={draftTorque}
                          onChange={(e) => updateTorqueDraft(parseFloat(e.target.value), false)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') sendTargetTorque(draftTorque);
                          }}
                          className="h-9 flex-1 rounded-lg border border-slate-200 bg-white text-center font-mono text-sm font-bold tnum outline-none focus:border-amber-500 dark:border-slate-800 dark:bg-slate-900"
                        />
                        <Button
                          variant="outline"
                          onClick={() => updateTorqueDraft(draftTorque + 0.1, false)}
                          className="w-14 font-mono font-bold"
                        >
                          +0.1
                        </Button>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {TORQUE_PRESETS.map((t) => {
                          const isActive = Math.abs(draftTorque - t) < 0.05;
                          return (
                            <button
                              key={t}
                              type="button"
                              onClick={() => updateTorqueDraft(t, false)}
                              className={`rounded-md border py-1.5 font-mono text-xs font-semibold tnum transition-all cursor-pointer ${
                                isActive
                                  ? 'border-amber-500 bg-amber-50 text-amber-800 font-bold shadow-2xs dark:bg-amber-950/60 dark:text-amber-300'
                                  : 'border-slate-200 bg-white text-slate-600 hover:border-amber-300 hover:text-amber-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
                              }`}
                            >
                              {t.toFixed(1)}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 扭矩前馈与动态电压上限提示盒 (+0.5V 裕量) */}
                    <div className="rounded-lg border border-sky-200 bg-sky-50/75 p-3 dark:border-sky-500/30 dark:bg-sky-950/25">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-bold text-sky-800 dark:text-sky-300">
                          ⚡ 扭矩前馈与动态电压上限 (基于已接受目标)
                        </span>
                        <Badge variant="default">1 V ⇋ 0.5 N·m (+0.5V)</Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <div className="rounded-md border border-sky-200/80 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                          <span className="block text-[10px] text-slate-500">
                            动态输出电压上限 Vmax
                          </span>
                          <span className="font-mono text-base font-extrabold text-sky-600 dark:text-sky-400 tnum">
                            {acceptedVmax.toFixed(2)} V
                          </span>
                        </div>
                        <div className="rounded-md border border-sky-200/80 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                          <span className="block text-[10px] text-slate-500">
                            固件前馈计算基准 Vff
                          </span>
                          <span className="font-mono text-base font-extrabold text-sky-600 dark:text-sky-400 tnum">
                            {acceptedVff.toFixed(2)} V
                          </span>
                        </div>
                      </div>
                      {!isTorqueSynced && (
                        <div className="mb-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1 font-mono text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-300 tnum">
                          👉 待下发设定 ({draftTorque.toFixed(3)} N·m) 预计: Vff ={' '}
                          {draftVff.toFixed(2)} V, Vmax = {draftVmax.toFixed(2)} V
                        </div>
                      )}
                      <div className="border-t border-dashed border-sky-200 pt-1.5 text-[10px] leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        * 按前馈基准 Vff = min(T/0.5, 18V) 叠加 +0.5V 裕量作为动态限幅 Vmax = min(Vff + 0.5, 18V)，避免电压不足无法到达目标；此为限幅计算值，非实测电压。
                      </div>
                    </div>

                    {/* 控制参数 2: 扭矩保护上限 (在线调整下位机 ID 6) */}
                    <div className="rounded-lg border border-slate-200/90 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
                        <span>控制参数 2 · 扭矩保护上限 (在线调整下位机 ID 6)</span>
                        <span className="font-mono text-[10px] text-slate-400">TORQUE_LIMIT</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          onClick={() =>
                            handleUpdateTorqueLimit(Math.max(0.1, torqueLimit - 0.5))
                          }
                          className="w-12 font-mono font-bold"
                        >
                          -0.5
                        </Button>
                        <input
                          type="number"
                          min={0.1}
                          max={10}
                          step={0.5}
                          value={draftParams[6] ?? torqueLimit.toFixed(2)}
                          onChange={(e) =>
                            setDraftParams((prev) => ({ ...prev, 6: e.target.value }))
                          }
                          className="h-9 flex-1 rounded-lg border border-slate-200 bg-white text-center font-mono text-sm font-bold tnum outline-none focus:border-amber-500 dark:border-slate-800 dark:bg-slate-900"
                        />
                        <Button
                          variant="outline"
                          onClick={() =>
                            handleUpdateTorqueLimit(Math.min(10.0, torqueLimit + 0.5))
                          }
                          className="w-12 font-mono font-bold"
                        >
                          +0.5
                        </Button>
                        <Button
                          variant="outlineAmber"
                          onClick={() =>
                            handleUpdateTorqueLimit(
                              parseFloat(draftParams[6] ?? String(torqueLimit))
                            )
                          }
                        >
                          更新上限
                        </Button>
                      </div>
                    </div>

                    {/* 扭矩闭环控制按钮行 */}
                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <Button
                        variant="outlineAmber"
                        onClick={() => sendTargetTorque(draftTorque)}
                      >
                        下发扭矩目标
                      </Button>
                      <Button
                        variant="success"
                        onClick={() => handleSetTorqueLoopEnabled(true)}
                        title="自动先下发确认当前扭矩目标，再开启扭矩闭环"
                      >
                        <Play className="h-3.5 w-3.5" />
                        {torqueEnabled ? '闭环运行中' : '开启闭环'}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => handleSetTorqueLoopEnabled(false)}
                      >
                        <Square className="h-3.5 w-3.5" />
                        关闭闭环
                      </Button>
                    </div>
                    <Button
                      variant="destructive"
                      size="lg"
                      onClick={() => {
                        sendTargetVoltage(0.0);
                        appendLog('warn', '【执行紧急软件停机】发送 0.00V 关闭闭环并停止 PWM');
                      }}
                      className="w-full"
                    >
                      <OctagonAlert className="h-4 w-4" />
                      ⛔ 紧急停机 (关闭闭环并归零)
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 栏位 2: 下位机 6 参数调优与 Flash 安全保存组 (GROUP 02) */}
            <Card className={mobileTab === 'control' ? 'hidden lg:block' : 'block'}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Badge variant="neutral">GROUP 02</Badge>
                  <CardTitle>
                    <Settings2 className="h-4 w-4 text-sky-600" />
                    下位机 6 参数调优与 Flash 保存
                  </CardTitle>
                </div>
                <Badge
                  variant={
                    flashSaveStatus.tone === 'saved'
                      ? 'success'
                      : flashSaveStatus.tone === 'error'
                        ? 'destructive'
                        : flashSaveStatus.tone === 'dirty' ||
                            flashSaveStatus.tone === 'saving' ||
                            flashSaveStatus.tone === 'unknown'
                          ? 'amber'
                          : 'default'
                  }
                >
                  {flashSaveStatus.text}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3.5">
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={syncDeviceState}>
                    <DownloadCloud className="h-3.5 w-3.5" />
                    从设备读取 (RAM)
                  </Button>
                  <Button variant="default" onClick={handleApplyParamsToRam}>
                    <Upload className="h-3.5 w-3.5" />
                    应用改动到 RAM
                  </Button>
                </div>

                {/* 对称 2x3 网格：完整展示下位机 6 项参数 */}
                <div className="grid grid-cols-2 gap-2.5">
                  {PARAMETER_META_LIST.map((meta) => {
                    const currentRam = ramParams[meta.id] ?? meta.defaultVal;
                    const draftStr = draftParams[meta.id] ?? currentRam.toFixed(meta.decimals);
                    const fDraft = Math.fround(parseFloat(draftStr));
                    const isDirty =
                      Number.isFinite(fDraft) && Math.abs(fDraft - currentRam) > 1e-6;

                    return (
                      <div
                        key={meta.id}
                        className={`rounded-lg border p-2.5 transition-colors ${
                          isDirty
                            ? 'border-sky-500 bg-sky-50/50 dark:border-sky-400 dark:bg-sky-950/30'
                            : 'border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/40'
                        }`}
                      >
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-100">
                            {meta.shortName}
                          </span>
                          <Badge variant="default" className="tnum">
                            {currentRam.toFixed(meta.decimals)}
                          </Badge>
                        </div>
                        <input
                          type="number"
                          step={meta.step}
                          min={meta.min}
                          value={draftStr}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraftParams((prev) => ({ ...prev, [meta.id]: val }));
                            setFlashSaveStatus({ text: '● 存在未应用改动', tone: 'dirty' });
                          }}
                          className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-right font-mono text-xs font-bold tnum outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-900"
                        />
                        <div className="mt-1 text-[10px] text-slate-400 leading-tight">
                          {meta.description}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="pt-1">
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={handleSafeSaveFlash}
                    disabled={flashSaveStatus.tone === 'saving'}
                    className="w-full border-sky-500 bg-sky-50/80 text-sky-700 font-bold hover:bg-sky-600 hover:text-white dark:border-sky-500/60 dark:bg-sky-950/40 dark:text-sky-300 dark:hover:bg-sky-600 dark:hover:text-white"
                  >
                    <Save className="h-4 w-4" />
                    💾 停机安全保存到下位机 Flash
                  </Button>
                  <p className="mt-1.5 text-[10px] text-slate-400 leading-relaxed">
                    * 严格遵循 HANDOFF.md 停机保存规范：1.发送0V停止输出并等待应答 → 2.逐项写入6参数到RAM → 3.执行SaveParameters擦写Flash(3s超时)。
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* 通信链路统计卡片 */}
            <Card className="hidden lg:block">
              <CardHeader className="py-2.5">
                <CardTitle>📡 通信链路质量与指标</CardTitle>
                <Badge variant="neutral">USART3 115200 8N1</Badge>
              </CardHeader>
              <CardContent className="grid grid-cols-4 gap-2 p-3">
                <div className="rounded-lg border border-slate-200/80 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-950">
                  <div className="text-[9px] uppercase text-slate-400">RX 有效帧</div>
                  <div className="font-mono text-sm font-bold text-emerald-600 tnum">
                    {telemetry.rxFrames}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200/80 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-950">
                  <div className="text-[9px] uppercase text-slate-400">TX 命令数</div>
                  <div className="font-mono text-sm font-bold text-sky-600 tnum">
                    {telemetry.txFrames}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200/80 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-950">
                  <div className="text-[9px] uppercase text-slate-400">遥测帧率</div>
                  <div className="font-mono text-sm font-bold text-sky-600 tnum">
                    {telemetry.fps} Hz
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200/80 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-950">
                  <div className="text-[9px] uppercase text-slate-400">CRC 校验错</div>
                  <div
                    className={`font-mono text-sm font-bold tnum ${
                      telemetry.crcErrors > 0 ? 'text-red-600' : 'text-slate-400'
                    }`}
                  >
                    {telemetry.crcErrors}
                  </div>
                </div>
              </CardContent>
            </Card>
          </aside>

          {/* ---------------------------------------------------------------
              右侧遥测大屏、60FPS 示波器与报文终端主区
             --------------------------------------------------------------- */}
          <div className="space-y-5">
            {/* 实时测量大屏仪表卡片 (在移动端始终置顶可见) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* 通道 A: 实测输出电压 */}
              <Card className="border-t-4 border-t-sky-500">
                <CardContent className="p-4 sm:p-5">
                  <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    <span>实测输出电压 (V_FEEDBACK)</span>
                    <span className="font-mono text-sky-600 dark:text-sky-400">● CHANNEL A</span>
                  </div>
                  <div className="my-2 flex items-baseline gap-2">
                    <span className="font-mono text-4xl font-extrabold tracking-tight text-sky-600 dark:text-sky-400 tnum">
                      {telemetry.voltage.toFixed(3)}
                    </span>
                    <span className="font-mono text-sm font-bold text-slate-400">V</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-sky-400 to-sky-600 transition-all duration-100"
                      style={{ width: `${vMeterPct.toFixed(1)}%` }}
                    />
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-4 border-t border-slate-100 pt-2 font-mono text-[11px] text-slate-500 tnum dark:border-slate-800">
                    <span>
                      谷值 Min:{' '}
                      <strong className="text-slate-800 dark:text-slate-200">
                        {telemetry.vMin === null ? '--' : telemetry.vMin.toFixed(2)}
                      </strong>{' '}
                      V
                    </span>
                    <span>
                      峰值 Max:{' '}
                      <strong className="text-slate-800 dark:text-slate-200">
                        {telemetry.vMax === null ? '--' : telemetry.vMax.toFixed(2)}
                      </strong>{' '}
                      V
                    </span>
                    <span>
                      全局量程: <strong className="text-slate-800 dark:text-slate-200">18.00</strong> V
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* 通道 B: 实测机械扭矩 */}
              <Card className="border-t-4 border-t-amber-500">
                <CardContent className="p-4 sm:p-5">
                  <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    <span>实测机械扭矩 (TORQUE_FEEDBACK)</span>
                    <span className="font-mono text-amber-600 dark:text-amber-400">● CHANNEL B</span>
                  </div>
                  <div className="my-2 flex items-baseline gap-2">
                    <span className="font-mono text-4xl font-extrabold tracking-tight text-amber-600 dark:text-amber-400 tnum">
                      {telemetry.torque.toFixed(3)}
                    </span>
                    <span className="font-mono text-sm font-bold text-slate-400">N·m</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600 transition-all duration-100"
                      style={{ width: `${tMeterPct.toFixed(1)}%` }}
                    />
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-4 border-t border-slate-100 pt-2 font-mono text-[11px] text-slate-500 tnum dark:border-slate-800">
                    <span>
                      峰值 |Max|:{' '}
                      <strong className="text-slate-800 dark:text-slate-200">
                        {telemetry.tMax === null ? '--' : telemetry.tMax.toFixed(2)}
                      </strong>{' '}
                      N·m
                    </span>
                    <span>
                      安全上限:{' '}
                      <strong className="text-slate-800 dark:text-slate-200">
                        {torqueLimit.toFixed(2)}
                      </strong>{' '}
                      N·m
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* 双通道 60FPS 实时示波器卡片 */}
            <Card
              className={
                mobileTab === 'control' || mobileTab === 'params' || mobileTab === 'terminal'
                  ? 'hidden lg:block'
                  : 'block'
              }
            >
              <CardHeader className="flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <CardTitle>双通道实时动态示波器</CardTitle>
                  <Badge variant="default">60 FPS 硬件加速</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={scopeConfig.showTargetRef}
                      onChange={(e) =>
                        setScopeConfig((prev) => ({
                          ...prev,
                          showTargetRef: e.target.checked,
                        }))
                      }
                      className="accent-sky-600 rounded cursor-pointer"
                    />
                    <span>目标/限幅参考线</span>
                  </label>

                  <select
                    value={scopeConfig.maxPoints}
                    onChange={(e) =>
                      setScopeConfig((prev) => ({
                        ...prev,
                        maxPoints: Number(e.target.value),
                      }))
                    }
                    className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs font-mono text-slate-700 outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    <option value={250}>窗口: 250 点</option>
                    <option value={500}>窗口: 500 点</option>
                    <option value={1000}>窗口: 1000 点</option>
                    <option value={2000}>窗口: 2000 点</option>
                  </select>

                  <Button
                    variant={scopeConfig.isPaused ? 'default' : 'outline'}
                    size="sm"
                    onClick={() =>
                      setScopeConfig((prev) => ({ ...prev, isPaused: !prev.isPaused }))
                    }
                  >
                    {scopeConfig.isPaused ? (
                      <>
                        <Play className="h-3 w-3" />
                        恢复采样
                      </>
                    ) : (
                      <>
                        <Pause className="h-3 w-3" />
                        暂停采样
                      </>
                    )}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      scopeRef.current?.clear();
                      setTelemetry((prev) => ({
                        ...prev,
                        vMin: null,
                        vMax: null,
                        tMax: null,
                      }));
                      appendLog('info', '示波器历史波形与统计极值已清空');
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                    清空波形
                  </Button>

                  <Button variant="outline" size="sm" onClick={handleExportCsv}>
                    <Download className="h-3 w-3" />
                    导出 CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <OscilloscopeCanvas
                  ref={scopeRef}
                  maxPoints={scopeConfig.maxPoints}
                  showTargetRef={scopeConfig.showTargetRef}
                  isPaused={scopeConfig.isPaused}
                  theme={theme}
                  mode={activeMode}
                  vTarget={appliedVoltage}
                  tTarget={appliedTorque}
                  vCeiling={acceptedVmax}
                  torqueEnabled={torqueEnabled}
                />
              </CardContent>
            </Card>

            {/* 通信报文监视器卡片 */}
            <Card
              className={
                mobileTab === 'control' || mobileTab === 'params' || mobileTab === 'scope'
                  ? 'hidden lg:block'
                  : 'block'
              }
            >
              <CardHeader className="flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <CardTitle>通信报文监视器</CardTitle>
                  <Badge variant="neutral">TX / 0x82 应答常显</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none dark:text-slate-400">
                    <input
                      type="checkbox"
                      checked={showRaw0x81}
                      onChange={(e) => setShowRaw0x81(e.target.checked)}
                      className="accent-sky-600 rounded cursor-pointer"
                    />
                    <span>打印高频测量帧 (0x81)</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none dark:text-slate-400">
                    <input
                      type="checkbox"
                      checked={pauseLogScroll}
                      onChange={(e) => setPauseLogScroll(e.target.checked)}
                      className="accent-sky-600 rounded cursor-pointer"
                    />
                    <span>暂停滚动</span>
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLogs([])}
                  >
                    清空日志
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div
                  ref={logContainerRef}
                  className="h-44 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/90 p-3 font-mono text-[11px] leading-relaxed tnum shadow-inner dark:border-slate-800 dark:bg-slate-950"
                >
                  {logs.length === 0 ? (
                    <div className="text-slate-400">暂无报文记录...</div>
                  ) : (
                    logs.map((entry) => (
                      <div key={entry.id} className="mb-1 flex gap-2">
                        <span className="select-none text-slate-400">{entry.time}</span>
                        <span
                          className={`font-bold ${
                            entry.level === 'tx'
                              ? 'text-sky-600 dark:text-sky-400'
                              : entry.level === 'rx'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : entry.level === 'warn'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : entry.level === 'error'
                                    ? 'text-red-600 dark:text-red-400'
                                    : 'text-sky-600 dark:text-sky-400'
                          }`}
                        >
                          {entry.dir}
                        </span>
                        <span className="break-all text-slate-700 dark:text-slate-300">
                          {entry.content}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </main>

        {/* =================================================================
            3. 移动端 / 窄窗伴侣模式底部自适应导航栏 (< 1024px 显示)
           ================================================================= */}
        <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-slate-200 bg-white/95 px-2 py-1.5 backdrop-blur-md lg:hidden dark:border-slate-800 dark:bg-slate-900/95">
          <button
            type="button"
            onClick={() => setMobileTab('control')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-[11px] font-bold cursor-pointer ${
              mobileTab === 'control'
                ? 'text-sky-600 dark:text-sky-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Sliders className="h-4 w-4" />
            <span>主控台</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('scope')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-[11px] font-bold cursor-pointer ${
              mobileTab === 'scope'
                ? 'text-sky-600 dark:text-sky-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Monitor className="h-4 w-4" />
            <span>示波器</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('params')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-[11px] font-bold cursor-pointer ${
              mobileTab === 'params'
                ? 'text-sky-600 dark:text-sky-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Settings2 className="h-4 w-4" />
            <span>6参数/Flash</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('terminal')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-[11px] font-bold cursor-pointer ${
              mobileTab === 'terminal'
                ? 'text-sky-600 dark:text-sky-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Terminal className="h-4 w-4" />
            <span>报文终端</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
export default App;
