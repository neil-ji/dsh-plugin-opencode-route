// Session-header route chip for OpenCode Go.
//
// Lives in `conversation.session.header.utilities`, not the composer: the route
// is session-level state, and the header has room without pushing the input box.
// Hover shows the full status; the ↻ button re-picks the route in place.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-opencode-route',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    let createPortal = null;
    try { createPortal = require('react-dom').createPortal; } catch { createPortal = null; }

    const STYLE_ID = 'opencode-route-chip-style';
    // The header remounts when the session changes, so the chip would otherwise
    // start from "no data" every time. Keep the last payload per session: a
    // switch back paints instantly, and a first visit shows a skeleton instead
    // of vanishing for a poll interval.
    const SESSION_CACHE = new Map();
    const CACHE_LIMIT = 40;
    function remember(sessionId, payload) {
      if (sessionId === null) return;
      SESSION_CACHE.delete(sessionId);
      SESSION_CACHE.set(sessionId, payload);
      while (SESSION_CACHE.size > CACHE_LIMIT) SESSION_CACHE.delete(SESSION_CACHE.keys().next().value);
    }
    const CSS = `
@keyframes orPulse { 0%{opacity:.35} 50%{opacity:1} 100%{opacity:.35} }
/* Matches the native session-header control: border-box 24px tall, 8px radius, 1px
   border-l2, transparent fill. A read-only badge: dot, optional arm tag, number. */
.orCapsule{box-sizing:border-box;display:inline-flex;align-items:center;align-self:center;gap:6px;
  height:24px;min-height:24px;max-height:24px;padding:0 8px;
  border-radius:8px;border:1px solid var(--or-border,rgba(0,0,0,.16));background:none;
  font-size:11px;line-height:1;color:var(--or-fg2,#61666b);white-space:nowrap;
  user-select:none;cursor:default;max-width:min(260px,46vw)}
.orCapsule *{box-sizing:border-box}
.orDot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--or-fg2,#61666b)}
.orDot.fast{background:#22c55e}
.orDot.slow{background:#f59e0b}
.orDot.busy{background:var(--or-fg,#0f1115);animation:orPulse 1s ease-in-out infinite}
.orDot.off{background:var(--or-fg2,#61666b)}
.orLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}
.orNum{font-variant-numeric:tabular-nums;color:var(--or-fg,#0f1115);
  width:60px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Odometer: each changed character rolls inside its own clipped cell, so the
   rest of the number (and the unit) never moves. */
.orRoll{display:inline-flex;align-items:baseline;vertical-align:baseline}
.orRollCell{position:relative;display:inline-block;height:1.15em;line-height:1.15em;
  overflow:hidden;vertical-align:baseline}
.orRollOld{position:absolute;left:0;top:0;animation:orRollOut .2s ease-in forwards}
.orRollNew{display:inline-block;animation:orRollIn .2s ease-out}
@keyframes orRollIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes orRollOut{from{transform:translateY(0)}to{transform:translateY(-100%)}}
@media (prefers-reduced-motion: reduce){.orRollOld{display:none}.orRollNew{animation:none}}
/* Text states (待选/对照组) are transient, so they size to their content
   instead of reserving the numeric slot: that is where most of the width went. */
.orNum.text{width:auto;text-align:left}
.orTag{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 4px;
  border-radius:8px;background:rgba(127,127,127,.12);
  font-size:9px;font-weight:600;line-height:1;letter-spacing:.04em;
  color:var(--or-fg2,#61666b)}
.orSkel{display:block;width:22px;height:7px;border-radius:2px;
  background:rgba(127,127,127,.18);margin-left:auto}
.orSrOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion: reduce){ .orDot.busy{animation:none} }
.orTip{position:fixed;z-index:10000;display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:16px;
  color:var(--or-fg2,#61666b);padding:9px 11px;border-radius:8px;max-width:420px;min-width:230px;
  background:var(--or-surface,#fff);border:1px solid var(--or-border,rgba(0,0,0,.16));
  box-shadow:0 8px 28px rgba(0,0,0,.16);pointer-events:none}
.orTable{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-top:1px}
.orTable th{font-weight:500;font-size:10px;letter-spacing:.03em;text-align:right;
  color:var(--or-fg2,#61666b);padding:0 0 4px;border-bottom:1px solid var(--or-border,rgba(0,0,0,.16))}
.orTable th:first-child{text-align:left}
.orTable td{text-align:right;white-space:nowrap;padding:3px 0 0;color:var(--or-fg,#0f1115)}
.orTable td:first-child{text-align:left;color:var(--or-fg2,#61666b)}
.orTable td:last-child{color:var(--or-fg2,#61666b)}
.orTip .num{font-variant-numeric:tabular-nums}
`;

    // 4 digits fit the slot; beyond that the unit changes to keep it short.
    // (A real turn never gets there — the burst filter caps the window — but the
    // badge should still read sensibly if it ever does.)
    function formatSpeed(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      if (n >= 1_000_000 || n / 1000 >= 999.95) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
      return String(Math.round(n));
    }

    // The stated colours are literals on purpose: relying on the host's CSS
    // variables couples this chip to an internal naming scheme. Instead read the
    // rendered page background once per render and pick the matching palette.
    const LIGHT_THEME = {
      fg: '#0f1115', fg2: '#61666b', border: 'rgba(0,0,0,.16)', surface: '#ffffff',
      shadow: '0 6px 20px rgba(0,0,0,.14)',
    };
    const DARK_THEME = {
      fg: '#f9fafb', fg2: '#cfd3d6', border: 'rgba(255,255,255,.2)', surface: '#2c2c2e',
      shadow: '0 6px 20px rgba(0,0,0,.5)',
    };
    function channelLuminance(color) {
      const match = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/.exec(color ?? '');
      if (match === null) return null;
      if (match[4] !== undefined && Number(match[4]) === 0) return null;
      return (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
    }
    function paletteOf(element) {
      // Walk out from the chip: the canvas colour can live on the body, on the
      // root, or on an app wrapper, and none of those names are ours to rely on.
      let luminance = null;
      for (let node = element; node !== null && luminance === null; node = node.parentElement) {
        luminance = channelLuminance(getComputedStyle(node).backgroundColor);
      }
      if (luminance === null) luminance = channelLuminance(getComputedStyle(document.body).backgroundColor);
      if (luminance === null) luminance = channelLuminance(getComputedStyle(document.documentElement).backgroundColor);
      const dark = luminance === null
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : luminance < 0.5;
      return dark ? DARK_THEME : LIGHT_THEME;
    }

    // The event log is ISO/UTC; the panel shows local wall-clock time.
    function clock(iso) {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? String(iso).slice(11, 19) : d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    // Odometer: only the characters that changed roll, each inside its own
    // clipped cell. The number never reflows, and a one-digit change does not
    // redraw the whole value.
    function RollingNumber(props) {
      const text = formatSpeed(props.value);
      const previous = useRef(text);
      const old = previous.current;
      useEffect(() => { previous.current = text; }, [text]);
      const oldChars = [...old];
      const chars = [...text];
      return h('span', { className: 'orRoll' }, chars.map((ch, index) => {
        // compare from the right so the ones digit stays in place when the value
        // grows or shrinks by a digit
        const fromRight = chars.length - 1 - index;
        const was = oldChars[oldChars.length - 1 - fromRight];
        const changed = was !== undefined && was !== ch;
        return h('span', { key: `${fromRight}-${ch}`, className: 'orRollCell' },
          changed ? h('span', { className: 'orRollOld', 'aria-hidden': 'true' }, was) : null,
          h('span', { className: changed ? 'orRollNew' : undefined }, ch),
        );
      }));
    }

    function Speed(props) {
      return h(React.Fragment, null, h(RollingNumber, { value: props.value }), ' tok/s');
    }

    function Chip(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : null;
      const [data, setData] = useState(() => (sessionId === null ? null : SESSION_CACHE.get(sessionId) ?? null));
      const dataId = useRef(sessionId);
      const [failures, setFailures] = useState(0);
      const [hover, setHover] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const chipRef = useRef(null);
      const hideTimer = useRef(null);

      const current = dataId.current === sessionId ? data : (sessionId === null ? null : SESSION_CACHE.get(sessionId) ?? null);

      useEffect(() => {
        if (!sessionId) return undefined;
        setFailures(0);
        let alive = true;
        let timer;
        let state = null;
        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
        }
        let running = false;
        const tick = async () => {
          if (!alive || running) return;
          // A hidden window does not need a 3 s poll; check rarely and refresh
          // immediately when it comes back.
          if (document.hidden) {
            timer = setTimeout(tick, 15000);
            return;
          }
          running = true;
          try {
            const res = await fetch(`/opencode-route/status?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
            if (res.ok && alive) {
              const next = await res.json();
              state = next.state;
              dataId.current = sessionId;
              remember(sessionId, next);
              setData(next);
              setFailures(0);
            } else if (alive) {
              setFailures((value) => value + 1);
            }
          } catch {
            if (alive) setFailures((value) => value + 1);
          } finally {
            running = false;
          }
          if (alive) timer = setTimeout(tick, 3000);
        };
        const onVisible = () => {
          if (document.hidden) return;
          clearTimeout(timer);
          void tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        void tick();
        return () => {
          alive = false;
          clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisible);
          if (hideTimer.current) clearTimeout(hideTimer.current);
        };
      }, [sessionId]);

      const place = () => {
        const node = chipRef.current;
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const below = rect.top < window.innerHeight * 0.4;
        const width = 420;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        return below
          ? { left: `${left}px`, top: `${rect.bottom + 8}px`, maxWidth: `${width}px` }
          : { left: `${left}px`, bottom: `${window.innerHeight - rect.top + 8}px`, maxWidth: `${width}px` };
      };

      const showTip = () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        const pos = place();
        if (pos) setAnchor(pos);
        setHover(true);
      };
      const scheduleHide = () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setHover(false), 140);
      };

      if (!sessionId) return null;
      if (!current) {
        if (failures >= 3) {
          return h('div', { className: 'orCapsule', title: '宿主没有注册 /opencode-route/status' },
            h('span', { className: 'orDot off' }),
            h('span', { className: 'orLabel' }, h('span', { className: 'orNum text' }, '未就绪')));
        }
        // Same box, same height: only the content fills in.
        return h('div', { className: 'orCapsule', 'aria-hidden': 'true' },
          h('span', { className: 'orDot off' }),
          h('span', { className: 'orLabel' }, h('span', { className: 'orNum' }, h('span', { className: 'orSkel' }))));
      }
      if (!current.enabled) return null;

      const arm = typeof current.arm === 'string' ? current.arm : 'off';
      const control = arm === 'control';
      // A single request is a noisy reading: bursts inflate it and a slow tool
      // step deflates it. The badge shows the median of the last three usable
      // requests (window >= 500 ms, at least 60 output tokens) so the number
      // moves only when the session's speed actually changes.
      const recentTurns = Array.isArray(current.turns) ? current.turns : [];
      const usable = (row) => typeof row.tps === 'number' && row.tps > 0 && row.tps <= 1000
        && (row.decodeMs === null || row.decodeMs === undefined || row.decodeMs >= 500)
        && (row.out === null || row.out === undefined || row.out >= 60);
      const sample = recentTurns.filter(usable).slice(-3).map((row) => row.tps).sort((a, b) => a - b);
      const median = sample.length ? sample[Math.floor((sample.length - 1) / 2)] : null;
      // Same definition as DSH's composer footer: total output over total decode
      // across the session, so one buffered burst cannot move it.
      const rate = current.rate && typeof current.rate.tps === 'number' && current.rate.tps > 0 ? current.rate.tps : null;
      const tps = rate ?? median;
      let dot = 'off';
      let textLabel = null;
      if (control) { dot = 'off'; textLabel = '对照组'; }
      else if (tps !== null) { dot = tps >= 150 ? 'fast' : 'slow'; }
      else textLabel = '待选';

      // The hover panel is just the table: the chip already carries the state,
      // and the column headers explain the rows without prose.
      const tipRows = [];
      if (recentTurns.length) {
        const rows = recentTurns.slice(-3).reverse();
        const cell = (value) => h('td', null, value);
        tipRows.push(h('table', { key: 'table', className: 'orTable' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, '时间'), h('th', { scope: 'col' }, '速度'),
            h('th', { scope: 'col' }, '首字'), h('th', { scope: 'col' }, '缓存'))),
          h('tbody', null, rows.map((row, index) => h('tr', { key: `${row.ts}-${index}` },
            cell(clock(row.ts)),
            cell(usable(row) ? `${formatSpeed(row.tps)} tok/s` : '—'),
            cell(row.ttfbMs ? `${(row.ttfbMs / 1000).toFixed(1)}s` : '—'),
            cell(row.cacheHit === null || row.cacheHit === undefined ? '—' : `${row.cacheHit}%`),
          )))));
      }

      const palette = paletteOf(chipRef.current);
      const theme = {
        '--or-fg': palette.fg,
        '--or-fg2': palette.fg2,
        '--or-border': palette.border,
        '--or-surface': palette.surface,
        '--or-shadow': palette.shadow,
      };
      const floating = hover && anchor && tipRows.length
        ? h('div', { className: 'orTip', style: { ...anchor, ...theme } }, tipRows)
        : null;
      const portal = floating === null ? null
        : (createPortal ? createPortal(floating, document.body) : floating);

      // One atomic status sentence for assistive tech; the visible parts are
      // aria-hidden so a polling update does not announce a bare number.
      const statusText = control
        ? '实验对照组，不回滚重试'
        : tps !== null ? `当前 ${formatSpeed(tps)} tok/s` : '还没有足够长的样本';
      return h(React.Fragment, null,
        h('div', {
          className: 'orCapsule',
          ref: chipRef,
          style: theme,
          role: 'group',
          'aria-label': 'OpenCode Go 路由',
          onMouseEnter: showTip,
          onMouseLeave: scheduleHide,
        },
          h('span', { className: `orDot ${dot}`, 'aria-hidden': 'true' }),
          current.experiment && current.experiment.enabled
            ? h('span', {
              className: 'orTag',
              title: control ? 'A/B 实验：对照组' : 'A/B 实验：处理组',
            }, '实验')
            : null,
          h('span', { className: 'orLabel' },
            h('span', { className: textLabel !== null ? 'orNum text' : 'orNum', 'aria-hidden': 'true' },
              textLabel !== null ? textLabel : h(Speed, { value: tps })),
          ),
          h('span', { className: 'orSrOnly', role: 'status', 'aria-atomic': 'true' }, statusText),
        ),
        portal,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          // Leftmost in the right-aligned utilities row: this chip's width changes
          // with the number (and with 挑选中/对照组), so it must not sit in front
          // of any other cell. Being first, its growth only moves its own left edge.
          name: 'conversation.session.header.utilities', id: 'opencode-route', order: -100,
        }, Chip));
      },
    };
  },
});
