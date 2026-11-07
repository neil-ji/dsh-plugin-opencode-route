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
.orChip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 7px;border-radius:999px;
  font-size:11px;line-height:24px;color:var(--dsw-alias-label-secondary);white-space:nowrap;
  background:transparent;border:0;cursor:default;user-select:none}
.orChip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.orDot{width:6px;height:6px;border-radius:50%;flex:none}
.orDot.fast{background:#22c55e}
.orDot.slow{background:#f59e0b}
.orDot.busy{background:#38bdf8;animation:orPulse 1s ease-in-out infinite}
.orDot.off{background:#94a3b8}
.orNum{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.orSpin{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;font-size:13px;line-height:1;padding:0}
.orSpin:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.orSpin:disabled{opacity:.35;cursor:default}
.orNote{position:fixed;z-index:10000;pointer-events:none;font-size:10px;line-height:14px;padding:4px 8px;
  border-radius:8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-input-major,#fff);
  border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.12);max-width:360px}
.orTip{position:fixed;z-index:10000;display:flex;flex-direction:column;gap:3px;font-size:10px;line-height:14px;
  color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:10px;max-width:420px;min-width:230px;
  background:var(--dsw-specific-input-major,#fff);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 8px 28px rgba(0,0,0,.16);pointer-events:none}
.orTip b{font-weight:600;color:var(--dsw-alias-label-primary)}
.orTip .num{font-variant-numeric:tabular-nums}
`;

    function Chip(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : null;
      const [data, setData] = useState(null);
      const [failures, setFailures] = useState(0);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const [hover, setHover] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const chipRef = useRef(null);
      const noteTimer = useRef(null);
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
          if (noteTimer.current) clearTimeout(noteTimer.current);
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

      const flash = (text) => {
        const pos = place();
        if (pos) setAnchor(pos);
        setNote(text);
        if (noteTimer.current) clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setNote(null), 9000);
      };

      const repin = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy || !sessionId) return;
        setBusy(true);
        flash('正在重新探测候选…');
        try {
          const res = await fetch(`/opencode-route/repin?session=${encodeURIComponent(sessionId)}`, { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          if (body.ok) {
            const next = await fetch(`/opencode-route/status?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
            if (next.ok) setData(await next.json());
            flash(`已换到 ${body.shape ?? '新路由'}${body.tps ? ` · 探测 ${body.tps} tok/s` : ''}，下条消息生效`);
          } else {
            flash(body.error ?? '换道没有成功');
          }
        } catch {
          flash('换道请求失败（宿主未响应）');
        } finally {
          setBusy(false);
        }
      };

      if (!sessionId) return null;
      if (!data) {
        if (failures < 3) return null;
        return h('button', { className: 'orChip', title: '宿主没有注册 /opencode-route/status' },
          h('span', { className: 'orDot off' }), h('span', null, 'route 未就绪'));
      }
      if (!data.enabled) return null;

      const last = data.last;
      const tps = last && typeof last.tps === 'number' ? last.tps : null;
      const shape = last && last.shape && last.shape !== 'none' ? last.shape : null;
      const best = typeof data.best === 'number' ? data.best : 0;
      const probing = data.state === 'probing' || busy;
      let dot = 'off';
      let label;
      if (probing) { dot = 'busy'; label = '挑选中…'; }
      else if (data.state === 'pinned' || data.state === 'locked') {
        dot = tps !== null && tps >= 150 ? 'fast' : 'slow';
        label = tps !== null ? `${tps} tok/s` : (shape ?? 'route');
      } else label = 'route 待选';

      const tipRows = [];
      if (data.pinned) tipRows.push(h('div', { key: 'pin' },
        '路由 ', h('b', null, shape ?? '?'), ' · 钉住 ', h('b', { className: 'num' }, String(data.pinned.id).slice(0, 16) + '…'),
        data.pinned.probeTps ? ` · 探测 ${data.pinned.probeTps}` : ''));
      if (best) tipRows.push(h('div', { key: 'best' }, '池最优 ', h('b', { className: 'num' }, `${best} tok/s`),
        data.locked ? ' · 已缓存锁定（不会再自动换道）' : ''));
      const st = data.stats;
      if (st && st.decisions) {
        tipRows.push(h('div', { key: 'stats' },
          `效果：决策 ${st.decisions} 次 · 保留原生 ${st.keptNatural} · 换道 ${st.switched}`,
          st.switched ? ` · 中位提升 ${st.medianGain}×` : ''));
      }
      if (data.pool && data.pool.length) {
        tipRows.push(h('div', { key: 'pool', style: { marginTop: '2px' } }, h('b', null, '候选池')));
        data.pool.slice(0, 5).forEach((row, index) => tipRows.push(h('div', { key: `p${index}` },
          `　${row.shape} · ${row.tps} tok/s · ${row.leased} 会话在用`)));
      }
      if (data.turns && data.turns.length) {
        tipRows.push(h('div', { key: 'turns', style: { marginTop: '2px' } }, h('b', null, '最近请求')));
        data.turns.slice(-3).reverse().forEach((row, index) => tipRows.push(h('div', { key: `t${index}` },
          `　${row.ts.slice(11, 19)} ${row.shape} · ${row.tps ?? '-'} tok/s · 首字 ${row.ttfbMs ? (row.ttfbMs / 1000).toFixed(1) : '-'}s · 缓存 ${row.cacheHit ?? '-'}%`)));
      }
      if (!tipRows.length) tipRows.push(h('div', { key: 'none' }, '发一条消息后这里会显示路由与速度。'));

      const tip = hover && anchor && !note
        ? h('div', { className: 'orTip', style: anchor }, tipRows)
        : null;
      const noteNode = note && anchor
        ? h('div', { className: 'orNote', style: anchor }, note)
        : null;
      const floating = (tip || noteNode)
        ? (createPortal ? createPortal(h(React.Fragment, null, tip, noteNode), document.body) : h(React.Fragment, null, tip, noteNode))
        : null;

      return h(React.Fragment, null,
        h('button', {
          className: 'orChip',
          ref: chipRef,
          onMouseEnter: showTip,
          onMouseLeave: scheduleHide,
          title: 'OpenCode Go 路由',
        },
          h('span', { className: `orDot ${dot}` }),
          h('span', { className: 'orNum' }, label),
          shape && !probing ? h('span', null, shape) : null,
        ),
        h('button', {
          className: 'orSpin',
          onClick: repin,
          disabled: probing,
          title: '重新挑选路由（会让缓存失效一次）',
          'aria-label': '重新挑选路由',
        }, '↻'),
        floating,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities', id: 'opencode-route', order: -2,
        }, Chip));
      },
    };
  },
});
