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
        vTarget,
        tTarget,
        vCeiling,
        torqueEnabled,
      };
      while (dataRef.current.length > maxPoints) {
        dataRef.current.shift();
      }
    }, [maxPoints, showTargetRef, isPaused, vTarget, tTarget, vCeiling, torqueEnabled]);

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
      const ro = new ResizeObserver(resizeCanvas);
      ro.observe(canvas);
      window.addEventListener('resize', resizeCanvas);

      let animId = 0;

      // Vercel / Apple Clean Light Oscilloscope Palette
      const palette = {
        bg: '#fafafa',
        plotBg: '#ffffff',
        gridMajor: '#f0f0f3',
        border: '#e4e4e7',
        text: '#71717a',
        vLine: '#0071e3',
        vRefLine: 'rgba(0, 113, 227, 0.65)',
        vFillTop: 'rgba(0, 113, 227, 0.14)',
        vFillBottom: 'rgba(0, 113, 227, 0.0)',
        tLine: '#d97706',
        tRefLine: 'rgba(217, 119, 6, 0.65)',
        tFillTop: 'rgba(217, 119, 6, 0.14)',
        tFillBottom: 'rgba(217, 119, 6, 0.0)',
        crosshair: 'rgba(24, 24, 27, 0.35)',
        tooltipBg: 'rgba(255, 255, 255, 0.98)',
        tooltipBorder: '#e4e4e7',
      };

      const draw = () => {
        const w = canvas.width;
        const h = canvas.height;
        if (w > 0 && h > 0) {
          const p = propsRef.current;

          ctx.fillStyle = palette.bg;
          ctx.fillRect(0, 0, w, h);

          const padLeft = 62;
          const padRight = 62;
          const padTop = 34;
          const padBottom = 34;
          const plotW = w - padLeft - padRight;
          const plotH = h - padTop - padBottom;

          if (plotW > 0 && plotH > 0) {
            ctx.fillStyle = palette.plotBg;
            ctx.fillRect(padLeft, padTop, plotW, plotH);

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

            // 1. 绘制网格与清晰刻度 (12px)
            ctx.lineWidth = 1;
            const gridRows = 5;
            const gridCols = 10;

            for (let r = 0; r <= gridRows; r++) {
              const y = Math.round(padTop + (plotH / gridRows) * r) + 0.5;
              ctx.strokeStyle =
                r === 0 || r === gridRows ? palette.border : palette.gridMajor;
              ctx.beginPath();
              ctx.moveTo(padLeft, y);
              ctx.lineTo(w - padRight, y);
              ctx.stroke();

              const vVal = vMax - (vMax - vMin) * (r / gridRows);
              ctx.fillStyle = palette.vLine;
              ctx.font = '600 12px "JetBrains Mono", Consolas, monospace';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'middle';
              ctx.fillText(`${vVal.toFixed(1)}V`, padLeft - 10, y);

              const tVal = tMax - (tMax - tMin) * (r / gridRows);
              ctx.fillStyle = palette.tLine;
              ctx.textAlign = 'left';
              ctx.fillText(`${tVal.toFixed(1)}`, w - padRight + 10, y);
            }

            for (let c = 0; c <= gridCols; c++) {
              const x = Math.round(padLeft + (plotW / gridCols) * c) + 0.5;
              ctx.strokeStyle =
                c === 0 || c === gridCols ? palette.border : palette.gridMajor;
              ctx.beginPath();
              ctx.moveTo(x, padTop);
              ctx.lineTo(x, h - padBottom);
              ctx.stroke();
            }

            // 顶栏图例
            ctx.save();
            ctx.font = '600 12.5px "Inter", "PingFang SC", sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = palette.vLine;
            ctx.beginPath();
            ctx.arc(padLeft + 5, 14, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#1d1d1f';
            ctx.fillText('CH-A 实测电压 (0 ~ 20V)', padLeft + 15, 8);

            ctx.fillStyle = palette.tLine;
            ctx.beginPath();
            ctx.arc(padLeft + 200, 14, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#1d1d1f';
            ctx.fillText(
              `CH-B 实测扭矩 (${tMin.toFixed(1)} ~ ${tMax.toFixed(1)} N·m)`,
              padLeft + 210,
              8
            );

            if (p.isPaused) {
              ctx.fillStyle = '#dc2626';
              ctx.textAlign = 'right';
              ctx.fillText('⏸ 已暂停采样', w - padRight, 8);
            }
            ctx.restore();

            let timeSpanText = `窗口容量: ${p.maxPoints} pts · 等待数据流`;
            if (pts.length > 1) {
              const spanSec = ((pts[pts.length - 1].time - pts[0].time) / 1000).toFixed(2);
              timeSpanText = `时间跨度: ${spanSec}s (${pts.length} / ${p.maxPoints} pts)`;
            }
            ctx.fillStyle = palette.text;
            ctx.font = '500 12px "Inter", "PingFang SC", sans-serif';
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

            // 2. 绘制目标与动态上限参考虚线
            if (p.showTargetRef) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(padLeft, padTop, plotW, plotH);
              ctx.clip();

              const activeVRef = p.torqueEnabled ? p.vCeiling : p.vTarget;
              if (activeVRef > 0.01) {
                const yVRef = Math.round(getY_V(activeVRef)) + 0.5;
                ctx.strokeStyle = palette.vRefLine;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yVRef);
                ctx.lineTo(w - padRight, yVRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = '600 11.5px "JetBrains Mono", monospace';
                ctx.fillStyle = palette.vLine;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                const vLabel = p.torqueEnabled
                  ? `▲ Vmax: ${activeVRef.toFixed(2)}V`
                  : `▸ V_target: ${activeVRef.toFixed(2)}V`;
                ctx.fillText(vLabel, padLeft + 8, Math.max(padTop + 16, yVRef - 4));
              }

              if (p.tTarget > 0.005) {
                const yTRef = Math.round(getY_T(p.tTarget)) + 0.5;
                ctx.strokeStyle = palette.tRefLine;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yTRef);
                ctx.lineTo(w - padRight, yTRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = '600 11.5px "JetBrains Mono", monospace';
                ctx.fillStyle = palette.tLine;
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText(
                  `◂ T_target: ${p.tTarget.toFixed(3)} N·m`,
                  w - padRight - 8,
                  Math.max(padTop + 16, yTRef - 4)
                );
              }
              ctx.restore();
            }

            // 3. 绘制双通道实测波形
            if (pts.length > 1) {
              const count = pts.length;
              const stepX = plotW / (p.maxPoints - 1);
              const offsetX = padLeft + (p.maxPoints - count) * stepX;

              ctx.save();
              ctx.beginPath();
              ctx.rect(padLeft, padTop, plotW, plotH);
              ctx.clip();

              // CH-A 电压曲线
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
              ctx.lineWidth = 2.2;
              ctx.lineJoin = 'round';
              ctx.stroke();

              // CH-B 扭矩曲线
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
              ctx.lineWidth = 2.2;
              ctx.lineJoin = 'round';
              ctx.stroke();

              const lastPt = pts[count - 1];
              const lastX = offsetX + (count - 1) * stepX;
              const lastVy = getY_V(lastPt.voltage);
              const lastTy = getY_T(lastPt.torque);

              ctx.fillStyle = palette.vLine;
              ctx.beginPath();
              ctx.arc(lastX, lastVy, 4, 0, Math.PI * 2);
              ctx.fill();

              ctx.fillStyle = palette.tLine;
              ctx.beginPath();
              ctx.arc(lastX, lastTy, 4, 0, Math.PI * 2);
              ctx.fill();

              ctx.restore();

              // 4. 十字探针浮窗
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
                  ctx.arc(ptX, ptVy, 4.5, 0, Math.PI * 2);
                  ctx.fill();

                  ctx.fillStyle = palette.tLine;
                  ctx.beginPath();
                  ctx.arc(ptX, ptTy, 4.5, 0, Math.PI * 2);
                  ctx.fill();

                  const tipW = 196;
                  const tipH = 74;
                  let tipX = m.x + 14;
                  if (tipX + tipW > w - padRight) tipX = m.x - tipW - 14;
                  let tipY = Math.min(ptVy, ptTy) - 26;
                  if (tipY < padTop + 6) tipY = padTop + 6;
                  if (tipY + tipH > h - padBottom) tipY = h - padBottom - tipH;

                  ctx.fillStyle = palette.tooltipBg;
                  ctx.strokeStyle = palette.tooltipBorder;
                  ctx.lineWidth = 1;
                  ctx.beginPath();
                  ctx.roundRect(tipX, tipY, tipW, tipH, 10);
                  ctx.fill();
                  ctx.stroke();

                  const relSec = ((pt.time - pts[0].time) / 1000).toFixed(2);
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'top';
                  ctx.font = '600 11px "JetBrains Mono", monospace';
                  ctx.fillStyle = palette.text;
                  ctx.fillText(`T+${relSec}s [#${pointIdx}]`, tipX + 12, tipY + 9);
                  ctx.font = 'bold 12.5px "JetBrains Mono", monospace';
                  ctx.fillStyle = palette.vLine;
                  ctx.fillText(`CH-A: ${pt.voltage.toFixed(3)} V`, tipX + 12, tipY + 28);
                  ctx.fillStyle = palette.tLine;
                  ctx.fillText(`CH-B: ${pt.torque.toFixed(3)} N·m`, tipX + 12, tipY + 48);
                }
                ctx.restore();
              }
            }
          }
        }
        animId = requestAnimationFrame(draw);
      };

      animId = requestAnimationFrame(draw);
      return () => {
        cancelAnimationFrame(animId);
        ro.disconnect();
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
      <div className="relative w-full h-[380px] xl:h-[420px] rounded-xl border border-[#ebebeb] overflow-hidden bg-[#fafafa]">
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
