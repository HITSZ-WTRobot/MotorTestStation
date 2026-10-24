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
  Columns2,
  Radio,
  ShieldAlert,
  CheckCircle2,
  SlidersHorizontal,
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
import {
  OscilloscopeCanvas,
  type OscilloscopeHandle,
} from './components/OscilloscopeCanvas';

const VOLTAGE_PRESETS = [0.0, 3.3, 5.0, 8.0, 10.0, 12.0, 15.0, 18.0];
const TORQUE_PRESETS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0];

type BottomDockMode = 'split' | 'params' | 'bus';

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

  const [bottomDock, setBottomDock] = React.useState<BottomDockMode>('split');

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
        level === 'tx' ? 'TX' : level === 'rx' ? '0x81' : level === 'info' ? 'RSP' : level.toUpperCase();
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

    appendLog('info', '正在同步下位机控制状态与 6 项 RAM 参数...');
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
      setFlashSaveStatus({ text: 'RAM SYNCED', tone: 'idle' });
      appendLog('info', '已成功同步下位机全部状态与 6 项配置参数 (RAM)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('warn', `同步未完全完成: ${msg}`);
    }
  }, [appendLog, setAppliedTorque, setDraftTorque, setTorqueLimit, setRamParams, setDraftParams, setFlashSaveStatus]);

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
            `#${fb.seq} V=${fb.voltage.toFixed(3)}V T=${fb.torque.toFixed(3)}N·m | ${hex}`
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
          `#${resp.seq} ${resp.originalCmdName} → ${resp.resultName} [val=${resp.value.toFixed(4)} loop=${resp.torqueEnabled ? 'ON' : 'OFF'} fdb=${resp.feedbackValid ? 'OK' : 'WAIT'}] | ${hex}`
        );
      },
      onError: (err) => {
        appendLog('error', `CRCERR: ${err.error}`);
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
              ? 'DISCONNECTED (MCU OUTPUT RETAINED!)'
              : 'OFFLINE',
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
      'FIELD STUDIO READY · 14-Byte Little-Endian CRC16 Engine Initialized'
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
    appendLog('info', `扫描完成: 发现 ${ports.length} 个串口设备`);
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
            alert('未检测到物理串口，请插入 USB-TTL 适配器或点击【SIM 仿真】按钮测试。');
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
          `[GetState] 已选定扭矩目标=${fTarget.toFixed(3)} N·m, 闭环=${resp.torqueEnabled ? '开启' : '关闭'}, 反馈=${resp.feedbackValid ? '有效' : '未就绪'}`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `状态查询失败: ${msg}`);
    }
  };

  const sendTargetVoltage = React.useCallback(
    async (v: number) => {
      const reqQueue = reqQueueRef.current;
      if (!reqQueue) return false;
      const fVal = Math.fround(Math.max(0.0, Math.min(MAX_VOLTAGE, Number(v) || 0.0)));
      if (torqueEnabled && fVal > 0.0) {
        appendLog('warn', '拒绝下发：扭矩闭环开启中，禁止非零手动电压');
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
          appendLog('info', `电压目标生效: ${accepted.toFixed(2)} V`);
          return true;
        } else {
          appendLog('warn', `电压未生效: ${resp.resultName}`);
          return false;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog('error', `电压下发异常: ${msg}`);
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
        appendLog('info', `扭矩目标已接受: ${accepted.toFixed(3)} N·m`);
        return true;
      } else {
        appendLog('warn', `扭矩目标被拒绝: ${resp.resultName}`);
        return false;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `扭矩下发异常: ${msg}`);
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
          appendLog('warn', '扭矩目标下发失败，已中止闭环启动');
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
        appendLog('info', `扭矩闭环已${enable ? '【开启】' : '【关闭】'}`);
      } else {
        appendLog('warn', `闭环切换失败: ${resp.resultName}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `闭环切换异常: ${msg}`);
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

        const stResp = await reqQueue.enqueue(CommandType.GetState, (seq) =>
          encodeGetState(seq)
        );
        if (stResp.result === Result.Ok) {
          const clampedTarget = Math.fround(stResp.value);
          setAppliedTorque(clampedTarget);
          setDraftTorque(Number(clampedTarget.toFixed(3)));
        }
        appendLog('info', `扭矩上限已更新为: ${appliedLimit.toFixed(2)} N·m`);
      } else {
        appendLog('warn', `设置扭矩上限失败: ${resp.resultName}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `设置扭矩上限异常: ${msg}`);
    }
  };

  const handleApplyParamsToRam = async () => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue) return;
    appendLog('info', '正在将修改的参数写入下位机 RAM...');
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
            appendLog('info', `RAM 写入成功 [${meta.name} = ${appliedVal}]`);
          } else {
            appendLog('warn', `参数 ${meta.name} 写入被拒绝: ${resp.resultName}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog('error', `写入异常: ${msg}`);
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
      setFlashSaveStatus({ text: 'RAM APPLIED', tone: 'applied' });
    }
  };

  const handleSafeSaveFlash = async () => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue || !connStatus.connected) {
      alert('请先连接硬件串口或启动 SIM 仿真模式');
      return;
    }

    setFlashSaveStatus({ text: 'BURNING FLASH...', tone: 'saving' });
    let step = 'stop';

    try {
      appendLog('info', '[FLASH 1/4] 下发 0V 停机指令并关闭闭环...');
      const stopResp = await reqQueue.enqueue(CommandType.SetVoltage, (seq) =>
        encodeSetVoltage(0.0, seq)
      );
      if (stopResp.result !== Result.Ok) {
        throw new Error(`停机前置失败: ${stopResp.resultName}`);
      }
      setAppliedVoltage(0.0);
      setTorqueEnabled(false);

      step = 'write_ram';
      appendLog('info', '[FLASH 2/4] 同步全部待修改参数至 RAM...');
      let limitChanged = false;
      for (const meta of PARAMETER_META_LIST) {
        const fVal = Math.fround(parseFloat(draftParams[meta.id] ?? ''));
        if (Number.isFinite(fVal) && Math.abs(fVal - (ramParams[meta.id] ?? 0)) > 1e-6) {
          const pResp = await reqQueue.enqueue(CommandType.SetParameter, (seq) =>
            encodeSetParameter(meta.id, fVal, seq)
          );
          if (pResp.result !== Result.Ok) {
            throw new Error(`参数 ${meta.name} 写入失败: ${pResp.resultName}`);
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
      appendLog('info', '[FLASH 3/4] 执行 SaveParameters (0x12) 扇区写入...');
      const saveResp = await reqQueue.enqueue(
        CommandType.SaveParameters,
        (seq) => encodeSaveParameters(seq),
        3000
      );

      const storageCode = Math.round(saveResp.value);
      const storageMsg = StorageCodeNames[storageCode] || `Code ${storageCode}`;

      if (saveResp.result === Result.Ok && storageCode === 0) {
        appendLog('info', `[FLASH 4/4] ✓ Flash 烧录校验成功 (${storageMsg})`);
        setFlashSaveStatus({ text: 'FLASH VERIFIED', tone: 'saved' });
      } else {
        throw new Error(`存储返回错误: ${saveResp.resultName} / ${storageMsg}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `Flash 保存中断: ${msg}`);
      if (step === 'save_flash' && msg.includes('Timeout')) {
        setFlashSaveStatus({ text: 'UNKNOWN (CHECK)', tone: 'unknown' });
      } else {
        setFlashSaveStatus({ text: 'BURN FAILED', tone: 'error' });
      }
    }
  };

  const handleExportCsv = () => {
    const csv = scopeRef.current?.exportCsv();
    if (!csv) {
      alert('当前无采样波形数据');
      return;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stm32_telemetry_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    appendLog('info', '已导出 CSV 遥测报表');
  };

  const acceptedVff = appliedTorque > 0 ? Math.min(appliedTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const acceptedVmax = appliedTorque > 0 ? Math.min(acceptedVff + 0.5, MAX_VOLTAGE) : 0.0;

  const draftVff = draftTorque > 0 ? Math.min(draftTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const draftVmax = draftTorque > 0 ? Math.min(draftVff + 0.5, MAX_VOLTAGE) : 0.0;

  const isVoltageSynced = Math.abs(draftVoltage - appliedVoltage) < 0.005;
  const isTorqueSynced = Math.abs(draftTorque - appliedTorque) < 0.001;

  const vCellsActive = Math.round((telemetry.voltage / MAX_VOLTAGE) * 16);
  const tCellsActive = Math.round((telemetry.torque / Math.max(0.1, torqueLimit)) * 16);

  const isDark = theme === 'dark';

  return (
    <div className={isDark ? 'dark' : ''}>
      <div
        className={`min-h-screen lg:h-screen lg:overflow-hidden flex flex-col transition-colors duration-150 ${
          isDark
            ? 'studio-surface-dark text-slate-100'
            : 'studio-surface-light text-slate-900'
        }`}
      >
        {/* =====================================================================
            TOP INSTRUMENT DECK: BRAND + INTEGRATED DIGITAL TELEMETRY + LINK/KILL
           ===================================================================== */}
        <header className="shrink-0 border-b border-slate-300/90 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-[#0d111a]/95">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            {/* 1. Brand & Architecture Tag */}
            <div className="flex items-center gap-2.5 pr-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600 text-white shadow-xs">
                <Cpu className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-black tracking-wider uppercase text-slate-900 dark:text-white">
                    FIELD STUDIO // STM32
                  </span>
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[9px] font-bold text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                    {platformInfo.isTauri ? platformInfo.os.toUpperCase() : 'WEB'}
                  </span>
                </div>
                <div className="font-mono text-[10px] text-slate-400">
                  100Hz TIM3 LOOP · 14B CRC16 · VMAX=VFF+0.5V
                </div>
              </div>
            </div>

            {/* 2. Integrated Dual-Channel Digital Readout Strip (Teenage Engineering / Keysight Style) */}
            <div className="flex flex-1 flex-wrap items-center justify-center gap-2 lg:gap-3">
              {/* CH-01 VOLTAGE READOUT MODULE */}
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-1.5 shadow-2xs dark:border-slate-800 dark:bg-[#131926]">
                <div>
                  <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-sky-600 dark:text-sky-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                    CH-01 // VOLTAGE
                  </div>
                  <div className="flex items-baseline gap-1 font-mono tnum">
                    <span className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                      {telemetry.voltage.toFixed(3)}
                    </span>
                    <span className="text-xs font-bold text-sky-600 dark:text-sky-400">V</span>
                  </div>
                </div>
                <div className="hidden sm:flex flex-col gap-1 border-l border-slate-200 pl-3 dark:border-slate-800">
                  {/* 16-Segment LED Bargraph */}
                  <div className="flex gap-0.5">
                    {Array.from({ length: 16 }).map((_, idx) => (
                      <span
                        key={idx}
                        className={`h-2.5 w-1 rounded-[1px] transition-colors ${
                          idx < vCellsActive
                            ? idx > 13
                              ? 'bg-red-500'
                              : 'bg-sky-500'
                            : 'bg-slate-200 dark:bg-slate-800'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2 font-mono text-[9px] text-slate-500 tnum">
                    <span>MIN:{telemetry.vMin === null ? '--' : telemetry.vMin.toFixed(2)}</span>
                    <span>MAX:{telemetry.vMax === null ? '--' : telemetry.vMax.toFixed(2)}</span>
                    <span className="text-sky-600 dark:text-sky-400 font-bold">
                      SET:{appliedVoltage.toFixed(2)}V
                    </span>
                  </div>
                </div>
              </div>

              {/* CH-02 TORQUE READOUT MODULE */}
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-1.5 shadow-2xs dark:border-slate-800 dark:bg-[#131926]">
                <div>
                  <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    CH-02 // TORQUE
                  </div>
                  <div className="flex items-baseline gap-1 font-mono tnum">
                    <span className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                      {telemetry.torque.toFixed(3)}
                    </span>
                    <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                      N·m
                    </span>
                  </div>
                </div>
                <div className="hidden sm:flex flex-col gap-1 border-l border-slate-200 pl-3 dark:border-slate-800">
                  <div className="flex gap-0.5">
                    {Array.from({ length: 16 }).map((_, idx) => (
                      <span
                        key={idx}
                        className={`h-2.5 w-1 rounded-[1px] transition-colors ${
                          idx < tCellsActive
                            ? idx > 13
                              ? 'bg-red-500'
                              : 'bg-amber-500'
                            : 'bg-slate-200 dark:bg-slate-800'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2 font-mono text-[9px] text-slate-500 tnum">
                    <span>PK:{telemetry.tMax === null ? '--' : telemetry.tMax.toFixed(2)}</span>
                    <span>LIM:{torqueLimit.toFixed(2)}</span>
                    <span
                      className={`font-bold ${
                        torqueEnabled
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {torqueEnabled ? 'LOOP:ON' : 'LOOP:OFF'}
                    </span>
                  </div>
                </div>
              </div>

              {/* BUS METRICS PILL */}
              <div className="hidden xl:grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-1.5 font-mono text-[10px] tnum dark:border-slate-800 dark:bg-[#131926]">
                <span className="text-slate-500">
                  RX: <strong className="text-emerald-600 dark:text-emerald-400">{telemetry.rxFrames}</strong>
                </span>
                <span className="text-slate-500">
                  TX: <strong className="text-sky-600 dark:text-sky-400">{telemetry.txFrames}</strong>
                </span>
                <span className="text-slate-500">
                  FPS: <strong className="text-slate-800 dark:text-slate-200">{telemetry.fps}Hz</strong>
                </span>
                <span className="text-slate-500">
                  CRC:{' '}
                  <strong className={telemetry.crcErrors > 0 ? 'text-red-600' : 'text-slate-400'}>
                    {telemetry.crcErrors}
                  </strong>
                </span>
              </div>
            </div>

            {/* 3. Hardware Link & Kill Switch Deck */}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Status Pill */}
              <div
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-bold tnum ${
                  connStatus.warning
                    ? 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                    : connStatus.connected
                      ? 'border-emerald-300 bg-emerald-50/90 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-400'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    !connStatus.connected
                      ? 'bg-red-500'
                      : connStatus.mode === 'mock'
                        ? 'bg-amber-500 animate-pulse'
                        : 'bg-emerald-500 animate-pulse'
                  }`}
                />
                <span className="max-w-[160px] truncate">{connStatus.label}</span>
              </div>

              {platformInfo.isTauri && (
                <div className="flex items-center gap-1">
                  <select
                    value={selectedPort}
                    onChange={(e) => setSelectedPort(e.target.value)}
                    disabled={connStatus.connected}
                    title="选择物理串口"
                    className="h-8 rounded-md border border-slate-200 bg-white px-2 font-mono text-xs text-slate-800 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  >
                    {serialPorts.length === 0 ? (
                      <option value="">NO PORT</option>
                    ) : (
                      serialPorts.map((p) => (
                        <option key={p.portName} value={p.portName}>
                          {p.label}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={handleRefreshPorts}
                    disabled={connStatus.connected}
                    title="扫描系统串口"
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:border-sky-400 hover:text-sky-600 cursor-pointer disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <select
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value))}
                disabled={connStatus.connected}
                title="波特率"
                className="h-8 rounded-md border border-slate-200 bg-white px-2 font-mono text-xs tnum text-slate-800 outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value={115200}>115200</option>
                <option value={921600}>921600</option>
                <option value={460800}>460800</option>
                <option value={230400}>230400</option>
              </select>

              {!connStatus.connected || connStatus.mode === 'mock' ? (
                <button
                  type="button"
                  onClick={handleConnectHardware}
                  className="flex h-8 items-center gap-1 rounded-md bg-sky-600 px-3 text-xs font-bold text-white shadow-2xs hover:bg-sky-700 cursor-pointer"
                >
                  <Zap className="h-3.5 w-3.5" />
                  连接硬件
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="flex h-8 items-center gap-1 rounded-md border border-red-300 bg-red-50 px-3 text-xs font-bold text-red-700 hover:bg-red-100 cursor-pointer dark:border-red-500/40 dark:bg-red-950/50 dark:text-red-300"
                >
                  断开
                </button>
              )}

              <button
                type="button"
                onClick={handleToggleMock}
                className={`flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-bold cursor-pointer ${
                  connStatus.mode === 'mock'
                    ? 'border-amber-500 bg-amber-500 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-sky-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                }`}
              >
                <Radio className="h-3.5 w-3.5" />
                {connStatus.mode === 'mock' ? '停止仿真' : 'SIM 仿真'}
              </button>

              <button
                type="button"
                onClick={() => setTheme(isDark ? 'cleanroom' : 'dark')}
                title="切换明暗仪器主题"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:text-sky-600 cursor-pointer dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                {isDark ? <Sun className="h-3.5 w-3.5 text-amber-400" /> : <Moon className="h-3.5 w-3.5" />}
              </button>

              {/* GLOBAL KILL SWITCH (0V STOP) */}
              <button
                type="button"
                onClick={() => {
                  updateVoltageDraft(0.0, true);
                  appendLog('warn', '【全局急停触发】发送 SetVoltage(0.0V) 停止输出并脱离闭环');
                }}
                className="flex h-8 items-center gap-1 rounded-md bg-red-600 px-3 font-mono text-xs font-black tracking-wider text-white shadow-xs hover:bg-red-700 active:scale-95 cursor-pointer"
              >
                <OctagonAlert className="h-3.5 w-3.5" />
                STOP 0V
              </button>
            </div>
          </div>
        </header>

        {/* =====================================================================
            MAIN STUDIO WORKBENCH (NON-SCROLLING SPLIT VIEW ON DESKTOP)
           ===================================================================== */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_400px] xl:grid-cols-[1fr_430px] pb-14 lg:pb-0">
          {/* -------------------------------------------------------------------
              LEFT / CENTER STAGE: FULL-BLEED OSCILLOSCOPE + BOTTOM RACK BAY
             ------------------------------------------------------------------- */}
          <div className="flex flex-col min-h-0 border-r border-slate-300/90 dark:border-slate-800">
            {/* A. CENTER STAGE: DSO OSCILLOSCOPE */}
            <div
              className={`flex-1 min-h-[300px] flex flex-col bg-white dark:bg-[#080b11] ${
                mobileTab === 'control' || mobileTab === 'params' || mobileTab === 'terminal'
                  ? 'hidden lg:flex'
                  : 'flex'
              }`}
            >
              {/* Oscilloscope Studio Ribbon */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/90 px-3 py-1.5 dark:border-slate-800 dark:bg-[#0d111a]">
                <div className="flex items-center gap-2">
                  <Activity className="h-3.5 w-3.5 text-sky-600" />
                  <span className="font-mono text-[11px] font-extrabold uppercase tracking-wider text-slate-700 dark:text-slate-200">
                    DSO // DUAL-CHANNEL WAVEFORM ANALYZER
                  </span>
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[9px] font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                    60 FPS
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Timebase Selector Pill Bar */}
                  <div className="flex rounded-md border border-slate-200 bg-white p-0.5 dark:border-slate-800 dark:bg-slate-900">
                    {[250, 500, 1000, 2000].map((pts) => (
                      <button
                        key={pts}
                        type="button"
                        onClick={() =>
                          setScopeConfig((prev) => ({ ...prev, maxPoints: pts }))
                        }
                        className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold cursor-pointer transition-colors ${
                          scopeConfig.maxPoints === pts
                            ? 'bg-sky-600 text-white'
                            : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                        }`}
                      >
                        {pts}P
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setScopeConfig((prev) => ({
                        ...prev,
                        showTargetRef: !prev.showTargetRef,
                      }))
                    }
                    className={`rounded-md border px-2 py-1 font-mono text-[10px] font-bold cursor-pointer ${
                      scopeConfig.showTargetRef
                        ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-950/50 dark:text-sky-300'
                        : 'border-slate-200 bg-white text-slate-500 dark:border-slate-800 dark:bg-slate-900'
                    }`}
                  >
                    REF LINES: {scopeConfig.showTargetRef ? 'ON' : 'OFF'}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setScopeConfig((prev) => ({ ...prev, isPaused: !prev.isPaused }))
                    }
                    className={`flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] font-bold cursor-pointer ${
                      scopeConfig.isPaused
                        ? 'border-amber-400 bg-amber-500 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-sky-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200'
                    }`}
                  >
                    {scopeConfig.isPaused ? (
                      <>
                        <Play className="h-3 w-3" /> RUN
                      </>
                    ) : (
                      <>
                        <Pause className="h-3 w-3" /> HOLD
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      scopeRef.current?.clear();
                      setTelemetry((prev) => ({
                        ...prev,
                        vMin: null,
                        vMax: null,
                        tMax: null,
                      }));
                    }}
                    className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] font-bold text-slate-600 hover:text-red-600 cursor-pointer dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
                  >
                    <Trash2 className="h-3 w-3" /> CLR
                  </button>

                  <button
                    type="button"
                    onClick={handleExportCsv}
                    className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] font-bold text-slate-600 hover:text-sky-600 cursor-pointer dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
                  >
                    <Download className="h-3 w-3" /> CSV
                  </button>
                </div>
              </div>

              {/* Full-bleed Canvas */}
              <div className="flex-1 min-h-0 relative">
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
              </div>
            </div>

            {/* B. BOTTOM STUDIO RACK: 6-CHANNEL PARAMETER SYNTH MATRIX & PACKET BUS */}
            <div
              className={`shrink-0 lg:h-[255px] border-t border-slate-300/90 bg-slate-100/90 flex flex-col dark:border-slate-800 dark:bg-[#0b0f17] ${
                mobileTab === 'control' || mobileTab === 'scope'
                  ? 'hidden lg:flex'
                  : 'flex'
              }`}
            >
              {/* Rack Mode Bar */}
              <div className="flex items-center justify-between border-b border-slate-200/90 bg-white px-3 py-1 dark:border-slate-800 dark:bg-[#101520]">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setBottomDock('split')}
                    className={`hidden xl:inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] font-bold cursor-pointer ${
                      bottomDock === 'split'
                        ? 'bg-slate-900 text-white dark:bg-sky-600'
                        : 'text-slate-500 hover:text-slate-900 dark:text-slate-400'
                    }`}
                  >
                    <Columns2 className="h-3 w-3" />
                    SPLIT RACK
                  </button>
                  <button
                    type="button"
                    onClick={() => setBottomDock('params')}
                    className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] font-bold cursor-pointer ${
                      bottomDock === 'params'
                        ? 'bg-slate-900 text-white dark:bg-sky-600'
                        : 'text-slate-500 hover:text-slate-900 dark:text-slate-400'
                    }`}
                  >
                    <SlidersHorizontal className="h-3 w-3" />
                    6-CH MCU PARAMETER RACK
                  </button>
                  <button
                    type="button"
                    onClick={() => setBottomDock('bus')}
                    className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] font-bold cursor-pointer ${
                      bottomDock === 'bus'
                        ? 'bg-slate-900 text-white dark:bg-sky-600'
                        : 'text-slate-500 hover:text-slate-900 dark:text-slate-400'
                    }`}
                  >
                    <Terminal className="h-3 w-3" />
                    14B PACKET BUS ({logs.length})
                  </button>
                </div>

                {/* Parameter Actions & Flash Status */}
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                      flashSaveStatus.tone === 'saved'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
                        : flashSaveStatus.tone === 'error'
                          ? 'bg-red-100 text-red-700'
                          : flashSaveStatus.tone === 'dirty' ||
                              flashSaveStatus.tone === 'saving' ||
                              flashSaveStatus.tone === 'unknown'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                    }`}
                  >
                    {flashSaveStatus.text}
                  </span>
                  <button
                    type="button"
                    onClick={syncDeviceState}
                    className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[10px] font-bold text-slate-700 hover:border-sky-400 hover:text-sky-600 cursor-pointer dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    <DownloadCloud className="h-3 w-3" /> READ RAM
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyParamsToRam}
                    className="flex items-center gap-1 rounded bg-sky-600 px-2 py-0.5 font-mono text-[10px] font-bold text-white hover:bg-sky-700 cursor-pointer"
                  >
                    <Upload className="h-3 w-3" /> WRITE RAM
                  </button>
                  <button
                    type="button"
                    onClick={handleSafeSaveFlash}
                    disabled={flashSaveStatus.tone === 'saving'}
                    className="flex items-center gap-1 rounded border border-sky-600 bg-sky-50 px-2.5 py-0.5 font-mono text-[10px] font-extrabold text-sky-700 hover:bg-sky-600 hover:text-white cursor-pointer dark:bg-sky-950/60 dark:text-sky-300"
                  >
                    <Save className="h-3 w-3" /> SAFE BURN FLASH
                  </button>
                </div>
              </div>

              {/* Rack Body */}
              <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-12 overflow-hidden">
                {/* 1) 6-Channel Synthesizer Parameter Strips */}
                <div
                  className={`${
                    bottomDock === 'bus'
                      ? 'hidden'
                      : bottomDock === 'params'
                        ? 'xl:col-span-12'
                        : 'xl:col-span-7'
                  } p-2.5 overflow-y-auto border-r border-slate-200/80 dark:border-slate-800`}
                >
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 h-full">
                    {PARAMETER_META_LIST.map((meta) => {
                      const currentRam = ramParams[meta.id] ?? meta.defaultVal;
                      const draftStr = draftParams[meta.id] ?? currentRam.toFixed(meta.decimals);
                      const fDraft = Math.fround(parseFloat(draftStr));
                      const isDirty =
                        Number.isFinite(fDraft) && Math.abs(fDraft - currentRam) > 1e-6;

                      return (
                        <div
                          key={meta.id}
                          className={`flex flex-col justify-between rounded-lg border p-2.5 transition-all ${
                            isDirty
                              ? 'border-amber-400 bg-amber-50/60 dark:border-amber-500/60 dark:bg-amber-950/20'
                              : 'border-slate-200/90 bg-white dark:border-slate-800 dark:bg-[#131924]'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[10px] font-black text-slate-400">
                                CH-0{meta.id}
                              </span>
                              <span
                                className={`h-2 w-2 rounded-full ${
                                  isDirty ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'
                                }`}
                                title={isDirty ? '本地已修改 (待写入RAM)' : '与下位机RAM一致'}
                              />
                            </div>
                            <div className="mt-0.5 font-mono text-xs font-extrabold text-slate-900 dark:text-white truncate">
                              {meta.name}
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-400 leading-tight line-clamp-2">
                              {meta.description}
                            </div>
                          </div>

                          <div className="mt-2 space-y-1.5">
                            <div className="flex items-center justify-between rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] tnum dark:bg-slate-800/90">
                              <span className="text-slate-400">RAM</span>
                              <strong className="text-sky-600 dark:text-sky-400">
                                {currentRam.toFixed(meta.decimals)}
                              </strong>
                            </div>
                            <input
                              type="number"
                              step={meta.step}
                              min={meta.min}
                              value={draftStr}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDraftParams((prev) => ({ ...prev, [meta.id]: val }));
                                setFlashSaveStatus({ text: 'UNSAVED EDIT', tone: 'dirty' });
                              }}
                              className="h-8 w-full rounded border border-slate-300 bg-slate-50 px-1.5 text-right font-mono text-xs font-black tnum text-slate-900 outline-none focus:border-sky-500 focus:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2) 14-Byte Packet Bus Stream */}
                <div
                  className={`${
                    bottomDock === 'params'
                      ? 'hidden'
                      : bottomDock === 'bus'
                        ? 'xl:col-span-12'
                        : 'xl:col-span-5'
                  } flex flex-col min-h-0 bg-[#f8fafc] dark:bg-[#070a10]`}
                >
                  <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-1 text-[10px] font-mono dark:border-slate-800">
                    <span className="font-bold text-slate-500">
                      BUS STREAM // TX &amp; 0x82 ALWAYS ON
                    </span>
                    <div className="flex items-center gap-2.5">
                      <label className="flex items-center gap-1 text-slate-500 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showRaw0x81}
                          onChange={(e) => setShowRaw0x81(e.target.checked)}
                          className="accent-sky-600"
                        />
                        <span>0x81 STREAM</span>
                      </label>
                      <label className="flex items-center gap-1 text-slate-500 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pauseLogScroll}
                          onChange={(e) => setPauseLogScroll(e.target.checked)}
                          className="accent-sky-600"
                        />
                        <span>HOLD</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setLogs([])}
                        className="text-slate-400 hover:text-red-500 cursor-pointer font-bold"
                      >
                        CLR
                      </button>
                    </div>
                  </div>
                  <div
                    ref={logContainerRef}
                    className="flex-1 overflow-y-auto p-2 font-mono text-[10.5px] leading-relaxed tnum"
                  >
                    {logs.length === 0 ? (
                      <div className="text-slate-400">Bus idle...</div>
                    ) : (
                      logs.map((entry) => (
                        <div
                          key={entry.id}
                          className="mb-1 flex items-baseline gap-1.5 border-b border-slate-200/40 pb-0.5 dark:border-slate-800/40"
                        >
                          <span className="shrink-0 text-[9.5px] text-slate-400">
                            {entry.time}
                          </span>
                          <span
                            className={`shrink-0 rounded px-1 py-0.2 text-[9px] font-black ${
                              entry.level === 'tx'
                                ? 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'
                                : entry.level === 'rx'
                                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                                  : entry.level === 'warn'
                                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
                                    : entry.level === 'error'
                                      ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
                                      : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
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
                </div>
              </div>
            </div>
          </div>

          {/* -------------------------------------------------------------------
              RIGHT INSPECTOR DOCK: TACTILE DRIVE CONTROLLER (VOLTAGE / TORQUE)
             ------------------------------------------------------------------- */}
          <aside
            className={`flex flex-col min-h-0 bg-white dark:bg-[#0d111a] overflow-y-auto ${
              mobileTab === 'scope' || mobileTab === 'params' || mobileTab === 'terminal'
                ? 'hidden lg:flex'
                : 'flex'
            }`}
          >
            {/* 1. Machined Anodized Mode Switcher */}
            <div className="border-b border-slate-200 p-3 dark:border-slate-800">
              <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <span>ACTIVE CONTROL ARCHITECTURE</span>
                <button
                  type="button"
                  onClick={handleQueryState}
                  disabled={!connStatus.connected}
                  className="text-sky-600 hover:underline cursor-pointer disabled:opacity-40"
                >
                  ↻ SYNC STATE (0x13)
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-slate-200/80 p-1 dark:bg-slate-950">
                <button
                  type="button"
                  onClick={() => setActiveMode('voltage')}
                  className={`flex items-center justify-center gap-1.5 rounded-lg py-2.5 font-mono text-xs font-black tracking-wide transition-all cursor-pointer ${
                    activeMode === 'voltage'
                      ? 'bg-sky-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`}
                >
                  <Zap className="h-3.5 w-3.5" />
                  VOLTAGE OPEN-LOOP
                </button>
                <button
                  type="button"
                  onClick={() => setActiveMode('torque')}
                  className={`flex items-center justify-center gap-1.5 rounded-lg py-2.5 font-mono text-xs font-black tracking-wide transition-all cursor-pointer ${
                    activeMode === 'torque'
                      ? 'bg-amber-500 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`}
                >
                  <Target className="h-3.5 w-3.5" />
                  TORQUE CLOSED-LOOP
                </button>
              </div>
            </div>

            {/* 2. Mode Inspector Body */}
            {activeMode === 'voltage' ? (
              <div className="flex-1 flex flex-col justify-between p-4 space-y-4">
                <div className="space-y-4">
                  {/* Setpoint vs Accepted Digital Readout Box */}
                  <div className="rounded-xl border border-slate-200 bg-slate-900 p-3.5 text-white shadow-inner dark:border-slate-800 dark:bg-[#06080d]">
                    <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                      <span>OPEN-LOOP VOLTAGE COMMAND</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                          isVoltageSynced
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        }`}
                      >
                        {isVoltageSynced ? '● MCU SYNCED' : '◐ DRAFT UNSENT'}
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline justify-between font-mono tnum">
                      <div>
                        <div className="text-[10px] text-slate-400">DRAFT SETPOINT</div>
                        <div className="text-3xl font-black text-sky-400">
                          {draftVoltage.toFixed(2)} <span className="text-sm">V</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-slate-400">MCU ACCEPTED</div>
                        <div className="text-xl font-bold text-slate-200">
                          {appliedVoltage.toFixed(2)} <span className="text-xs">V</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Hardware Interlock Banner when Torque Loop is Active */}
                  {torqueEnabled && (
                    <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 dark:bg-amber-950/40">
                      <div className="flex items-center gap-2 font-mono text-xs font-black text-amber-900 dark:text-amber-200">
                        <Lock className="h-4 w-4 text-amber-600" />
                        CLOSED-LOOP INTERLOCK ACTIVE
                      </div>
                      <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
                        扭矩闭环正在运行中，下位机硬件拒绝任何非零手动电压指令 (ModeConflict)。请先切换至扭矩模式关闭闭环，或点击下方 0V 停机。
                      </p>
                    </div>
                  )}

                  {/* Parameter 1: Linear Fader & 8-Key Preset Matrix */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 dark:border-slate-800 dark:bg-[#121722]">
                    <div className="mb-2 flex items-center justify-between font-mono text-[11px] font-bold">
                      <span className="text-slate-700 dark:text-slate-200">
                        PARAM 01 // TARGET VOLTAGE
                      </span>
                      <span className="text-sky-600 dark:text-sky-400">0.0 ~ 18.0 V</span>
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
                        className="studio-fader-blue w-full bg-slate-200 dark:bg-slate-800"
                      />
                    </div>
                    <div className="mt-2.5 grid grid-cols-4 gap-1.5">
                      {VOLTAGE_PRESETS.map((v) => {
                        const active = Math.abs(draftVoltage - v) < 0.05;
                        return (
                          <button
                            key={v}
                            type="button"
                            disabled={torqueEnabled}
                            onClick={() => updateVoltageDraft(v, autoSyncVoltage)}
                            className={`rounded-lg border py-2 font-mono text-xs font-bold tnum transition-all cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
                              active
                                ? 'border-sky-600 bg-sky-600 text-white shadow-xs'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-sky-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                            }`}
                          >
                            {v.toFixed(1)}V
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Parameter 2: CNC Step Increment Matrix */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 dark:border-slate-800 dark:bg-[#121722]">
                    <div className="mb-2 flex items-center justify-between font-mono text-[11px] font-bold">
                      <span className="text-slate-700 dark:text-slate-200">
                        PARAM 02 // CNC STEP JOGGER
                      </span>
                      <span className="text-slate-400">FINE DELTA</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={torqueEnabled}
                        onClick={() => updateVoltageDraft(draftVoltage - 0.2, autoSyncVoltage)}
                        className="h-10 w-16 rounded-lg border border-slate-300 bg-white font-mono text-xs font-black hover:border-sky-500 hover:text-sky-600 cursor-pointer disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900"
                      >
                        -0.2V
                      </button>
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
                        className="h-10 flex-1 rounded-lg border border-slate-300 bg-white text-center font-mono text-base font-black tnum outline-none focus:border-sky-500 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
                      />
                      <button
                        type="button"
                        disabled={torqueEnabled}
                        onClick={() => updateVoltageDraft(draftVoltage + 0.2, autoSyncVoltage)}
                        className="h-10 w-16 rounded-lg border border-slate-300 bg-white font-mono text-xs font-black hover:border-sky-500 hover:text-sky-600 cursor-pointer disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900"
                      >
                        +0.2V
                      </button>
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
                          className="rounded-md border border-slate-200 bg-white py-1.5 font-mono text-[11px] font-bold text-slate-600 hover:border-sky-400 hover:text-sky-600 cursor-pointer disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                        >
                          {delta > 0 ? `+${delta.toFixed(1)}V` : `${delta.toFixed(1)}V`}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Auto-Sync Switch */}
                  <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 cursor-pointer dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                    <span>滑块/步进调节时实时自动下发 (20Hz 节流)</span>
                    <input
                      type="checkbox"
                      checked={autoSyncVoltage}
                      onChange={(e) => setAutoSyncVoltage(e.target.checked)}
                      className="h-4 w-4 accent-sky-600 cursor-pointer"
                    />
                  </label>
                </div>

                {/* Bottom Action Triggers */}
                <div className="grid grid-cols-2 gap-2.5 pt-2">
                  <button
                    type="button"
                    disabled={torqueEnabled}
                    onClick={() => sendTargetVoltage(draftVoltage)}
                    className="flex h-11 items-center justify-center gap-2 rounded-xl bg-sky-600 font-mono text-xs font-black text-white shadow-sm hover:bg-sky-700 cursor-pointer disabled:opacity-45 disabled:pointer-events-none"
                  >
                    {torqueEnabled ? (
                      <>
                        <Lock className="h-4 w-4" />
                        LOCKED BY LOOP
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4" />
                        TRANSMIT VOLTAGE
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      updateVoltageDraft(0.0, true);
                      appendLog('warn', '【软件停机】发送 0.00V 停止输出');
                    }}
                    className="flex h-11 items-center justify-center gap-2 rounded-xl bg-red-600 font-mono text-xs font-black text-white shadow-sm hover:bg-red-700 cursor-pointer"
                  >
                    <OctagonAlert className="h-4 w-4" />
                    SOFTWARE STOP (0V)
                  </button>
                </div>
              </div>
            ) : (
              /* ================= TORQUE CLOSED-LOOP INSPECTOR ================= */
              <div className="flex-1 flex flex-col justify-between p-4 space-y-3.5">
                <div className="space-y-3.5">
                  {/* Setpoint vs Accepted Digital LCD Box */}
                  <div className="rounded-xl border border-slate-200 bg-slate-900 p-3.5 text-white shadow-inner dark:border-slate-800 dark:bg-[#06080d]">
                    <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                      <span className="flex items-center gap-1.5">
                        {torqueEnabled ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <ShieldAlert className="h-3.5 w-3.5 text-slate-400" />
                        )}
                        {torqueEnabled ? 'LOOP ENGAGED (100Hz)' : 'LOOP STANDBY'}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                          isTorqueSynced
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        }`}
                      >
                        {isTorqueSynced ? '● MCU ACCEPTED' : '◐ DRAFT UNSENT'}
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline justify-between font-mono tnum">
                      <div>
                        <div className="text-[10px] text-slate-400">DRAFT TORQUE</div>
                        <div className="text-3xl font-black text-amber-400">
                          {draftTorque.toFixed(3)} <span className="text-sm">N·m</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-slate-400">MCU ACCEPTED</div>
                        <div className="text-xl font-bold text-slate-200">
                          {appliedTorque.toFixed(3)} <span className="text-xs">N·m</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 2-Stage Feedforward & Dynamic Ceiling Analyzer (Vff + 0.5V) */}
                  <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-500/30 dark:bg-sky-950/20">
                    <div className="flex items-center justify-between font-mono text-[10px] font-bold">
                      <span className="text-sky-900 dark:text-sky-300">
                        DYNAMIC CEILING // Vmax = Vff + 0.5V
                      </span>
                      <span className="rounded bg-sky-200/70 px-1.5 py-0.5 text-sky-800 dark:bg-sky-500/30 dark:text-sky-200">
                        1V ⇋ 0.5 N·m
                      </span>
                    </div>

                    {/* Visual 2-Stage Bar (Vff base + 0.5V margin out of 18V) */}
                    <div className="my-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-200 flex dark:bg-slate-800">
                      <div
                        className="h-full bg-sky-500 transition-all duration-150"
                        style={{ width: `${(acceptedVff / MAX_VOLTAGE) * 100}%` }}
                        title={`前馈基准 Vff: ${acceptedVff.toFixed(2)}V`}
                      />
                      <div
                        className="h-full bg-amber-500 transition-all duration-150"
                        style={{
                          width: `${((acceptedVmax - acceptedVff) / MAX_VOLTAGE) * 100}%`,
                        }}
                        title={`PID 动态上浮裕量: +${(acceptedVmax - acceptedVff).toFixed(2)}V`}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2 font-mono tnum">
                      <div className="rounded-lg border border-sky-200/80 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                        <span className="block text-[9px] text-slate-400">
                          FEEDFORWARD (Vff)
                        </span>
                        <span className="text-sm font-black text-sky-600 dark:text-sky-400">
                          {acceptedVff.toFixed(2)} V
                        </span>
                      </div>
                      <div className="rounded-lg border border-sky-200/80 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                        <span className="block text-[9px] text-slate-400">
                          VOLTAGE CEILING (Vmax)
                        </span>
                        <span className="text-sm font-black text-amber-600 dark:text-amber-400">
                          {acceptedVmax.toFixed(2)} V
                        </span>
                      </div>
                    </div>

                    {!isTorqueSynced && (
                      <div className="mt-2 rounded bg-amber-100/90 px-2 py-1 font-mono text-[10px] font-bold text-amber-900 tnum dark:bg-amber-950/60 dark:text-amber-300">
                        ▸ 待下发预览 ({draftTorque.toFixed(2)} N·m): Vff={draftVff.toFixed(2)}V, Vmax={draftVmax.toFixed(2)}V
                      </div>
                    )}
                  </div>

                  {/* Parameter 1: Torque Setpoint Fader & Presets */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-[#121722]">
                    <div className="mb-1.5 flex items-center justify-between font-mono text-[11px] font-bold">
                      <span className="text-slate-700 dark:text-slate-200">
                        PARAM 01 // TORQUE SETPOINT
                      </span>
                      <span className="text-amber-600">0.0 ~ {torqueLimit.toFixed(1)} N·m</span>
                    </div>
                    <div className="py-1.5">
                      <input
                        type="range"
                        min={0}
                        max={torqueLimit}
                        step={0.05}
                        value={draftTorque}
                        onChange={(e) => updateTorqueDraft(parseFloat(e.target.value), false)}
                        className="studio-fader-orange w-full bg-slate-200 dark:bg-slate-800"
                      />
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => updateTorqueDraft(draftTorque - 0.1, false)}
                        className="h-9 w-14 rounded-lg border border-slate-300 bg-white font-mono text-xs font-black hover:border-amber-500 cursor-pointer dark:border-slate-700 dark:bg-slate-900"
                      >
                        -0.1
                      </button>
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
                        className="h-9 flex-1 rounded-lg border border-slate-300 bg-white text-center font-mono text-sm font-black tnum outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-900"
                      />
                      <button
                        type="button"
                        onClick={() => updateTorqueDraft(draftTorque + 0.1, false)}
                        className="h-9 w-14 rounded-lg border border-slate-300 bg-white font-mono text-xs font-black hover:border-amber-500 cursor-pointer dark:border-slate-700 dark:bg-slate-900"
                      >
                        +0.1
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1.5">
                      {TORQUE_PRESETS.map((t) => {
                        const active = Math.abs(draftTorque - t) < 0.05;
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => updateTorqueDraft(t, false)}
                            className={`rounded-md border py-1.5 font-mono text-xs font-bold tnum cursor-pointer ${
                              active
                                ? 'border-amber-500 bg-amber-500 text-white'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-amber-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                            }`}
                          >
                            {t.toFixed(1)}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Parameter 2: Torque Safety Ceiling (ID 6) */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-[#121722]">
                    <div className="mb-1.5 flex items-center justify-between font-mono text-[11px] font-bold">
                      <span className="text-slate-700 dark:text-slate-200">
                        PARAM 02 // TORQUE LIMIT (ID 6)
                      </span>
                      <span className="text-slate-400">MAX CLAMP</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateTorqueLimit(Math.max(0.1, torqueLimit - 0.5))
                        }
                        className="h-9 w-12 rounded-lg border border-slate-300 bg-white font-mono text-xs font-black hover:border-amber-500 cursor-pointer dark:border-slate-700 dark:bg-slate-900"
                      >
                        -0.5
                      </button>
                      <input
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.5}
                        value={draftParams[6] ?? torqueLimit.toFixed(2)}
                        onChange={(e) =>
                          setDraftParams((prev) => ({ ...prev, 6: e.target.value }))
                        }
                        className="h-9 flex-1 rounded-lg border border-slate-300 bg-white text-center font-mono text-sm font-black tnum outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-900"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateTorqueLimit(Math.min(10.0, torqueLimit + 0.5))
                        }
                        className="h-9 w-12 rounded-lg border border-slate-300 bg-white font-mono text-xs font-black hover:border-amber-500 cursor-pointer dark:border-slate-700 dark:bg-slate-900"
                      >
                        +0.5
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateTorqueLimit(
                            parseFloat(draftParams[6] ?? String(torqueLimit))
                          )
                        }
                        className="h-9 rounded-lg border border-amber-500 bg-amber-500/10 px-3 font-mono text-xs font-bold text-amber-700 hover:bg-amber-500 hover:text-white cursor-pointer dark:text-amber-300"
                      >
                        SET LIMIT
                      </button>
                    </div>
                  </div>
                </div>

                {/* Loop Engagement Console */}
                <div className="space-y-2 pt-1">
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => sendTargetTorque(draftTorque)}
                      className="h-10 rounded-xl border border-amber-500 bg-amber-50 font-mono text-xs font-black text-amber-800 hover:bg-amber-100 cursor-pointer dark:bg-amber-950/50 dark:text-amber-300"
                    >
                      SET TARGET
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetTorqueLoopEnabled(true)}
                      className="flex h-10 items-center justify-center gap-1 rounded-xl bg-emerald-600 font-mono text-xs font-black text-white shadow-xs hover:bg-emerald-700 cursor-pointer"
                    >
                      <Play className="h-3.5 w-3.5" />
                      {torqueEnabled ? 'LOOP ON' : 'ENGAGE'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetTorqueLoopEnabled(false)}
                      className="flex h-10 items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white font-mono text-xs font-black text-slate-700 hover:bg-slate-100 cursor-pointer dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      <Square className="h-3.5 w-3.5" />
                      DISENGAGE
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      sendTargetVoltage(0.0);
                      appendLog('warn', '【紧急停机】发送 0.00V 关闭闭环并停止 PWM');
                    }}
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-red-600 font-mono text-xs font-black text-white shadow-xs hover:bg-red-700 cursor-pointer"
                  >
                    <OctagonAlert className="h-4 w-4" />
                    EMERGENCY STOP (0V)
                  </button>
                </div>
              </div>
            )}
          </aside>
        </div>

        {/* =====================================================================
            COMPACT / MOBILE BOTTOM NAVIGATION BAR (< 1024px)
           ===================================================================== */}
        <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-slate-300 bg-white/95 px-2 py-1.5 backdrop-blur-md lg:hidden dark:border-slate-800 dark:bg-slate-900/95">
          <button
            type="button"
            onClick={() => setMobileTab('control')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 font-mono text-[10px] font-bold cursor-pointer ${
              mobileTab === 'control' ? 'text-sky-600' : 'text-slate-500'
            }`}
          >
            <Sliders className="h-4 w-4" />
            <span>CONTROL</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('scope')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 font-mono text-[10px] font-bold cursor-pointer ${
              mobileTab === 'scope' ? 'text-sky-600' : 'text-slate-500'
            }`}
          >
            <Monitor className="h-4 w-4" />
            <span>DSO SCOPE</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMobileTab('params');
              setBottomDock('params');
            }}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 font-mono text-[10px] font-bold cursor-pointer ${
              mobileTab === 'params' ? 'text-sky-600' : 'text-slate-500'
            }`}
          >
            <Settings2 className="h-4 w-4" />
            <span>6-CH RACK</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMobileTab('terminal');
              setBottomDock('bus');
            }}
            className={`flex flex-1 flex-col items-center gap-0.5 py-1 font-mono text-[10px] font-bold cursor-pointer ${
              mobileTab === 'terminal' ? 'text-sky-600' : 'text-slate-500'
            }`}
          >
            <Terminal className="h-4 w-4" />
            <span>PACKET BUS</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
export default App;
