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
    const CSS = `
@keyframes orPulse { 0%{opacity:.35} 50%{opacity:1} 100%{opacity:.35} }
/* Matches the native session-header control: border-box 24px tall, 8px radius, 1px
   border-l2, transparent fill. A read-only badge: dot, optional arm tag, number. */
.orCapsule{box-sizing:border-box;display:inline-flex;align-items:center;align-self:center;gap:6px;
  height:24px;min-height:24px;max-height:24px;padding:0 8px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:none;
  font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary,#5b6068);white-space:nowrap;
  user-select:none;cursor:default;max-width:min(260px,46vw)}
.orCapsule *{box-sizing:border-box}
.orDot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary,#61666b)}
.orDot.fast{background:var(--dsw-alias-state-success-primary)}
.orDot.slow{background:var(--dsw-alias-state-warn-primary)}
.orDot.busy{background:var(--dsw-alias-brand-primary);animation:orPulse 1s ease-in-out infinite}
.orDot.off{background:var(--dsw-alias-label-secondary,#61666b)}
.orLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}
.orNum{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1b1c1f);
  width:66px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orNum.text{text-align:center}
.orTag{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 5px;
  border-radius:8px;background:rgba(127,127,127,.12);
  font-size:9px;font-weight:600;line-height:1;letter-spacing:.04em;
  color:var(--dsw-alias-label-secondary,#5b6068)}
.orSrOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion: reduce){ .orDot.busy{animation:none} }
.orTip{position:fixed;z-index:10000;display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary,#5b6068);padding:9px 11px;border-radius:8px;max-width:420px;min-width:230px;
  background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 8px 28px rgba(0,0,0,.16);pointer-events:none}
.orTip b{font-weight:600;color:var(--dsw-alias-label-primary)}
.orTable{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-top:1px}
.orTable th{font-weight:500;font-size:10px;letter-spacing:.03em;text-align:right;
  color:var(--dsw-alias-label-secondary,#5b6068);padding:0 0 4px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.orTable th:first-child{text-align:left}
.orTable td{text-align:right;white-space:nowrap;padding:3px 0 0;color:var(--dsw-alias-label-primary)}
.orTable td:first-child{text-align:left;color:var(--dsw-alias-label-secondary)}
.orTable td:last-child{color:var(--dsw-alias-label-secondary)}
.orTip .num{font-variant-numeric:tabular-nums}
`;

    const REDUCE = '(prefers-reduced-motion: reduce)';

    // The event log is ISO/UTC; the panel shows local wall-clock time.
    function clock(iso) {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? String(iso).slice(11, 19) : d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    // Count up to a new speed instead of swapping the text in one frame: the
    // chip is a live readout, and a 380 ms ease makes the change readable
    // without drawing attention. Reduced motion gets the final value at once.
    function useCountUp(value, duration = 380) {
      const [shown, setShown] = useState(value);
      const current = useRef(value);
      useEffect(() => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          current.current = value;
          setShown(value);
          return undefined;
        }
        if (window.matchMedia?.(REDUCE).matches) {
          current.current = value;
          setShown(value);
          return undefined;
        }
        const from = typeof current.current === 'number' ? current.current : value;
        if (from === value) { setShown(value); return undefined; }
        const t0 = performance.now();
        let raf = 0;
        const tick = (now) => {
          const p = Math.min(1, (now - t0) / duration);
          const next = Math.round(from + (value - from) * (1 - (1 - p) ** 3));
          current.current = next;
          setShown(next);
          if (p < 1) raf = requestAnimationFrame(tick);
          else { current.current = value; setShown(value); }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [value, duration]);
      return shown;
    }

    function Speed(props) {
      const n = useCountUp(props.value);
      return h(React.Fragment, null, String(n), ' tok/s');
    }

    function Chip(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : null;
      const [data, setData] = useState(null);
      const [failures, setFailures] = useState(0);
      const [hover, setHover] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const chipRef = useRef(null);
      const hideTimer = useRef(null);

      useEffect(() => {
        if (!sessionId) return undefined;
        let alive = true;
        let timer;
        let state = null;
        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
        }
        const tick = async () => {
          try {
            const res = await fetch(`/opencode-route/status?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
            if (res.ok && alive) {
              const next = await res.json();
              state = next.state;
              setData(next);
              setFailures(0);
            } else if (alive) {
              setFailures((value) => value + 1);
            }
          } catch {
            if (alive) setFailures((value) => value + 1);
          }
          if (alive) timer = setTimeout(tick, state === 'probing' ? 900 : 3000);
        };
        timer = setTimeout(tick, 300);
        return () => {
          alive = false;
          clearTimeout(timer);
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
      if (!data) {
        if (failures < 3) return null;
        return h('div', { className: 'orCapsule', title: '宿主没有注册 /opencode-route/status' },
          h('span', { className: 'orDot off' }),
          h('span', { className: 'orLabel' }, h('span', { className: 'orNum text' }, '未就绪')));
      }
      if (!data.enabled) return null;

      const arm = typeof data.arm === 'string' ? data.arm : 'off';
      const control = arm === 'control';
      // A single request is a noisy reading: bursts inflate it and a slow tool
      // step deflates it. The badge shows the median of the last three usable
      // requests (window >= 500 ms, at least 60 output tokens) so the number
      // moves only when the session's speed actually changes.
      const recentTurns = Array.isArray(data.turns) ? data.turns : [];
      const usable = (row) => typeof row.tps === 'number' && row.tps > 0
        && (row.decodeMs === null || row.decodeMs === undefined || row.decodeMs >= 500)
        && (row.out === null || row.out === undefined || row.out >= 60);
      const sample = recentTurns.filter(usable).slice(-3).map((row) => row.tps).sort((a, b) => a - b);
      const tps = sample.length ? sample[Math.floor((sample.length - 1) / 2)] : null;
      const probing = data.state === 'probing';
      let dot = 'off';
      let textLabel = null;
      if (probing) { dot = 'busy'; textLabel = '挑选中…'; }
      else if (control) { dot = 'off'; textLabel = '对照组'; }
      else if (tps !== null) { dot = tps >= 150 ? 'fast' : 'slow'; }
      else if (data.state === 'pinned' || data.state === 'locked') textLabel = '已选路';
      else textLabel = '待选';

      // Only what a reader can act on: current state, the last few request
      // speeds, and the experiment arm. Internal identifiers (response-id shape,
      // pinned id, pool entries) stay in `/route`, where they are asked for.
      const tipRows = [h('div', { key: 'state' },
        control ? '实验对照组，本会话不参与选路'
          : probing ? '正在挑选路由…'
            : data.state === 'locked' ? '路由已锁定，不会再自动换道'
              : data.state === 'pinned' ? '已固定到一条路由'
                : '使用会话自身的路由')];
      if (data.experiment && data.experiment.enabled) {
        tipRows.push(h('div', { key: 'arm' }, `实验：${control ? '对照组' : '处理组'}`));
      }
      if (recentTurns.length) {
        const rows = recentTurns.slice(-3).reverse();
        const cell = (value) => h('td', null, value);
        tipRows.push(h('div', { key: 'turns', style: { marginTop: '4px' } }, h('b', null, '最近请求')));
        tipRows.push(h('table', { key: 'table', className: 'orTable' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, '时间'), h('th', { scope: 'col' }, '速度'),
            h('th', { scope: 'col' }, '首字'), h('th', { scope: 'col' }, '缓存'))),
          h('tbody', null, rows.map((row, index) => h('tr', { key: `${row.ts}-${index}` },
            cell(clock(row.ts)),
            cell(usable(row) ? `${row.tps} tok/s` : '—'),
            cell(row.ttfbMs ? `${(row.ttfbMs / 1000).toFixed(1)}s` : '—'),
            cell(row.cacheHit === null || row.cacheHit === undefined ? '—' : `${row.cacheHit}%`),
          )))));
      }

      const floating = hover && anchor
        ? h('div', { className: 'orTip', style: anchor }, tipRows)
        : null;
      const portal = floating === null ? null
        : (createPortal ? createPortal(floating, document.body) : floating);

      // One atomic status sentence for assistive tech; the visible parts are
      // aria-hidden so a polling update does not announce a bare number.
      const statusText = control
        ? '实验对照组，不参与选路'
        : probing
          ? '正在挑选路由'
          : data.state === 'locked'
            ? '路由已锁定'
            : tps !== null ? `最近 ${tps} tok/s` : '还没有足够长的样本';
      return h(React.Fragment, null,
        h('div', {
          className: 'orCapsule',
          ref: chipRef,
          role: 'group',
          'aria-label': 'OpenCode Go 路由',
          onMouseEnter: showTip,
          onMouseLeave: scheduleHide,
        },
          h('span', { className: `orDot ${dot}`, 'aria-hidden': 'true' }),
          data.experiment && data.experiment.enabled
            ? h('span', {
              className: 'orTag',
              title: control ? 'A/B 实验：对照组（不探测、不换道）' : 'A/B 实验：处理组（探测并钉住）',
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
