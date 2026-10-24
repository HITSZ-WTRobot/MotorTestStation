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
  Radio,
  ShieldAlert,
  CheckCircle2,
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

  // 最新下位机规范：前馈 Vff = min(T / 0.5, 18.0V)，动态电压上限 Vmax = min(Vff + 1.5V, 18.0V)
  const acceptedVff = appliedTorque > 0 ? Math.min(appliedTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const acceptedVmax = appliedTorque > 0 ? Math.min(acceptedVff + 1.5, MAX_VOLTAGE) : 0.0;

  const draftVff = draftTorque > 0 ? Math.min(draftTorque / 0.5, MAX_VOLTAGE) : 0.0;
  const draftVmax = draftTorque > 0 ? Math.min(draftVff + 1.5, MAX_VOLTAGE) : 0.0;

  const isVoltageSynced = Math.abs(draftVoltage - appliedVoltage) < 0.005;
  const isTorqueSynced = Math.abs(draftTorque - appliedTorque) < 0.001;

  const vMeterPct = Math.max(0, Math.min(100, (telemetry.voltage / MAX_VOLTAGE) * 100));
  const tMeterPct = Math.max(0, Math.min(100, (telemetry.torque / Math.max(0.1, torqueLimit)) * 100));

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1d1d1f] pb-16 lg:pb-8">
      {/* =====================================================================
          1. 顶部导航栏 (Apple / Vercel 极简留白顶栏，不塞大表头，清爽平衡)
         ===================================================================== */}
      <header className="sticky top-0 z-50 border-b border-[#e5e7eb] bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-4 px-5 py-3.5">
          {/* 左侧品牌标题 */}
          <div className="flex items-center gap-3.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#1d1d1f] text-white shadow-xs">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-[17px] font-semibold tracking-tight text-[#1d1d1f]">
                  Motor Test Station
                </h1>
                <span className="rounded-full bg-[#f2f2f7] border border-[#e5e7eb] px-2.5 py-0.5 font-mono text-xs font-medium text-[#515154]">
                  {platformInfo.isTauri ? platformInfo.os.toUpperCase() : 'WEB'}
                </span>
                <span className="hidden sm:inline-flex rounded-full bg-sky-50 border border-sky-200/80 px-2.5 py-0.5 font-mono text-xs font-medium text-[#0066cc]">
                  Vmax = Vff + 1.5V
                </span>
              </div>
              <p className="text-xs text-[#86868b] mt-0.5">
                STM32 电机测控与扭矩闭环工作台 · TIM3 100Hz · 14B Little-Endian CRC16
              </p>
            </div>
          </div>

          {/* 右侧硬件连接工具栏 */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div
              className={`flex h-9 items-center gap-2 rounded-full border px-3.5 text-xs font-medium tnum ${
                connStatus.warning
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : connStatus.connected
                    ? 'border-emerald-200 bg-emerald-50/80 text-emerald-800'
                    : 'border-[#e5e7eb] bg-[#f5f5f7] text-[#515154]'
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
              <span>{connStatus.label}</span>
            </div>

            {platformInfo.isTauri && (
              <div className="flex items-center gap-1.5">
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  disabled={connStatus.connected}
                  title="选择物理串口"
                  className="h-9 rounded-xl border border-[#e5e7eb] bg-[#f8f9fa] px-3 font-mono text-xs font-medium text-[#1d1d1f] outline-none transition-colors focus:border-[#0071e3] focus:bg-white"
                >
                  {serialPorts.length === 0 ? (
                    <option value="">未检测到串口</option>
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
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#e5e7eb] bg-[#f8f9fa] text-[#515154] hover:bg-[#ebebf0] hover:text-[#1d1d1f] cursor-pointer disabled:opacity-40 transition-colors"
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
              className="h-9 rounded-xl border border-[#e5e7eb] bg-[#f8f9fa] px-3 font-mono text-xs font-medium tnum text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white"
            >
              <option value={115200}>115200 bps</option>
              <option value={921600}>921600 bps</option>
              <option value={460800}>460800 bps</option>
              <option value={230400}>230400 bps</option>
            </select>

            {!connStatus.connected || connStatus.mode === 'mock' ? (
              <button
                type="button"
                onClick={handleConnectHardware}
                className="flex h-9 items-center gap-1.5 rounded-xl bg-[#0071e3] px-4 text-[13px] font-medium text-white shadow-2xs hover:bg-[#0066cc] cursor-pointer transition-colors"
              >
                <Zap className="h-3.5 w-3.5" />
                连接串口
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDisconnect}
                className="flex h-9 items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-4 text-[13px] font-medium text-red-600 hover:bg-red-100 cursor-pointer transition-colors"
              >
                断开连接
              </button>
            )}

            <button
              type="button"
              onClick={handleToggleMock}
              className={`flex h-9 items-center gap-1.5 rounded-xl border px-3.5 text-[13px] font-medium cursor-pointer transition-colors ${
                connStatus.mode === 'mock'
                  ? 'border-amber-500 bg-amber-500 text-white'
                  : 'border-[#e5e7eb] bg-white text-[#1d1d1f] hover:bg-[#f5f5f7]'
              }`}
            >
              <Radio className="h-3.5 w-3.5" />
              {connStatus.mode === 'mock' ? '停止仿真' : '仿真模式'}
            </button>

            <button
              type="button"
              onClick={() => {
                updateVoltageDraft(0.0, true);
                appendLog('warn', '【急停触发】发送 SetVoltage(0.0V) 停止输出');
              }}
              className="flex h-9 items-center gap-1.5 rounded-xl bg-[#ef4444] px-3.5 text-[13px] font-semibold text-white shadow-2xs hover:bg-[#dc2626] active:scale-95 cursor-pointer transition-all"
            >
              <OctagonAlert className="h-3.5 w-3.5" />
              STOP 0V
            </button>
          </div>
        </div>
      </header>

      {/* =====================================================================
          2. 主工作区：Apple / Cal.com 风格 Bento 悬浮卡片网格 (#f5f5f7 画布 + #ffffff 圆角卡片 + #f8f9fa 内槽)
         ===================================================================== */}
      <main className="mx-auto grid max-w-[1720px] grid-cols-1 gap-5 p-5 lg:grid-cols-[430px_1fr]">
        {/* -------------------------------------------------------------------
            左侧控制栏 (430px 宽幅：主控卡片 + 6参数调优卡片)
           ------------------------------------------------------------------- */}
        <aside
          className={`space-y-5 ${
            mobileTab === 'scope' || mobileTab === 'terminal' ? 'hidden lg:block' : 'block'
          }`}
        >
          {/* Bento Card 1: 主控台 (单栏位通过分段开关切换 电压开环 vs 扭矩闭环) */}
          <section
            className={`rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] ${
              mobileTab === 'params' ? 'hidden lg:block' : 'block'
            }`}
          >
            {/* Apple 风格胶囊分段切换器 */}
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-[#f2f2f7] p-1">
              <button
                type="button"
                onClick={() => setActiveMode('voltage')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-[13px] font-semibold transition-all cursor-pointer ${
                  activeMode === 'voltage'
                    ? 'bg-white text-[#0071e3] shadow-xs'
                    : 'text-[#6b7280] hover:text-[#1d1d1f]'
                }`}
              >
                <Zap className="h-4 w-4" />
                手动电压模式
              </button>
              <button
                type="button"
                onClick={() => setActiveMode('torque')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-[13px] font-semibold transition-all cursor-pointer ${
                  activeMode === 'torque'
                    ? 'bg-white text-[#d97706] shadow-xs'
                    : 'text-[#6b7280] hover:text-[#1d1d1f]'
                }`}
              >
                <Target className="h-4 w-4" />
                扭矩闭环模式
              </button>
            </div>

            {activeMode === 'voltage' ? (
              <div className="space-y-4">
                {/* 设定值 vs 已生效对比内槽 (#f8f9fa) */}
                <div className="rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-4">
                  <div className="flex items-center justify-between text-xs font-medium text-[#6b7280]">
                    <span>电压开环控制 (V_target)</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        isVoltageSynced
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}
                    >
                      {isVoltageSynced ? '● 已同步' : '◐ 待下发'}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-baseline justify-between font-mono tnum">
                    <div>
                      <div className="text-xs text-[#86868b]">当前设定 (SET)</div>
                      <div className="text-3xl font-bold tracking-tight text-[#0071e3] mt-0.5">
                        {draftVoltage.toFixed(2)} <span className="text-sm font-semibold">V</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-[#86868b]">已生效 (MCU)</div>
                      <div className="text-2xl font-semibold text-[#1d1d1f] mt-0.5">
                        {appliedVoltage.toFixed(2)}{' '}
                        <span className="text-xs text-[#86868b]">V</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 闭环互锁提示 */}
                {torqueEnabled && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-900">
                      <Lock className="h-4 w-4 text-amber-600" />
                      扭矩闭环运行中 (ModeConflict 互锁)
                    </div>
                    <p className="mt-1 text-xs text-amber-700 leading-relaxed">
                      闭环开启时禁止发送非零手动电压。请先关闭闭环或点击下方 0V 停机。
                    </p>
                  </div>
                )}

                {/* 控制参数 1：目标输出电压 */}
                <div className="rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-4">
                  <div className="mb-2.5 flex items-center justify-between text-[13px] font-semibold text-[#1d1d1f]">
                    <span>目标电压设定</span>
                    <span className="font-mono text-xs font-medium text-[#6b7280]">
                      0.0 ~ 18.0 V
                    </span>
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
                      className="bento-slider-blue w-full"
                    />
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    {VOLTAGE_PRESETS.map((v) => {
                      const active = Math.abs(draftVoltage - v) < 0.05;
                      return (
                        <button
                          key={v}
                          type="button"
                          disabled={torqueEnabled}
                          onClick={() => updateVoltageDraft(v, autoSyncVoltage)}
                          className={`rounded-lg border py-2 font-mono text-[13px] font-semibold tnum transition-all cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
                            active
                              ? 'border-[#0071e3] bg-[#0071e3] text-white shadow-2xs'
                              : 'border-[#e5e7eb] bg-white text-[#374151] hover:border-[#0071e3]/50 hover:text-[#0071e3]'
                          }`}
                        >
                          {v.toFixed(1)}V
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 控制参数 2：步进微调 */}
                <div className="rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-4">
                  <div className="mb-2.5 flex items-center justify-between text-[13px] font-semibold text-[#1d1d1f]">
                    <span>步进微调 (Step)</span>
                    <span className="font-mono text-xs font-medium text-[#6b7280]">
                      ±0.2V / ±0.5V / ±1.0V
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={torqueEnabled}
                      onClick={() => updateVoltageDraft(draftVoltage - 0.2, autoSyncVoltage)}
                      className="h-10 w-16 rounded-xl border border-[#e5e7eb] bg-white font-mono text-[13px] font-semibold text-[#1d1d1f] hover:bg-[#f2f2f7] cursor-pointer disabled:opacity-40 transition-colors"
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
                      className="h-10 flex-1 rounded-xl border border-[#e5e7eb] bg-white text-center font-mono text-base font-bold tnum text-[#1d1d1f] outline-none focus:border-[#0071e3] disabled:opacity-50"
                    />
                    <button
                      type="button"
                      disabled={torqueEnabled}
                      onClick={() => updateVoltageDraft(draftVoltage + 0.2, autoSyncVoltage)}
                      className="h-10 w-16 rounded-xl border border-[#e5e7eb] bg-white font-mono text-[13px] font-semibold text-[#1d1d1f] hover:bg-[#f2f2f7] cursor-pointer disabled:opacity-40 transition-colors"
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
                        className="rounded-lg border border-[#e5e7eb] bg-white py-1.5 font-mono text-xs font-medium text-[#515154] hover:border-[#0071e3]/50 hover:text-[#0071e3] cursor-pointer disabled:opacity-40 transition-colors"
                      >
                        {delta > 0 ? `+${delta.toFixed(1)}V` : `${delta.toFixed(1)}V`}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 自动下发开关 */}
                <label className="flex items-center justify-between rounded-xl border border-[#eceef0] bg-[#f8f9fa] px-4 py-2.5 text-[13px] font-medium text-[#374151] cursor-pointer">
                  <span>拖动滑块或步进时自动下发 (20Hz)</span>
                  <input
                    type="checkbox"
                    checked={autoSyncVoltage}
                    onChange={(e) => setAutoSyncVoltage(e.target.checked)}
                    className="h-4 w-4 accent-[#0071e3] cursor-pointer"
                  />
                </label>

                {/* 执行按钮 */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    type="button"
                    disabled={torqueEnabled}
                    onClick={() => sendTargetVoltage(draftVoltage)}
                    className="flex h-11 items-center justify-center gap-2 rounded-xl bg-[#0071e3] text-[14px] font-semibold text-white shadow-xs hover:bg-[#0066cc] cursor-pointer disabled:opacity-45 disabled:pointer-events-none transition-colors"
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
                    className="flex h-11 items-center justify-center gap-2 rounded-xl bg-[#ef4444] text-[14px] font-semibold text-white shadow-xs hover:bg-[#dc2626] cursor-pointer transition-colors"
                  >
                    <OctagonAlert className="h-4 w-4" />
                    软件停机 (0V)
                  </button>
                </div>
              </div>
            ) : (
              /* ================= 扭矩闭环模式 ================= */
              <div className="space-y-4">
                {/* 设定扭矩 vs 已接受对比内槽 */}
                <div className="rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-4">
                  <div className="flex items-center justify-between text-xs font-medium text-[#6b7280]">
                    <span className="flex items-center gap-1.5">
                      {torqueEnabled ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <ShieldAlert className="h-4 w-4 text-amber-600" />
                      )}
                      {torqueEnabled ? '闭环运行中 (TIM3 100Hz)' : '扭矩闭环待机'}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        commTimeoutWarning
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : isTorqueSynced
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-amber-50 text-amber-700 border border-amber-200'
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
                      <div className="text-xs text-[#86868b]">设定扭矩 (SET)</div>
                      <div className="text-3xl font-bold tracking-tight text-[#d97706] mt-0.5">
                        {draftTorque.toFixed(3)}{' '}
                        <span className="text-sm font-semibold">N·m</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-[#86868b]">已接受 (MCU)</div>
                      <div className="text-2xl font-semibold text-[#1d1d1f] mt-0.5">
                        {appliedTorque.toFixed(3)}{' '}
                        <span className="text-xs text-[#86868b]">N·m</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 前馈与动态电压上限内槽 (Vmax = Vff + 1.5V) */}
                <div className="rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-4">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#1d1d1f]">
                    <span>前馈与动态电压上限 (Vmax = Vff + 1.5V)</span>
                    <span className="rounded-md bg-white border border-[#e5e7eb] px-2 py-0.5 font-mono text-xs text-[#515154]">
                      1V ⇋ 0.5 N·m
                    </span>
                  </div>

                  <div className="my-3 h-2.5 w-full overflow-hidden rounded-full bg-[#e5e7eb] flex">
                    <div
                      className="h-full bg-[#0071e3] transition-all duration-150"
                      style={{ width: `${(acceptedVff / MAX_VOLTAGE) * 100}%` }}
                      title={`前馈 Vff: ${acceptedVff.toFixed(2)}V`}
                    />
                    <div
                      className="h-full bg-[#f59e0b] transition-all duration-150"
                      style={{
                        width: `${((acceptedVmax - acceptedVff) / MAX_VOLTAGE) * 100}%`,
                      }}
                      title={`+1.5V 裕量: +${(acceptedVmax - acceptedVff).toFixed(2)}V`}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 font-mono tnum">
                    <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
                      <span className="block text-xs text-[#86868b]">前馈电压 Vff</span>
                      <span className="text-base font-bold text-[#0071e3]">
                        {acceptedVff.toFixed(2)} V
                      </span>
                    </div>
                    <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
                      <span className="block text-xs text-[#86868b]">动态上限 Vmax</span>
                      <span className="text-base font-bold text-[#d97706]">
                        {acceptedVmax.toFixed(2)} V
                      </span>
                    </div>
                  </div>

                  {!isTorqueSynced && (
                    <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50/90 px-3 py-1.5 font-mono text-xs font-medium text-amber-800 tnum">
                      ▸ 待下发预览 ({draftTorque.toFixed(2)} N·m): Vff={draftVff.toFixed(2)}V, Vmax={draftVmax.toFixed(2)}V
                    </div>
                  )}
                </div>

                {/* 控制参数 1：目标扭矩设定 */}
                <div className="rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-4">
                  <div className="mb-2 flex items-center justify-between text-[13px] font-semibold text-[#1d1d1f]">
                    <span>目标扭矩设定 (T_target)</span>
                    <span className="font-mono text-xs font-medium text-[#d97706]">
                      0.0 ~ {torqueLimit.toFixed(1)} N·m
                    </span>
                  </div>
                  <div className="py-2">
                    <input
                      type="range"
                      min={0}
                      max={torqueLimit}
                      step={0.05}
                      value={draftTorque}
                      onChange={(e) => updateTorqueDraft(parseFloat(e.target.value), false)}
                      className="bento-slider-amber w-full"
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => updateTorqueDraft(draftTorque - 0.1, false)}
                      className="h-10 w-14 rounded-xl border border-[#e5e7eb] bg-white font-mono text-xs font-semibold text-[#1d1d1f] hover:bg-[#f2f2f7] cursor-pointer"
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
                      className="h-10 flex-1 rounded-xl border border-[#e5e7eb] bg-white text-center font-mono text-sm font-bold tnum text-[#1d1d1f] outline-none focus:border-[#d97706]"
                    />
                    <button
                      type="button"
                      onClick={() => updateTorqueDraft(draftTorque + 0.1, false)}
                      className="h-10 w-14 rounded-xl border border-[#e5e7eb] bg-white font-mono text-xs font-semibold text-[#1d1d1f] hover:bg-[#f2f2f7] cursor-pointer"
                    >
                      +0.1
                    </button>
                  </div>
                  <div className="mt-2.5 grid grid-cols-4 gap-2">
                    {TORQUE_PRESETS.map((t) => {
                      const active = Math.abs(draftTorque - t) < 0.05;
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => updateTorqueDraft(t, false)}
                          className={`rounded-lg border py-1.5 font-mono text-[13px] font-semibold tnum cursor-pointer transition-all ${
                            active
                              ? 'border-[#d97706] bg-[#d97706] text-white shadow-2xs'
                              : 'border-[#e5e7eb] bg-white text-[#374151] hover:border-[#d97706]/50 hover:text-[#d97706]'
                          }`}
                        >
                          {t.toFixed(1)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 控制参数 2：扭矩上限 (TorqueLimit ID 6) */}
                <div className="rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-4">
                  <div className="mb-2 flex items-center justify-between text-[13px] font-semibold text-[#1d1d1f]">
                    <span>扭矩安全上限 (TorqueLimit)</span>
                    <span className="font-mono text-xs text-[#86868b]">ID 6</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleUpdateTorqueLimit(Math.max(0.1, torqueLimit - 0.5))
                      }
                      className="h-10 w-12 rounded-xl border border-[#e5e7eb] bg-white font-mono text-xs font-semibold text-[#1d1d1f] hover:bg-[#f2f2f7] cursor-pointer"
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
                      className="h-10 flex-1 rounded-xl border border-[#e5e7eb] bg-white text-center font-mono text-sm font-bold tnum text-[#1d1d1f] outline-none focus:border-[#d97706]"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        handleUpdateTorqueLimit(Math.min(10.0, torqueLimit + 0.5))
                      }
                      className="h-10 w-12 rounded-xl border border-[#e5e7eb] bg-white font-mono text-xs font-semibold text-[#1d1d1f] hover:bg-[#f2f2f7] cursor-pointer"
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
                      className="h-10 rounded-xl bg-[#d97706] px-3.5 text-xs font-semibold text-white hover:bg-[#b45309] cursor-pointer transition-colors"
                    >
                      更新上限
                    </button>
                  </div>
                </div>

                {/* 闭环控制按钮组 */}
                <div className="space-y-2.5 pt-1">
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => sendTargetTorque(draftTorque)}
                      className="h-10 rounded-xl border border-[#d97706] bg-amber-50/70 text-[13px] font-semibold text-[#b45309] hover:bg-amber-100/80 cursor-pointer transition-colors"
                    >
                      下发扭矩
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetTorqueLoopEnabled(true)}
                      className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-[#10b981] text-[13px] font-semibold text-white shadow-2xs hover:bg-[#059669] cursor-pointer transition-colors"
                    >
                      <Play className="h-4 w-4" />
                      {torqueEnabled ? '闭环运行中' : '开启闭环'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetTorqueLoopEnabled(false)}
                      className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-[#e5e7eb] bg-white text-[13px] font-semibold text-[#374151] hover:bg-[#f5f5f7] cursor-pointer transition-colors"
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
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#ef4444] text-[14px] font-semibold text-white shadow-2xs hover:bg-[#dc2626] cursor-pointer transition-colors"
                  >
                    <OctagonAlert className="h-4 w-4" />
                    紧急停机 (0V)
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Bento Card 2: 下位机 6 参数调优与 Flash 存储 */}
          <section
            className={`rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] ${
              mobileTab === 'control' ? 'hidden lg:block' : 'block'
            }`}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-[#0071e3]" />
                <h2 className="text-[15px] font-semibold text-[#1d1d1f]">
                  6 参数调优与 Flash 保存
                </h2>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-medium ${
                  flashSaveStatus.tone === 'saved'
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : flashSaveStatus.tone === 'error'
                      ? 'bg-red-50 text-red-700 border border-red-200'
                      : flashSaveStatus.tone === 'dirty' ||
                          flashSaveStatus.tone === 'saving' ||
                          flashSaveStatus.tone === 'unknown'
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : 'bg-[#f5f5f7] text-[#6b7280]'
                }`}
              >
                {flashSaveStatus.text}
              </span>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={syncDeviceState}
                className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[#e5e7eb] bg-[#f8f9fa] text-[13px] font-medium text-[#1d1d1f] hover:bg-[#ebebf0] cursor-pointer transition-colors"
              >
                <DownloadCloud className="h-4 w-4 text-[#515154]" />
                读取 RAM
              </button>
              <button
                type="button"
                onClick={handleApplyParamsToRam}
                className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-[#0071e3] text-[13px] font-medium text-white hover:bg-[#0066cc] cursor-pointer transition-colors"
              >
                <Upload className="h-4 w-4" />
                写入 RAM
              </button>
            </div>

            {/* 2x3 对称 Bento 参数矩阵 (大字号清晰易读) */}
            <div className="grid grid-cols-2 gap-3">
              {PARAMETER_META_LIST.map((meta) => {
                const currentRam = ramParams[meta.id] ?? meta.defaultVal;
                const draftStr = draftParams[meta.id] ?? currentRam.toFixed(meta.decimals);
                const fDraft = Math.fround(parseFloat(draftStr));
                const isDirty =
                  Number.isFinite(fDraft) && Math.abs(fDraft - currentRam) > 1e-6;

                return (
                  <div
                    key={meta.id}
                    className={`rounded-xl border p-3.5 transition-all ${
                      isDirty
                        ? 'border-[#0071e3] bg-sky-50/40'
                        : 'border-[#eceef0] bg-[#f8f9fa]'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-mono text-[13px] font-bold text-[#1d1d1f]">
                        {meta.shortName}
                      </span>
                      <span className="rounded-md bg-white border border-[#e5e7eb] px-2 py-0.5 font-mono text-xs font-semibold text-[#0071e3] tnum">
                        {currentRam.toFixed(meta.decimals)}
                      </span>
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
                      className="h-9 w-full rounded-lg border border-[#e5e7eb] bg-white px-2.5 text-right font-mono text-sm font-bold tnum text-[#1d1d1f] outline-none focus:border-[#0071e3]"
                    />
                    <div className="mt-1.5 text-xs text-[#6b7280] leading-snug">
                      {meta.description}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 pt-1">
              <button
                type="button"
                onClick={handleSafeSaveFlash}
                disabled={flashSaveStatus.tone === 'saving'}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#1d1d1f] bg-[#1d1d1f] text-[14px] font-semibold text-white hover:bg-[#333336] cursor-pointer transition-colors"
              >
                <Save className="h-4 w-4" />
                💾 停机安全保存到 Flash
              </button>
            </div>
          </section>
        </aside>

        {/* -------------------------------------------------------------------
            右侧遥测主区 (顶部 3 张独立 KPI Bento 卡片 + 中部示波器 + 底部报文终端)
           ------------------------------------------------------------------- */}
        <div className="space-y-5">
          {/* 顶部 3 张独立 KPI 遥测卡片 (宽敞通透，大字号) */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* KPI 1: 通道 A 实测电压 */}
            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
              <div className="flex items-center justify-between text-xs font-semibold text-[#6b7280]">
                <span>实测输出电压 (V_feedback)</span>
                <span className="font-mono text-[#0071e3]">● CH-A</span>
              </div>
              <div className="my-2.5 flex items-baseline gap-2 font-mono tnum">
                <span className="text-4xl font-bold tracking-tight text-[#1d1d1f]">
                  {telemetry.voltage.toFixed(3)}
                </span>
                <span className="text-sm font-semibold text-[#86868b]">V</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[#f2f2f7]">
                <div
                  className="h-full rounded-full bg-[#0071e3] transition-all duration-100"
                  style={{ width: `${vMeterPct.toFixed(1)}%` }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[#f2f2f7] pt-2.5 font-mono text-xs text-[#6b7280] tnum">
                <span>
                  MIN:{' '}
                  <strong className="text-[#1d1d1f]">
                    {telemetry.vMin === null ? '--' : telemetry.vMin.toFixed(2)}V
                  </strong>
                </span>
                <span>
                  MAX:{' '}
                  <strong className="text-[#1d1d1f]">
                    {telemetry.vMax === null ? '--' : telemetry.vMax.toFixed(2)}V
                  </strong>
                </span>
                <span className="text-[#0071e3] font-semibold">
                  SET: {appliedVoltage.toFixed(2)}V
                </span>
              </div>
            </div>

            {/* KPI 2: 通道 B 实测扭矩 */}
            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
              <div className="flex items-center justify-between text-xs font-semibold text-[#6b7280]">
                <span>实测机械扭矩 (Torque)</span>
                <span className="font-mono text-[#d97706]">● CH-B</span>
              </div>
              <div className="my-2.5 flex items-baseline gap-2 font-mono tnum">
                <span className="text-4xl font-bold tracking-tight text-[#1d1d1f]">
                  {telemetry.torque.toFixed(3)}
                </span>
                <span className="text-sm font-semibold text-[#86868b]">N·m</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[#f2f2f7]">
                <div
                  className="h-full rounded-full bg-[#d97706] transition-all duration-100"
                  style={{ width: `${tMeterPct.toFixed(1)}%` }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[#f2f2f7] pt-2.5 font-mono text-xs text-[#6b7280] tnum">
                <span>
                  PEAK:{' '}
                  <strong className="text-[#1d1d1f]">
                    {telemetry.tMax === null ? '--' : telemetry.tMax.toFixed(2)}
                  </strong>
                </span>
                <span>
                  LIM: <strong className="text-[#1d1d1f]">{torqueLimit.toFixed(2)}</strong>
                </span>
                <span
                  className={`font-semibold ${
                    torqueEnabled ? 'text-emerald-600' : 'text-[#86868b]'
                  }`}
                >
                  {torqueEnabled ? 'LOOP: ON' : 'LOOP: OFF'}
                </span>
              </div>
            </div>

            {/* KPI 3: 通信链路与总线指标 */}
            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#6b7280]">
                  通信链路指标 (USART3)
                </span>
                <button
                  type="button"
                  onClick={handleQueryState}
                  disabled={!connStatus.connected}
                  className="rounded-lg bg-[#f2f2f7] px-2.5 py-1 font-mono text-xs font-medium text-[#0071e3] hover:bg-[#e5e5ea] cursor-pointer disabled:opacity-40 transition-colors"
                >
                  ↻ GetState
                </button>
              </div>
              <div className="my-2 grid grid-cols-2 gap-2.5 font-mono tnum">
                <div className="rounded-xl bg-[#f8f9fa] border border-[#eceef0] px-3 py-2">
                  <div className="text-[11px] text-[#86868b]">RX 接收帧</div>
                  <div className="text-lg font-bold text-emerald-600">
                    {telemetry.rxFrames}
                  </div>
                </div>
                <div className="rounded-xl bg-[#f8f9fa] border border-[#eceef0] px-3 py-2">
                  <div className="text-[11px] text-[#86868b]">TX 命令帧</div>
                  <div className="text-lg font-bold text-[#0071e3]">
                    {telemetry.txFrames}
                  </div>
                </div>
                <div className="rounded-xl bg-[#f8f9fa] border border-[#eceef0] px-3 py-2">
                  <div className="text-[11px] text-[#86868b]">FPS 帧率</div>
                  <div className="text-lg font-bold text-[#1d1d1f]">
                    {telemetry.fps} Hz
                  </div>
                </div>
                <div className="rounded-xl bg-[#f8f9fa] border border-[#eceef0] px-3 py-2">
                  <div className="text-[11px] text-[#86868b]">CRC 错误</div>
                  <div
                    className={`text-lg font-bold ${
                      telemetry.crcErrors > 0 ? 'text-red-600' : 'text-[#86868b]'
                    }`}
                  >
                    {telemetry.crcErrors}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 中部 Bento Card: 双通道实时动态示波器 */}
          <section
            className={`rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] ${
              mobileTab === 'control' || mobileTab === 'params' || mobileTab === 'terminal'
                ? 'hidden lg:block'
                : 'block'
            }`}
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Activity className="h-4 w-4 text-[#0071e3]" />
                <h2 className="text-[15px] font-semibold text-[#1d1d1f]">
                  双通道实时动态示波器
                </h2>
                <span className="rounded-full bg-[#f2f2f7] px-2.5 py-0.5 font-mono text-xs font-medium text-[#515154]">
                  60 FPS
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-xl bg-[#f2f2f7] p-1">
                  {[250, 500, 1000, 2000].map((pts) => (
                    <button
                      key={pts}
                      type="button"
                      onClick={() =>
                        setScopeConfig((prev) => ({ ...prev, maxPoints: pts }))
                      }
                      className={`rounded-lg px-2.5 py-1 font-mono text-xs font-medium cursor-pointer transition-all ${
                        scopeConfig.maxPoints === pts
                          ? 'bg-white text-[#1d1d1f] shadow-2xs font-semibold'
                          : 'text-[#6b7280] hover:text-[#1d1d1f]'
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
                  className={`h-8 rounded-xl border px-3 text-xs font-medium cursor-pointer transition-colors ${
                    scopeConfig.showTargetRef
                      ? 'border-sky-200 bg-sky-50 text-[#0071e3]'
                      : 'border-[#e5e7eb] bg-white text-[#6b7280]'
                  }`}
                >
                  参考线: {scopeConfig.showTargetRef ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setScopeConfig((prev) => ({ ...prev, isPaused: !prev.isPaused }))
                  }
                  className={`flex h-8 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium cursor-pointer transition-colors ${
                    scopeConfig.isPaused
                      ? 'border-amber-500 bg-amber-500 text-white'
                      : 'border-[#e5e7eb] bg-white text-[#1d1d1f] hover:bg-[#f5f5f7]'
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
                  className="flex h-8 items-center gap-1.5 rounded-xl border border-[#e5e7eb] bg-white px-3 text-xs font-medium text-[#515154] hover:bg-[#f5f5f7] hover:text-red-600 cursor-pointer transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 清空
                </button>

                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="flex h-8 items-center gap-1.5 rounded-xl border border-[#e5e7eb] bg-white px-3 font-mono text-xs font-medium text-[#1d1d1f] hover:bg-[#f5f5f7] cursor-pointer transition-colors"
                >
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
              </div>
            </div>

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
          </section>

          {/* 底部 Bento Card: 通信报文监视器 (大字号 13px) */}
          <section
            className={`rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] ${
              mobileTab === 'control' || mobileTab === 'params' || mobileTab === 'scope'
                ? 'hidden lg:block'
                : 'block'
            }`}
          >
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <Terminal className="h-4 w-4 text-[#0071e3]" />
                <h2 className="text-[15px] font-semibold text-[#1d1d1f]">
                  通信报文监视器
                </h2>
                <span className="rounded-full bg-[#f2f2f7] px-2.5 py-0.5 font-mono text-xs text-[#6b7280]">
                  TX / 0x82 常显
                </span>
              </div>

              <div className="flex items-center gap-4 text-[13px] text-[#515154]">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showRaw0x81}
                    onChange={(e) => setShowRaw0x81(e.target.checked)}
                    className="h-4 w-4 accent-[#0071e3] cursor-pointer"
                  />
                  <span>打印 0x81 测量流</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pauseLogScroll}
                    onChange={(e) => setPauseLogScroll(e.target.checked)}
                    className="h-4 w-4 accent-[#0071e3] cursor-pointer"
                  />
                  <span>暂停滚动</span>
                </label>
                <button
                  type="button"
                  onClick={() => setLogs([])}
                  className="rounded-lg border border-[#e5e7eb] bg-[#f8f9fa] px-3 py-1 text-xs font-medium text-[#515154] hover:bg-[#ebebf0] hover:text-[#1d1d1f] cursor-pointer transition-colors"
                >
                  清空日志
                </button>
              </div>
            </div>

            <div
              ref={logContainerRef}
              className="h-52 overflow-y-auto rounded-xl border border-[#eceef0] bg-[#f8f9fa] p-3.5 font-mono text-[13px] leading-relaxed tnum"
            >
              {logs.length === 0 ? (
                <div className="text-[#86868b]">暂无通信报文记录...</div>
              ) : (
                logs.map((entry) => (
                  <div
                    key={entry.id}
                    className="mb-1.5 flex items-baseline gap-2.5 border-b border-[#eceef0] pb-1 last:border-none"
                  >
                    <span className="shrink-0 text-xs text-[#86868b]">
                      {entry.time}
                    </span>
                    <span
                      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold ${
                        entry.level === 'tx'
                          ? 'bg-sky-100/80 text-[#0066cc]'
                          : entry.level === 'rx'
                            ? 'bg-emerald-100/80 text-emerald-700'
                            : entry.level === 'warn'
                              ? 'bg-amber-100/80 text-amber-800'
                              : entry.level === 'error'
                                ? 'bg-red-100/80 text-red-700'
                                : 'bg-zinc-200/80 text-[#1d1d1f]'
                      }`}
                    >
                      {entry.dir}
                    </span>
                    <span className="break-all text-[#1d1d1f]">
                      {entry.content}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>

      {/* =====================================================================
          3. 移动端 / 窄窗伴侣模式底部导航栏 (< 1024px)
         ===================================================================== */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-[#e5e7eb] bg-white/95 px-2 py-2 backdrop-blur-md lg:hidden">
        <button
          type="button"
          onClick={() => setMobileTab('control')}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-semibold cursor-pointer ${
            mobileTab === 'control' ? 'text-[#0071e3]' : 'text-[#86868b]'
          }`}
        >
          <Sliders className="h-4 w-4" />
          <span>控制</span>
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('scope')}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-semibold cursor-pointer ${
            mobileTab === 'scope' ? 'text-[#0071e3]' : 'text-[#86868b]'
          }`}
        >
          <Monitor className="h-4 w-4" />
          <span>示波器</span>
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('params')}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-semibold cursor-pointer ${
            mobileTab === 'params' ? 'text-[#0071e3]' : 'text-[#86868b]'
          }`}
        >
          <Settings2 className="h-4 w-4" />
          <span>参数</span>
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('terminal')}
          className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-xs font-semibold cursor-pointer ${
            mobileTab === 'terminal' ? 'text-[#0071e3]' : 'text-[#86868b]'
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
