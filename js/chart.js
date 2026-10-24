/**
 * @file chart.js
 * @brief 高性能工业/实验室级双通道实时 Canvas 示波器 (电压通道 & 扭矩通道 & 目标参考轨迹)
 * @architecture Cleanroom White + Ice Blue 极客纯白与浅蓝仪器视觉规范
 */

(function (global) {
    'use strict';

    class RealtimeScope {
        constructor(canvasId, options = {}) {
            this.canvas = document.getElementById(canvasId);
            if (!this.canvas) throw new Error(`Canvas element #${canvasId} not found`);
            this.ctx = this.canvas.getContext('2d');

            // 配置参数
            this.maxPoints = options.maxPoints || 500; // 屏幕显示的历史点数
            this.vMin = 0.0;
            this.vMax = 20.0; // 电压轴量程 0 ~ 20V
            this.tMin = -0.5;
            this.tMax = 5.0;  // 扭矩轴初始量程 (支持自适应扩展)
            this.autoScaleTorque = true;
            this.showTargetRef = true;

            // 当前控制参考值 (用于绘制目标/限幅参考线)
            this.refState = {
                mode: 'voltage',    // 'voltage' | 'torque'
                vTarget: 0.0,       // 手动电压目标 (V)
                tTarget: 0.0,       // 闭环扭矩目标 (N·m)
                vCeiling: 0.0,      // 闭环动态电压上限 Vmax (V)
                torqueEnabled: false
            };

            // 数据缓存队列: { time, voltage, torque, vRef, tRef }
            this.data = [];
            this.isPaused = false;

            // 交互光标
            this.mouseX = null;
            this.mouseY = null;
            this.isHovering = false;

            // 调色盘规范：纯白 + 冰蓝 Cleanroom 实验室仪表调色体系
            this.theme = {
                bg: '#f8fafc',                              // 浅亮仪器背景
                gridMajor: 'rgba(15, 23, 42, 0.08)',         // 主分度线
                gridMinor: 'rgba(15, 23, 42, 0.03)',         // 副分度线
                text: '#64748b',                            // 轴标签文字
                textBright: '#334155',                      // 标头文字
                accentLine: 'rgba(15, 23, 42, 0.16)',       // 外框线
                voltageLine: '#0284c7',                     // 通道 A: 湛蓝 (Electric Sky Blue)
                voltageRefLine: 'rgba(2, 132, 199, 0.55)',  // 电压目标/上限参考虚线
                voltageFillTop: 'rgba(2, 132, 199, 0.16)',
                voltageFillBottom: 'rgba(2, 132, 199, 0.01)',
                torqueLine: '#d97706',                      // 通道 B: 机械金 (Machine Amber)
                torqueRefLine: 'rgba(217, 119, 6, 0.65)',   // 扭矩目标参考虚线
                torqueFillTop: 'rgba(217, 119, 6, 0.16)',
                torqueFillBottom: 'rgba(217, 119, 6, 0.01)',
                crosshair: 'rgba(15, 23, 42, 0.45)',        // 准星虚线
                tooltipBg: 'rgba(255, 255, 255, 0.96)',      // 悬浮提示框背景
                tooltipBorder: 'rgba(2, 132, 199, 0.35)'     // 悬浮提示框边框
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
         * 更新当前目标参考线状态
         */
        setTargets(state = {}) {
            Object.assign(this.refState, state);
        }

        /**
         * 设置历史采样窗口点数 (时基缩放)
         */
        setMaxPoints(maxPoints) {
            const n = parseInt(maxPoints, 10);
            if (Number.isFinite(n) && n >= 50 && n <= 5000) {
                this.maxPoints = n;
                while (this.data.length > this.maxPoints) {
                    this.data.shift();
                }
            }
        }

        setShowTargetRef(show) {
            this.showTargetRef = Boolean(show);
        }

        /**
         * 推送一帧新数据点
         * @param {number} voltage 电压值 (V)
         * @param {number} torque 扭矩值 (N·m)
         * @param {number} time 时间戳 (ms)
         */
        pushData(voltage, torque, time = performance.now()) {
            if (this.isPaused) return;

            const vRef = this.refState.torqueEnabled ? this.refState.vCeiling : this.refState.vTarget;
            const tRef = this.refState.tTarget;

            this.data.push({
                time: time,
                voltage: Number(voltage) || 0.0,
                torque: Number(torque) || 0.0,
                vRef: Number(vRef) || 0.0,
                tRef: Number(tRef) || 0.0
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
            let csv = 'Index,RelTimeSec,Voltage_V,Torque_Nm,VoltageRef_V,TorqueRef_Nm\n';
            this.data.forEach((p, idx) => {
                const relTime = ((p.time - t0) / 1000).toFixed(4);
                csv += `${idx},${relTime},${p.voltage.toFixed(4)},${p.torque.toFixed(4)},${(p.vRef || 0).toFixed(4)},${(p.tRef || 0).toFixed(4)}\n`;
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
            const padLeft = 58;
            const padRight = 58;
            const padTop = 34;
            const padBottom = 32;

            const plotW = w - padLeft - padRight;
            const plotH = h - padTop - padBottom;

            if (plotW <= 0 || plotH <= 0) return;

            // 计算动态自适应扭矩刻度 (包含目标参考线防止越界)
            let tMin = this.tMin;
            let tMax = this.tMax;
            if (this.autoScaleTorque && this.data.length > 0) {
                let minT = 0.0;
                let maxT = this.refState.tTarget > 0 ? this.refState.tTarget : 0.5;
                for (let i = 0; i < this.data.length; i++) {
                    const t = this.data[i].torque;
                    const tr = this.data[i].tRef || 0;
                    if (t < minT) minT = t;
                    if (t > maxT) maxT = t;
                    if (this.showTargetRef && tr > maxT) maxT = tr;
                }
                if (Number.isFinite(minT) && Number.isFinite(maxT)) {
                    const span = Math.max(1.0, maxT - minT);
                    tMin = Math.floor((minT - span * 0.1) * 10) / 10;
                    tMax = Math.ceil((maxT + span * 0.18) * 10) / 10;
                }
            }

            // 2. 绘制网格与时间刻度 (Tektronix Reticle 风格)
            ctx.lineWidth = 1;
            const gridRows = 6;
            const gridCols = 8;

            // 横向网格线 (电压与扭矩分度)
            for (let r = 0; r <= gridRows; r++) {
                const y = Math.round(padTop + (plotH / gridRows) * r) + 0.5;
                ctx.strokeStyle = (r === 0 || r === gridRows) ? this.theme.accentLine : this.theme.gridMajor;
                ctx.beginPath();
                ctx.moveTo(padLeft, y);
                ctx.lineTo(w - padRight, y);
                ctx.stroke();

                // 标定左 Y 轴刻度 (电压 0 ~ 20V)
                const vVal = this.vMax - (this.vMax - this.vMin) * (r / gridRows);
                ctx.fillStyle = this.theme.voltageLine;
                ctx.font = '11px "JetBrains Mono", Consolas, monospace';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(`${vVal.toFixed(1)}V`, padLeft - 8, y);

                // 标定右 Y 轴刻度 (扭矩 N·m)
                const tVal = tMax - (tMax - tMin) * (r / gridRows);
                ctx.fillStyle = this.theme.torqueLine;
                ctx.textAlign = 'left';
                ctx.fillText(`${tVal.toFixed(1)}`, w - padRight + 8, y);
            }

            // 纵向网格线
            for (let c = 0; c <= gridCols; c++) {
                const x = Math.round(padLeft + (plotW / gridCols) * c) + 0.5;
                ctx.strokeStyle = (c === 0 || c === gridCols) ? this.theme.accentLine : this.theme.gridMajor;
                ctx.beginPath();
                ctx.moveTo(x, padTop);
                ctx.lineTo(x, h - padBottom);
                ctx.stroke();
            }

            // 计算实际时间跨度说明
            let timeSpanText = `历史窗口容量: ${this.maxPoints} 点 (等待数据流...)`;
            if (this.data.length > 1) {
                const spanSec = ((this.data[this.data.length - 1].time - this.data[0].time) / 1000).toFixed(1);
                timeSpanText = `实时时间跨度: ${spanSec} 秒 (已采样 ${this.data.length} / ${this.maxPoints} 点)`;
            }
            ctx.fillStyle = this.theme.text;
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(timeSpanText, padLeft + plotW / 2, h - padBottom + 10);

            const getY_V = (v) => {
                const ratio = (v - this.vMin) / (this.vMax - this.vMin);
                return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
            };

            const getY_T = (t) => {
                const ratio = (t - tMin) / (tMax - tMin);
                return padTop + plotH * (1 - Math.max(0, Math.min(1, ratio)));
            };

            // 2.5 绘制目标/上限参考虚线 (Target / Ceiling Reference Lines)
            if (this.showTargetRef) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(padLeft, padTop, plotW, plotH);
                ctx.clip();

                const activeVRef = this.refState.torqueEnabled ? this.refState.vCeiling : this.refState.vTarget;
                if (activeVRef > 0.01) {
                    const yVRef = Math.round(getY_V(activeVRef)) + 0.5;
                    ctx.strokeStyle = this.theme.voltageRefLine;
                    ctx.lineWidth = 1.2;
                    ctx.setLineDash([6, 4]);
                    ctx.beginPath();
                    ctx.moveTo(padLeft, yVRef);
                    ctx.lineTo(w - padRight, yVRef);
                    ctx.stroke();

                    ctx.setLineDash([]);
                    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
                    ctx.fillStyle = this.theme.voltageLine;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'bottom';
                    const vLabel = this.refState.torqueEnabled
                        ? `Vmax 限幅: ${activeVRef.toFixed(2)}V`
                        : `V 目标: ${activeVRef.toFixed(2)}V`;
                    ctx.fillText(vLabel, padLeft + 6, Math.max(padTop + 12, yVRef - 3));
                }

                if (this.refState.tTarget > 0.005) {
                    const yTRef = Math.round(getY_T(this.refState.tTarget)) + 0.5;
                    ctx.strokeStyle = this.theme.torqueRefLine;
                    ctx.lineWidth = 1.2;
                    ctx.setLineDash([6, 4]);
                    ctx.beginPath();
                    ctx.moveTo(padLeft, yTRef);
                    ctx.lineTo(w - padRight, yTRef);
                    ctx.stroke();

                    ctx.setLineDash([]);
                    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
                    ctx.fillStyle = this.theme.torqueLine;
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(`T 目标: ${this.refState.tTarget.toFixed(3)} N·m`, w - padRight - 6, Math.max(padTop + 12, yTRef - 3));
                }
                ctx.restore();
            }

            // 3. 映射与绘制曲线
            if (this.data.length > 1) {
                const count = this.data.length;
                const stepX = plotW / (this.maxPoints - 1);
                // 数据靠右对齐
                const offsetX = padLeft + (this.maxPoints - count) * stepX;

                ctx.save();
                ctx.beginPath();
                ctx.rect(padLeft, padTop, plotW, plotH);
                ctx.clip(); // 限制在示波器绘图区内

                // (A) 绘制电压通道渐变面积
                const gradV = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
                gradV.addColorStop(0, this.theme.voltageFillTop);
                gradV.addColorStop(1, this.theme.voltageFillBottom);

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
                ctx.fillStyle = gradV;
                ctx.fill();

                // (A) 绘制电压折线
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
                ctx.stroke();

                // (B) 绘制扭矩通道渐变面积
                const gradT = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
                gradT.addColorStop(0, this.theme.torqueFillTop);
                gradT.addColorStop(1, this.theme.torqueFillBottom);

                ctx.beginPath();
                ctx.moveTo(offsetX, getY_T(this.data[0].torque));
                for (let i = 1; i < count; i++) {
                    const px = offsetX + i * stepX;
                    const py = getY_T(this.data[i].torque);
                    ctx.lineTo(px, py);
                }
                ctx.lineTo(offsetX + (count - 1) * stepX, padTop + plotH);
                ctx.lineTo(offsetX, padTop + plotH);
                ctx.closePath();
                ctx.fillStyle = gradT;
                ctx.fill();

                // (B) 绘制扭矩折线
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

                        // 绘制捕获点高亮圆环
                        ctx.setLineDash([]);
                        ctx.fillStyle = this.theme.voltageLine;
                        ctx.beginPath();
                        ctx.arc(ptX, ptVy, 4, 0, Math.PI * 2);
                        ctx.fill();

                        ctx.fillStyle = this.theme.torqueLine;
                        ctx.beginPath();
                        ctx.arc(ptX, ptTy, 4, 0, Math.PI * 2);
                        ctx.fill();

                        // 悬浮 Tooltip 卡片
                        const tipW = 186;
                        const tipH = 68;
                        let tipX = this.mouseX + 14;
                        if (tipX + tipW > w - padRight) tipX = this.mouseX - tipW - 14;
                        let tipY = Math.min(ptVy, ptTy) - 24;
                        if (tipY < padTop + 5) tipY = padTop + 5;
                        if (tipY + tipH > h - padBottom) tipY = h - padBottom - tipH;

                        ctx.fillStyle = this.theme.tooltipBg;
                        ctx.strokeStyle = this.theme.tooltipBorder;
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.roundRect(tipX, tipY, tipW, tipH, 6);
                        ctx.fill();
                        ctx.stroke();

                        const relSec = ((pt.time - this.data[0].time) / 1000).toFixed(2);
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'top';
                        ctx.font = '10px "JetBrains Mono", Consolas, monospace';
                        ctx.fillStyle = this.theme.text;
                        ctx.fillText(`⏱ T+${relSec}s (#${pointIdx})`, tipX + 10, tipY + 8);
                        ctx.font = '11px "JetBrains Mono", Consolas, monospace';
                        ctx.fillStyle = this.theme.voltageLine;
                        ctx.fillText(`● 电压: ${pt.voltage.toFixed(3)} V`, tipX + 10, tipY + 26);
                        ctx.fillStyle = this.theme.torqueLine;
                        ctx.fillText(`● 扭矩: ${pt.torque.toFixed(3)} N·m`, tipX + 10, tipY + 45);
                    }
                    ctx.restore();
                }
            }

            // 5. 顶栏示波器状态图例
            ctx.save();
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            // 通道 A 图例
            ctx.fillStyle = this.theme.voltageLine;
            ctx.fillRect(padLeft, 11, 8, 8);
            ctx.fillStyle = this.theme.textBright;
            ctx.fillText('CH A: 实测电压 (0 ~ 20V)', padLeft + 14, 10);

            // 通道 B 图例
            ctx.fillStyle = this.theme.torqueLine;
            ctx.fillRect(padLeft + 185, 11, 8, 8);
            ctx.fillStyle = this.theme.textBright;
            ctx.fillText(`CH B: 实测扭矩 (${tMin.toFixed(1)} ~ ${tMax.toFixed(1)} N·m)`, padLeft + 199, 10);

            if (this.isPaused) {
                ctx.fillStyle = '#dc2626';
                ctx.font = 'bold 11px "JetBrains Mono", monospace';
                ctx.textAlign = 'right';
                ctx.fillText('[ ⏸ 示波器已暂停采集 ]', w - padRight, 10);
            }
            ctx.restore();
        }
    }

    global.RealtimeScope = RealtimeScope;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this)));
