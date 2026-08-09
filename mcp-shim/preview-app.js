// The MCP App UI resource — a PLAYABLE question preview.
//
// Rendered by the host inside a sandboxed iframe. It speaks raw JSON-RPC over postMessage per
// SEP-1865 (no SDK dependency, because this Worker has no bundler). Full lifecycle:
//   → ui/initialize (request, carries appInfo + appCapabilities)
//   ← McpUiInitializeResult (hostContext: theme, containerDimensions, displayMode)
//   → ui/notifications/initialized     ONLY after the result arrives — the host MUST NOT send
//                                      anything before it, so getting this wrong stalls everything
//   ← ui/notifications/tool-input      then
//   ← ui/notifications/tool-result     the payload arrives here
//   → ui/notifications/size-changed    CONTINUOUSLY, via ResizeObserver
//   ← ui/notifications/host-context-changed   theme / display mode / container resize
//   ← ui/resource-teardown             respond {} and stop
//
// WHY PLAYABLE, not just a rendering: tapping GENTLE at level 7 and being told you are wrong is how
// a person FEELS the same-length bug. Reading "both words are 6 letters" is abstract. This is the
// judgement the human reviewer exists to make, and no automated check can make it.
//
// THE HEIGHT BUG (fixed Aug 2026). The first version rendered fine and was CLIPPED to roughly one
// card, which read as "blank/broken". It never sent ui/notifications/size-changed, so the host had
// no idea the content was taller than the initial frame. Per the spec, when a host uses flexible
// dimensions the VIEW owns its height and MUST report it; a min-height in CSS does nothing, because
// the iframe is sized from outside. Any change to layout here must keep reportSize() reachable.
//
// It stays defensive about where the payload lives (structuredContent vs result.structuredContent vs
// a bare object) because host behaviour still varies.

export const PREVIEW_APP_HTML = `<!DOCTYPE html>
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
</style></head><body>
<div id="status" style="background:#6C4CE0;color:#fff;font:700 12px/1.4 system-ui;padding:8px 10px;border-radius:10px;margin-bottom:8px">PM widget v2 — script not started</div>
<div id="app"><div class="empty">Waiting for data from the host…</div></div>
<script>
(function(){
  var rpcId = 1, initId = null, initDone = false, DATA = null, ro = null;
  var lastW = -1, lastH = -1, pending = false;
  function setStatus(t){ var el = document.getElementById('status'); if (el) el.textContent = 'PM widget v2 — ' + t; }
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
  function dig(o, depth){
    if (!o || depth > 6) return null;
    if (Array.isArray(o.previews)) return o.previews;
    if (typeof o !== 'object') return null;
    for (var k in o){
      if (!Object.prototype.hasOwnProperty.call(o,k)) continue;
      var v = o[k];
      if (v && typeof v === 'object'){ var f = dig(v, depth+1); if (f) return f; }
      if (typeof v === 'string' && v.indexOf('previews') !== -1){
        try { var p = JSON.parse(v); var f2 = dig(p, depth+1); if (f2) return f2; } catch(e){}
      }
    }
    return null;
  }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function render(previews){
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
        setStatus(found.length + ' question(s)');
        render(DATA);
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
    if (!initDone) setStatus('NO HANDSHAKE after 5s — host never answered ui/initialize');
    else if (!DATA) setStatus('connected but NO DATA after 5s — host never sent tool-result');
  }, 5000);
})();
</script>
</body></html>`;
