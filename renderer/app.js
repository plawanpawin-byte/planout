'use strict';
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const uid = () => Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toast = (m) => { const t = h('div', { class: 'toast', text: m }); document.body.append(t); setTimeout(() => t.remove(), 2400); };

// ---------- dates (UTC day numbers) ----------
const DAY = 86400000;
const toDay = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
const toIso = (d) => new Date(d * DAY).toISOString().slice(0, 10);
const todayDay = () => { const n = new Date(); return Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / DAY); };
const validIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const dow = (d) => (new Date(d * DAY).getUTCDay());
const isWeekend = (d) => dow(d) === 0 || dow(d) === 6;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- model ----------
// task: {id, name, start(day), dur(days, 0 = milestone), done(0-100), dep: id|'' , who, group(bool)}
let doc = { title: 'Untitled plan', tasks: [] };
let sel = null, fileName = '';
let dayW = 26;
let undoS = [], redoS = [];
const snapshot = () => JSON.stringify(doc);
function commit() { undoS.push(snapshot()); if (undoS.length > 100) undoS.shift(); redoS = []; }
function undo() { if (!undoS.length) return; redoS.push(snapshot()); doc = JSON.parse(undoS.pop()); render(); }
function redo() { if (!redoS.length) return; undoS.push(snapshot()); doc = JSON.parse(redoS.pop()); render(); }
const byId = (id) => doc.tasks.find((t) => t.id === id);
const endOf = (t) => t.start + Math.max(t.dur, 0);

// resolve dependencies: a task starts no earlier than its predecessor's end (iterate, guard against cycles)
function schedule() {
  for (let pass = 0; pass < doc.tasks.length + 1; pass++) {
    let changed = false;
    for (const t of doc.tasks) {
      if (!t.dep) continue; const p = byId(t.dep); if (!p || p === t) continue;
      if (t.start < endOf(p)) { t.start = endOf(p); changed = true; }
    }
    if (!changed) break;
  }
}
function hasCycle(id, dep) { let cur = dep, n = 0; while (cur && n++ < 1000) { if (cur === id) return true; const p = byId(cur); cur = p ? p.dep : ''; } return false; }
// critical path method: forward pass is the schedule itself, backward pass gives latest finish; slack = LF - EF
let slackMap = {};
function critical() {
  const finish = Math.max(...doc.tasks.map(endOf), 0), lf = {}, crit = new Set();
  const succ = (t) => doc.tasks.filter((x) => x.dep === t.id);
  const calc = (t, depth = 0) => { if (lf[t.id] != null) return lf[t.id]; if (depth > 500) return finish; const ss = succ(t); let v = finish; for (const x of ss) v = Math.min(v, calc(x, depth + 1) - Math.max(x.dur, 0)); lf[t.id] = v; return v; };
  slackMap = {};
  for (const t of doc.tasks) { const sl = calc(t) - endOf(t); slackMap[t.id] = sl; if (sl <= 0) crit.add(t.id); }
  return crit;
}
// resources: workload per owner
function resources() {
  const m = new Map();
  for (const t of doc.tasks) { const w = (t.who || '').trim(); if (!w || t.dur === 0) continue; if (!m.has(w)) m.set(w, []); m.get(w).push(t); }
  return [...m.entries()].map(([name, ts]) => {
    const load = new Map(); let days = 0;
    for (const t of ts) for (let d = t.start; d < endOf(t); d++) { load.set(d, (load.get(d) || 0) + 1); days++; }
    const over = [...load.values()].filter((v) => v > 1).length;
    const a = Math.min(...ts.map((t) => t.start)), b = Math.max(...ts.map(endOf));
    return { name, tasks: ts, days, over, peak: Math.max(...load.values(), 0), a, b, load };
  }).sort((x, y) => y.days - x.days);
}
function levelResources() {
  commit();
  let moved = 0;
  const order = [...doc.tasks].sort((x, y) => x.start - y.start);
  const busy = new Map();
  for (const t of order) {
    const w = (t.who || '').trim(); if (!w || t.dur === 0) continue;
    const list = busy.get(w) || []; let guard = 0;
    while (guard++ < 400 && list.some((o) => t.start < endOf(o) && endOf(t) > o.start)) { t.start = Math.max(t.start + 1, Math.min(...list.filter((o) => t.start < endOf(o) && endOf(t) > o.start).map(endOf))); moved++; }
    list.push(t); busy.set(w, list); schedule();
  }
  render(); toast(moved ? 'Leveled: moved ' + moved + ' step(s)' : 'No overlaps to level');
}
function setBaseline() { commit(); doc.baseline = {}; for (const t of doc.tasks) doc.baseline[t.id] = { start: t.start, dur: t.dur }; render(); toast('Baseline saved'); }
function clearBaseline() { if (!doc.baseline) return; commit(); delete doc.baseline; render(); toast('Baseline cleared'); }
function openResources() {
  const rs = resources(); const body = h('div', { style: 'min-width:560px;max-height:60vh;overflow:auto' });
  if (!rs.length) body.append(h('div', { class: 'muted', text: 'Give tasks an owner and workload will show up here.' }));
  for (const r of rs) {
    const W = 520, n = r.b - r.a + 1, cw = Math.max(3, Math.min(14, W / n));
    const svg = sv('svg', { width: Math.ceil(n * cw), height: 30, style: 'display:block;margin:4px 0' });
    for (let i = 0; i < n; i++) { const v = r.load.get(r.a + i) || 0; if (v) svg.append(sv('rect', { x: i * cw, y: v > 1 ? 2 : 10, width: cw - 1, height: v > 1 ? 26 : 18, fill: v > 1 ? '#f0f0f0' : '#8a8a8a' })); }
    body.append(h('div', { style: 'border-bottom:1px solid var(--line);padding:8px 0' }, h('div', { style: 'display:flex;gap:12px;align-items:baseline' }, h('b', { text: r.name }), h('span', { class: 'muted', text: r.tasks.length + ' tasks, ' + r.days + ' working days, peak ' + r.peak + ' at once' }), h('span', { style: 'margin-left:auto', text: r.over ? r.over + ' overloaded day(s)' : 'No overload' })), svg));
  }
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Resources' }), body, h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Level overlaps', () => { back.remove(); levelResources(); }), btn('Close', () => back.remove(), 'primary'))));
  document.body.append(back);
}

// ---------- shell ----------
const app = $('#app');
const toolbar = h('div', { class: 'toolbar' });
const main = h('div', { class: 'main', style: 'flex:1;min-height:0;min-width:0;overflow:hidden;width:100%' });
const tableWrap = h('div', { style: 'width:560px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--line);min-height:0' });
const tHead = h('div', { class: 'pl-head' });
const tBody = h('div', { class: 'pl-body', style: 'overflow:hidden;flex:1' });
tableWrap.append(tHead, tBody);
const ganttWrap = h('div', { class: 'pl-gantt', style: 'flex:1;min-width:0;overflow:auto;position:relative;background:#1f1f1f' });
main.append(tableWrap, ganttWrap);
const status = h('div', { class: 'status' });
app.append(toolbar, main, status);
const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn, text: label });
toolbar.append(btn('New', newDoc), btn('Open', openDoc), btn('Save', saveDoc, 'primary'), h('span', { class: 'sep' }),
  btn('Add task', () => addTask(false)), btn('Add milestone', () => addTask(true)), btn('Delete', del), btn('Move up', () => mv(-1)), btn('Move down', () => mv(1)), h('span', { class: 'sep' }),
  btn('Undo', undo), btn('Redo', redo), h('span', { class: 'sep' }),
  btn('-', () => { dayW = clamp(dayW / 1.25, 6, 80); render(); }, 'icon'), btn('+', () => { dayW = clamp(dayW * 1.25, 6, 80); render(); }, 'icon'), btn('Today', scrollToday), h('span', { class: 'sep' }), btn('Set baseline', setBaseline), btn('Clear baseline', clearBaseline), btn('Resources', openResources), h('span', { class: 'grow' }),
  btn('Export CSV', exportCsv), btn('Export PNG', exportPng));
const style = h('style', { text: `
.pl-head,.pl-row{display:grid;grid-template-columns:34px minmax(140px,1fr) 104px 56px 68px 66px 96px;align-items:center;gap:0;border-bottom:1px solid var(--line);height:32px;font-size:12px}
.pl-head{background:var(--bg-2);color:var(--text-2);height:44px;border-bottom:1px solid var(--line-2);padding-top:0}
.pl-head>div,.pl-row>div{padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-row.sel{background:#3a3a3a}
.pl-row input,.pl-row select{height:26px;width:100%;background:transparent;border:1px solid transparent;color:var(--text);padding:3px 4px;font:inherit;border-radius:3px}
.pl-row input:hover,.pl-row select:hover{border-color:var(--line-2)}
.pl-row input:focus,.pl-row select:focus{border-color:var(--accent);background:var(--bg)}
.pl-row.ms .nm{font-style:italic}
.pl-row.bad input.d{border-color:#c08080}
` });
document.head.append(style);

// ---------- render ----------
const ROWH = 32, HEADH = 44;
let origin = 0, span = 60;
function render() {
  schedule();
  // table
  tHead.textContent = '';
  tHead.style.display = 'grid';
  ['#', 'Task', 'Start', 'Days', 'Done %', 'After', 'Owner'].forEach((c) => tHead.append(h('div', { text: c })));
  tHead.style.gridTemplateColumns = '34px minmax(140px,1fr) 104px 56px 68px 66px 96px';
  tBody.textContent = '';
  const cols = '34px minmax(140px,1fr) 104px 56px 68px 66px 96px';
  doc.tasks.forEach((t, i) => {
    const row = h('div', { class: 'pl-row' + (sel === t.id ? ' sel' : '') + (t.dur === 0 ? ' ms' : ''), style: `grid-template-columns:${cols}`, 'data-id': t.id, onclick: () => { if (sel !== t.id) { sel = t.id; render(); } } });
    const name = h('input', { class: 'nm', type: 'text', 'aria-label': 'Task name', value: t.name, onfocus: commit, oninput: (e) => { t.name = e.target.value; drawGantt(); } });
    const start = h('input', { 'aria-label': 'Start date', class: 'd', type: 'text', value: toIso(t.start), onchange: (e) => { if (validIso(e.target.value)) { commit(); t.start = toDay(e.target.value); render(); } else { e.target.value = toIso(t.start); toast('Use YYYY-MM-DD'); } } });
    const dur = h('input', { 'aria-label': 'Duration in days', type: 'number', min: 0, value: t.dur, onchange: (e) => { commit(); t.dur = clamp(Math.round(+e.target.value || 0), 0, 3650); render(); } });
    const done = h('input', { 'aria-label': 'Percent done', type: 'number', min: 0, max: 100, value: t.done, onchange: (e) => { commit(); t.done = clamp(Math.round(+e.target.value || 0), 0, 100); render(); } });
    const dep = h('select', { onchange: (e) => { const v = e.target.value; if (v && hasCycle(t.id, v)) { toast('That would create a loop'); e.target.value = t.dep; return; } commit(); t.dep = v; render(); } },
      h('option', { value: '', text: '-' }), ...doc.tasks.map((o, j) => (o === t ? null : h('option', { value: o.id, text: String(j + 1), selected: t.dep === o.id }))));
    const who = h('input', { 'aria-label': 'Assigned to', type: 'text', value: t.who, placeholder: '', onfocus: commit, oninput: (e) => { t.who = e.target.value; } });
    row.append(h('div', { text: String(i + 1), style: 'color:var(--text-2)' }), h('div', { style: 'padding:0' }, name), h('div', { style: 'padding:0' }, start), h('div', { style: 'padding:0' }, dur), h('div', { style: 'padding:0' }, done), h('div', { style: 'padding:0' }, dep), h('div', { style: 'padding:0' }, who));
    tBody.append(row);
  });
  if (!doc.tasks.length) tBody.append(h('div', { class: 'muted', style: 'padding:16px', text: 'No tasks yet. Use Add task to begin.' }));
  tBody.style.overflow = 'auto';
  drawGantt(); renderStatus();
}
function range() {
  if (!doc.tasks.length) return { a: todayDay() - 3, b: todayDay() + 40 };
  const a = Math.min(...doc.tasks.map((t) => t.start), todayDay()), b = Math.max(...doc.tasks.map(endOf), todayDay());
  return { a: a - 4, b: b + 14 };
}
function drawGantt() {
  const { a, b } = range(); origin = a; span = b - a + 1;
  const W = span * dayW, H = Math.max(doc.tasks.length * ROWH + HEADH + 40, ganttWrap.clientHeight - 2);
  ganttWrap.textContent = '';
  const svg = sv('svg', { width: W, height: H, style: 'display:block;font-family:Segoe UI,Arial,sans-serif' });
  ganttWrap.append(svg);
  // header: months and days
  svg.append(sv('rect', { x: 0, y: 0, width: W, height: HEADH, fill: '#2b2b2b' }));
  let lastM = -1;
  for (let i = 0; i < span; i++) {
    const d = a + i, dt = new Date(d * DAY), x = i * dayW;
    if (isWeekend(d)) svg.append(sv('rect', { x, y: HEADH, width: dayW, height: H - HEADH, fill: '#232323' }));
    if (dt.getUTCDate() === 1 || i === 0) { const m = dt.getUTCMonth(); if (m !== lastM || i === 0) { lastM = m; const t = sv('text', { x: x + 4, y: 15, fill: '#d0d0d0', 'font-size': 12, 'font-weight': 600 }); t.textContent = MON[m] + ' ' + dt.getUTCFullYear(); svg.append(t); svg.append(sv('line', { x1: x, x2: x, y1: 0, y2: H, stroke: '#4a4a4a' })); } }
    if (dayW >= 16 || dt.getUTCDay() === 1) { const t = sv('text', { x: x + dayW / 2, y: 36, 'text-anchor': 'middle', fill: isWeekend(d) ? '#777' : '#aaa', 'font-size': 10 }); t.textContent = dt.getUTCDate(); svg.append(t); }
    svg.append(sv('line', { x1: x, x2: x, y1: HEADH - 10, y2: HEADH, stroke: '#444' }));
  }
  for (let i = 0; i <= doc.tasks.length; i++) svg.append(sv('line', { x1: 0, x2: W, y1: HEADH + i * ROWH, y2: HEADH + i * ROWH, stroke: '#2f2f2f' }));
  const crit = critical();
  const pos = (t) => ({ x: (t.start - a) * dayW, y: HEADH + doc.tasks.indexOf(t) * ROWH });
  // dependency arrows
  for (const t of doc.tasks) {
    if (!t.dep) continue; const p = byId(t.dep); if (!p) continue;
    const pp = pos(p), tp = pos(t); const x1 = pp.x + p.dur * dayW, y1 = pp.y + ROWH / 2, x2 = tp.x, y2 = tp.y + ROWH / 2;
    const mid = x2 - x1 > 14 ? x1 + 7 : x2 - 7;
    svg.append(sv('path', { d: `M${x1} ${y1}H${mid}V${y2}H${x2 - 1}`, fill: 'none', stroke: crit.has(t.id) && crit.has(p.id) ? '#e0e0e0' : '#808080', 'stroke-width': 1.3 }));
    svg.append(sv('path', { d: `M${x2} ${y2}l-5 -3.5v7z`, fill: crit.has(t.id) && crit.has(p.id) ? '#e0e0e0' : '#808080' }));
  }
  // bars
  for (const t of doc.tasks) {
    const { x, y } = pos(t); const g = sv('g', { 'data-id': t.id });
    const isCrit = crit.has(t.id);
    if (t.dur === 0) {
      g.append(sv('path', { d: `M${x} ${y + 6}l9 9l-9 9l-9 -9z`, fill: isCrit ? '#f0f0f0' : '#bdbdbd', stroke: sel === t.id ? '#fff' : 'none', 'stroke-width': 2, style: 'cursor:ew-resize' }));
    } else {
      const w = t.dur * dayW;
      g.append(sv('rect', { x, y: y + 7, width: w, height: ROWH - 14, rx: 4, fill: '#4a4a4a', stroke: sel === t.id ? '#fff' : isCrit ? '#d8d8d8' : '#6a6a6a', 'stroke-width': sel === t.id ? 2 : 1, style: 'cursor:grab', 'data-role': 'move' }));
      if (t.done > 0) g.append(sv('rect', { x, y: y + 7, width: (w * t.done) / 100, height: ROWH - 14, rx: 4, fill: isCrit ? '#e4e4e4' : '#a8a8a8', style: 'pointer-events:none' }));
      g.append(sv('rect', { x: x + w - 6, y: y + 7, width: 6, height: ROWH - 14, fill: 'transparent', style: 'cursor:ew-resize', 'data-role': 'resize' }));
    }
    if (doc.baseline && doc.baseline[t.id]) { const bl = doc.baseline[t.id], bx = (bl.start - a) * dayW; g.append(sv('rect', { x: bx, y: y + ROWH - 7, width: Math.max(bl.dur, 0.3) * dayW, height: 3, fill: '#909090', style: 'pointer-events:none' })); }
    const lab = sv('text', { x: x + Math.max(t.dur, 0.5) * dayW + 8, y: y + ROWH / 2 + 4, fill: '#c8c8c8', 'font-size': 11, style: 'pointer-events:none' }); lab.textContent = t.name + (t.who ? '  -  ' + t.who : '') + (!isCrit && slackMap[t.id] > 0 ? '  (slack ' + slackMap[t.id] + 'd)' : ''); g.append(lab);
    svg.append(g);
  }
  // today
  const tx = (todayDay() - a) * dayW + dayW / 2; svg.append(sv('line', { x1: tx, x2: tx, y1: HEADH, y2: H, stroke: '#e0e0e0', 'stroke-dasharray': '4 4', opacity: 0.7 }));
  svg.addEventListener('pointerdown', ganttDown);
  ganttWrap.scrollTop = tBody.scrollTop;
}
// keep table and gantt rows aligned when scrolling
ganttWrap.addEventListener('scroll', () => { tBody.scrollTop = ganttWrap.scrollTop; });
tBody.addEventListener('scroll', () => { if (Math.abs(ganttWrap.scrollTop - tBody.scrollTop) > 1) ganttWrap.scrollTop = tBody.scrollTop; });

let drag = null;
function ganttDown(ev) {
  const g = ev.target.closest('[data-id]'); if (!g) return;
  const t = byId(g.dataset.id); sel = t.id;
  const role = ev.target.dataset.role || (t.dur === 0 ? 'move' : null); if (!role) { render(); return; }
  commit(); drag = { t, role, x: ev.clientX, start: t.start, dur: t.dur, moved: false }; // drawGantt() replaces the <svg> on every move, so listen on the window (an svg listener died after the first move)
  window.addEventListener('pointermove', ganttMove); window.addEventListener('pointerup', ganttUp, { once: true });
}
function ganttMove(ev) {
  if (!drag) return; const dd = Math.round((ev.clientX - drag.x) / dayW); drag.moved = drag.moved || dd !== 0;
  if (drag.role === 'move') drag.t.start = drag.start + dd; else drag.t.dur = Math.max(1, drag.dur + dd);
  schedule(); const rows = tBody.querySelectorAll('.pl-row'); const i = doc.tasks.indexOf(drag.t);
  const st = rows[i]?.querySelector('input.d'); if (st) st.value = toIso(drag.t.start);
  const keep = ganttWrap.scrollLeft; drawGantt(); ganttWrap.scrollLeft = keep;
}
function ganttUp() { window.removeEventListener('pointermove', ganttMove); const d = drag; drag = null; if (d && !d.moved) undoS.pop(); const keep = ganttWrap.scrollLeft; render(); ganttWrap.scrollLeft = keep; }
function scrollToday() { ganttWrap.scrollLeft = Math.max(0, (todayDay() - origin) * dayW - ganttWrap.clientWidth / 3); }
function renderStatus() {
  status.textContent = '';
  const fin = doc.tasks.length ? toIso(Math.max(...doc.tasks.map(endOf))) : '-';
  const avg = doc.tasks.length ? Math.round(doc.tasks.reduce((s, t) => s + (t.dur || 1) * t.done, 0) / doc.tasks.reduce((s, t) => s + (t.dur || 1), 0)) : 0;
  status.append(h('span', { text: fileName || 'Untitled' }), h('span', { class: 'grow' }), h('span', { text: doc.tasks.length + ' tasks' }), h('span', { text: 'Finish ' + fin }), h('span', { text: avg + '% complete' }), ...(doc.baseline ? [h('span', { text: 'Baseline ' + (() => { const bf = Math.max(...Object.values(doc.baseline).map((v) => v.start + v.dur), 0), v = Math.max(...doc.tasks.map(endOf), 0) - bf; return v === 0 ? 'on track' : (v > 0 ? '+' : '') + v + 'd'; })() })] : []));
}

// ---------- actions ----------
function addTask(ms) {
  commit();
  const idx = sel ? doc.tasks.findIndex((t) => t.id === sel) + 1 : doc.tasks.length;
  const prev = doc.tasks[idx - 1];
  const t = { id: uid(), name: ms ? 'Milestone' : 'New task', start: prev ? endOf(prev) : todayDay(), dur: ms ? 0 : 3, done: 0, dep: '', who: '' };
  doc.tasks.splice(idx, 0, t); sel = t.id; render();
  const row = tBody.querySelector(`[data-id="${t.id}"] input.nm`); if (row) { row.focus(); row.select(); }
}
function del() { if (!sel) return; commit(); doc.tasks = doc.tasks.filter((t) => t.id !== sel); for (const t of doc.tasks) if (t.dep === sel) t.dep = ''; sel = null; render(); }
function mv(d) { const i = doc.tasks.findIndex((t) => t.id === sel); const j = i + d; if (i < 0 || j < 0 || j >= doc.tasks.length) return; commit(); [doc.tasks[i], doc.tasks[j]] = [doc.tasks[j], doc.tasks[i]]; render(); }
function newDoc() { if (doc.tasks.length && !confirm('Discard the current plan?')) return; doc = { title: 'Untitled plan', tasks: [] }; sel = null; undoS = []; savedSnap = snapshot(); redoS = []; fileName = ''; render(); }
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveDoc(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openDoc(); }
  else if (e.key === 'Delete' && !document.querySelector('.modal-back') && !e.target.matches('input,select,textarea,button')) del();
});

// ---------- files ----------
const cleanTask = (t) => ({ id: String(t.id || uid()), name: String(t.name ?? ''), start: Number.isFinite(+t.start) ? Math.round(+t.start) : todayDay(), dur: clamp(Math.round(+t.dur || 0), 0, 3650), done: clamp(Math.round(+t.done || 0), 0, 100), dep: String(t.dep || ''), who: String(t.who || '') });
async function openDoc(dropped) {
  const f = (dropped && dropped.data) ? dropped : (await window.host.openFiles({ filters: [['Planout plan', ['planout', 'json']]] }))[0]; if (!f) return;
  try { const d = JSON.parse(new TextDecoder().decode(f.data)); if (!Array.isArray(d.tasks)) throw new Error('Not a Planout file'); doc = { title: String(d.title || 'Untitled plan'), tasks: d.tasks.map(cleanTask) }; if (d.baseline && typeof d.baseline === 'object') { doc.baseline = {}; for (const [k, v] of Object.entries(d.baseline)) if (v && Number.isFinite(+v.start)) doc.baseline[String(k)] = { start: Math.round(+v.start), dur: clamp(Math.round(+v.dur || 0), 0, 3650) }; } fileName = f.name; sel = null; undoS = []; savedSnap = snapshot(); render(); }
  catch (e) { toast('Cannot open: ' + e.message); }
}
async function saveDoc() {
  const r = await window.host.saveFile({ name: 'plan.planout', filters: [['Planout plan', ['planout']]], data: new TextEncoder().encode(JSON.stringify(doc, null, 1)) });
  if (r) { savedSnap = snapshot(); fileName = r.name; toast('Saved ' + r.name); renderStatus(); }
}
async function exportCsv() {
  const q = (s) => { s = String(s); if ('=+-@'.includes(s[0] || 'x') || s[0] === '\t' || s[0] === '\r') s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = [['Task', 'Start', 'End', 'Days', 'Done %', 'After', 'Owner'].join(',')];
  doc.tasks.forEach((t) => rows.push([q(t.name), toIso(t.start), toIso(endOf(t)), t.dur, t.done, t.dep ? doc.tasks.findIndex((x) => x.id === t.dep) + 1 : '', q(t.who)].join(',')));
  const r = await window.host.saveFile({ name: 'plan.csv', filters: [['CSV', ['csv']]], data: new TextEncoder().encode('﻿' + rows.join('\r\n')) }); if (r) toast('Saved ' + r.name);
}
async function exportPng() {
  const svg = ganttWrap.querySelector('svg'); if (!svg) return;
  const clone = svg.cloneNode(true); clone.setAttribute('xmlns', NS);
  const W = +svg.getAttribute('width'), H = doc.tasks.length * ROWH + HEADH + 10; clone.setAttribute('height', H); clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const str = new XMLSerializer().serializeToString(clone);
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str); await img.decode();
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d'); ctx.fillStyle = '#1f1f1f'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const res = await window.host.saveFile({ name: 'timeline.png', filters: [['PNG image', ['png']]], data: new Uint8Array(await blob.arrayBuffer()) }); if (res) toast('Saved ' + res.name);
}

// sample
(function sample() {
  const t0 = todayDay() - 2; const mk = (name, start, dur, done, dep = '', who = '') => ({ id: uid(), name, start, dur, done, dep, who });
  const a = mk('Gather requirements', t0, 4, 100, '', 'Mali'), b = mk('Design', t0 + 4, 6, 80, a.id, 'Ken'), c = mk('Build', t0 + 10, 10, 35, b.id, 'Ploy'), d = mk('Write documentation', t0 + 10, 5, 10, b.id, 'Mali'), e = mk('Test', t0 + 20, 5, 0, c.id, 'Ken'), f = mk('Release', t0 + 25, 0, 0, e.id);
  doc.tasks = [a, b, c, d, e, f]; doc.title = 'Product release';
})();
render(); setTimeout(scrollToday, 50);
window.addEventListener('resize', drawGantt);
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => /.(planout|json)$/i.test(x.name)); if (!f) { toast('Drop a .planout file to open it'); return; }
  openDoc({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
});

let savedSnap = null;
setTimeout(() => { if (savedSnap === null) savedSnap = snapshot(); }, 0);
window.addEventListener('beforeunload', (e) => { if (savedSnap !== null && snapshot() !== savedSnap) { e.preventDefault(); e.returnValue = ''; } });
