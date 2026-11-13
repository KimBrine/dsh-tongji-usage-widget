/** A dependency-free widget. Keep every helper inside this function for inline injection. */
export function mountWidget({ call, storage, document: documentOption } = {}) {
  const doc = documentOption || globalThis.document;
  const win = doc.defaultView || globalThis;
  if (!doc?.body || typeof call !== 'function') return () => {};
  const previous = doc.getElementById('tongji-ai-usage-widget');
  if (previous?.__tongjiDispose) previous.__tongjiDispose();
  else previous?.remove();
  if (storage === undefined) {
    try { storage = win.localStorage; } catch { storage = null; }
  }
  const storageKey = 'tongji-ai-usage-widget:v1';
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(storageKey) || '{}') || {}; } catch { /* optional storage */ }
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
  const preferences = {
    collapsed: saved.collapsed === true,
    lowBalance: numeric(saved.lowBalance) && saved.lowBalance >= 0 ? saved.lowBalance : 100,
    dailyBudget: numeric(saved.dailyBudget) && saved.dailyBudget >= 0 ? saved.dailyBudget : 0,
    x: numeric(saved.x) ? saved.x : null,
    y: numeric(saved.y) ? saved.y : null,
    edgeX: ['left', 'right'].includes(saved.edgeX) ? saved.edgeX : numeric(saved.x) ? null : 'right',
    edgeY: ['top', 'bottom'].includes(saved.edgeY) ? saved.edgeY : numeric(saved.y) ? null : 'bottom',
  };
  let disposed = false;
  let loading = false;
  let timer;
  let range = 'today';
  let report = null;
  let todayUsage = null;
  let todayError = null;
  let error = null;
  let setupCommand = '';
  let refreshSeconds = 60;
  let detailsOpen = false;
  let settingsOpen = false;
  let drag = null;
  let dragged = false;
  let rangeNeedsRefresh = false;
  const cleanups = [];
  const listen = (target, event, listener, options) => {
    target.addEventListener(event, listener, options);
    cleanups.push(() => target.removeEventListener(event, listener, options));
  };
  const host = doc.createElement('div');
  host.id = 'tongji-ai-usage-widget';
  host.style.cssText = 'position:fixed;z-index:2147483000;left:0;top:0;display:block;width:max-content;max-width:calc(100vw - 16px);font-size:14px;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{--bg:#fff;--fg:#182f38;--muted:#697e84;--line:#e3ecec;--soft:#f2f7f6;--accent:#087c75;--accent-soft:#e4f4ef;--warn:#8c5511;--warn-bg:#fff5dd;--danger:#a43a38;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--fg);color-scheme:light;box-sizing:border-box}
      *{box-sizing:border-box} [hidden]{display:none!important} button,input,select{font:inherit}button,a,select,input{outline-offset:3px}button{color:inherit;cursor:pointer;border:0}button:disabled{cursor:wait;opacity:.45}button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent)}
      .card{width:284px;max-width:calc(100vw - 16px);border:1px solid var(--line);border-radius:19px;background:var(--bg);box-shadow:0 9px 34px #163f3524,0 2px 5px #163f3510;overflow:hidden}
      .header{display:flex;align-items:center;gap:9px;padding:13px 13px 10px;cursor:grab;touch-action:none;user-select:none}.header:active{cursor:grabbing}.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;color:var(--accent);background:var(--accent-soft);font-size:18px;flex:none}.title{font-size:12px;font-weight:700;letter-spacing:.04em;flex:1}.subtitle{font-size:10px;color:var(--muted);font-weight:400;letter-spacing:0;margin-top:1px}.icon{display:grid;place-items:center;width:27px;height:27px;padding:0;border-radius:8px;background:transparent;font-size:17px}.icon:hover{background:var(--soft)}
      .body{padding:0 16px 13px}.balance-label{color:var(--muted);font-size:11px}.balance-row{display:flex;align-items:baseline;gap:7px;margin:2px 0 7px}.balance{font-size:32px;font-weight:720;line-height:1.2;letter-spacing:-1.2px;font-variant-numeric:tabular-nums}.unit{font-size:11px;color:var(--muted)}.plan{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:11px}.progress{height:5px;background:var(--soft);border-radius:9px;overflow:hidden;margin:9px 0 6px}.progress>span{display:block;background:var(--accent);height:100%;width:0;transition:width .4s ease;border-radius:9px}.progress.low>span{background:#c38a32}.progress-text{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);gap:8px}.summary{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--line);margin-top:11px;padding-top:10px;gap:8px}.summary-label{font-size:11px;color:var(--muted)}.summary-value{font-variant-numeric:tabular-nums;font-size:15px;font-weight:650}.summary-value small{font-size:10px;font-weight:400;color:var(--muted);margin-left:3px}
      .notice{font-size:11px;padding:8px 10px;border-radius:9px;margin-top:10px;color:var(--warn);background:var(--warn-bg);overflow-wrap:anywhere}.notice.error{color:var(--danger);background:#fceeee}.status{display:flex;gap:5px;align-items:center;min-width:0;font-size:10px;color:var(--muted);padding-top:10px}.dot{width:5px;height:5px;border-radius:50%;background:var(--accent);flex:none}.dot.stale{background:#be8b32}.status-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.text-button{color:var(--accent);background:transparent;padding:0;font-size:11px;flex:none}.text-button:hover{text-decoration:underline}
      .details,.settings,.setup{border-top:1px solid var(--line);padding:12px 16px 14px}.section-title{font-size:11px;letter-spacing:.03em;font-weight:650;margin-bottom:8px}.facts{display:grid;grid-template-columns:1fr auto;gap:7px 9px;margin:0;font-size:11px}.facts dt{color:var(--muted)}.facts dd{margin:0;text-align:right;overflow-wrap:anywhere;max-width:155px;font-variant-numeric:tabular-nums}.select-row{display:flex;align-items:center;justify-content:space-between;margin:13px 0 9px;font-size:11px}select{max-width:120px;padding:3px 6px;background:var(--soft);border:1px solid var(--line);border-radius:7px;color:var(--fg);font-size:11px}.caption{margin-top:9px;font-size:10px;color:var(--muted);line-height:1.5}.warning-text{margin-top:9px;font-size:10px;color:var(--warn);overflow-wrap:anywhere}.models{padding:0;margin:8px 0 0;list-style:none;font-size:10px;color:var(--muted)}.models li{display:flex;justify-content:space-between;gap:8px;padding-top:4px}.models li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
      .setting-row{display:flex;align-items:center;justify-content:space-between;margin-top:9px;font-size:11px;gap:8px}.setting-row input{width:93px;min-width:0;background:var(--soft);border:1px solid var(--line);border-radius:7px;padding:5px 7px;color:var(--fg)}.actions{display:flex;justify-content:flex-end;gap:7px;margin-top:11px}.button{padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font-size:11px}.button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.settings-message{color:var(--danger);font-size:10px;margin-top:6px}.setup{font-size:11px;overflow-wrap:anywhere}.setup p{margin:0 0 8px}.setup a{color:var(--accent)}.command{display:block;white-space:pre-wrap;word-break:break-all;background:var(--soft);border-radius:7px;padding:8px;font:10px/1.5 Consolas,monospace;user-select:text;max-height:100px;overflow:auto}
      .pill{display:flex;align-items:center;gap:7px;max-width:calc(100vw - 16px);border:1px solid var(--line);border-radius:30px;background:var(--bg);box-shadow:0 6px 24px #163f3526;padding:7px 10px;cursor:grab;touch-action:none;user-select:none}.pill:active{cursor:grabbing}.pill .mark{width:25px;height:25px;border-radius:50%;font-size:15px}.pill-value{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.3px}.pill-unit{font-size:10px;color:var(--muted)}.pill-alert{color:var(--warn);font-weight:700}.pill-expand{padding:2px 1px 2px 5px;background:transparent;color:var(--muted);font-size:15px}.dragging .card,.dragging .pill{box-shadow:0 16px 42px #163f3530}
      @media(prefers-color-scheme:dark){:host{--bg:#17262b;--fg:#e4efed;--muted:#9bb0b3;--line:#2b4145;--soft:#20353a;--accent:#6bd7bc;--accent-soft:#213f3c;--warn:#eac68a;--warn-bg:#40351f;color-scheme:dark}.notice.error{color:#f1a7a2;background:#422a2a}.button.primary{color:#13372e}}
      @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
    </style>
    <section class="card" aria-label="同济 AI 积分监控">
      <div class="header" data-drag tabindex="0" aria-label="拖动积分卡片；方向键移动，Shift 加速">
        <span class="mark" aria-hidden="true">◈</span>
        <div class="title">同济 AI<span class="subtitle" style="display:block">积分监控</span></div>
        <button class="icon" id="refresh" aria-label="刷新积分" title="刷新积分">↻</button>
        <button class="icon" id="settings-toggle" aria-label="提醒设置" aria-expanded="false" title="提醒设置">⚙</button>
        <button class="icon" id="collapse" aria-label="收起积分卡片" title="收起">−</button>
      </div>
      <div class="body">
        <div class="balance-label" id="balance-label">套餐本周期剩余</div>
        <div class="balance-row"><span class="balance" id="balance">—</span><span class="unit">积分</span></div>
        <div class="plan" id="plan">正在连接平台…</div>
        <div class="progress" id="progress" role="progressbar" aria-label="套餐剩余比例" aria-valuemin="0" aria-valuemax="100"><span id="progress-fill"></span></div>
        <div class="progress-text"><span id="remaining-percentage">剩余 —</span><span id="reset-short">重置日期待查询</span></div>
        <div class="summary"><span class="summary-label" id="today-label">今日已用 · 平台统计</span><span class="summary-value"><span id="today-cost">—</span><small>积分</small></span></div>
        <div class="notice" id="notice" role="status" aria-live="polite" hidden></div>
        <div class="status"><span class="dot" id="status-dot"></span><span class="status-text" id="status">等待首次更新</span><button class="text-button" id="details-toggle" aria-expanded="false">查看明细</button></div>
      </div>
      <div class="details" id="details" hidden>
        <div class="section-title">积分概览</div>
        <dl class="facts"><dt>账户总积分</dt><dd id="account-total">—</dd><dt>本周期已用 / 总额</dt><dd id="period-usage">—</dd><dt>下次重置</dt><dd id="reset-full">—</dd></dl>
        <div class="select-row"><label for="range">实际 Token 用量</label><select id="range"><option value="today">今日</option><option value="yesterday">昨日</option><option value="7d">近 7 天</option></select></div>
        <dl class="facts"><dt>统计积分消耗</dt><dd id="range-cost">—</dd><dt>Token 总计</dt><dd id="tokens-total">—</dd><dt>未缓存输入 / 输出</dt><dd id="tokens-io">—</dd><dt>缓存输入</dt><dd id="tokens-cached">—</dd><dt>调用次数</dt><dd id="calls">—</dd></dl>
        <ul class="models" id="models"></ul>
        <div class="caption">Token 总计由未缓存输入、缓存输入和输出组成。统计为平台账户范围，包含其他客户端的使用；所选范围不等同于套餐重置周期。</div>
        <div class="warning-text" id="warnings" hidden></div>
      </div>
      <form class="settings" id="settings" hidden>
        <div class="section-title">提醒设置</div>
        <label class="setting-row">低积分阈值<input id="low-balance" type="number" min="0" max="1000000000" step="any" inputmode="decimal" required></label>
        <label class="setting-row">每日积分预算<input id="daily-budget" type="number" min="0" max="1000000000" step="any" inputmode="decimal" required></label>
        <div class="caption">填 0 关闭对应提醒。设置仅保存在当前浏览器，余额与登录令牌不会存入浏览器。</div>
        <div class="settings-message" id="settings-message" role="status"></div>
        <div class="actions"><button class="button" type="button" id="reset-position">复位位置</button><button class="button primary" type="submit">保存设置</button></div>
      </form>
      <div class="setup" id="setup" hidden><p>请在 <a href="https://agi.tongji.edu.cn/models/hub" target="_blank" rel="noopener noreferrer">同济 AI 平台</a>重新登录，然后在本机终端导入 access_token。</p><code class="command" id="setup-command"></code><div class="actions"><button class="button" id="copy-command">复制导入命令</button></div><div class="caption">令牌只粘贴到本机导入终端，请勿发到聊天中。完成后点击刷新。</div></div>
    </section>
    <div class="pill" id="pill" data-drag tabindex="0" aria-label="同济 AI 积分；回车展开，方向键移动" hidden><span class="mark" aria-hidden="true">◈</span><span class="pill-value" id="pill-value">—</span><span class="pill-unit">积分</span><span class="pill-alert" id="pill-alert" hidden>!</span><button class="pill-expand" id="expand" aria-label="展开积分卡片" title="展开">↗</button></div>`;
  const element = (id) => shadow.getElementById(id);
  const card = shadow.querySelector('.card');
  const pill = element('pill');
  const put = (id, value) => { element(id).textContent = value; };
  const numberText = (value, maximumFractionDigits = 3) => numeric(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits }) : '—';
  const dateText = (value, short = false) => {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', short
      ? { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }
      : { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '未提供';
  };
  const persist = () => {
    try { storage?.setItem(storageKey, JSON.stringify(preferences)); } catch { /* optional storage */ }
  };
  const move = (x, y) => {
    const width = host.getBoundingClientRect().width;
    const height = host.getBoundingClientRect().height;
    const maxX = Math.max(8, win.innerWidth - width - 8);
    const maxY = Math.max(8, win.innerHeight - Math.min(height, win.innerHeight - 16) - 8);
    preferences.x = Math.max(8, Math.min(maxX, x));
    preferences.y = Math.max(8, Math.min(maxY, y));
    host.style.left = `${preferences.x}px`;
    host.style.top = `${preferences.y}px`;
    card.style.maxHeight = `${Math.max(140, win.innerHeight - 16)}px`;
    card.style.overflowY = 'auto';
  };
  const place = () => {
    if (disposed || drag) return;
    const rect = host.getBoundingClientRect();
    const x = preferences.edgeX === 'left' ? 12 : preferences.edgeX === 'right'
      ? win.innerWidth - rect.width - 16 : preferences.x ?? win.innerWidth - rect.width - 16;
    const y = preferences.edgeY === 'top' ? 12 : preferences.edgeY === 'bottom'
      ? win.innerHeight - rect.height - 20 : preferences.y ?? win.innerHeight - rect.height - 20;
    move(x, y);
  };
  const render = () => {
    if (disposed) return;
    const points = report?.points || {};
    const usage = report?.usage?.range === range ? report.usage : null;
    const isAuth = error && ['AUTH_MISSING', 'AUTH_EXPIRED', 'INVALID_CREDENTIALS'].includes(error.code);
    const remaining = points.planRemaining;
    const low = preferences.lowBalance > 0 && numeric(remaining) && remaining < preferences.lowBalance;
    const overBudget = preferences.dailyBudget > 0 && numeric(todayUsage?.pointsCost) && todayUsage.pointsCost >= preferences.dailyBudget;
    const alerts = [];
    if (low) alerts.push(`剩余积分低于 ${numberText(preferences.lowBalance)}`);
    if (overBudget) alerts.push(`今日消耗已达预算 ${numberText(preferences.dailyBudget)} 积分`);
    card.hidden = preferences.collapsed;
    pill.hidden = !preferences.collapsed;
    put('balance-label', points.source === 'account' ? '账户总积分' : '套餐本周期剩余');
    put('balance', numberText(remaining));
    put('pill-value', numberText(remaining));
    pill.setAttribute('aria-label', `同济 AI ${points.source === 'account' ? '账户总积分' : '套餐剩余'} ${numberText(remaining)} 积分；回车展开，方向键移动`);
    put('plan', report?.plan?.name || (report ? points.source === 'account' ? '当前无活动套餐' : '套餐信息未提供' : error ? '等待连接' : '正在连接平台…'));
    const percentage = numeric(points.remainingPercentage) ? Math.max(0, Math.min(100, points.remainingPercentage)) : null;
    element('progress').hidden = percentage === null;
    element('progress').classList.toggle('low', low);
    if (percentage !== null) element('progress').setAttribute('aria-valuenow', String(percentage));
    else element('progress').removeAttribute('aria-valuenow');
    element('progress-fill').style.width = `${percentage ?? 0}%`;
    put('remaining-percentage', percentage === null ? '周期比例未知' : `剩余 ${numberText(percentage, 1)}%`);
    put('reset-short', points.resetAt ? `${dateText(points.resetAt, true)} 重置` : '重置日期未提供');
    put('today-cost', numberText(todayUsage?.pointsCost));
    put('today-label', todayError ? todayUsage ? '今日已用 · 上次统计' : '今日已用 · 暂不可用' : '今日已用 · 平台统计');
    put('account-total', numberText(points.totalAvailable));
    put('period-usage', `${numberText(points.planPeriodUsed)} / ${numberText(points.planIncluded)}`);
    put('reset-full', dateText(points.resetAt));
    put('range-cost', numberText(usage?.pointsCost));
    put('tokens-total', numberText(usage?.totalTokens, 0));
    put('tokens-io', `${numberText(usage?.inputTokens, 0)} / ${numberText(usage?.outputTokens, 0)}`);
    put('tokens-cached', numberText(usage?.cachedInputTokens, 0));
    put('calls', numberText(usage?.calls, 0));
    const models = element('models');
    models.replaceChildren();
    for (const model of (Array.isArray(usage?.byModel) ? usage.byModel : []).slice(0, 8)) {
      const row = doc.createElement('li');
      const name = doc.createElement('span');
      const cost = doc.createElement('span');
      name.textContent = String(model.model || model.name || '未命名模型');
      cost.textContent = `${numberText(model.pointsCost)} 积分`;
      row.append(name, cost);
      models.append(row);
    }
    const warningMessages = (Array.isArray(report?.warnings) ? report.warnings : []).map((warning) => typeof warning === 'string' ? warning : warning?.message).filter(Boolean);
    if (todayError) warningMessages.push(todayUsage ? '今日统计更新失败，今日已用为上次成功查询值。' : '今日统计暂不可用。');
    element('warnings').hidden = warningMessages.length === 0;
    put('warnings', warningMessages.join('；'));
    const notice = element('notice');
    const message = error?.message || (todayError && !todayUsage ? '今日统计暂不可用，余额已单独更新。' : alerts.join('；'));
    notice.hidden = !message;
    notice.classList.toggle('error', Boolean(isAuth));
    if (notice.textContent !== message) notice.textContent = message;
    element('pill-alert').hidden = !(error || low || overBudget || warningMessages.length);
    element('status-dot').classList.toggle('stale', Boolean(error || warningMessages.length));
    put('status', loading ? '正在刷新…' : error ? report ? `更新失败 · 上次 ${dateText(report.queriedAt)}` : '尚未成功更新' : report ? `更新于 ${dateText(report.queriedAt)} · ${refreshSeconds}秒刷新` : '等待首次更新');
    element('status').title = report?.queriedAt ? `平台数据查询时间：${dateText(report.queriedAt)}（北京时间）` : '';
    element('refresh').disabled = loading;
    element('refresh').setAttribute('aria-busy', String(loading));
    element('details').hidden = !detailsOpen;
    element('details-toggle').setAttribute('aria-expanded', String(detailsOpen));
    put('details-toggle', detailsOpen ? '收起明细' : '查看明细');
    element('settings').hidden = !settingsOpen;
    element('settings-toggle').setAttribute('aria-expanded', String(settingsOpen));
    element('setup').hidden = !isAuth;
    put('setup-command', setupCommand || '请在插件目录执行：node scripts/auth.mjs set-token');
    place();
  };
  const schedule = () => {
    win.clearTimeout(timer);
    if (!disposed && !doc.hidden) timer = win.setTimeout(() => refresh(false), refreshSeconds * 1000);
  };
  const accept = (snapshot, expectedRange, updateReport = true) => {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('invalid snapshot');
    if (typeof snapshot.setupCommand === 'string') setupCommand = snapshot.setupCommand;
    if (numeric(snapshot.refreshInterval)) refreshSeconds = Math.max(30, Math.min(3600, snapshot.refreshInterval));
    if (snapshot.error && ['AUTH_MISSING', 'AUTH_EXPIRED', 'INVALID_CREDENTIALS'].includes(snapshot.error.code)) {
      // Credentials may now refer to another account; no former account balance remains trustworthy.
      report = null;
      todayUsage = null;
      todayError = snapshot.error;
      error = snapshot.error;
      return snapshot;
    }
    if (expectedRange === 'today') {
      if (snapshot.report) {
        // A fresh balance with failed statistics must not make an older daily total look fresh.
        todayUsage = snapshot.report.usage?.range === 'today' ? snapshot.report.usage : null;
        todayError = snapshot.error || (todayUsage ? null : { code: 'STATS_UNAVAILABLE', message: '今日统计暂不可用。' });
      } else {
        todayError = snapshot.error || null;
      }
    }
    if (updateReport && expectedRange === range) {
      if (snapshot.report) report = snapshot.report;
      error = snapshot.error || null;
    }
    return snapshot;
  };
  async function refresh(force = false) {
    if (disposed || doc.hidden) return;
    if (loading) { if (force) rangeNeedsRefresh = true; return; }
    win.clearTimeout(timer);
    const requestedRange = range;
    loading = true;
    render();
    try {
      // Keep the daily budget based on today's statistics even while another range is selected.
      if (requestedRange !== 'today') {
        const daily = accept(await call('status', { range: 'today', force }), 'today', false);
        if (disposed) return;
        if (daily.error && ['AUTH_MISSING', 'AUTH_EXPIRED', 'INVALID_CREDENTIALS'].includes(daily.error.code)) {
          error = daily.error;
          return;
        }
      }
      const snapshot = await call('status', { range: requestedRange, force });
      if (!disposed) accept(snapshot, requestedRange);
    } catch {
      if (!disposed) error = { code: 'BRIDGE_ERROR', message: '暂时无法连接 DSH，稍后将自动重试。' };
    } finally {
      loading = false;
      if (!disposed) {
        render();
        if (rangeNeedsRefresh || requestedRange !== range) {
          rangeNeedsRefresh = false;
          timer = win.setTimeout(() => refresh(false), 0);
        } else schedule();
      }
    }
  }
  const collapse = (collapsed) => {
    preferences.collapsed = collapsed;
    persist();
    render();
    if (!collapsed) element('collapse').focus();
    else pill.focus();
  };
  listen(element('refresh'), 'click', () => refresh(true));
  listen(element('collapse'), 'click', () => collapse(true));
  listen(element('expand'), 'click', () => { if (!dragged) collapse(false); });
  listen(pill, 'click', (event) => { if (event.target !== element('expand') && !dragged) collapse(false); });
  listen(element('details-toggle'), 'click', () => { detailsOpen = !detailsOpen; render(); });
  listen(element('settings-toggle'), 'click', () => {
    settingsOpen = !settingsOpen;
    element('low-balance').value = String(preferences.lowBalance);
    element('daily-budget').value = String(preferences.dailyBudget);
    put('settings-message', '');
    render();
  });
  listen(element('range'), 'change', () => {
    range = element('range').value;
    render();
    refresh(true);
  });
  listen(element('settings'), 'submit', (event) => {
    event.preventDefault();
    const lowBalance = Number(element('low-balance').value);
    const dailyBudget = Number(element('daily-budget').value);
    if (![lowBalance, dailyBudget].every((value) => Number.isFinite(value) && value >= 0 && value <= 1e9)) {
      put('settings-message', '请输入 0 至 10 亿之间的有效数字。');
      return;
    }
    preferences.lowBalance = lowBalance;
    preferences.dailyBudget = dailyBudget;
    settingsOpen = false;
    persist();
    render();
  });
  listen(element('reset-position'), 'click', () => {
    preferences.edgeX = 'right'; preferences.edgeY = 'bottom';
    preferences.x = null; preferences.y = null;
    place(); persist();
  });
  listen(element('copy-command'), 'click', async () => {
    try {
      await win.navigator.clipboard.writeText(setupCommand || 'node scripts/auth.mjs set-token');
      if (!disposed) put('copy-command', '已复制');
    } catch {
      if (!disposed) put('copy-command', '请手动选中命令复制');
    }
  });
  const snap = () => {
    const rect = host.getBoundingClientRect();
    preferences.edgeX = rect.left < 34 ? 'left' : win.innerWidth - rect.right < 34 ? 'right' : null;
    preferences.edgeY = rect.top < 34 ? 'top' : win.innerHeight - rect.bottom < 34 ? 'bottom' : null;
    place(); persist();
  };
  for (const handle of shadow.querySelectorAll('[data-drag]')) {
    listen(handle, 'pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button,a,input,select')) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, handle };
      dragged = false;
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    listen(handle, 'keydown', (event) => {
      if (event.target !== handle) return;
      if (handle === pill && ['Enter', ' '].includes(event.key)) { event.preventDefault(); collapse(false); return; }
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      preferences.edgeX = null; preferences.edgeY = null;
      move((preferences.x || 0) + direction[0] * (event.shiftKey ? 24 : 8), (preferences.y || 0) + direction[1] * (event.shiftKey ? 24 : 8));
      persist();
    });
  }
  listen(win, 'pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    if (!dragged) return;
    host.classList.add('dragging');
    preferences.edgeX = null; preferences.edgeY = null;
    move(drag.x + dx, drag.y + dy);
  });
  const stopDrag = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    try { drag.handle.releasePointerCapture?.(event.pointerId); } catch { /* pointer capture already lost */ }
    drag = null;
    host.classList.remove('dragging');
    snap();
    // A dragged capsule must not interpret its synthetic click as an expand action.
    win.clearTimeout(clickResetTimer);
    clickResetTimer = win.setTimeout(() => { dragged = false; }, 0);
  };
  let clickResetTimer;
  listen(win, 'pointerup', stopDrag);
  listen(win, 'pointercancel', stopDrag);
  listen(win, 'resize', place);
  listen(doc, 'visibilitychange', () => {
    if (doc.hidden) win.clearTimeout(timer);
    else refresh(false);
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    win.clearTimeout(timer);
    win.clearTimeout(clickResetTimer);
    for (const cleanup of cleanups) cleanup();
    host.remove();
  };
  host.__tongjiDispose = dispose;
  doc.body.append(host);
  render();
  refresh(false);
  return dispose;
}
