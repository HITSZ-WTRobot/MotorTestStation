/**
 * @file chart.js
 * @brief 高性能工业级双通道实时 Canvas 示波器 (电压通道 & 扭矩通道)
 */

(function (global) {
    'use strict';

    class RealtimeScope {
        constructor(canvasId, options = {}) {
            this.canvas = document.getElementById(canvasId);
            if (!this.canvas) throw new Error(`Canvas element #${canvasId} not found`);
            this.ctx = this.canvas.getContext('2d');

            // 配置参数
            this.maxPoints = options.maxPoints || 500; // 屏幕显示的历史点数 (约 25 秒)
            this.vMin = 0.0;
            this.vMax = 20.0; // 电压轴量程 0 ~ 20V
            this.tMin = -5.0;
            this.tMax = 25.0; // 扭矩轴量程 -5 ~ 25 Nm (支持自适应或固定)
            this.autoScaleTorque = true;

            // 数据缓存队列
            this.data = []; // { time, voltage, torque }
            this.isPaused = false;

            // 交互光标
            this.mouseX = null;
            this.mouseY = null;
            this.isHovering = false;

            // 调色盘规范（与工业深暗风格契合）
            this.theme = {
                bg: '#080c14',
                gridMajor: '#17223b',
                gridMinor: '#0f172a',
                text: '#64748b',
                accentLine: '#1e293b',
                voltageLine: '#38bdf8',     // Sky Blue
                voltageFill: 'rgba(56, 189, 248, 0.08)',
                torqueLine: '#f59e0b',      // Amber Gold
                torqueFill: 'rgba(245, 158, 11, 0.08)',
                crosshair: 'rgba(148, 163, 184, 0.5)',
                tooltipBg: 'rgba(15, 23, 42, 0.92)'
            };

            this._setupEvents();
            this._resizeCanvas();
            window.addEventListener('resize', () => this._resizeCanvas());

            // 启动 60FPS 渲染循环
            this._renderLoop = this._renderLoop.bind(this);
            requestAnimationFrame(this._renderLoop);
        }

        _setupEvents() {
            this.canvas.addEventListener('mousemove', (e) => {
                const rect = this.canvas.getBoundingClientRect();
                this.mouseX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
                this.mouseY = (e.clientY - rect.top) * (this.canvas.height / rect.height);
                this.isHovering = true;
            });

            this.canvas.addEventListener('mouseleave', () => {
                this.isHovering = false;
                this.mouseX = null;
                this.mouseY = null;
            });
        }

        _resizeCanvas() {
            const dpr = window.devicePixelRatio || 1;
            const rect = this.canvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                this.canvas.width = rect.width * dpr;
                this.canvas.height = rect.height * dpr;
            }
        }

        /**
         * 推送一帧新数据点
         * @param {number} voltage 电压值 (V)
         * @param {number} torque 扭矩值
         * @param {number} time 时间戳 (ms)
         */
        pushData(voltage, torque, time = performance.now()) {
            if (this.isPaused) return;

            this.data.push({
                time: time,
                voltage: Number(voltage) || 0.0,
                torque: Number(torque) || 0.0
            });

            if (this.data.length > this.maxPoints) {
                this.data.shift();
            }
        }

        clear() {
            this.data = [];
        }

        togglePause() {
            this.isPaused = !this.isPaused;
            return this.isPaused;
        }

        /**
         * 导出当前记录的 CSV 数据
         */
        exportCsv() {
            if (this.data.length === 0) return null;
            const t0 = this.data[0].time;
            let csv = 'Index,RelTimeSec,Voltage_V,Torque_Nm\n';
            this.data.forEach((p, idx) => {
                const relTime = ((p.time - t0) / 1000).toFixed(4);
                csv += `${idx},${relTime},${p.voltage.toFixed(4)},${p.torque.toFixed(4)}\n`;
            });
            return csv;
        }

        _renderLoop() {
            this._draw();
            requestAnimationFrame(this._renderLoop);
        }

        _draw() {
            const ctx = this.ctx;
            const w = this.canvas.width;
            const h = this.canvas.height;
            if (w === 0 || h === 0) return;

            // 1. 清空背景
            ctx.fillStyle = this.theme.bg;
            ctx.fillRect(0, 0, w, h);

            // 边距
            const padLeft = 55;
            const padRight = 55;
            const padTop = 30;
            const padBottom = 32;

            const plotW = w - padLeft - padRight;
            const plotH = h - padTop - padBottom;

            if (plotW <= 0 || plotH <= 0) return;

            // 计算动态自适应扭矩刻度
            let tMin = this.tMin;
            let tMax = this.tMax;
            if (this.autoScaleTorque && this.data.length > 0) {
                let minT = Infinity;
                let maxT = -Infinity;
                for (let i = 0; i < this.data.length; i++) {
                    const t = this.data[i].torque;
                    if (t < minT) minT = t;
                    if (t > maxT) maxT = t;
                }
                if (Number.isFinite(minT) && Number.isFinite(maxT)) {
                    const span = Math.max(2.0, maxT - minT);
                    tMin = Math.floor(minT - span * 0.15);
                    tMax = Math.ceil(maxT + span * 0.15);
                }
            }

            // 2. 绘制网格与时间刻度
            ctx.lineWidth = 1;
            const gridRows = 6;
            const gridCols = 8;

            // 横向网格线 (电压与扭矩分度)
            for (let r = 0; r <= gridRows; r++) {
                const y = padTop + (plotH / gridRows) * r;
                ctx.strokeStyle = (r === 0 || r === gridRows) ? this.theme.accentLine : this.theme.gridMinor;
                ctx.beginPath();
                ctx.moveTo(padLeft, y);
                ctx.lineTo(w - padRight, y);
                ctx.stroke();

                // 标定左 Y 轴刻度 (电压 0 ~ 20V)
                const vVal = this.vMax - (this.vMax - this.vMin) * (r / gridRows);
                ctx.fillStyle = this.theme.voltageLine;
                ctx.font = '11px Consolas, monospace';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(`${vVal.toFixed(1)}V`, padLeft - 8, y);

                // 标定右 Y 轴刻度 (扭矩)
                const tVal = tMax - (tMax - tMin) * (r / gridRows);
                ctx.fillStyle = this.theme.torqueLine;
                ctx.textAlign = 'left';
                ctx.fillText(`${tVal.toFixed(1)}`, w - padRight + 8, y);
            }

            // 纵向网格线
            for (let c = 0; c <= gridCols; c++) {
                const x = padLeft + (plotW / gridCols) * c;
                ctx.strokeStyle = (c === 0 || c === gridCols) ? this.theme.accentLine : this.theme.gridMinor;
                ctx.beginPath();
                ctx.moveTo(x, padTop);
                ctx.lineTo(x, h - padBottom);
                ctx.stroke();
            }

            // 绘制底边时间轴说明
            ctx.fillStyle = this.theme.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText('历史时间窗口 (最近 ~25 秒 / 500 点)', padLeft + plotW / 2, h - padBottom + 10);

            // 3. 映射与绘制曲线
            if (this.data.length > 1) {
                const count = this.data.length;
                const stepX = plotW / (this.maxPoints - 1);
                // 数据靠右对齐
                const offsetX = padLeft + (this.maxPoints - count) * stepX;

                const getY_V = (v) => {
                    const ratio = (v - this.vMin) / (this.vMax - this.vMin);
                    return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
                };

                const getY_T = (t) => {
                    const ratio = (t - tMin) / (tMax - tMin);
                    return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
                };

                // (A) 绘制电压通道折线与半透明渐变
                ctx.save();
                ctx.beginPath();
                ctx.rect(padLeft, padTop, plotW, plotH);
                ctx.clip(); // 限制在示波器绘图区内

                // 阴影面积
                ctx.beginPath();
                ctx.moveTo(offsetX, getY_V(this.data[0].voltage));
                for (let i = 1; i < count; i++) {
                    const px = offsetX + i * stepX;
                    const py = getY_V(this.data[i].voltage);
                    ctx.lineTo(px, py);
                }
                ctx.lineTo(offsetX + (count - 1) * stepX, padTop + plotH);
                ctx.lineTo(offsetX, padTop + plotH);
                ctx.closePath();
                ctx.fillStyle = this.theme.voltageFill;
                ctx.fill();

                // 曲线
                ctx.beginPath();
                ctx.moveTo(offsetX, getY_V(this.data[0].voltage));
                for (let i = 1; i < count; i++) {
                    const px = offsetX + i * stepX;
                    const py = getY_V(this.data[i].voltage);
                    ctx.lineTo(px, py);
                }
                ctx.strokeStyle = this.theme.voltageLine;
                ctx.lineWidth = 2.0;
                ctx.lineJoin = 'round';
                ctx.shadowColor = this.theme.voltageLine;
                ctx.shadowBlur = 4;
                ctx.stroke();

                // (B) 绘制扭矩通道折线与半透明渐变
                ctx.beginPath();
                ctx.moveTo(offsetX, getY_T(this.data[0].torque));
                for (let i = 1; i < count; i++) {
                    const px = offsetX + i * stepX;
                    const py = getY_T(this.data[i].torque);
                    ctx.lineTo(px, py);
                }
                ctx.strokeStyle = this.theme.torqueLine;
                ctx.lineWidth = 2.0;
                ctx.lineJoin = 'round';
                ctx.shadowColor = this.theme.torqueLine;
                ctx.shadowBlur = 4;
                ctx.stroke();

                ctx.restore();

                // 4. 十字准星与悬停数值
                if (this.isHovering && this.mouseX !== null && this.mouseX >= padLeft && this.mouseX <= padLeft + plotW) {
                    ctx.save();
                    // 准星竖线
                    ctx.strokeStyle = this.theme.crosshair;
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.moveTo(this.mouseX, padTop);
                    ctx.lineTo(this.mouseX, padTop + plotH);
                    ctx.stroke();

                    // 计算光标最接近的数据索引
                    const relativeX = this.mouseX - offsetX;
                    const pointIdx = Math.round(relativeX / stepX);
                    if (pointIdx >= 0 && pointIdx < count) {
                        const pt = this.data[pointIdx];
                        const ptX = offsetX + pointIdx * stepX;
                        const ptVy = getY_V(pt.voltage);
                        const ptTy = getY_T(pt.torque);

                        // 绘制捕获点圆环
                        ctx.setLineDash([]);
                        ctx.fillStyle = this.theme.voltageLine;
                        ctx.beginPath();
                        ctx.arc(ptX, ptVy, 4, 0, Math.PI * 2);
                        ctx.fill();

                        ctx.fillStyle = this.theme.torqueLine;
                        ctx.beginPath();
                        ctx.arc(ptX, ptTy, 4, 0, Math.PI * 2);
                        ctx.fill();

                        // 悬浮 Tooltip 框
                        const tipW = 160;
                        const tipH = 54;
                        let tipX = this.mouseX + 12;
                        if (tipX + tipW > w - padRight) tipX = this.mouseX - tipW - 12;
                        let tipY = Math.min(ptVy, ptTy) - 20;
                        if (tipY < padTop + 5) tipY = padTop + 5;
                        if (tipY + tipH > h - padBottom) tipY = h - padBottom - tipH;

                        ctx.fillStyle = this.theme.tooltipBg;
                        ctx.strokeStyle = this.theme.accentLine;
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.roundRect(tipX, tipY, tipW, tipH, 6);
                        ctx.fill();
                        ctx.stroke();

                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'top';
                        ctx.font = '11px Consolas, monospace';
                        ctx.fillStyle = this.theme.voltageLine;
                        ctx.fillText(`● 电压: ${pt.voltage.toFixed(4)} V`, tipX + 10, tipY + 10);
                        ctx.fillStyle = this.theme.torqueLine;
                        ctx.fillText(`● 扭矩: ${pt.torque.toFixed(4)} Nm`, tipX + 10, tipY + 30);
                    }
                    ctx.restore();
                }
            }

            // 5. 顶栏示波器状态标识
            ctx.save();
            ctx.font = '12px "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillRect(padLeft, 10, 10, 10);
            ctx.fillText('通道 A: 实测输出电压 (0~20V)', padLeft + 16, 9);

            // 扭矩通道图例
            ctx.fillStyle = this.theme.torqueLine;
            ctx.fillRect(padLeft + 220, 10, 10, 10);
            ctx.fillText(`通道 B: 实测扭矩 (${tMin.toFixed(1)}~${tMax.toFixed(1)}Nm)`, padLeft + 236, 9);

            if (this.isPaused) {
                ctx.fillStyle = '#ef4444';
                ctx.font = 'bold 12px monospace';
                ctx.textAlign = 'right';
                ctx.fillText('[ ⏸ 示波器已暂停采集 ]', w - padRight, 9);
            }
            ctx.restore();
        }
    }

    global.RealtimeScope = RealtimeScope;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this)));
