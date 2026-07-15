// ============================================================
// Realtime — live sync via Supabase Realtime (Postgres changes).
// Lean websocket client (no Supabase SDK): connects to the Realtime
// endpoint, subscribes to postgres_changes on our tables, and emits
// events so open sessions refresh when anyone edits data.
// ============================================================
const realtime = (() => {
  let ws = null;
  let ref = 0;
  let heartbeat = null;
  let reconnectTimer = null;
  let connected = false;
  let intentionalClose = false;
  const listeners = new Set();       // fns called on any relevant change: (payload) => {}
  const statusListeners = new Set(); // fns called on connection status change: (isConnected) => {}
  const TOPIC = "realtime:pm";

  const TABLES = ["pm_packs", "pm_questions", "pm_levels", "pm_question_levels", "pm_export_profiles", "pm_sync_targets", "pm_activity"];

  const nextRef = () => String(++ref);

  const send = (event, payload, joinRef) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ topic: TOPIC, event, payload, ref: nextRef(), join_ref: joinRef }));
  };

  const emitStatus = (val) => { connected = val; statusListeners.forEach(fn => { try { fn(val); } catch {} }); };

  const join = () => {
    const joinRef = nextRef();
    // Subscribe to all our tables via postgres_changes config.
    const changes = TABLES.map(t => ({ event: "*", schema: "public", table: t }));
    ws.send(JSON.stringify({
      topic: TOPIC,
      event: "phx_join",
      payload: { config: { postgres_changes: changes, broadcast: { self: false }, presence: { key: "" } }, access_token: session.token || CFG.key },
      ref: nextRef(), join_ref: joinRef,
    }));
    // Heartbeat every 25s keeps the socket alive.
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() }));
    }, 25000);
  };

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    // If a previous socket is still CLOSING, tear it down cleanly before opening a new one
    // so we never end up with two live sockets (and two heartbeats).
    if (ws && ws.readyState === WebSocket.CLOSING) { try { ws.onclose = null; ws.close(); } catch {} ws = null; clearInterval(heartbeat); }
    intentionalClose = false;
    const wsUrl = CFG.url.replace(/^http/, "ws") + `/realtime/v1/websocket?apikey=${encodeURIComponent(CFG.key)}&vsn=1.0.0`;
    try { ws = new WebSocket(wsUrl); } catch { scheduleReconnect(); return; }

    ws.onopen = () => { join(); };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "phx_reply" && msg.payload?.status === "ok" && !connected) emitStatus(true);
      if (msg.event === "postgres_changes") {
        const data = msg.payload?.data;
        if (data) {
          const info = { table: data.table, type: data.type, record: data.record, old: data.old_record };
          listeners.forEach(fn => { try { fn(info); } catch {} });
        }
      }
      if (msg.event === "phx_error" || msg.event === "phx_close") { emitStatus(false); }
    };
    ws.onerror = () => { emitStatus(false); };
    ws.onclose = () => { emitStatus(false); clearInterval(heartbeat); if (!intentionalClose) scheduleReconnect(); };
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (!intentionalClose) connect(); }, 3000);
  };

  const disconnect = () => {
    intentionalClose = true;
    clearInterval(heartbeat); clearTimeout(reconnectTimer);
    if (ws) { try { ws.close(); } catch {} ws = null; }
    emitStatus(false);
  };

  // Push a refreshed access token to the live socket so long-lived connections keep
  // authorizing correctly after a background token refresh (no need to wait for reconnect).
  const updateToken = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ topic: TOPIC, event: "access_token", payload: { access_token: session.token || CFG.key }, ref: nextRef() }));
    }
  };

  return {
    connect, disconnect, updateToken,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    onStatus: (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    isConnected: () => connected,
  };
})();

// Hook: manage the realtime connection lifecycle + a live status flag.
function useRealtime(authed) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!authed) { realtime.disconnect(); setLive(false); return; }
    const offStatus = realtime.onStatus(setLive);
    realtime.connect();
    // Reconnect when the tab becomes visible again (mobile/browsers suspend sockets).
    const onVis = () => { if (document.visibilityState === "visible") realtime.connect(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { offStatus(); document.removeEventListener("visibilitychange", onVis); realtime.disconnect(); };
  }, [authed]);
  return live;
}

// Hook: subscribe to changes on specific tables and run a (debounced) refresh.
// `tables` is an array of table names; `onRelevant` is called when any fires.
function useRealtimeRefresh(tables, onRelevant, deps = []) {
  const savedCb = useRef(onRelevant);
  savedCb.current = onRelevant;
  useEffect(() => {
    let timer = null;
    const off = realtime.onChange((info) => {
      if (!tables.includes(info.table)) return;
      clearTimeout(timer);
      timer = setTimeout(() => savedCb.current && savedCb.current(info), 350); // debounce bursts
    });
    return () => { off(); clearTimeout(timer); };
    // eslint-disable-next-line
  }, deps);
}

// Small "Live" pill for the header.
function LiveBadge({ live }) {
  return (
    <span title={live ? "Live sync on — changes from other devices appear automatically" : "Reconnecting…"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: R.pill, background: live ? C.goodSoft : C.lineSoft, color: live ? C.goodInk : C.faint, whiteSpace: "nowrap" }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: live ? C.good : C.faint, boxShadow: live ? `0 0 0 3px ${C.good}22` : "none", animation: live ? "pm-pulse 2s ease-in-out infinite" : "none" }} />
      {live ? "Live" : "Offline"}
    </span>
  );
}
