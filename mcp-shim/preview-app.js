// The MCP App UI resource — a PLAYABLE question preview.
//
// Rendered by the host inside a sandboxed iframe. It speaks raw JSON-RPC over postMessage per
// SEP-1865 (no SDK dependency), because this Worker has no bundler:
//   → ui/initialize (request)          then  ui/notifications/initialized (notification)
//   ← ui/notifications/tool-result     the tool's structuredContent arrives here
//   ← ui/notifications/host-context-changed   theme / safe-area
//   ← ui/resource-teardown             respond {} and stop
//
// WHY PLAYABLE, not just a rendering: tapping GENTLE at level 7 and being told you are wrong is how
// a person FEELS the same-length bug. Reading "both words are 6 letters" is abstract. This is the
// judgement the human reviewer exists to make, and no automated check can make it.
//
// It is defensive about where the payload lives (structuredContent vs result.structuredContent vs a
// bare object) because the spec is young and host behaviour still varies.

export const PREVIEW_APP_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Question preview</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    background:transparent;color:#191728;padding:4px}
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
<div id="app"><div class="empty">Waiting for the question…</div></div>
<script>
(function(){
  var rpcId = 1, initDone = false, DATA = null;
  function post(m){ try { window.parent.postMessage(m, '*'); } catch(e){} }
  function request(method, params){ post({ jsonrpc:'2.0', id: rpcId++, method: method, params: params||{} }); }
  function notify(method, params){ post({ jsonrpc:'2.0', method: method, params: params||{} }); }

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
          b.onclick = function(){ sel = parseInt(b.getAttribute('data-j'),10); paint(); };
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
            notify('ui/notifications/context-update', {
              text: 'Reviewer tried \"' + w + '\" on Q' + (p.n || (i+1)) + ' \u2014 ' + (ok ? 'correct' : 'marked wrong') + '.'
            });
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
    if (m.method === 'ui/notifications/tool-result' || m.method === 'ui/notifications/tool-input'){
      var found = dig(m.params, 0);
      if (found){ DATA = found; render(DATA); }
      return;
    }
    if (m.method === 'ui/notifications/host-context-changed'){
      var t = m.params && (m.params.theme || (m.params.hostContext && m.params.hostContext.theme));
      document.body.classList.toggle('dark', t === 'dark');
      return;
    }
    if (m.method === 'ui/resource-teardown'){ if (m.id != null) post({ jsonrpc:'2.0', id:m.id, result:{} }); return; }
    if (m.id != null && m.result && !initDone){ initDone = true; notify('ui/notifications/initialized', {}); }
  });

  request('ui/initialize', { protocolVersion: '2026-01-26', capabilities: {} });
  // If the host never handshakes, say so rather than spinning forever.
  setTimeout(function(){
    if (!DATA) {
      var app = document.getElementById('app');
      if (app && app.querySelector('.empty')) app.querySelector('.empty').textContent =
        'Connected, but no question data arrived from the host.';
    }
  }, 4000);
})();
</script>
</body></html>`;
