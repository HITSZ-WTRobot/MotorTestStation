---
version: 2.1.0
name: Motor-Test-Station-Cleanroom-White-Azure
description: |
  A precision cleanroom laboratory & medical-grade hardware telemetry design system tailored for the STM32 Motor Test Station.
  Built around pure-white surfaces (#ffffff), soft light-ice-blue canvas (#f1f6fb), crisp light-slate hairlines (#e2e8f0),
  electric sky azure accents (#0284c7 / #38bdf8), machine amber gold (#d97706), and high-contrast tabular typography.

colors:
  # Surfaces (Cleanroom Light Depth Ladder)
  canvas: "#f1f6fb"               # Light ice-blue atmospheric wash
  surface-nav: "#ffffff"          # Top command bar
  surface-panel: "#ffffff"        # Container panels
  surface-card: "#f8fafc"         # Subtle secondary cards
  surface-card-hover: "#f0f7ff"   # Interactive hover highlight
  surface-sunken: "#edf2f7"       # Inputs, sliders, terminal well
  surface-accent-soft: "#e0f2fe"  # Badge and pill background

  # Hairlines & Borders
  hairline-subtle: "#f1f5f9"
  hairline: "#e2e8f0"
  hairline-bright: "#cbd5e1"
  hairline-cyan: "#7dd3fc"
  hairline-amber: "#fde68a"
  hairline-danger: "#fca5a5"

  # Inks & Typography (AAA High Contrast on White)
  ink-bright: "#0f172a"           # Deep slate navy
  ink: "#1e293b"                  # Body text
  ink-secondary: "#475569"        # Subtitles and table text
  ink-muted: "#64748b"            # Labels and tags
  ink-faint: "#94a3b8"            # Placeholder & secondary timestamps

  # Telemetry Channels & Semantics
  ch-a-voltage: "#0284c7"         # Channel A: Electric Sky Azure (0 ~ 18V)
  ch-a-voltage-light: "#38bdf8"
  ch-a-voltage-subtle: "#e0f2fe"
  ch-b-torque: "#d97706"          # Channel B: Machine Amber Gold
  ch-b-torque-subtle: "#fef3c7"
  semantic-success: "#16a34a"     # Emerald Green (Connected / Closed Loop Active)
  semantic-success-subtle: "#dcfce7"
  semantic-error: "#dc2626"       # Crimson Red (Stop / Fault / CRC Error)
  semantic-error-subtle: "#fee2e2"
  semantic-warning: "#d97706"     # Amber Warning

typography:
  font-sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', 'Helvetica Neue', Arial, sans-serif"
  font-mono: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, Consolas, monospace"
  tabular-nums: "font-variant-numeric: tabular-nums; font-feature-settings: 'tnum', 'zero'"

components:
  top-header:
    background: "{colors.surface-nav}"
    borderBottom: "1px solid {colors.hairline}"
    boxShadow: "0 1px 4px rgba(15, 23, 42, 0.04), 0 4px 16px rgba(15, 23, 42, 0.03)"
  
  oscilloscope:
    background: "#f8fafc"
    gridMajor: "rgba(15, 23, 42, 0.08)"
    gridMinor: "rgba(15, 23, 42, 0.03)"
    chAColor: "#0284c7"
    chBColor: "#d97706"
    hudTooltip: "rgba(255, 255, 255, 0.96) with #0284c7 border"

  tabs:
    background: "{colors.surface-sunken}"
    activeBg: "#ffffff"
    activeColor: "{colors.ch-a-voltage}"

  flash-save-button:
    background: "linear-gradient(180deg, #f0f9ff 0%, #e0f2fe 100%)"
    border: "1px solid {colors.ch-a-voltage}"
    hoverBackground: "linear-gradient(180deg, #0ea5e9 0%, #0284c7 100%)"
---
