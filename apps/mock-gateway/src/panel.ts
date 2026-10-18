/** GET /_control：零依赖的演示控制面板（纯 HTML + 原生 JS，调用同源 /_control/* 接口） */
export function renderPanel(): string {
  return PANEL_HTML;
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock Gateway 控制台</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#1d2330; --muted:#6b7385; --line:#e3e6ec; --accent:#2f6fed; --warn:#c2410c; --ok:#15803d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  header { display:flex; flex-wrap:wrap; gap:12px 24px; align-items:center; padding:14px 20px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:1; }
  header h1 { font-size:16px; margin:0; }
  header .stats { color:var(--muted); font-variant-numeric: tabular-nums; }
  header label { display:inline-flex; gap:6px; align-items:center; }
  main { display:grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); gap:16px; padding:16px 20px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:16px; }
  section h2 { font-size:14px; margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  code { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:8px; }
  input[type=text], input[type=number], select { padding:5px 8px; border:1px solid var(--line); border-radius:6px; font:inherit; background:#fff; }
  input[type=text] { min-width:140px; }
  button { padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:#fff; font:inherit; cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger:hover { border-color:var(--warn); color:var(--warn); }
  .tag { display:inline-block; padding:0 6px; border-radius:4px; font-size:12px; background:#eef1f6; color:var(--muted); margin-right:4px; }
  .tag.ok { background:#e7f6ec; color:var(--ok); }
  .tag.warn { background:#fdeee6; color:var(--warn); }
  .muted { color:var(--muted); }
  #events td { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  #toast { position:fixed; right:16px; bottom:16px; background:#1d2330; color:#fff; padding:8px 12px; border-radius:6px; opacity:0; transition:opacity .2s; max-width:60vw; }
  #toast.show { opacity:.95; }
</style>
</head>
<body>
<header>
  <h1>Mock Gateway</h1>
  <span class="stats" id="stats">加载中…</span>
  <label><input type="checkbox" id="cfg-dup"> 重复事件</label>
  <label><input type="checkbox" id="cfg-unavailable"> 整体不可用 (503)</label>
  <label><input type="checkbox" id="cfg-chaos"> 随机故障</label>
  <button id="btn-drop">断开 SSE</button>
  <button id="btn-reset" class="danger">重置</button>
</header>
<main>
  <div>
    <section>
      <h2>群与成员</h2>
      <div id="groups" class="muted">暂无群</div>
    </section>
    <section>
      <h2>账号</h2>
      <div id="accounts" class="muted">暂无账号</div>
    </section>
  </div>
  <div>
    <section>
      <h2>外部消息</h2>
      <div class="row">
        <select id="msg-group" class="group-select"></select>
        <input type="text" id="msg-user" value="ext_alice" placeholder="platformUserId">
      </div>
      <div class="row">
        <input type="text" id="msg-text" placeholder="消息内容" style="flex:1" value="大家好">
        <label><input type="checkbox" id="msg-media"> 带媒体</label>
        <button class="primary" id="btn-msg">发送</button>
      </div>
    </section>
    <section>
      <h2>外部用户进出群</h2>
      <div class="row">
        <select id="ext-group" class="group-select"></select>
        <input type="text" id="ext-user" value="ext_alice" placeholder="platformUserId">
        <button id="btn-ext-join">入群</button>
        <button id="btn-ext-leave">退群</button>
      </div>
    </section>
    <section>
      <h2>禁写群</h2>
      <div class="row">
        <select id="forbid-group" class="group-select"></select>
        <select id="forbid-mode">
          <option value="">不禁写</option>
          <option value="sync">sync（send 同步 403）</option>
          <option value="async">async（推 message_failed）</option>
        </select>
        <button id="btn-forbid">应用</button>
      </div>
    </section>
    <section>
      <h2>账号故障</h2>
      <div class="row">
        <input type="text" id="acc-id" placeholder="accountId">
        <select id="acc-status">
          <option value="suspended">suspended</option>
          <option value="session_expired">session_expired</option>
        </select>
        <label><input type="checkbox" id="acc-push" checked> 推 account_status</label>
        <button class="danger" id="btn-terminal">标为终态</button>
      </div>
      <div class="row">
        <input type="number" id="acc-rl" value="5" min="0" style="width:80px">
        <span class="muted">秒</span>
        <button id="btn-ratelimit">限流</button>
      </div>
    </section>
    <section>
      <h2>最近事件</h2>
      <table id="events"><tbody></tbody></table>
    </section>
  </div>
</main>
<div id="toast"></div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 2200);
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!r.ok) throw new Error((data && data.code) || ('HTTP ' + r.status));
        return data;
      });
    });
  }
  function act(method, path, body, okMsg) {
    return api(method, path, body).then(function (d) { toast(okMsg || '已完成'); refresh(); return d; })
      .catch(function (e) { toast('失败：' + e.message); });
  }

  var state = null;
  function renderGroups() {
    var el = $('groups');
    if (!state.groups.length) { el.className = 'muted'; el.textContent = '暂无群'; return; }
    el.className = '';
    var html = '<table><thead><tr><th>群</th><th>群主</th><th>状态</th><th>成员</th></tr></thead><tbody>';
    state.groups.forEach(function (g) {
      var flags = '';
      if (g.ownerLeft) flags += '<span class="tag warn">群主已退</span>';
      if (g.forbid) flags += '<span class="tag warn">禁写 ' + esc(g.forbid) + '</span>';
      if (!flags) flags = '<span class="tag ok">正常</span>';
      var members = g.members.map(function (m) {
        var role = m.accountId === g.ownerAccountId ? '群主' : (g.promoted.indexOf(m.accountId) >= 0 ? '管理员' : (m.accountId ? '账号' : '外部'));
        return '<div><code>' + esc(m.platformUserId) + '</code> <span class="tag">' + role + '</span>' +
          '<button data-leave="' + esc(g.groupId) + '|' + esc(m.platformUserId) + '">移出</button></div>';
      }).join('');
      html += '<tr><td><code>' + esc(g.groupId) + '</code></td><td><code>' + esc(g.ownerAccountId) + '</code></td><td>' + flags +
        '</td><td>' + (members || '<span class="muted">无</span>') + '</td></tr>';
    });
    el.innerHTML = html + '</tbody></table>';
  }
  function renderAccounts() {
    var el = $('accounts');
    if (!state.accounts.length) { el.className = 'muted'; el.textContent = '暂无账号'; return; }
    el.className = '';
    var html = '<table><thead><tr><th>账号</th><th>platformUserId</th><th>状态</th><th></th></tr></thead><tbody>';
    state.accounts.forEach(function (a) {
      var st = a.terminal ? '<span class="tag warn">' + esc(a.terminal) + '</span>' :
        (a.online ? '<span class="tag ok">online</span>' : '<span class="tag">offline</span>');
      if (a.rateLimitedUntil) st += '<span class="tag warn">限流至 ' + esc(a.rateLimitedUntil.slice(11, 19)) + '</span>';
      html += '<tr><td><code>' + esc(a.accountId) + '</code></td><td><code>' + esc(a.platformUserId) + '</code></td><td>' + st +
        '</td><td><button data-pick="' + esc(a.accountId) + '">选中</button></td></tr>';
    });
    el.innerHTML = html + '</tbody></table>';
  }
  function renderSelects() {
    var opts = state.groups.map(function (g) { return g.groupId; });
    Array.prototype.forEach.call(document.querySelectorAll('.group-select'), function (sel) {
      var cur = sel.value;
      var html = opts.length ? '' : '<option value="">（无群）</option>';
      opts.forEach(function (id) { html += '<option value="' + esc(id) + '">' + esc(id) + '</option>'; });
      if (sel.innerHTML !== html) {
        sel.innerHTML = html;
        if (opts.indexOf(cur) >= 0) sel.value = cur;
      }
    });
  }
  function renderEvents(list) {
    var html = '';
    list.slice().reverse().forEach(function (e) {
      var d = Object.assign({}, e.data);
      delete d.eventId; delete d.type;
      html += '<tr><td>#' + esc(e.eventId) + '</td><td>' + esc(e.type) + '</td><td>' + esc(JSON.stringify(d)) + '</td></tr>';
    });
    $('events').querySelector('tbody').innerHTML = html || '<tr><td class="muted">暂无事件</td></tr>';
  }
  function refresh() {
    return Promise.all([api('GET', '/_control/state'), api('GET', '/_control/events?limit=20')]).then(function (res) {
      state = res[0];
      var s = state.stats;
      $('stats').textContent = 'lastEventId ' + s.lastEventId + ' · SSE 连接 ' + s.sseClients + ' · 已落地消息 ' + s.messages +
        ' · 待入群 ' + s.pendingJoins + ' · 待落地 ' + s.pendingSends + ' · 故障规则 ' + s.faults;
      $('cfg-dup').checked = state.config.duplicateEvents >= 1;
      $('cfg-unavailable').checked = state.config.unavailable;
      $('cfg-chaos').checked = state.config.chaos;
      renderGroups(); renderAccounts(); renderSelects(); renderEvents(res[1]);
    }).catch(function (e) { $('stats').textContent = '无法连接：' + e.message; });
  }

  $('cfg-dup').onchange = function (e) { act('PATCH', '/_control/config', { duplicateEvents: e.target.checked ? 1 : 0 }, '已更新'); };
  $('cfg-unavailable').onchange = function (e) { act('PATCH', '/_control/config', { unavailable: e.target.checked }, '已更新'); };
  $('cfg-chaos').onchange = function (e) { act('PATCH', '/_control/config', { chaos: e.target.checked }, '已更新'); };
  $('btn-drop').onclick = function () { act('POST', '/_control/sse/drop', {}, 'SSE 已断开'); };
  $('btn-reset').onclick = function () { if (confirm('清空账号、群、消息与故障规则？')) act('POST', '/_control/reset', {}, '已重置'); };
  $('btn-msg').onclick = function () {
    var g = $('msg-group').value; if (!g) return toast('先选择群');
    act('POST', '/_control/groups/' + encodeURIComponent(g) + '/external-message',
      { platformUserId: $('msg-user').value, text: $('msg-text').value, withMedia: $('msg-media').checked }, '已推送 message');
  };
  $('btn-ext-join').onclick = function () {
    var g = $('ext-group').value; if (!g) return toast('先选择群');
    act('POST', '/_control/groups/' + encodeURIComponent(g) + '/external-join', { platformUserId: $('ext-user').value }, '已入群');
  };
  $('btn-ext-leave').onclick = function () {
    var g = $('ext-group').value; if (!g) return toast('先选择群');
    act('POST', '/_control/groups/' + encodeURIComponent(g) + '/external-leave', { platformUserId: $('ext-user').value }, '已退群');
  };
  $('btn-forbid').onclick = function () {
    var g = $('forbid-group').value; if (!g) return toast('先选择群');
    act('POST', '/_control/groups/' + encodeURIComponent(g) + '/forbid', { mode: $('forbid-mode').value || null }, '已更新');
  };
  $('btn-terminal').onclick = function () {
    var id = $('acc-id').value.trim(); if (!id) return toast('先填写 accountId');
    act('POST', '/_control/accounts/' + encodeURIComponent(id) + '/status',
      { status: $('acc-status').value, push: $('acc-push').checked }, '已标记');
  };
  $('btn-ratelimit').onclick = function () {
    var id = $('acc-id').value.trim(); if (!id) return toast('先填写 accountId');
    act('POST', '/_control/accounts/' + encodeURIComponent(id) + '/rate-limit',
      { retryAfterSeconds: Number($('acc-rl').value) || 0 }, '已限流');
  };
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;
    var leave = t.getAttribute('data-leave');
    if (leave) {
      var i = leave.indexOf('|');
      act('POST', '/_control/groups/' + encodeURIComponent(leave.slice(0, i)) + '/external-leave',
        { platformUserId: leave.slice(i + 1) }, '已移出');
    }
    var pick = t.getAttribute('data-pick');
    if (pick) { $('acc-id').value = pick; toast('已选中 ' + pick); }
  });

  refresh();
  setInterval(refresh, 1500);
})();
</script>
</body>
</html>
`;
