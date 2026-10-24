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

      let dpr = 1;
      const resizeCanvas = () => {
        dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        const w = parent?.clientWidth || canvas.offsetWidth;
        const h = parent?.clientHeight || canvas.offsetHeight;
        if (w > 0 && h > 0) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
          canvas.style.width = `${w}px`;
          canvas.style.height = `${h}px`;
        }
      };

      resizeCanvas();
      const ro = new ResizeObserver(resizeCanvas);
      ro.observe(canvas);
      window.addEventListener('resize', resizeCanvas);

      let animId = 0;

      // 亮色高对比度实验室调色板
      const palette = {
        bg: '#ffffff',
        plotBg: '#f8fbff',
        gridMajor: 'rgba(2, 132, 199, 0.09)',
        border: 'rgba(14, 165, 233, 0.24)',
        text: '#64748b',
        vLine: '#0284c7',
        vRefLine: 'rgba(2, 132, 199, 0.65)',
        vFillTop: 'rgba(14, 165, 233, 0.18)',
        vFillBottom: 'rgba(14, 165, 233, 0.01)',
        tLine: '#ea580c',
        tRefLine: 'rgba(234, 88, 12, 0.65)',
        tFillTop: 'rgba(249, 115, 22, 0.16)',
        tFillBottom: 'rgba(249, 115, 22, 0.01)',
        crosshair: 'rgba(2, 132, 199, 0.45)',
        tooltipBg: 'rgba(255, 255, 255, 0.97)',
        tooltipBorder: 'rgba(14, 165, 233, 0.45)',
      };

      const draw = () => {
        const w = canvas.width / dpr;
        const h = canvas.height / dpr;
        if (w > 0 && h > 0) {
          ctx.save();
          ctx.scale(dpr, dpr);
          const p = propsRef.current;

          ctx.fillStyle = palette.bg;
          ctx.fillRect(0, 0, w, h);
          const padLeft = 58;
          const padRight = 58;
          const padTop = 76;
          const padBottom = 30;
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

            // 1. 绘制亮色实验室网格与中心十字刻度短线
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
              ctx.font = '700 11px "JetBrains Mono", Consolas, monospace';
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
                c === 0 || c === gridCols ? palette.border : palette.gridMajor;
              ctx.beginPath();
              ctx.moveTo(x, padTop);
              ctx.lineTo(x, h - padBottom);
              ctx.stroke();
            }

            // 中心十字细微刻度线
            const midY = Math.round(padTop + plotH / 2) + 0.5;
            const midX = Math.round(padLeft + plotW / 2) + 0.5;
            ctx.strokeStyle = palette.border;
            ctx.beginPath();
            for (let s = 1; s < gridCols * 5; s++) {
              const sx = padLeft + (plotW / (gridCols * 5)) * s;
              ctx.moveTo(sx, midY - 3);
              ctx.lineTo(sx, midY + 3);
            }
            for (let s = 1; s < gridRows * 4; s++) {
              const sy = padTop + (plotH / (gridRows * 4)) * s;
              ctx.moveTo(midX - 3, sy);
              ctx.lineTo(midX + 3, sy);
            }
            ctx.stroke();

            // 顶栏图例
            ctx.save();
            ctx.font = 'bold 13px "JetBrains Mono", "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = palette.vLine;
            ctx.fillRect(padLeft, 26, 11, 11);
            ctx.fillStyle = '#1e293b';
            ctx.fillText('CH-A: 实测电压 (0 ~ 20V)', padLeft + 18, 24);

            ctx.fillStyle = palette.tLine;
            ctx.fillRect(padLeft + 225, 26, 11, 11);
            ctx.fillStyle = '#1e293b';
            ctx.fillText(
              `CH-B: 实测扭矩 (${tMin.toFixed(1)} ~ ${tMax.toFixed(1)} N·m)`,
              padLeft + 243,
              24
            );

            if (p.isPaused) {
              ctx.fillStyle = '#dc2626';
              ctx.textAlign = 'right';
              ctx.fillText('[ ⏸ HOLD / 已暂停 ]', w - padRight, 24);
            }
            ctx.restore();

            let timeSpanText = `Window: ${p.maxPoints} pts · 等待数据流...`;
            if (pts.length > 1) {
              const spanSec = ((pts[pts.length - 1].time - pts[0].time) / 1000).toFixed(2);
              timeSpanText = `Span: ${spanSec}s (${pts.length} / ${p.maxPoints} pts)`;
            }
            ctx.fillStyle = palette.text;
            ctx.font = '600 10.5px "JetBrains Mono", "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(timeSpanText, padLeft + plotW / 2, h - padBottom + 7);

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
                ctx.lineWidth = 1.4;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yVRef);
                ctx.lineTo(w - padRight, yVRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = 'bold 10px "JetBrains Mono", "PingFang SC", monospace';
                ctx.fillStyle = palette.vLine;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                const vLabel = p.torqueEnabled
                  ? `▲ Vmax: ${activeVRef.toFixed(2)}V`
                  : `▸ V_target: ${activeVRef.toFixed(2)}V`;
                ctx.fillText(vLabel, padLeft + 8, Math.max(padTop + 14, yVRef - 3));
              }

              if (p.tTarget > 0.005) {
                const yTRef = Math.round(getY_T(p.tTarget)) + 0.5;
                ctx.strokeStyle = palette.tRefLine;
                ctx.lineWidth = 1.4;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yTRef);
                ctx.lineTo(w - padRight, yTRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = 'bold 10px "JetBrains Mono", "PingFang SC", monospace';
                ctx.fillStyle = palette.tLine;
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText(
                  `◂ T_target: ${p.tTarget.toFixed(3)} N·m`,
                  w - padRight - 8,
                  Math.max(padTop + 14, yTRef - 3)
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

              // 最新采样点实时指示头
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

              // 4. 十字探针光标与测量浮窗
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
                ctx.setLineDash([3, 3]);
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

                  const tipW = 186;
                  const tipH = 68;
                  let tipX = m.x + 14;
                  if (tipX + tipW > w - padRight) tipX = m.x - tipW - 14;
                  let tipY = Math.min(ptVy, ptTy) - 24;
                  if (tipY < padTop + 6) tipY = padTop + 6;
                  if (tipY + tipH > h - padBottom) tipY = h - padBottom - tipH;

                  ctx.fillStyle = palette.tooltipBg;
                  ctx.strokeStyle = palette.tooltipBorder;
                  ctx.lineWidth = 1.2;
                  ctx.beginPath();
                  ctx.roundRect(tipX, tipY, tipW, tipH, 6);
                  ctx.fill();
                  ctx.stroke();

                  const relSec = ((pt.time - pts[0].time) / 1000).toFixed(2);
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'top';
                  ctx.font = '600 10px "JetBrains Mono", Consolas, monospace';
                  ctx.fillStyle = palette.text;
                  ctx.fillText(`T+${relSec}s [#${pointIdx}]`, tipX + 10, tipY + 8);
                  ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
                  ctx.fillStyle = palette.vLine;
                  ctx.fillText(`CH-A: ${pt.voltage.toFixed(3)} V`, tipX + 10, tipY + 26);
                  ctx.fillStyle = palette.tLine;
                  ctx.fillText(`CH-B: ${pt.torque.toFixed(3)} N·m`, tipX + 10, tipY + 45);
                }
                ctx.restore();
              }
            }
          }
          ctx.restore();
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
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        hovering: true,
      };
    };

    const handleMouseLeave = () => {
      mouseRef.current = { x: null, y: null, hovering: false };
    };

    return (
      <div className="relative w-full h-full min-h-[260px] overflow-hidden bg-white">
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
