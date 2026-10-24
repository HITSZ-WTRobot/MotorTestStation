import * as React from 'react';

export interface ScopeSamplePoint {
  time: number;
  voltage: number;
  torque: number;
  vRef: number;
  tRef: number;
}

export interface OscilloscopeHandle {
  pushData: (voltage: number, torque: number, time?: number) => void;
  clear: () => void;
  exportCsv: () => string | null;
}

interface OscilloscopeProps {
  maxPoints: number;
  showTargetRef: boolean;
  isPaused: boolean;
  theme: 'cleanroom' | 'dark';
  mode: 'voltage' | 'torque';
  vTarget: number;
  tTarget: number;
  vCeiling: number;
  torqueEnabled: boolean;
}

export const OscilloscopeCanvas = React.forwardRef<OscilloscopeHandle, OscilloscopeProps>(
  (
    {
      maxPoints,
      showTargetRef,
      isPaused,
      theme,
      vTarget,
      tTarget,
      vCeiling,
      torqueEnabled,
    },
    ref
  ) => {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const dataRef = React.useRef<ScopeSamplePoint[]>([]);
    const mouseRef = React.useRef<{ x: number | null; y: number | null; hovering: boolean }>({
      x: null,
      y: null,
      hovering: false,
    });

    const propsRef = React.useRef({
      maxPoints,
      showTargetRef,
      isPaused,
      theme,
      vTarget,
      tTarget,
      vCeiling,
      torqueEnabled,
    });

    React.useEffect(() => {
      propsRef.current = {
        maxPoints,
        showTargetRef,
        isPaused,
        theme,
        vTarget,
        tTarget,
        vCeiling,
        torqueEnabled,
      };
      while (dataRef.current.length > maxPoints) {
        dataRef.current.shift();
      }
    }, [maxPoints, showTargetRef, isPaused, theme, vTarget, tTarget, vCeiling, torqueEnabled]);

    React.useImperativeHandle(ref, () => ({
      pushData(voltage: number, torque: number, time = performance.now()) {
        const p = propsRef.current;
        if (p.isPaused) return;
        const vRef = p.torqueEnabled ? p.vCeiling : p.vTarget;
        const tRef = p.tTarget;
        dataRef.current.push({
          time,
          voltage: Number(voltage) || 0.0,
          torque: Number(torque) || 0.0,
          vRef: Number(vRef) || 0.0,
          tRef: Number(tRef) || 0.0,
        });
        while (dataRef.current.length > p.maxPoints) {
          dataRef.current.shift();
        }
      },
      clear() {
        dataRef.current = [];
      },
      exportCsv() {
        const pts = dataRef.current;
        if (pts.length === 0) return null;
        const t0 = pts[0].time;
        let csv = 'Index,RelTimeSec,Voltage_V,Torque_Nm,VoltageRef_V,TorqueRef_Nm\n';
        pts.forEach((pt, idx) => {
          const relSec = ((pt.time - t0) / 1000).toFixed(4);
          csv += `${idx},${relSec},${pt.voltage.toFixed(4)},${pt.torque.toFixed(4)},${pt.vRef.toFixed(4)},${pt.tRef.toFixed(4)}\n`;
        });
        return csv;
      },
    }));

    React.useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const resizeCanvas = () => {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          canvas.width = Math.round(rect.width * dpr);
          canvas.height = Math.round(rect.height * dpr);
        }
      };

      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);

      let animId = 0;

      const draw = () => {
        const w = canvas.width;
        const h = canvas.height;
        if (w > 0 && h > 0) {
          const p = propsRef.current;
          const isDark = p.theme === 'dark';

          const palette = isDark
            ? {
                bg: '#06090e',
                gridMajor: 'rgba(255, 255, 255, 0.07)',
                accentLine: 'rgba(255, 255, 255, 0.14)',
                text: '#64748b',
                textBright: '#cbd5e1',
                vLine: '#38bdf8',
                vRefLine: 'rgba(56, 189, 248, 0.55)',
                vFillTop: 'rgba(56, 189, 248, 0.14)',
                vFillBottom: 'rgba(56, 189, 248, 0.01)',
                tLine: '#f59e0b',
                tRefLine: 'rgba(245, 158, 11, 0.65)',
                tFillTop: 'rgba(245, 158, 11, 0.14)',
                tFillBottom: 'rgba(245, 158, 11, 0.01)',
                crosshair: 'rgba(255, 255, 255, 0.35)',
                tooltipBg: 'rgba(11, 15, 23, 0.94)',
                tooltipBorder: 'rgba(56, 189, 248, 0.35)',
              }
            : {
                bg: '#f8fafc',
                gridMajor: 'rgba(15, 23, 42, 0.075)',
                accentLine: 'rgba(15, 23, 42, 0.16)',
                text: '#64748b',
                textBright: '#334155',
                vLine: '#0284c7',
                vRefLine: 'rgba(2, 132, 199, 0.55)',
                vFillTop: 'rgba(2, 132, 199, 0.15)',
                vFillBottom: 'rgba(2, 132, 199, 0.01)',
                tLine: '#d97706',
                tRefLine: 'rgba(217, 119, 6, 0.65)',
                tFillTop: 'rgba(217, 119, 6, 0.15)',
                tFillBottom: 'rgba(217, 119, 6, 0.01)',
                crosshair: 'rgba(15, 23, 42, 0.45)',
                tooltipBg: 'rgba(255, 255, 255, 0.96)',
                tooltipBorder: 'rgba(2, 132, 199, 0.35)',
              };

          ctx.fillStyle = palette.bg;
          ctx.fillRect(0, 0, w, h);

          const padLeft = 58;
          const padRight = 58;
          const padTop = 34;
          const padBottom = 32;
          const plotW = w - padLeft - padRight;
          const plotH = h - padTop - padBottom;

          if (plotW > 0 && plotH > 0) {
            const vMin = 0.0;
            const vMax = 20.0;
            let tMin = -0.3;
            let tMax = 4.0;

            const pts = dataRef.current;
            if (pts.length > 0) {
              let minT = 0.0;
              let maxT = p.tTarget > 0 ? p.tTarget : 0.5;
              for (let i = 0; i < pts.length; i++) {
                const t = pts[i].torque;
                const tr = pts[i].tRef || 0;
                if (t < minT) minT = t;
                if (t > maxT) maxT = t;
                if (p.showTargetRef && tr > maxT) maxT = tr;
              }
              const span = Math.max(1.0, maxT - minT);
              tMin = Math.floor((minT - span * 0.1) * 10) / 10;
              tMax = Math.ceil((maxT + span * 0.18) * 10) / 10;
            }

            // 绘制分度网格
            ctx.lineWidth = 1;
            const gridRows = 6;
            const gridCols = 8;

            for (let r = 0; r <= gridRows; r++) {
              const y = Math.round(padTop + (plotH / gridRows) * r) + 0.5;
              ctx.strokeStyle =
                r === 0 || r === gridRows ? palette.accentLine : palette.gridMajor;
              ctx.beginPath();
              ctx.moveTo(padLeft, y);
              ctx.lineTo(w - padRight, y);
              ctx.stroke();

              const vVal = vMax - (vMax - vMin) * (r / gridRows);
              ctx.fillStyle = palette.vLine;
              ctx.font = '11px "JetBrains Mono", Consolas, monospace';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'middle';
              ctx.fillText(`${vVal.toFixed(1)}V`, padLeft - 8, y);

              const tVal = tMax - (tMax - tMin) * (r / gridRows);
              ctx.fillStyle = palette.tLine;
              ctx.textAlign = 'left';
              ctx.fillText(`${tVal.toFixed(1)}`, w - padRight + 8, y);
            }

            for (let c = 0; c <= gridCols; c++) {
              const x = Math.round(padLeft + (plotW / gridCols) * c) + 0.5;
              ctx.strokeStyle =
                c === 0 || c === gridCols ? palette.accentLine : palette.gridMajor;
              ctx.beginPath();
              ctx.moveTo(x, padTop);
              ctx.lineTo(x, h - padBottom);
              ctx.stroke();
            }

            let timeSpanText = `历史窗口容量: ${p.maxPoints} 点 (等待数据流...)`;
            if (pts.length > 1) {
              const spanSec = ((pts[pts.length - 1].time - pts[0].time) / 1000).toFixed(1);
              timeSpanText = `实时时间跨度: ${spanSec} 秒 (已采样 ${pts.length} / ${p.maxPoints} 点)`;
            }
            ctx.fillStyle = palette.text;
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(timeSpanText, padLeft + plotW / 2, h - padBottom + 10);

            const getY_V = (v: number) => {
              const ratio = (v - vMin) / (vMax - vMin);
              return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
            };

            const getY_T = (t: number) => {
              const ratio = (t - tMin) / (tMax - tMin);
              return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
            };

            // 绘制目标与动态上限参考虚线
            if (p.showTargetRef) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(padLeft, padTop, plotW, plotH);
              ctx.clip();

              const activeVRef = p.torqueEnabled ? p.vCeiling : p.vTarget;
              if (activeVRef > 0.01) {
                const yVRef = Math.round(getY_V(activeVRef)) + 0.5;
                ctx.strokeStyle = palette.vRefLine;
                ctx.lineWidth = 1.2;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yVRef);
                ctx.lineTo(w - padRight, yVRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = '10px "JetBrains Mono", Consolas, monospace';
                ctx.fillStyle = palette.vLine;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                const vLabel = p.torqueEnabled
                  ? `Vmax 限幅: ${activeVRef.toFixed(2)}V`
                  : `V 目标: ${activeVRef.toFixed(2)}V`;
                ctx.fillText(vLabel, padLeft + 6, Math.max(padTop + 12, yVRef - 3));
              }

              if (p.tTarget > 0.005) {
                const yTRef = Math.round(getY_T(p.tTarget)) + 0.5;
                ctx.strokeStyle = palette.tRefLine;
                ctx.lineWidth = 1.2;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yTRef);
                ctx.lineTo(w - padRight, yTRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = '10px "JetBrains Mono", Consolas, monospace';
                ctx.fillStyle = palette.tLine;
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText(
                  `T 目标: ${p.tTarget.toFixed(3)} N·m`,
                  w - padRight - 6,
                  Math.max(padTop + 12, yTRef - 3)
                );
              }
              ctx.restore();
            }

            // 绘制双通道实测波形
            if (pts.length > 1) {
              const count = pts.length;
              const stepX = plotW / (p.maxPoints - 1);
              const offsetX = padLeft + (p.maxPoints - count) * stepX;

              ctx.save();
              ctx.beginPath();
              ctx.rect(padLeft, padTop, plotW, plotH);
              ctx.clip();

              // 通道 A 面积与曲线
              const gradV = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
              gradV.addColorStop(0, palette.vFillTop);
              gradV.addColorStop(1, palette.vFillBottom);

              ctx.beginPath();
              ctx.moveTo(offsetX, getY_V(pts[0].voltage));
              for (let i = 1; i < count; i++) {
                ctx.lineTo(offsetX + i * stepX, getY_V(pts[i].voltage));
              }
              ctx.lineTo(offsetX + (count - 1) * stepX, padTop + plotH);
              ctx.lineTo(offsetX, padTop + plotH);
              ctx.closePath();
              ctx.fillStyle = gradV;
              ctx.fill();

              ctx.beginPath();
              ctx.moveTo(offsetX, getY_V(pts[0].voltage));
              for (let i = 1; i < count; i++) {
                ctx.lineTo(offsetX + i * stepX, getY_V(pts[i].voltage));
              }
              ctx.strokeStyle = palette.vLine;
              ctx.lineWidth = 2.0;
              ctx.lineJoin = 'round';
              ctx.stroke();

              // 通道 B 面积与曲线
              const gradT = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
              gradT.addColorStop(0, palette.tFillTop);
              gradT.addColorStop(1, palette.tFillBottom);

              ctx.beginPath();
              ctx.moveTo(offsetX, getY_T(pts[0].torque));
              for (let i = 1; i < count; i++) {
                ctx.lineTo(offsetX + i * stepX, getY_T(pts[i].torque));
              }
              ctx.lineTo(offsetX + (count - 1) * stepX, padTop + plotH);
              ctx.lineTo(offsetX, padTop + plotH);
              ctx.closePath();
              ctx.fillStyle = gradT;
              ctx.fill();

              ctx.beginPath();
              ctx.moveTo(offsetX, getY_T(pts[0].torque));
              for (let i = 1; i < count; i++) {
                ctx.lineTo(offsetX + i * stepX, getY_T(pts[i].torque));
              }
              ctx.strokeStyle = palette.tLine;
              ctx.lineWidth = 2.0;
              ctx.lineJoin = 'round';
              ctx.stroke();

              ctx.restore();

              // 十字准星与悬浮 HUD
              const m = mouseRef.current;
              if (
                m.hovering &&
                m.x !== null &&
                m.x >= padLeft &&
                m.x <= padLeft + plotW
              ) {
                ctx.save();
                ctx.strokeStyle = palette.crosshair;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(m.x, padTop);
                ctx.lineTo(m.x, padTop + plotH);
                ctx.stroke();

                const relativeX = m.x - offsetX;
                const pointIdx = Math.round(relativeX / stepX);
                if (pointIdx >= 0 && pointIdx < count) {
                  const pt = pts[pointIdx];
                  const ptX = offsetX + pointIdx * stepX;
                  const ptVy = getY_V(pt.voltage);
                  const ptTy = getY_T(pt.torque);

                  ctx.setLineDash([]);
                  ctx.fillStyle = palette.vLine;
                  ctx.beginPath();
                  ctx.arc(ptX, ptVy, 4, 0, Math.PI * 2);
                  ctx.fill();

                  ctx.fillStyle = palette.tLine;
                  ctx.beginPath();
                  ctx.arc(ptX, ptTy, 4, 0, Math.PI * 2);
                  ctx.fill();

                  const tipW = 186;
                  const tipH = 68;
                  let tipX = m.x + 14;
                  if (tipX + tipW > w - padRight) tipX = m.x - tipW - 14;
                  let tipY = Math.min(ptVy, ptTy) - 24;
                  if (tipY < padTop + 5) tipY = padTop + 5;
                  if (tipY + tipH > h - padBottom) tipY = h - padBottom - tipH;

                  ctx.fillStyle = palette.tooltipBg;
                  ctx.strokeStyle = palette.tooltipBorder;
                  ctx.lineWidth = 1;
                  ctx.beginPath();
                  ctx.roundRect(tipX, tipY, tipW, tipH, 6);
                  ctx.fill();
                  ctx.stroke();

                  const relSec = ((pt.time - pts[0].time) / 1000).toFixed(2);
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'top';
                  ctx.font = '10px "JetBrains Mono", Consolas, monospace';
                  ctx.fillStyle = palette.text;
                  ctx.fillText(`⏱ T+${relSec}s (#${pointIdx})`, tipX + 10, tipY + 8);
                  ctx.font = '11px "JetBrains Mono", Consolas, monospace';
                  ctx.fillStyle = palette.vLine;
                  ctx.fillText(`● 电压: ${pt.voltage.toFixed(3)} V`, tipX + 10, tipY + 26);
                  ctx.fillStyle = palette.tLine;
                  ctx.fillText(`● 扭矩: ${pt.torque.toFixed(3)} N·m`, tipX + 10, tipY + 45);
                }
                ctx.restore();
              }
            }

            // 顶栏图例
            ctx.save();
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            ctx.fillStyle = palette.vLine;
            ctx.fillRect(padLeft, 11, 8, 8);
            ctx.fillStyle = palette.textBright;
            ctx.fillText('CH A: 实测电压 (0 ~ 20V)', padLeft + 14, 10);

            ctx.fillStyle = palette.tLine;
            ctx.fillRect(padLeft + 185, 11, 8, 8);
            ctx.fillStyle = palette.textBright;
            ctx.fillText(
              `CH B: 实测扭矩 (${tMin.toFixed(1)} ~ ${tMax.toFixed(1)} N·m)`,
              padLeft + 199,
              10
            );

            if (p.isPaused) {
              ctx.fillStyle = '#dc2626';
              ctx.font = 'bold 11px "JetBrains Mono", monospace';
              ctx.textAlign = 'right';
              ctx.fillText('[ ⏸ 示波器已暂停采集 ]', w - padRight, 10);
            }
            ctx.restore();
          }
        }
        animId = requestAnimationFrame(draw);
      };

      animId = requestAnimationFrame(draw);
      return () => {
        cancelAnimationFrame(animId);
        window.removeEventListener('resize', resizeCanvas);
      };
    }, []);

    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
        hovering: true,
      };
    };

    const handleMouseLeave = () => {
      mouseRef.current = { x: null, y: null, hovering: false };
    };

    return (
      <div className="relative w-full h-[380px] sm:h-[460px] rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden shadow-inner bg-slate-50 dark:bg-[#06090e]">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="w-full h-full block cursor-crosshair"
        />
      </div>
    );
  }
);
OscilloscopeCanvas.displayName = 'OscilloscopeCanvas';
