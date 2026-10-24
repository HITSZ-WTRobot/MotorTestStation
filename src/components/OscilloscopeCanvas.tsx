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

      // 柔和不刺眼的护眼浅灰蓝实验室调色板 (Soft Matte Daylight Palette)
      const palette = {
        bg: '#f1f5f9',                              // 外框柔和冷灰白 (Slate-100)
        plotBg: '#e8eff7',                          // 内部波形视口微沉浅冰灰蓝 (不刺眼，对比度舒适)
        gridMajor: 'rgba(15, 23, 42, 0.085)',       // 主网格线
        border: 'rgba(2, 132, 199, 0.28)',          // 视口边界线
        text: '#475569',                            // 底部说明文字 (Slate-600)
        vLine: '#0284c7',                           // CH-A 湛蓝
        vRefLine: 'rgba(2, 132, 199, 0.75)',
        vFillTop: 'rgba(14, 165, 233, 0.22)',
        vFillBottom: 'rgba(14, 165, 233, 0.02)',
        tLine: '#d97706',                           // CH-B 琥珀橙
        tRefLine: 'rgba(217, 119, 6, 0.75)',
        tFillTop: 'rgba(245, 158, 11, 0.20)',
        tFillBottom: 'rgba(245, 158, 11, 0.02)',
        crosshair: 'rgba(15, 23, 42, 0.45)',
        tooltipBg: 'rgba(255, 255, 255, 0.96)',
        tooltipBorder: 'rgba(2, 132, 199, 0.45)',
      };

      const draw = () => {
        const w = canvas.width;
        const h = canvas.height;
        if (w > 0 && h > 0) {
          const p = propsRef.current;

          ctx.fillStyle = palette.bg;
          ctx.fillRect(0, 0, w, h);

          const padLeft = 64;
          const padRight = 64;
          const padTop = 32;
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

            // 1. 绘制网格与放大后的清晰刻度字号 (12px)
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
              ctx.font = 'bold 12px "JetBrains Mono", Consolas, monospace';
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

            // 顶栏图例 (12.5px 清晰字号)
            ctx.save();
            ctx.font = 'bold 12.5px "JetBrains Mono", "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = palette.vLine;
            ctx.fillRect(padLeft, 9, 10, 10);
            ctx.fillStyle = '#1e293b';
            ctx.fillText('CH-A: 实测电压 (0 ~ 20V)', padLeft + 15, 7);

            ctx.fillStyle = palette.tLine;
            ctx.fillRect(padLeft + 210, 9, 10, 10);
            ctx.fillStyle = '#1e293b';
            ctx.fillText(
              `CH-B: 实测扭矩 (${tMin.toFixed(1)} ~ ${tMax.toFixed(1)} N·m)`,
              padLeft + 225,
              7
            );

            if (p.isPaused) {
              ctx.fillStyle = '#dc2626';
              ctx.textAlign = 'right';
              ctx.fillText('[ ⏸ HOLD / 已暂停 ]', w - padRight, 7);
            }
            ctx.restore();

            let timeSpanText = `Window: ${p.maxPoints} pts · 等待数据流...`;
            if (pts.length > 1) {
              const spanSec = ((pts[pts.length - 1].time - pts[0].time) / 1000).toFixed(2);
              timeSpanText = `Span: ${spanSec}s (${pts.length} / ${p.maxPoints} pts)`;
            }
            ctx.fillStyle = palette.text;
            ctx.font = 'bold 12px "JetBrains Mono", "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(timeSpanText, padLeft + plotW / 2, h - padBottom + 9);

            const getY_V = (v: number) => {
              const ratio = (v - vMin) / (vMax - vMin);
              return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
            };

            const getY_T = (t: number) => {
              const ratio = (t - tMin) / (tMax - tMin);
              return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
            };

            // 2. 绘制目标与动态上限参考虚线 (12px 清晰字号)
            if (p.showTargetRef) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(padLeft, padTop, plotW, plotH);
              ctx.clip();

              const activeVRef = p.torqueEnabled ? p.vCeiling : p.vTarget;
              if (activeVRef > 0.01) {
                const yVRef = Math.round(getY_V(activeVRef)) + 0.5;
                ctx.strokeStyle = palette.vRefLine;
                ctx.lineWidth = 1.6;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yVRef);
                ctx.lineTo(w - padRight, yVRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = 'bold 12px "JetBrains Mono", "PingFang SC", monospace';
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
                ctx.lineWidth = 1.6;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padLeft, yTRef);
                ctx.lineTo(w - padRight, yTRef);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = 'bold 12px "JetBrains Mono", "PingFang SC", monospace';
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
              ctx.lineWidth = 2.4;
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
              ctx.lineWidth = 2.4;
              ctx.lineJoin = 'round';
              ctx.stroke();

              // 最新采样点实时指示头
              const lastPt = pts[count - 1];
              const lastX = offsetX + (count - 1) * stepX;
              const lastVy = getY_V(lastPt.voltage);
              const lastTy = getY_T(lastPt.torque);

              ctx.fillStyle = palette.vLine;
              ctx.beginPath();
              ctx.arc(lastX, lastVy, 4.5, 0, Math.PI * 2);
              ctx.fill();

              ctx.fillStyle = palette.tLine;
              ctx.beginPath();
              ctx.arc(lastX, lastTy, 4.5, 0, Math.PI * 2);
              ctx.fill();

              ctx.restore();

              // 4. 十字探针光标与测量浮窗 (放大至 12px/13px)
              const m = mouseRef.current;
              if (
                m.hovering &&
                m.x !== null &&
                m.x >= padLeft &&
                m.x <= padLeft + plotW
              ) {
                ctx.save();
                ctx.strokeStyle = palette.crosshair;
                ctx.lineWidth = 1.2;
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
                  ctx.arc(ptX, ptVy, 5, 0, Math.PI * 2);
                  ctx.fill();

                  ctx.fillStyle = palette.tLine;
                  ctx.beginPath();
                  ctx.arc(ptX, ptTy, 5, 0, Math.PI * 2);
                  ctx.fill();

                  const tipW = 204;
                  const tipH = 76;
                  let tipX = m.x + 14;
                  if (tipX + tipW > w - padRight) tipX = m.x - tipW - 14;
                  let tipY = Math.min(ptVy, ptTy) - 26;
                  if (tipY < padTop + 6) tipY = padTop + 6;
                  if (tipY + tipH > h - padBottom) tipY = h - padBottom - tipH;

                  ctx.fillStyle = palette.tooltipBg;
                  ctx.strokeStyle = palette.tooltipBorder;
                  ctx.lineWidth = 1.5;
                  ctx.beginPath();
                  ctx.roundRect(tipX, tipY, tipW, tipH, 8);
                  ctx.fill();
                  ctx.stroke();

                  const relSec = ((pt.time - pts[0].time) / 1000).toFixed(2);
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'top';
                  ctx.font = 'bold 11.5px "JetBrains Mono", Consolas, monospace';
                  ctx.fillStyle = palette.text;
                  ctx.fillText(`T+${relSec}s [#${pointIdx}]`, tipX + 12, tipY + 9);
                  ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
                  ctx.fillStyle = palette.vLine;
                  ctx.fillText(`CH-A: ${pt.voltage.toFixed(3)} V`, tipX + 12, tipY + 29);
                  ctx.fillStyle = palette.tLine;
                  ctx.fillText(`CH-B: ${pt.torque.toFixed(3)} N·m`, tipX + 12, tipY + 50);
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
      <div className="relative w-full h-full min-h-[260px] overflow-hidden bg-[#f1f5f9]">
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
