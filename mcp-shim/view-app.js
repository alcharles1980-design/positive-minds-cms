// THE MCP App UI resource — ONE view that renders whichever payload arrives.
//
// WHY ONE VIEW AND NOT TWO. There were briefly two: a question preview and an overview menu, each
// with its own ui:// resource, linked per-tool via _meta.ui.resourceUri. Claude Web does not honour
// that — it loaded the question-preview resource for an `overview` call and then sent it nothing, so
// a partner saw an idle widget next to a perfectly good answer. Proved by making each view name its
// own resource in its status bar and reading it off a screenshot (rule 4.21).
// The host picks ONE view per connector, so the view has to handle everything. Both URIs now serve
// this file, and it dispatches on the SHAPE of the payload it receives. A second copy of the
// lifecycle code would have been a fourth parity problem waiting to happen.
//
// Lifecycle (SEP-1865, raw JSON-RPC over postMessage — no SDK, this Worker has no bundler):
//   → ui/initialize (appInfo + appCapabilities)   ← McpUiInitializeResult (hostContext)
//   → ui/notifications/initialized ONLY on the matching id — the host sends nothing before it
//   ← ui/notifications/tool-result                → ui/notifications/size-changed, CONTINUOUSLY
//   → ui/message / ui/update-model-context        ← ui/resource-teardown → respond {}
//
// IF YOU CHANGE THE LAYOUT, KEEP reportSize() REACHABLE. A view that does not report its height
// renders correctly and is clipped to its initial frame, which looks exactly like "the widget is
// blank" and is not. That mistake cost three sessions.

export const VIEW_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Question preview</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    background:#F6F5FB;color:#191728;padding:8px}
  .card{background:#fff;border:1px solid #E4E0F0;border-radius:16px;padding:16px 16px 14px;
    margin-bottom:10px;box-shadow:0 2px 10px rgba(25,23,40,.05)}
  .meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;
    font-size:11px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:#6E6B85}
  .chip{background:#EEE9FD;color:#4A32B0;border-radius:999px;padding:3px 9px}
  .levels{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:13px}
  .lv{border:1px solid #E4E0F0;background:#FBFAFE;color:#4A4763;border-radius:8px;
    padding:4px 9px;font-size:11.5px;font-weight:800;cursor:pointer;font-family:inherit}
  .lv.on{background:#6C4CE0;border-color:#6C4CE0;color:#fff}
  .sentence{font-size:19px;line-height:1.5;font-weight:600;margin:0 0 15px;letter-spacing:.3px}
  .blank{font-family:ui-monospace,Menlo,monospace;color:#6C4CE0;font-weight:800;letter-spacing:2px}
  .opts{display:flex;gap:9px;flex-wrap:wrap}
  .opt{flex:1 1 120px;padding:13px 10px;border:2px solid #E4E0F0;background:#fff;border-radius:12px;
    font-size:15.5px;font-weight:800;font-family:ui-monospace,Menlo,monospace;letter-spacing:1px;
    cursor:pointer;transition:all .12s;color:#191728}
  .opt:hover{border-color:#8A6EF0}
  .opt.right{background:#DEF5F1;border-color:#0E8C7E;color:#0A6B60}
  .opt.wrong{background:#FDECEC;border-color:#C2352F;color:#C2352F}
  .verdict{margin-top:11px;font-size:13px;font-weight:700;min-height:18px}
  .verdict.ok{color:#0A6B60}
  .verdict.no{color:#C2352F}
  .hint{margin-top:9px;font-size:11.5px;color:#8B87A3;line-height:1.5}
  .empty{padding:22px;text-align:center;color:#8B87A3;font-size:13.5px}
  body.dark{color:#F3F1FB}
  body.dark .card{background:#1C1930;border-color:#332F4C}
  body.dark .opt{background:#131120;border-color:#332F4C;color:#F3F1FB}
  body.dark .lv{background:#131120;border-color:#332F4C;color:#C9C5DC}

  html,body{margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    background:#F6F5FB;color:#191728;padding:8px}
  .card{background:#fff;border:1px solid #E4E0F0;border-radius:16px;padding:18px 18px 16px;
    margin-bottom:12px;box-shadow:0 2px 10px rgba(25,23,40,.05)}
  .lbl{font-size:11px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:#6E6B85}
  h1{margin:6px 0 4px;font-size:20px;font-weight:800;letter-spacing:-.3px}
  .lead{margin:0;color:#6E6B85;font-size:13.5px;line-height:1.6}
  .stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  .stat{flex:1 1 88px;background:#FBFAFE;border:1px solid #E4E0F0;border-radius:11px;padding:9px 11px}
  .stat b{display:block;font-size:19px;font-weight:800;line-height:1.25}
  .stat span{font-size:10.5px;font-weight:700;color:#6E6B85;text-transform:uppercase;letter-spacing:.3px}
  .stat.hot b{color:#6C4CE0}
  .packs{margin-top:4px}
  .pack{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #F0EDF9}
  .pack:first-child{border-top:0}
  .pk-emoji{font-size:17px;width:22px;text-align:center}
  .pk-name{flex:1;font-size:14px;font-weight:700}
  .pk-desc{display:block;font-size:11.5px;font-weight:500;color:#8B87A3;margin-top:2px}
  .pill{font-size:10.5px;font-weight:800;border-radius:999px;padding:3px 8px;white-space:nowrap}
  .pill.wait{background:#EEE9FD;color:#4A32B0}
  .pill.live{background:#DEF5F1;color:#0A6B60}
  .more{font-size:12px;color:#8B87A3;padding-top:10px}
  .menu{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}
  .act{display:flex;align-items:center;gap:9px;text-align:left;padding:13px 12px;border-radius:12px;
    border:1.5px solid #E4E0F0;background:#fff;cursor:pointer;font-family:inherit;font-size:13px;
    font-weight:700;color:#191728;line-height:1.35;transition:border-color .12s,background .12s}
  .act:hover{border-color:#8A6EF0;background:#FBFAFE}
  .act:active{background:#EEE9FD}
  .act .ic{font-size:15px;color:#6C4CE0;width:18px;text-align:center;flex:0 0 18px}
  .cannot{margin-top:13px;padding:11px 13px;border-radius:11px;background:#FBFAFE;
    border:1px solid #E4E0F0;font-size:12px;color:#4A4763;line-height:1.55}
  .cannot b{color:#191728}
  .warn{background:#FDECEC;border:1px solid #C2352F;color:#C2352F;border-radius:11px;
    padding:11px 13px;font-size:12.5px;font-weight:700;margin-bottom:12px;line-height:1.5}
  .empty{padding:22px;text-align:center;color:#8B87A3;font-size:13.5px}
  </style></head><body>
<div id="status" style="background:#6C4CE0;color:#fff;font:700 12px/1.4 system-ui;padding:8px 10px;border-radius:10px;margin-bottom:8px">PM widget v2 — script not started</div>
<div id="app"><div class="empty">Waiting for data from the host…</div></div>
<script>
(function(){
  var rpcId = 1, initId = null, initDone = false, DATA = null, ro = null;
  var lastW = -1, lastH = -1, pending = false;
  function setStatus(t){ var el = document.getElementById('status'); if (el) el.textContent = 'positive minds — ' + t; }
  setStatus('script running');
  window.addEventListener('error', function(e){ setStatus('JS ERROR: ' + (e.message || 'unknown')); });
  function post(m){ try { window.parent.postMessage(m, '*'); } catch(e){} }
  function request(method, params){ post({ jsonrpc:'2.0', id: rpcId++, method: method, params: params||{} }); }
  function notify(method, params){ post({ jsonrpc:'2.0', method: method, params: params||{} }); }

  // THE FIX. When the host gives a flexible height (maxHeight, or nothing at all) the iframe is
  // sized from what we report — not from our CSS. Without this the frame keeps whatever height it
  // started at and the content is simply cut off, which is what "the widget renders blank" was.
  function reportSize(){
    if (pending) return;
    pending = true;
    requestAnimationFrame(function(){
      pending = false;
      var d = document.documentElement;
      var h = Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0);
      var w = d.clientWidth || d.scrollWidth;
      if (h === lastH && w === lastW) return;
      lastH = h; lastW = w;
      notify('ui/notifications/size-changed', { width: w, height: h });
    });
  }

  function applyHostContext(ctx){
    if (!ctx) return;
    if (ctx.theme) document.body.classList.toggle('dark', ctx.theme === 'dark');
    var cd = ctx.containerDimensions;
    if (cd){
      var d = document.documentElement;
      // Fixed => fill the space the host allotted. Flexible => we own the height, up to their cap.
      if ('height' in cd)          { d.style.height = '100vh'; d.style.maxHeight = ''; }
      else if (cd.maxHeight != null){ d.style.maxHeight = cd.maxHeight + 'px'; d.style.height = ''; }
      if ('width' in cd)           { d.style.width = '100vw'; d.style.maxWidth = ''; }
      else if (cd.maxWidth != null) { d.style.maxWidth = cd.maxWidth + 'px'; d.style.width = ''; }
    }
  }

  // Find the previews array wherever the host chose to put it.
  // Which payload is this? The two are unmistakable, so dispatch on shape rather than on which
  // tool the host THINKS it is showing — it has already been wrong about that once.
  function classify(o){
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o.previews)) return { kind: 'previews', data: o.previews };
    if (Array.isArray(o.what_you_can_do) && o.content_status) return { kind: 'overview', data: o };
    return null;
  }

  function dig(o, depth){
    if (!o || depth > 6) return null;
    var hit = classify(o); if (hit) return hit;
    if (typeof o !== 'object') return null;
    for (var k in o){
      if (!Object.prototype.hasOwnProperty.call(o,k)) continue;
      var v = o[k];
      if (v && typeof v === 'object'){ var f = dig(v, depth+1); if (f) return f; }
      if (typeof v === 'string' && (v.indexOf('previews') !== -1 || v.indexOf('what_you_can_do') !== -1)){
        try { var p = JSON.parse(v); var f2 = dig(p, depth+1); if (f2) return f2; } catch(e){}
      }
    }
    return null;
  }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function renderOverview(d){
    var app = document.getElementById('app');
    var cs = d.content_status || {};
    var packs = (d.packs || []).filter(function(p){ return p.live_questions > 0 || p.awaiting_review > 0; });
    // Trust the SERVER'S count, not a recount of the array. The array is a list to display and could
    // be a subset; content_status is the authoritative tally. Recomputing here would let the widget
    // and the text version report different numbers from the same payload.
    var emptyCount = (cs.packs_empty != null) ? cs.packs_empty : ((d.packs || []).length - packs.length);
    var h = '';

    if (d.problems && d.problems.length){
      h += '<div class="warn">Some of this could not be loaded: ' + esc(d.problems.join('; ')) +
           '. The numbers below are incomplete.</div>';
    }

    h += '<div class="card">' +
           '<div class="lbl">Positive Minds \\u2014 content partner</div>' +
           '<h1>Here is where things stand</h1>' +
           '<p class="lead">' + esc(d.headline || '') + '</p>' +
           '<div class="stats">' +
             '<div class="stat' + (cs.awaiting_review_total ? ' hot' : '') + '"><b>' +
               esc(cs.awaiting_review_total || 0) + '</b><span>Awaiting review</span></div>' +
             '<div class="stat"><b>' + esc(cs.live_questions_total || 0) + '</b><span>Live questions</span></div>' +
             '<div class="stat"><b>' + esc(cs.packs_total || 0) + '</b><span>Packs</span></div>' +
           '</div>' +
         '</div>';

    if (packs.length){
      h += '<div class="card"><div class="lbl">Packs with content</div><div class="packs">';
      packs.forEach(function(p){
        h += '<div class="pack">' +
               '<span class="pk-emoji">' + esc(p.emoji || '\\u25CF') + '</span>' +
               '<span class="pk-name">' + esc(p.name) +
                 (p.description ? '<span class="pk-desc">' + esc(p.description) + '</span>' : '') +
               '</span>' +
               (p.awaiting_review ? '<span class="pill wait">' + esc(p.awaiting_review) + ' waiting</span>' : '') +
               (p.live_questions ? '<span class="pill live">' + esc(p.live_questions) + ' live</span>' : '') +
             '</div>';
      });
      h += '</div>';
      if (emptyCount > 0){
        h += '<div class="more">' + esc(emptyCount) + ' other pack' + (emptyCount === 1 ? '' : 's') +
             ' have no questions yet \\u2014 any of them can be written for.</div>';
      }
      h += '</div>';
    }

    h += '<div class="card"><div class="lbl">What you can do</div><div class="menu" id="menu"></div>';
    if (d.what_you_cannot_do){
      h += '<div class="cannot"><b>What you cannot do here:</b> ' + esc(d.what_you_cannot_do) + '</div>';
    }
    h += '</div>';
    app.innerHTML = h;

    // Buttons are built with DOM APIs, not innerHTML, so the phrase each one sends is bound to the
    // element rather than round-tripped through an attribute.
    var menu = document.getElementById('menu');
    (d.what_you_can_do || []).forEach(function(a){
      var b = document.createElement('button');
      b.className = 'act';
      b.innerHTML = '<span class="ic">' + esc(a.icon || '\\u2192') + '</span><span>' + esc(a.do) + '</span>';
      b.onclick = function(){
        // ui/message is a REQUEST in the spec, not a notification. It puts a message in the chat as
        // if the partner had typed it, which is exactly what a menu should do — no tool names, no
        // phrasing to learn.
        request('ui/message', { role: 'user', content: { type: 'text', text: a.say || a.do } });
        b.style.borderColor = '#6C4CE0';
        b.style.background = '#EEE9FD';
      };
      menu.appendChild(b);
    });
    reportSize();
  }

  function renderPreviews(previews){
    var app = document.getElementById('app');
    if (!previews || !previews.length){ app.innerHTML = '<div class="empty">No questions to preview.</div>'; return; }
    app.innerHTML = '';
    previews.slice(0,40).forEach(function(p, i){
      // Data shape (question-first, since v14): sentence / options / correct / level_shown, with an
      // optional at_other_levels of {level, sentence} for the tabs. Older shape used at_each_level;
      // tolerated here so a stale server cannot blank the card again.
      var tabs = p.at_other_levels || p.at_each_level || [];
      var baseSentence = p.sentence || (tabs[0] && (tabs[0].sentence || tabs[0].the_child_sees)) || '';
      var opts = p.options || (tabs[0] && tabs[0].picks_between) || [];
      var correct = p.correct || opts[0];
      if (!baseSentence || opts.length < 2) return;

      var card = document.createElement('div'); card.className = 'card';
      var sel = 0;
      if (tabs.length && p.level_shown != null){
        for (var k = 0; k < tabs.length; k++){ if (tabs[k].level === p.level_shown){ sel = k; break; } }
      }

      function paint(){
        var t = tabs[sel];
        var sentence = t ? (t.sentence || t.the_child_sees || baseSentence) : baseSentence;
        var lvlNum = t ? t.level : p.level_shown;
        // Stable but non-obvious ordering so the correct word isn't always first.
        var shown = opts.slice();
        if ((i + sel) % 2 === 1) shown.reverse();

        card.innerHTML =
          '<div class="meta">' +
            '<span class="chip">' + esc(p.n != null ? ('Q' + p.n) : ('Q' + (i + 1))) + '</span>' +
            (p.pack ? '<span class="chip">' + esc(p.pack) + '</span>' : '') +
            (p.by ? '<span>by ' + esc(p.by) + '</span>' : '') +
            (lvlNum != null ? '<span>Level ' + esc(lvlNum) + '</span>' : '') +
          '</div>' +
          (tabs.length > 1
            ? '<div class="levels">' + tabs.map(function(l, j){
                return '<button class="lv' + (j===sel?' on':'') + '" data-j="' + j + '">L' + esc(l.level) + '</button>';
              }).join('') + '</div>'
            : '') +
          '<p class="sentence">' + esc(sentence).replace(/(_{2,})/g,'<span class="blank">$1</span>') + '</p>' +
          '<div class="opts">' + shown.map(function(w){
            return '<button class="opt" data-w="' + esc(w) + '">' + esc(w) + '</button>';
          }).join('') + '</div>' +
          '<div class="verdict"></div>';

        card.querySelectorAll('.lv').forEach(function(b){
          b.onclick = function(){ sel = parseInt(b.getAttribute('data-j'),10); paint(); reportSize(); };
        });
        var verdict = card.querySelector('.verdict');
        card.querySelectorAll('.opt').forEach(function(b){
          b.onclick = function(){
            var w = b.getAttribute('data-w');
            var ok = w === correct;
            b.classList.add(ok ? 'right' : 'wrong');
            verdict.className = 'verdict ' + (ok ? 'ok' : 'no');
            verdict.textContent = ok
              ? 'Correct \u2014 that is what the child should pick.'
              : 'Marked wrong. If this word ALSO fits the blank, the question is broken.';
            request('ui/update-model-context', {
              content: [{ type:'text', text:
                'Reviewer tried \"' + w + '\" on Q' + (p.n || (i+1)) + ' \u2014 ' + (ok ? 'correct' : 'marked wrong') + '.' }]
            });
            reportSize();
          };
        });
      }
      paint();
      app.appendChild(card);
    });
  }

  window.addEventListener('message', function(e){
    var m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;

    // The handshake RESULT. Everything else the host sends comes after we acknowledge this, so a
    // missed reply here means a permanently empty widget.
    if (m.id != null && m.id === initId && m.result){
      if (!initDone){
        initDone = true;
        applyHostContext(m.result.hostContext || {});
        notify('ui/notifications/initialized', {});
        setStatus('connected, waiting for data');
        reportSize();
      }
      return;
    }

    if (m.method === 'ui/notifications/tool-result' || m.method === 'ui/notifications/tool-input'){
      var found = dig(m.params, 0);
      if (found){
        DATA = found;
        if (found.kind === 'overview'){ setStatus('overview'); renderOverview(found.data); }
        else { setStatus(found.data.length + ' question(s)'); renderPreviews(found.data); }
        reportSize();
      } else if (m.method === 'ui/notifications/tool-result'){
        setStatus('message received but no previews array found');
      }
      return;
    }
    if (m.method === 'ui/notifications/tool-cancelled'){
      setStatus('tool cancelled by host' + (m.params && m.params.reason ? ' — ' + m.params.reason : ''));
      return;
    }
    if (m.method === 'ui/notifications/host-context-changed'){
      applyHostContext(m.params || {});
      reportSize();
      return;
    }
    if (m.method === 'ui/resource-teardown'){
      if (ro) { try { ro.disconnect(); } catch(_){} }
      if (m.id != null) post({ jsonrpc:'2.0', id:m.id, result:{} });
      return;
    }
  });

  if (window.ResizeObserver){
    ro = new ResizeObserver(function(){ reportSize(); });
    try { ro.observe(document.documentElement); if (document.body) ro.observe(document.body); } catch(_){}
  }
  window.addEventListener('load', reportSize);

  setStatus('handshake sent, waiting for host');
  initId = rpcId++;
  post({ jsonrpc:'2.0', id: initId, method:'ui/initialize', params:{
    protocolVersion: '2025-06-18',
    appInfo: { name: 'Positive Minds question preview', version: '2.0.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }
  }});

  // If the host never handshakes, say so rather than spinning forever.
  setTimeout(function(){
    if (!initDone) { setStatus('no handshake after 8s — host never answered ui/initialize'); return; }
    if (DATA) return;
    // No data usually means the host attached THIS view to a tool call it does not serve. That is a
    // wiring problem, not something the partner did wrong, so do not shout it at them in red.
    setStatus('idle — nothing to show for this message');
    var app = document.getElementById('app');
    if (app) app.innerHTML = '<div class="empty">Nothing to show here.<br>' +
      'Ask what you can do, to see the review queue, or to play a pack.</div>';
    var bar = document.getElementById('status');
    if (bar){ bar.style.background = '#EEE9FD'; bar.style.color = '#4A32B0'; }
    reportSize();
  }, 8000);
})();
</script>
</body></html>`;
