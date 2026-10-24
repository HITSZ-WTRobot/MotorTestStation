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
        level === 'tx'
          ? 'TX'
          : level === 'rx'
            ? 'RX'
            : level === 'info'
              ? 'RSP'
              : level === 'warn'
                ? 'WARN'
                : 'ERR';
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

    appendLog('info', '正在同步下位机状态与 6 项 RAM 参数...');
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
      appendLog('info', '已成功同步下位机全部状态与 6 项 RAM 参数');
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
        appendLog('error', `[CRC Error] ${err.error}`);
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
              ? '已断开 (注意: 下位机保持最后输出!)'
              : '未连接',
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
      'Motor Test Station 已就绪 · 14B Little-Endian CRC16 引擎已启动'
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
            alert('未检测到物理串口，请插入 USB-TTL 适配器或点击【仿真模式】按钮测试。');
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
          `[GetState] T_target=${fTarget.toFixed(3)} N·m, loop=${resp.torqueEnabled ? 'ON' : 'OFF'}, fdb=${resp.feedbackValid ? 'OK' : 'WAIT'}`
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
          appendLog('info', `电压目标已生效: ${accepted.toFixed(2)} V`);
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
      alert('TorqueLimit 必须大于 0');
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
        appendLog('info', `TorqueLimit 已更新为: ${appliedLimit.toFixed(2)} N·m`);
      } else {
        appendLog('warn', `设置 TorqueLimit 失败: ${resp.resultName}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `设置 TorqueLimit 异常: ${msg}`);
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
      setFlashSaveStatus({ text: 'RAM 已应用', tone: 'applied' });
    }
  };

  const handleSafeSaveFlash = async () => {
    const reqQueue = reqQueueRef.current;
    if (!reqQueue || !connStatus.connected) {
      alert('请先连接硬件串口或启动仿真模式');
      return;
    }

    setFlashSaveStatus({ text: '正在写入 Flash...', tone: 'saving' });
    let step = 'stop';

    try {
      appendLog('info', '[Flash 1/4] 下发 0V 停机指令并关闭闭环...');
      const stopResp = await reqQueue.enqueue(CommandType.SetVoltage, (seq) =>
        encodeSetVoltage(0.0, seq)
      );
      if (stopResp.result !== Result.Ok) {
        throw new Error(`停机前置失败: ${stopResp.resultName}`);
      }
      setAppliedVoltage(0.0);
      setTorqueEnabled(false);

      step = 'write_ram';
      appendLog('info', '[Flash 2/4] 同步全部待修改参数至 RAM...');
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
      appendLog('info', '[Flash 3/4] 执行 SaveParameters (0x12) 扇区写入...');
      const saveResp = await reqQueue.enqueue(
        CommandType.SaveParameters,
        (seq) => encodeSaveParameters(seq),
        3000
      );

      const storageCode = Math.round(saveResp.value);
      const storageMsg = StorageCodeNames[storageCode] || `Code ${storageCode}`;

      if (saveResp.result === Result.Ok && storageCode === 0) {
        appendLog('info', `[Flash 4/4] ✓ Flash 烧录校验成功 (${storageMsg})`);
        setFlashSaveStatus({ text: '✓ 已存 Flash', tone: 'saved' });
      } else {
        throw new Error(`存储返回错误: ${saveResp.resultName} / ${storageMsg}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', `Flash 保存中断: ${msg}`);
      if (step === 'save_flash' && msg.includes('Timeout')) {
        setFlashSaveStatus({ text: '⚠️ 结果未知', tone: 'unknown' });
      } else {
        setFlashSaveStatus({ text: '✕ 保存失败', tone: 'error' });
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
    appendLog('info', '已导出 CSV 遥测数据文件');
  };

  const acceptedVff = appliedTorque > 0 ? Math.min(appliedTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const acceptedVmax = appliedTorque > 0 ? Math.min(acceptedVff + 0.5, MAX_VOLTAGE) : 0.0;

  const draftVff = draftTorque > 0 ? Math.min(draftTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const draftVmax = draftTorque > 0 ? Math.min(draftVff + 0.5, MAX_VOLTAGE) : 0.0;

  const isVoltageSynced = Math.abs(draftVoltage - appliedVoltage) < 0.005;
  const isTorqueSynced = Math.abs(draftTorque - appliedTorque) < 0.001;

  const vCellsActive = Math.round((telemetry.voltage / MAX_VOLTAGE) * 16);
  const tCellsActive = Math.round((telemetry.torque / Math.max(0.1, torqueLimit)) * 16);

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col studio-surface-matte text-slate-900">
      {/* =====================================================================
          顶部精密仪表横梁 (色阶: #e4ebf2 冷灰铝底板 + #ffffff 独立内嵌表头模块)
         ===================================================================== */}
      <header className="shrink-0 border-b border-slate-300 bg-[#e4ebf2] shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
          {/* 1. 左侧品牌与平台标签 (字号放大) */}
          <div className="flex items-center gap-3 pr-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-sky-700 text-white shadow-sm border border-sky-400">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-black tracking-wide uppercase text-slate-900">
                  MOTOR TEST STATION
                </span>
                <span className="rounded-md bg-sky-600 px-2 py-0.5 font-mono text-[11px] font-bold text-white shadow-2xs">
                  {platformInfo.isTauri ? platformInfo.os.toUpperCase() : 'WEB'}
                </span>
              </div>
              <div className="font-mono text-xs font-medium text-slate-600">
                TIM3 100Hz · 14B CRC16 · Vmax = Vff + 0.5V
              </div>
            </div>
          </div>

          {/* 2. 中央集成式双通道数字表头与16段光柱 (独立白底悬浮卡片 + 字号放大) */}
          <div className="flex flex-1 flex-wrap items-center justify-center gap-3">
            {/* CH-A：实测电压表头 */}
            <div className="flex items-center gap-3.5 rounded-xl border border-slate-300/90 bg-white px-4 py-2 shadow-xs">
              <div>
                <div className="flex items-center gap-1.5 font-mono text-xs font-extrabold text-sky-700">
                  <span className="h-2 w-2 rounded-full bg-sky-500" />
                  CH-A · 实测电压
                </div>
                <div className="flex items-baseline gap-1 font-mono tnum">
                  <span className="text-3xl font-black tracking-tight text-sky-700">
                    {telemetry.voltage.toFixed(3)}
                  </span>
                  <span className="text-sm font-bold text-sky-600">V</span>
                </div>
              </div>
              <div className="hidden sm:flex flex-col gap-1.5 border-l border-slate-200 pl-3.5">
                <div className="flex gap-1">
                  {Array.from({ length: 16 }).map((_, idx) => (
                    <span
                      key={idx}
                      className={`h-3 w-1.5 rounded-[1px] transition-colors ${
                        idx < vCellsActive
                          ? idx > 13
                            ? 'bg-red-500'
                            : 'bg-sky-500'
                          : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
                <div className="flex gap-2.5 font-mono text-xs font-semibold text-slate-600 tnum">
                  <span>MIN:{telemetry.vMin === null ? '--' : telemetry.vMin.toFixed(2)}</span>
                  <span>MAX:{telemetry.vMax === null ? '--' : telemetry.vMax.toFixed(2)}</span>
                  <span className="text-sky-700 font-bold">
                    SET:{appliedVoltage.toFixed(2)}V
                  </span>
                </div>
              </div>
            </div>

            {/* CH-B：实测扭矩表头 */}
            <div className="flex items-center gap-3.5 rounded-xl border border-slate-300/90 bg-white px-4 py-2 shadow-xs">
              <div>
                <div className="flex items-center gap-1.5 font-mono text-xs font-extrabold text-amber-700">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  CH-B · 实测扭矩
                </div>
                <div className="flex items-baseline gap-1 font-mono tnum">
                  <span className="text-3xl font-black tracking-tight text-amber-600">
                    {telemetry.torque.toFixed(3)}
                  </span>
                  <span className="text-sm font-bold text-amber-600">
                    N·m
                  </span>
                </div>
              </div>
              <div className="hidden sm:flex flex-col gap-1.5 border-l border-slate-200 pl-3.5">
                <div className="flex gap-1">
                  {Array.from({ length: 16 }).map((_, idx) => (
                    <span
                      key={idx}
                      className={`h-3 w-1.5 rounded-[1px] transition-colors ${
                        idx < tCellsActive
                          ? idx > 13
                            ? 'bg-red-500'
                            : 'bg-amber-500'
                          : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
                <div className="flex gap-2.5 font-mono text-xs font-semibold text-slate-600 tnum">
                  <span>PEAK:{telemetry.tMax === null ? '--' : telemetry.tMax.toFixed(2)}</span>
                  <span>LIM:{torqueLimit.toFixed(2)}</span>
                  <span
                    className={`font-bold ${
                      torqueEnabled ? 'text-emerald-600' : 'text-slate-500'
                    }`}
                  >
                    {torqueEnabled ? 'LOOP:ON' : 'LOOP:OFF'}
                  </span>
                </div>
              </div>
            </div>

            {/* 通信统计胶囊 (独立白底模块 + 字号放大至 12px) */}
            <div className="hidden xl:grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl border border-slate-300/90 bg-white px-3.5 py-2 font-mono text-xs font-semibold tnum shadow-xs">
              <span className="text-slate-600">
                RX: <strong className="text-emerald-600">{telemetry.rxFrames}</strong>
              </span>
              <span className="text-slate-600">
                TX: <strong className="text-sky-600">{telemetry.txFrames}</strong>
              </span>
              <span className="text-slate-600">
                FPS: <strong className="text-slate-900">{telemetry.fps}Hz</strong>
              </span>
              <span className="text-slate-600">
                CRC:{' '}
                <strong className={telemetry.crcErrors > 0 ? 'text-red-600' : 'text-slate-500'}>
                  {telemetry.crcErrors}
                </strong>
              </span>
            </div>
          </div>

          {/* 3. 右侧硬件连接与安全急停操作台 (字号与高度放大) */}
          <div className="flex flex-wrap items-center gap-2">
            <div
              className={`flex h-9 items-center gap-2 rounded-lg border px-3 font-mono text-xs font-bold tnum shadow-2xs ${
                connStatus.warning
                  ? 'border-red-300 bg-red-50 text-red-700'
                  : connStatus.connected
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-slate-300 bg-white text-slate-700'
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  !connStatus.connected
                    ? 'bg-red-500'
                    : connStatus.mode === 'mock'
                      ? 'bg-amber-500 animate-pulse'
                      : 'bg-emerald-500 animate-pulse'
                }`}
              />
              <span className="max-w-[175px] truncate">{connStatus.label}</span>
            </div>

            {platformInfo.isTauri && (
              <div className="flex items-center gap-1.5">
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  disabled={connStatus.connected}
                  title="选择物理串口"
                  className="h-9 rounded-lg border border-slate-300 bg-white px-2.5 font-mono text-xs font-semibold text-slate-800 shadow-2xs outline-none focus:border-sky-500"
                >
                  {serialPorts.length === 0 ? (
                    <option value="">无可用串口</option>
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
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 shadow-2xs hover:border-sky-500 hover:text-sky-600 cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            )}

            <select
              value={baudRate}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              disabled={connStatus.connected}
              title="波特率"
              className="h-9 rounded-lg border border-slate-300 bg-white px-2.5 font-mono text-xs font-semibold tnum text-slate-800 shadow-2xs outline-none focus:border-sky-500"
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
                className="flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-b from-sky-500 to-sky-600 px-3.5 text-[13px] font-bold text-white shadow-xs hover:from-sky-600 hover:to-sky-700 cursor-pointer"
              >
                <Zap className="h-4 w-4" />
                连接串口
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDisconnect}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3.5 text-[13px] font-bold text-red-700 hover:bg-red-100 cursor-pointer"
              >
                断开
              </button>
            )}

            <button
              type="button"
              onClick={handleToggleMock}
              className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-bold cursor-pointer transition-colors shadow-2xs ${
                connStatus.mode === 'mock'
                  ? 'border-amber-500 bg-amber-500 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-sky-400 hover:text-sky-700'
              }`}
            >
              <Radio className="h-4 w-4" />
              {connStatus.mode === 'mock' ? '停止仿真' : '仿真模式'}
            </button>

            {/* 全局安全急停按钮 */}
            <button
              type="button"
              onClick={() => {
                updateVoltageDraft(0.0, true);
                appendLog('warn', '【全局急停触发】发送 SetVoltage(0.0V) 停止输出并脱离闭环');
              }}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-b from-red-500 to-red-600 px-3.5 font-mono text-[13px] font-black tracking-wider text-white shadow-xs hover:from-red-600 hover:to-red-700 active:scale-95 cursor-pointer"
            >
              <OctagonAlert className="h-4 w-4" />
              STOP 0V
            </button>
          </div>
        </div>
      </header>

      {/* =====================================================================
          主工作台：模块间采用不同明度色阶区分 (#f1f5f9 / #e8eff7 / #dfe7f0 / #ffffff)
         ===================================================================== */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_410px] xl:grid-cols-[1fr_440px] pb-14 lg:pb-0">
        {/* -------------------------------------------------------------------
            左/中主舞台：全画幅示波器 + 底部参数与报文双联舱
           ------------------------------------------------------------------- */}
        <div className="flex flex-col min-h-0 border-r border-slate-300">
          {/* A. 中央舞台：双通道数字示波器 (工具栏色阶 #edf2f7 + 画布色阶 #f1f5f9/#e8eff7) */}
          <div
            className={`flex-1 min-h-[290px] flex flex-col bg-[#f1f5f9] ${
              mobileTab === 'control' || mobileTab === 'params' || mobileTab === 'terminal'
                ? 'hidden lg:flex'
                : 'flex'
            }`}
          >
            {/* 示波器工具横条 (字号放大至 13px~14px) */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-300/90 bg-[#edf2f7] px-4 py-2">
              <div className="flex items-center gap-2.5">
                <Activity className="h-4 w-4 text-sky-600" />
                <span className="text-sm font-extrabold tracking-wide text-slate-800">
                  双通道实时动态示波器
                </span>
                <span className="rounded-md bg-emerald-100 border border-emerald-300 px-2 py-0.5 font-mono text-xs font-bold text-emerald-800">
                  60 FPS
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 shadow-2xs">
                  {[250, 500, 1000, 2000].map((pts) => (
                    <button
                      key={pts}
                      type="button"
                      onClick={() =>
                        setScopeConfig((prev) => ({ ...prev, maxPoints: pts }))
                      }
                      className={`rounded-md px-2.5 py-1 font-mono text-xs font-bold cursor-pointer transition-colors ${
                        scopeConfig.maxPoints === pts
                          ? 'bg-sky-600 text-white shadow-2xs'
                          : 'text-slate-600 hover:text-sky-700'
                      }`}
                    >
                      {pts} pts
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
                  className={`rounded-lg border px-3 py-1 text-xs font-bold cursor-pointer transition-colors shadow-2xs ${
                    scopeConfig.showTargetRef
                      ? 'border-sky-400 bg-sky-100 text-sky-800'
                      : 'border-slate-300 bg-white text-slate-600'
                  }`}
                >
                  参考线: {scopeConfig.showTargetRef ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setScopeConfig((prev) => ({ ...prev, isPaused: !prev.isPaused }))
                  }
                  className={`flex items-center gap-1 rounded-lg border px-3 py-1 text-xs font-bold cursor-pointer shadow-2xs ${
                    scopeConfig.isPaused
                      ? 'border-amber-500 bg-amber-500 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-sky-400 hover:text-sky-700'
                  }`}
                >
                  {scopeConfig.isPaused ? (
                    <>
                      <Play className="h-3.5 w-3.5" /> 继续
                    </>
                  ) : (
                    <>
                      <Pause className="h-3.5 w-3.5" /> 暂停
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
                  className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-700 hover:border-red-300 hover:text-red-600 cursor-pointer shadow-2xs"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 清空
                </button>

                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="flex items-center gap-1 rounded-lg border border-sky-300 bg-white px-3 py-1 font-mono text-xs font-bold text-sky-700 hover:bg-sky-50 cursor-pointer shadow-2xs"
                >
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
              </div>
            </div>

            {/* 示波器画布 */}
            <div className="flex-1 min-h-0 relative">
              <OscilloscopeCanvas
                ref={scopeRef}
                maxPoints={scopeConfig.maxPoints}
                showTargetRef={scopeConfig.showTargetRef}
                isPaused={scopeConfig.isPaused}
                mode={activeMode}
                vTarget={appliedVoltage}
                tTarget={appliedTorque}
                vCeiling={acceptedVmax}
                torqueEnabled={torqueEnabled}
              />
            </div>
          </div>

          {/* B. 底部双联机架舱 (高度增大至 290px，底部全部字号放大，色阶 #e2e8f0 / #eaeff5) */}
          <div
            className={`shrink-0 lg:h-[290px] border-t border-slate-300 bg-[#eaeff5] flex flex-col ${
              mobileTab === 'control' || mobileTab === 'scope'
                ? 'hidden lg:flex'
                : 'flex'
            }`}
          >
            {/* 机架顶部切换与保存栏 (色阶 #dfe6ee，字号 13px) */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 bg-[#dfe6ee] px-4 py-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBottomDock('split')}
                  className={`hidden xl:inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold cursor-pointer transition-colors ${
                    bottomDock === 'split'
                      ? 'bg-sky-600 text-white shadow-xs'
                      : 'bg-white/80 text-slate-700 hover:bg-white hover:text-sky-700'
                  }`}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  分屏同显
                </button>
                <button
                  type="button"
                  onClick={() => setBottomDock('params')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold cursor-pointer transition-colors ${
                    bottomDock === 'params'
                      ? 'bg-sky-600 text-white shadow-xs'
                      : 'bg-white/80 text-slate-700 hover:bg-white hover:text-sky-700'
                  }`}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  6 参数调优 (PID / EKF)
                </button>
                <button
                  type="button"
                  onClick={() => setBottomDock('bus')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold cursor-pointer transition-colors ${
                    bottomDock === 'bus'
                      ? 'bg-sky-600 text-white shadow-xs'
                      : 'bg-white/80 text-slate-700 hover:bg-white hover:text-sky-700'
                  }`}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  通信报文 ({logs.length})
                </button>
              </div>

              {/* 参数读写与停机保存动作 (字号放大至 12px~13px) */}
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-bold ${
                    flashSaveStatus.tone === 'saved'
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                      : flashSaveStatus.tone === 'error'
                        ? 'border-red-300 bg-red-50 text-red-700'
                        : flashSaveStatus.tone === 'dirty' ||
                            flashSaveStatus.tone === 'saving' ||
                            flashSaveStatus.tone === 'unknown'
                          ? 'border-amber-300 bg-amber-50 text-amber-800'
                          : 'border-slate-300 bg-white text-slate-700'
                  }`}
                >
                  {flashSaveStatus.text}
                </span>
                <button
                  type="button"
                  onClick={syncDeviceState}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-700 hover:border-sky-500 hover:text-sky-600 cursor-pointer shadow-2xs"
                >
                  <DownloadCloud className="h-3.5 w-3.5" /> 读取 RAM
                </button>
                <button
                  type="button"
                  onClick={handleApplyParamsToRam}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1 text-xs font-bold text-white hover:bg-sky-700 cursor-pointer shadow-xs"
                >
                  <Upload className="h-3.5 w-3.5" /> 写入 RAM
                </button>
                <button
                  type="button"
                  onClick={handleSafeSaveFlash}
                  disabled={flashSaveStatus.tone === 'saving'}
                  className="flex items-center gap-1.5 rounded-lg border border-sky-600 bg-white px-3 py-1 text-xs font-extrabold text-sky-700 hover:bg-sky-600 hover:text-white cursor-pointer transition-colors shadow-2xs"
                >
                  <Save className="h-3.5 w-3.5" /> 停机存 Flash
                </button>
              </div>
            </div>

            {/* 机架内容区 */}
            <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-12 overflow-hidden">
              {/* 1) 6通道合成器式参数条 (底色 #eaeff5 + 卡片 #ffffff，字号全面放大至 12px~14px) */}
              <div
                className={`${
                  bottomDock === 'bus'
                    ? 'hidden'
                    : bottomDock === 'params'
                      ? 'xl:col-span-12'
                      : 'xl:col-span-7'
                } p-3 overflow-y-auto border-r border-slate-300`}
              >
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5 h-full">
                  {PARAMETER_META_LIST.map((meta) => {
                    const currentRam = ramParams[meta.id] ?? meta.defaultVal;
                    const draftStr = draftParams[meta.id] ?? currentRam.toFixed(meta.decimals);
                    const fDraft = Math.fround(parseFloat(draftStr));
                    const isDirty =
                      Number.isFinite(fDraft) && Math.abs(fDraft - currentRam) > 1e-6;

                    return (
                      <div
                        key={meta.id}
                        className={`flex flex-col justify-between rounded-xl border p-3 transition-all shadow-xs ${
                          isDirty
                            ? 'border-amber-400 bg-amber-50/90'
                            : 'border-slate-300/90 bg-white hover:border-sky-400'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-sm font-black text-slate-900">
                              {meta.shortName}
                            </span>
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${
                                isDirty ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'
                              }`}
                              title={isDirty ? '已修改 (待写入 RAM)' : '与下位机 RAM 一致'}
                            />
                          </div>
                          <div className="mt-1.5 text-xs font-medium text-slate-600 leading-snug">
                            {meta.description}
                          </div>
                        </div>

                        <div className="mt-2.5 space-y-1.5">
                          <div className="flex items-center justify-between rounded-md bg-slate-100 border border-slate-200 px-2 py-1 font-mono text-xs tnum">
                            <span className="font-semibold text-slate-500">RAM</span>
                            <strong className="text-sky-700 font-bold">
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
                              setFlashSaveStatus({ text: '● 待写入 RAM', tone: 'dirty' });
                            }}
                            className="h-9 w-full rounded-lg border border-slate-300 bg-[#f8fafc] px-2 text-right font-mono text-sm font-black tnum text-slate-900 outline-none focus:border-sky-500 focus:bg-white"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 2) 14字节报文总线流 (色阶 #f1f5f9，文字放大至 12px) */}
              <div
                className={`${
                  bottomDock === 'params'
                    ? 'hidden'
                    : bottomDock === 'bus'
                      ? 'xl:col-span-12'
                      : 'xl:col-span-5'
                } flex flex-col min-h-0 bg-[#f1f5f9]`}
              >
                <div className="flex items-center justify-between border-b border-slate-300 bg-[#e5ecf4] px-3 py-1.5 text-xs">
                  <span className="font-mono font-bold text-slate-700">
                    报文监视器 (TX / 0x82 常显)
                  </span>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 font-semibold text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showRaw0x81}
                        onChange={(e) => setShowRaw0x81(e.target.checked)}
                        className="h-3.5 w-3.5 accent-sky-600"
                      />
                      <span>打印 0x81</span>
                    </label>
                    <label className="flex items-center gap-1.5 font-semibold text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pauseLogScroll}
                        onChange={(e) => setPauseLogScroll(e.target.checked)}
                        className="h-3.5 w-3.5 accent-sky-600"
                      />
                      <span>暂停</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setLogs([])}
                      className="text-slate-600 hover:text-red-600 cursor-pointer font-bold"
                    >
                      清空
                    </button>
                  </div>
                </div>
                <div
                  ref={logContainerRef}
                  className="flex-1 overflow-y-auto p-2.5 font-mono text-xs leading-relaxed tnum bg-[#f4f7fb]"
                >
                  {logs.length === 0 ? (
                    <div className="text-slate-500">暂无报文记录...</div>
                  ) : (
                    logs.map((entry) => (
                      <div
                        key={entry.id}
                        className="mb-1.5 flex items-baseline gap-2 border-b border-slate-200/80 pb-1"
                      >
                        <span className="shrink-0 text-[11px] font-medium text-slate-500">
                          {entry.time}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-black ${
                            entry.level === 'tx'
                              ? 'bg-sky-100 text-sky-800 border border-sky-200'
                              : entry.level === 'rx'
                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                : entry.level === 'warn'
                                  ? 'bg-amber-100 text-amber-900 border border-amber-200'
                                  : entry.level === 'error'
                                    ? 'bg-red-100 text-red-800 border border-red-200'
                                    : 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                          }`}
                        >
                          {entry.dir}
                        </span>
                        <span className="break-all font-medium text-slate-800">
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
            右侧推子主控舱 (底色阶 #edf2f7 + 内部独立白卡片 #ffffff)
           ------------------------------------------------------------------- */}
        <aside
          className={`flex flex-col min-h-0 bg-[#edf2f7] overflow-y-auto ${
            mobileTab === 'scope' || mobileTab === 'params' || mobileTab === 'terminal'
              ? 'hidden lg:flex'
              : 'flex'
          }`}
        >
          {/* 1. 顶部模式二选一切换器 (色阶 #e2e9f1) */}
          <div className="border-b border-slate-300 bg-[#e2e9f1] p-3.5">
            <div className="mb-2 flex items-center justify-between text-xs font-bold text-slate-600">
              <span>控制模式切换</span>
              <button
                type="button"
                onClick={handleQueryState}
                disabled={!connStatus.connected}
                className="font-mono text-sky-700 hover:underline cursor-pointer disabled:opacity-40"
              >
                ↻ GetState (0x13)
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-300 bg-[#d5e0ec] p-1">
              <button
                type="button"
                onClick={() => setActiveMode('voltage')}
                className={`flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-black tracking-wide transition-all cursor-pointer ${
                  activeMode === 'voltage'
                    ? 'bg-sky-600 text-white shadow-sm'
                    : 'text-slate-700 hover:text-sky-700 hover:bg-white/70'
                }`}
              >
                <Zap className="h-4 w-4" />
                ⚡ 手动电压模式
              </button>
              <button
                type="button"
                onClick={() => setActiveMode('torque')}
                className={`flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-black tracking-wide transition-all cursor-pointer ${
                  activeMode === 'torque'
                    ? 'bg-amber-500 text-white shadow-sm'
                    : 'text-slate-700 hover:text-amber-700 hover:bg-white/70'
                }`}
              >
                <Target className="h-4 w-4" />
                🎯 扭矩闭环模式
              </button>
            </div>
          </div>

          {/* 2. 主控舱内容区 */}
          {activeMode === 'voltage' ? (
            <div className="flex-1 flex flex-col justify-between p-4 space-y-4">
              <div className="space-y-3.5">
                {/* 设定值 vs 下位机已生效对比窗 (独立白卡片) */}
                <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-xs">
                  <div className="flex items-center justify-between text-xs font-bold text-sky-800">
                    <span>电压开环控制 (V_target)</span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                        isVoltageSynced
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-amber-100 text-amber-800 border border-amber-300'
                      }`}
                    >
                      {isVoltageSynced ? '● 已同步' : '◐ 待下发'}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline justify-between font-mono tnum">
                    <div>
                      <div className="text-xs font-semibold text-slate-500">
                        设定电压 (SET)
                      </div>
                      <div className="text-3xl font-black text-sky-600">
                        {draftVoltage.toFixed(2)} <span className="text-sm">V</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-semibold text-slate-500">
                        已生效 (MCU)
                      </div>
                      <div className="text-2xl font-extrabold text-slate-800">
                        {appliedVoltage.toFixed(2)} <span className="text-xs text-slate-500">V</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 闭环互锁警告横幅 */}
                {torqueEnabled && (
                  <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3.5 shadow-xs">
                    <div className="flex items-center gap-2 text-xs font-black text-amber-900">
                      <Lock className="h-4 w-4 text-amber-600" />
                      扭矩闭环运行中 (ModeConflict 互锁)
                    </div>
                    <p className="mt-1 text-xs text-amber-800 leading-relaxed">
                      闭环开启时禁止发送非零手动电压。请先关闭闭环或点击 0V 停机。
                    </p>
                  </div>
                )}

                {/* 控制参数 1：目标输出电压推子与预设矩阵 (独立白卡片) */}
                <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-xs">
                  <div className="mb-2 flex items-center justify-between text-[13px] font-bold">
                    <span className="text-slate-800">
                      目标电压设定
                    </span>
                    <span className="font-mono text-sky-600">0.0 ~ 18.0 V</span>
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
                      className="studio-fader-blue w-full"
                    />
                  </div>
                  <div className="mt-2.5 grid grid-cols-4 gap-2">
                    {VOLTAGE_PRESETS.map((v) => {
                      const active = Math.abs(draftVoltage - v) < 0.05;
                      return (
                        <button
                          key={v}
                          type="button"
                          disabled={torqueEnabled}
                          onClick={() => updateVoltageDraft(v, autoSyncVoltage)}
                          className={`rounded-lg border py-2 font-mono text-[13px] font-bold tnum transition-all cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
                            active
                              ? 'border-sky-600 bg-sky-600 text-white shadow-xs'
                              : 'border-slate-300 bg-[#f8fafc] text-slate-700 hover:border-sky-500 hover:bg-sky-50'
                          }`}
                        >
                          {v.toFixed(1)}V
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 控制参数 2：步进微调增量 (独立白卡片) */}
                <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-xs">
                  <div className="mb-2 flex items-center justify-between text-[13px] font-bold">
                    <span className="text-slate-800">
                      步进微调 (Step)
                    </span>
                    <span className="font-mono text-xs text-slate-500">±0.2V / ±0.5V / ±1.0V</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={torqueEnabled}
                      onClick={() => updateVoltageDraft(draftVoltage - 0.2, autoSyncVoltage)}
                      className="h-10 w-16 rounded-lg border border-slate-300 bg-[#f8fafc] font-mono text-[13px] font-black text-slate-700 hover:border-sky-500 hover:text-sky-600 cursor-pointer disabled:opacity-40"
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
                      className="h-10 flex-1 rounded-lg border border-slate-300 bg-[#f8fafc] text-center font-mono text-base font-black tnum text-slate-900 outline-none focus:border-sky-500 focus:bg-white disabled:opacity-50"
                    />
                    <button
                      type="button"
                      disabled={torqueEnabled}
                      onClick={() => updateVoltageDraft(draftVoltage + 0.2, autoSyncVoltage)}
                      className="h-10 w-16 rounded-lg border border-slate-300 bg-[#f8fafc] font-mono text-[13px] font-black text-slate-700 hover:border-sky-500 hover:text-sky-600 cursor-pointer disabled:opacity-40"
                    >
                      +0.2V
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {[-1.0, -0.5, 0.5, 1.0].map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        disabled={torqueEnabled}
                        onClick={() =>
                          updateVoltageDraft(draftVoltage + delta, autoSyncVoltage)
                        }
                        className="rounded-lg border border-slate-300 bg-[#f8fafc] py-1.5 font-mono text-xs font-bold text-slate-700 hover:border-sky-500 hover:text-sky-600 cursor-pointer disabled:opacity-40"
                      >
                        {delta > 0 ? `+${delta.toFixed(1)}V` : `${delta.toFixed(1)}V`}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 实时自动下发开关 */}
                <label className="flex items-center justify-between rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-700 shadow-2xs cursor-pointer">
                  <span>拖动滑块或步进时自动下发 (20Hz)</span>
                  <input
                    type="checkbox"
                    checked={autoSyncVoltage}
                    onChange={(e) => setAutoSyncVoltage(e.target.checked)}
                    className="h-4 w-4 accent-sky-600 cursor-pointer"
                  />
                </label>
              </div>

              {/* 底部执行按钮 */}
              <div className="grid grid-cols-2 gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={torqueEnabled}
                  onClick={() => sendTargetVoltage(draftVoltage)}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 text-[13px] font-black text-white shadow-sm hover:from-sky-600 hover:to-sky-700 cursor-pointer disabled:opacity-45 disabled:pointer-events-none"
                >
                  {torqueEnabled ? (
                    <>
                      <Lock className="h-4 w-4" />
                      闭环中已锁定
                    </>
                  ) : (
                    <>
                      <Zap className="h-4 w-4" />
                      下发电压目标
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateVoltageDraft(0.0, true);
                    appendLog('warn', '【软件停机】发送 0.00V 停止输出');
                  }}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-red-500 to-red-600 text-[13px] font-black text-white shadow-sm hover:from-red-600 hover:to-red-700 cursor-pointer"
                >
                  <OctagonAlert className="h-4 w-4" />
                  软件停机 (0V)
                </button>
              </div>
            </div>
          ) : (
            /* ================= 扭矩闭环控制面板 ================= */
            <div className="flex-1 flex flex-col justify-between p-4 space-y-3.5">
              <div className="space-y-3.5">
                {/* 设定扭矩 vs 下位机已接受对比窗 (独立白卡片) */}
                <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-xs">
                  <div className="flex items-center justify-between text-xs font-bold text-amber-900">
                    <span className="flex items-center gap-1.5">
                      {torqueEnabled ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <ShieldAlert className="h-4 w-4 text-amber-600" />
                      )}
                      {torqueEnabled ? '闭环运行中 (TIM3 100Hz)' : '扭矩闭环待机'}
                    </span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                        commTimeoutWarning
                          ? 'bg-red-100 text-red-700 border border-red-300'
                          : isTorqueSynced
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            : 'bg-amber-100 text-amber-800 border border-amber-300'
                      }`}
                    >
                      {commTimeoutWarning
                        ? '▲ 通信超时'
                        : isTorqueSynced
                          ? '● 已同步'
                          : '◐ 待下发'}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline justify-between font-mono tnum">
                    <div>
                      <div className="text-xs font-semibold text-slate-500">
                        设定扭矩 (SET)
                      </div>
                      <div className="text-3xl font-black text-amber-600">
                        {draftTorque.toFixed(3)} <span className="text-sm">N·m</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-semibold text-slate-500">
                        已接受 (MCU)
                      </div>
                      <div className="text-2xl font-extrabold text-slate-800">
                        {appliedTorque.toFixed(3)} <span className="text-xs text-slate-500">N·m</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 双段式前馈与动态电压上限指示器 (Vff + 0.5V) */}
                <div className="rounded-xl border border-slate-300 bg-white p-3.5 shadow-xs">
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span className="text-slate-800">
                      前馈与动态电压上限 (Vmax = Vff + 0.5V)
                    </span>
                    <span className="rounded bg-sky-100 border border-sky-200 px-2 py-0.5 font-mono text-xs text-sky-800">
                      1V ⇋ 0.5 N·m
                    </span>
                  </div>

                  {/* 双色分段进度条 */}
                  <div className="my-2.5 h-3 w-full overflow-hidden rounded-full bg-slate-200 border border-slate-300 flex">
                    <div
                      className="h-full bg-sky-500 transition-all duration-150"
                      style={{ width: `${(acceptedVff / MAX_VOLTAGE) * 100}%` }}
                      title={`Vff: ${acceptedVff.toFixed(2)}V`}
                    />
                    <div
                      className="h-full bg-amber-400 transition-all duration-150"
                      style={{
                        width: `${((acceptedVmax - acceptedVff) / MAX_VOLTAGE) * 100}%`,
                      }}
                      title={`+0.5V Margin: +${(acceptedVmax - acceptedVff).toFixed(2)}V`}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 font-mono tnum">
                    <div className="rounded-lg border border-slate-200 bg-[#f8fafc] px-3 py-2">
                      <span className="block text-xs font-semibold text-slate-500">
                        前馈电压 Vff
                      </span>
                      <span className="text-base font-black text-sky-700">
                        {acceptedVff.toFixed(2)} V
                      </span>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-[#f8fafc] px-3 py-2">
                      <span className="block text-xs font-semibold text-slate-500">
                        动态上限 Vmax
                      </span>
                      <span className="text-base font-black text-amber-600">
                        {acceptedVmax.toFixed(2)} V
                      </span>
                    </div>
                  </div>

                  {!isTorqueSynced && (
                    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 font-mono text-xs font-bold text-amber-900 tnum">
                      ▸ 待下发预览 ({draftTorque.toFixed(2)} N·m): Vff={draftVff.toFixed(2)}V, Vmax={draftVmax.toFixed(2)}V
                    </div>
                  )}
                </div>

                {/* 控制参数 1：目标扭矩幅值推子与档位 (独立白卡片) */}
                <div className="rounded-xl border border-slate-300 bg-white p-3.5 shadow-xs">
                  <div className="mb-1.5 flex items-center justify-between text-[13px] font-bold">
                    <span className="text-slate-800">
                      目标扭矩设定 (T_target)
                    </span>
                    <span className="font-mono text-amber-600">0.0 ~ {torqueLimit.toFixed(1)} N·m</span>
                  </div>
                  <div className="py-1.5">
                    <input
                      type="range"
                      min={0}
                      max={torqueLimit}
                      step={0.05}
                      value={draftTorque}
                      onChange={(e) => updateTorqueDraft(parseFloat(e.target.value), false)}
                      className="studio-fader-orange w-full"
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => updateTorqueDraft(draftTorque - 0.1, false)}
                      className="h-9 w-14 rounded-lg border border-slate-300 bg-[#f8fafc] font-mono text-xs font-black text-slate-700 hover:border-amber-500 cursor-pointer"
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
                      className="h-9 flex-1 rounded-lg border border-slate-300 bg-[#f8fafc] text-center font-mono text-sm font-black tnum text-slate-900 outline-none focus:border-amber-500 focus:bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => updateTorqueDraft(draftTorque + 0.1, false)}
                      className="h-9 w-14 rounded-lg border border-slate-300 bg-[#f8fafc] font-mono text-xs font-black text-slate-700 hover:border-amber-500 cursor-pointer"
                    >
                      +0.1
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {TORQUE_PRESETS.map((t) => {
                      const active = Math.abs(draftTorque - t) < 0.05;
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => updateTorqueDraft(t, false)}
                          className={`rounded-lg border py-1.5 font-mono text-[13px] font-bold tnum cursor-pointer ${
                            active
                              ? 'border-amber-500 bg-amber-500 text-white shadow-2xs'
                              : 'border-slate-300 bg-[#f8fafc] text-slate-700 hover:border-amber-400 hover:bg-amber-50'
                          }`}
                        >
                          {t.toFixed(1)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 控制参数 2：扭矩安全上限 (TorqueLimit ID 6) */}
                <div className="rounded-xl border border-slate-300 bg-white p-3.5 shadow-xs">
                  <div className="mb-1.5 flex items-center justify-between text-[13px] font-bold">
                    <span className="text-slate-800">
                      扭矩上限 (TorqueLimit)
                    </span>
                    <span className="font-mono text-xs text-slate-500">ID 6</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleUpdateTorqueLimit(Math.max(0.1, torqueLimit - 0.5))
                      }
                      className="h-9 w-12 rounded-lg border border-slate-300 bg-[#f8fafc] font-mono text-xs font-black text-slate-700 hover:border-amber-500 cursor-pointer"
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
                      className="h-9 flex-1 rounded-lg border border-slate-300 bg-[#f8fafc] text-center font-mono text-sm font-black tnum text-slate-900 outline-none focus:border-amber-500 focus:bg-white"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        handleUpdateTorqueLimit(Math.min(10.0, torqueLimit + 0.5))
                      }
                      className="h-9 w-12 rounded-lg border border-slate-300 bg-[#f8fafc] font-mono text-xs font-black text-slate-700 hover:border-amber-500 cursor-pointer"
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
                      className="h-9 rounded-lg border border-amber-500 bg-amber-500 px-3.5 text-xs font-bold text-white hover:bg-amber-600 cursor-pointer shadow-2xs"
                    >
                      更新上限
                    </button>
                  </div>
                </div>
              </div>

              {/* 扭矩闭环操作按钮组 */}
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => sendTargetTorque(draftTorque)}
                    className="h-10 rounded-xl border border-amber-400 bg-amber-50 text-[13px] font-black text-amber-800 hover:bg-amber-100 cursor-pointer"
                  >
                    下发扭矩
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetTorqueLoopEnabled(true)}
                    className="flex h-10 items-center justify-center gap-1 rounded-xl bg-gradient-to-b from-emerald-500 to-emerald-600 text-[13px] font-black text-white shadow-xs hover:from-emerald-600 hover:to-emerald-700 cursor-pointer"
                  >
                    <Play className="h-4 w-4" />
                    {torqueEnabled ? '闭环运行中' : '开启闭环'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetTorqueLoopEnabled(false)}
                    className="flex h-10 items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white text-[13px] font-black text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    <Square className="h-4 w-4" />
                    关闭闭环
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    sendTargetVoltage(0.0);
                    appendLog('warn', '【紧急停机】发送 0.00V 关闭闭环并停止 PWM');
                  }}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-red-500 to-red-600 text-[13px] font-black text-white shadow-xs hover:from-red-600 hover:to-red-700 cursor-pointer"
                >
                  <OctagonAlert className="h-4 w-4" />
                  紧急停机 (0V)
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* =====================================================================
          窄窗 / 移动端底部四栏导航条 (< 1024px)
         ===================================================================== */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-slate-300 bg-[#e8eef5] px-2 py-1.5 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileTab('control')}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-bold cursor-pointer ${
            mobileTab === 'control' ? 'text-sky-600' : 'text-slate-600'
          }`}
        >
          <Sliders className="h-4 w-4" />
          <span>控制</span>
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('scope')}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-bold cursor-pointer ${
            mobileTab === 'scope' ? 'text-sky-600' : 'text-slate-600'
          }`}
        >
          <Monitor className="h-4 w-4" />
          <span>示波器</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setMobileTab('params');
            setBottomDock('params');
          }}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-bold cursor-pointer ${
            mobileTab === 'params' ? 'text-sky-600' : 'text-slate-600'
          }`}
        >
          <Settings2 className="h-4 w-4" />
          <span>参数</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setMobileTab('terminal');
            setBottomDock('bus');
          }}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-bold cursor-pointer ${
            mobileTab === 'terminal' ? 'text-sky-600' : 'text-slate-600'
          }`}
        >
          <Terminal className="h-4 w-4" />
          <span>报文</span>
        </button>
      </nav>
    </div>
  );
}
export default App;
