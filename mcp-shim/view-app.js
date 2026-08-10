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
  /* These were lost when the two views were merged: the overview's dark rules sat AFTER
     body.dark{...} in the original file and the splice cut them off. Visible symptom: white numbers
     on white tiles, because .stat b had no colour of its own and inherited the dark-mode text
     colour while .stat kept its light background. Anything with its own background needs its own
     foreground. */
  body.dark .stat{background:#131120;border-color:#332F4C}
  body.dark .stat b{color:#F3F1FB}
  body.dark .stat span{color:#A9A4C4}
  body.dark .act{background:#131120;border-color:#332F4C;color:#F3F1FB}
  body.dark .act:hover{background:#1C1930;border-color:#8A6EF0}
  body.dark .pack{border-top-color:#2A2640}
  body.dark .pk-desc{color:#A9A4C4}
  body.dark .more{color:#A9A4C4}
  body.dark .cannot{background:#131120;border-color:#332F4C;color:#C9C5DC}
  body.dark .cannot b{color:#F3F1FB}
  body.dark .lead{color:#A9A4C4}
  body.dark .lbl{color:#A9A4C4}
  body.dark .sentence{color:#F3F1FB}

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
  .stat b{display:block;font-size:19px;font-weight:800;line-height:1.25;color:#191728}
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
  .act{flex-wrap:wrap}
  .act .note{flex:1 1 100%;font-size:11px;font-weight:700;color:#4A32B0;margin-top:6px;
    padding-left:27px;line-height:1.4;letter-spacing:.2px}
  .act .note.quote{font-style:italic;font-weight:600}
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
  var HOSTCAPS = null, msgIds = {};
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

  // ONE TAP MUST ALWAYS ACHIEVE SOMETHING.
  // ui/message is the nice path — it drops the request straight into the chat — but the spec lists
  // no host capability for it, and this host rejects it. The previous version only fell back AFTER
  // the rejection arrived, which meant the first tap did nothing visible and the copy needed a
  // second tap. Worse, clipboard writes need a user gesture, so a copy triggered from an async
  // rejection is not guaranteed to work at all.
  // So: copy DURING the tap (synchronously, inside the gesture), and try ui/message at the same
  // time. If the message lands, say so. If it does not, the text is already on the clipboard and
  // the tile just says to paste it. The tile keeps its label either way — rewriting a button into a
  // block of instructions is what collapsed the layout.
  function copyNow(text){
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch(e){ return false; }
  }

  function tileNote(btn, text, cls){
    var n = btn.querySelector('.note');
    if (!n){
      n = document.createElement('span');
      n.className = 'note';
      btn.appendChild(n);
    }
    n.className = 'note' + (cls ? ' ' + cls : '');
    n.textContent = text;
    reportSize();
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
        var text = a.say || a.do;
        // Copy FIRST, inside the gesture, while the browser still permits it.
        var copied = copyNow(text);
        b.style.borderColor = '#6C4CE0';
        b.style.background = '#EEE9FD';
        b.setAttribute('data-state', 'sent');
        tileNote(b, copied ? 'Copied \u2014 paste it below' : 'Sending\u2026');

        var id = rpcId++;
        msgIds[id] = { btn: b, text: text, copied: copied };
        post({ jsonrpc:'2.0', id: id, method:'ui/message',
               params:{ role:'user', content:{ type:'text', text: text } } });
        setTimeout(function(){
          if (b.getAttribute('data-state') === 'sent'){
            b.setAttribute('data-state', 'copy');
            tileNote(b, copied ? 'Copied \u2014 paste it below' : text, copied ? '' : 'quote');
          }
        }, 2000);
      };
      menu.appendChild(b);
    });
    reportSize();
  }

  function renderPreviews(previews){
    var app = document.getElementById('app');
    if (!previews || !previews.length){ app.innerHTML = '<div class="empty">No questions to preview.</div>'; return; }

    // TWO LEVELS OF CONTROL, on purpose.
    // The GLOBAL bar is an override: it sets every question at once, because the usual question is
    // "how does this pack read at level 7?" — a property of the sitting, not of each question, and
    // setting it twelve times made comparison at a fixed level almost impossible.
    // The PER-CARD tabs stay, because the other real job is checking ONE question across levels
    // (that is how the same-length bug is felt). A card moved on its own diverges from the global
    // level and says so, and the global bar reports MIXED rather than lying about a single value.
    var rows = [];
    previews.slice(0, 40).forEach(function(p, i){
      // Question-first shape (since v14): sentence / options / correct / level_shown, plus
      // at_other_levels of {level, sentence}. Older at_each_level tolerated so a stale server
      // cannot blank the card again.
      var tabs = p.at_other_levels || p.at_each_level || [];
      var base = p.sentence || (tabs[0] && (tabs[0].sentence || tabs[0].the_child_sees)) || '';
      var opts = p.options || (tabs[0] && tabs[0].picks_between) || [];
      if (!base || opts.length < 2) return;
      var byLevel = {};
      tabs.forEach(function(t){ if (t && t.level != null) byLevel[t.level] = t.sentence || t.the_child_sees || base; });
      rows.push({ p: p, i: i, base: base, opts: opts, correct: p.correct || opts[0],
                  byLevel: byLevel, level: p.level_shown != null ? p.level_shown : null });
    });
    if (!rows.length){ app.innerHTML = '<div class="empty">No questions to preview.</div>'; return; }

    // Offer every level ANY question can render, so a partial set never hides one.
    var levels = [];
    rows.forEach(function(r){
      Object.keys(r.byLevel).forEach(function(l){ l = +l; if (levels.indexOf(l) === -1) levels.push(l); });
    });
    levels.sort(function(a, b){ return a - b; });
    rows.forEach(function(r){ if (r.level == null || !r.byLevel[r.level]) r.level = levels[0]; });

    function globalLevel(){
      var first = rows[0].level;
      for (var i = 1; i < rows.length; i++) if (rows[i].level !== first) return null; // mixed
      return first;
    }

    app.innerHTML = '';
    var head = document.createElement('div'); head.className = 'card head';
    var list = document.createElement('div');
    if (levels.length > 1) app.appendChild(head);
    app.appendChild(list);

    function paintHead(){
      if (levels.length <= 1) return;
      var g = globalLevel();
      head.innerHTML =
        '<div class="lbl">' + esc(rows[0].p.pack || 'Questions') + '</div>' +
        '<h1>' + esc(rows.length) + ' question' + (rows.length === 1 ? '' : 's') + '</h1>' +
        '<p class="lead">' + (g == null
            ? 'Levels are mixed \u2014 pick one below to put every question on the same level.'
            : 'Every question shown at level ' + esc(g) + ', the way a child at that level meets them.') +
        '</p>' +
        '<div class="lbl" style="margin-top:14px">Set all to level' +
          (g == null ? ' <span style="color:#6C4CE0">\u2014 mixed</span>' : '') + '</div>' +
        '<div class="levels" id="lvbar" style="margin-top:7px"></div>';
      var bar = head.querySelector('#lvbar');
      levels.forEach(function(l){
        var b = document.createElement('button');
        b.className = 'lv' + (l === g ? ' on' : '');
        b.textContent = 'L' + l;
        b.onclick = function(){ rows.forEach(function(r){ r.level = l; }); paintHead(); paintAll(); reportSize(); };
        bar.appendChild(b);
      });
    }

    function paintCard(r){
      var g = globalLevel();
      var diverged = g == null && rows.length > 1;
      var sentence = r.byLevel[r.level] || r.base;
      var shown = r.opts.slice();
      if ((r.i + (r.level || 0)) % 2 === 1) shown.reverse();

      r.el.innerHTML =
        '<div class="meta">' +
          '<span class="chip">' + esc(r.p.n != null ? ('Q' + r.p.n) : ('Q' + (r.i + 1))) + '</span>' +
          (r.p.by ? '<span>by ' + esc(r.p.by) + '</span>' : '') +
          '<span>Level ' + esc(r.level) + '</span>' +
          (diverged ? '<span style="color:#6C4CE0">own level</span>' : '') +
        '</div>' +
        (levels.length > 1
          ? '<div class="levels">' + levels.map(function(l){
              return '<button class="lv' + (l === r.level ? ' on' : '') + '" data-l="' + l + '">L' + esc(l) + '</button>';
            }).join('') + '</div>'
          : '') +
        '<p class="sentence">' + esc(sentence).replace(/(_{2,})/g, '<span class="blank">$1</span>') + '</p>' +
        '<div class="opts">' + shown.map(function(w){
          return '<button class="opt" data-w="' + esc(w) + '">' + esc(w) + '</button>';
        }).join('') + '</div>' +
        '<div class="verdict"></div>';

      // Per-card tabs move THIS question only.
      r.el.querySelectorAll('.lv').forEach(function(b){
        b.onclick = function(){
          r.level = parseInt(b.getAttribute('data-l'), 10);
          paintCard(r); paintHead(); reportSize();
        };
      });

      var verdict = r.el.querySelector('.verdict');
      r.el.querySelectorAll('.opt').forEach(function(b){
        b.onclick = function(){
          var w = b.getAttribute('data-w');
          var ok = w === r.correct;
          b.classList.add(ok ? 'right' : 'wrong');
          verdict.className = 'verdict ' + (ok ? 'ok' : 'no');
          verdict.textContent = ok
            ? 'Correct \u2014 that is what the child should pick.'
            : 'Marked wrong. If this word ALSO fits the blank, the question is broken.';
          request('ui/update-model-context', {
            content: [{ type:'text', text:
              'Reviewer tried "' + w + '" on Q' + (r.p.n || (r.i + 1)) + ' at level ' + r.level +
              ' \u2014 ' + (ok ? 'correct' : 'marked wrong') + '.' }]
          });
          reportSize();
        };
      });
    }

    function paintAll(){ rows.forEach(paintCard); }

    rows.forEach(function(r){
      r.el = document.createElement('div');
      r.el.className = 'card q';
      list.appendChild(r.el);
    });
    paintHead();
    paintAll();
  }

  window.addEventListener('message', function(e){
    var m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;

    // The handshake RESULT. Everything else the host sends comes after we acknowledge this, so a
    // missed reply here means a permanently empty widget.
    // The reply to a ui/message we sent. This is the only way to learn whether the host supports it.
    if (m.id != null && msgIds[m.id]){
      var rec = msgIds[m.id]; delete msgIds[m.id];
      if (m.error){
        rec.btn.setAttribute('data-state', 'copy');
        tileNote(rec.btn, rec.copied ? 'Copied \u2014 paste it below' : rec.text, rec.copied ? '' : 'quote');
        setStatus('this host does not accept ui/message (' + (m.error.message || m.error.code) + ') \u2014 tiles copy instead');
      } else {
        rec.btn.setAttribute('data-state', 'ok');
        tileNote(rec.btn, 'Sent');
        setStatus('sent to chat');
      }
      return;
    }

    if (m.id != null && m.id === initId && m.result){
      if (!initDone){
        initDone = true;
        HOSTCAPS = m.result.hostCapabilities || {};
        applyHostContext(m.result.hostContext || {});
        notify('ui/notifications/initialized', {});
        // Name the host and what it says it supports — one screenshot then explains any dead button.
        var hn = (m.result.hostInfo && m.result.hostInfo.name) || 'host';
        setStatus('connected to ' + hn + ' [' + Object.keys(HOSTCAPS).join(',') + ']');
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
