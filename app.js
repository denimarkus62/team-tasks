(function () {
'use strict';

var CFG = { owner: 'denimarkus62', repo: 'team-tasks', branch: 'main', path: 'data/tasks.json' };
var API = 'https://api.github.com';
var LS_TOKEN = 'tasks_token';
var LS_ME = 'tasks_me';
var STATUSES = [['new', 'Новая'], ['progress', 'В работе'], ['review', 'На проверке'], ['done', 'Готово']];
var COLORS = ['#d12c2c', '#2f6fed', '#1f9d6b', '#d98a00', '#8a4fd6', '#00859b', '#6b7280'];
var POLL_MS = 60000;
var FILES_DIR = 'files';
var MAX_FILE = 20 * 1024 * 1024;

var S = {
  data: null,
  token: lsGet(LS_TOKEN),
  me: lsGet(LS_ME),
  canWrite: false,
  keyProblem: '',
  saving: 0,
  uploading: 0,
  error: '',
  lastSync: null,
  filter: { who: 'all', status: '', exec: '', q: '' },
  showDone: {}
};

/* ---------- утилиты ---------- */

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* без хранилища работаем как есть */ } }
function $(id) { return document.getElementById(id); }
function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
function nowIso() { return new Date().toISOString(); }
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDue(s) {
  var p = s.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}
function fmtStamp(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '') + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function h(tag, attrs) {
  var el = document.createElement(tag);
  var late = null;
  var a = attrs || {};
  Object.keys(a).forEach(function (k) {
    var v = a[k];
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else if (k === 'value') late = v;
    else if (k === 'data') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  });
  for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
  if (late !== null) el.value = late;
  return el;
}
function append(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
  el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
}
function opt(value, label) { return h('option', { value: value }, label); }

function b64enc(str) {
  var bytes = new TextEncoder().encode(str), bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64dec(b64) {
  var bin = atob(b64.replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function toast(text, kind) {
  var t = h('div', { class: 'toast' + (kind === 'err' ? ' err' : '') }, text);
  $('toast').append(t);
  setTimeout(function () { t.remove(); }, kind === 'err' ? 7000 : 2800);
}

/* ---------- данные ---------- */

function normalize(d) {
  d = d || {};
  d.users = Array.isArray(d.users) ? d.users : [];
  d.themes = Array.isArray(d.themes) ? d.themes : [];
  d.tasks = Array.isArray(d.tasks) ? d.tasks : [];
  d.tasks.forEach(function (t) {
    if (!Array.isArray(t.comments)) t.comments = [];
    if (!Array.isArray(t.files)) t.files = [];
  });
  return d;
}
function user(id) { return S.data.users.filter(function (u) { return u.id === id; })[0] || null; }
function uname(id) { var u = id && user(id); return u ? u.name : 'Не назначен'; }
function theme(id) { return S.data.themes.filter(function (t) { return t.id === id; })[0] || null; }
function meUser() { return S.me ? user(S.me) : null; }
function isAdmin() { var u = meUser(); return !!(u && u.admin); }
function canEditTask(t) { return S.canWrite && (isAdmin() || t.assignee === S.me || t.author === S.me); }
function stLabel(code) { var s = STATUSES.filter(function (x) { return x[0] === code; })[0]; return s ? s[1] : code; }

function ghHeaders(extra) {
  var hd = { Accept: 'application/vnd.github+json' };
  if (S.token) hd.Authorization = 'Bearer ' + S.token;
  if (extra) Object.keys(extra).forEach(function (k) { hd[k] = extra[k]; });
  return hd;
}
function contentsUrl(p) { return API + '/repos/' + CFG.owner + '/' + CFG.repo + '/contents/' + (p || CFG.path); }

function readStatic() {
  return fetch('data/tasks.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('Не удалось загрузить данные (' + r.status + ')');
    return r.json();
  }).then(function (j) { return { data: normalize(j), sha: null }; });
}

function readLatest() {
  if (!S.token || S.keyProblem) return readStatic();
  return fetch(contentsUrl() + '?ref=' + CFG.branch + '&t=' + Date.now(), { headers: ghHeaders(), cache: 'no-store' }).then(function (r) {
    if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw new Error('Лимит запросов GitHub, подождите минуту.');
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      S.keyProblem = 'Ключ не подходит или истек. Введите новый ключ.';
      S.canWrite = false;
      return readStatic();
    }
    if (!r.ok) throw new Error('GitHub вернул ошибку ' + r.status);
    return r.json().then(function (j) { return { data: normalize(JSON.parse(b64dec(j.content))), sha: j.sha }; });
  });
}

function checkToken() {
  S.canWrite = false;
  S.keyProblem = '';
  if (!S.token) return Promise.resolve();
  return fetch(API + '/repos/' + CFG.owner + '/' + CFG.repo, { headers: ghHeaders(), cache: 'no-store' }).then(function (r) {
    if (r.status === 401) { S.keyProblem = 'Ключ не подходит или истек. Введите новый ключ.'; return; }
    if (r.status === 404) { S.keyProblem = 'У этого ключа нет доступа к репозиторию с задачами.'; return; }
    if (!r.ok) { S.keyProblem = 'GitHub вернул ошибку ' + r.status + ' при проверке ключа.'; return; }
    return r.json().then(function (j) {
      var p = j.permissions;
      S.canWrite = p ? !!(p.push || p.admin) : true;
      if (!S.canWrite) S.keyProblem = 'У ключа только право чтения. Нужно право Contents: Read and write.';
    });
  }).catch(function () { S.keyProblem = 'Не удалось проверить ключ, нет связи с GitHub.'; });
}

var queue = Promise.resolve();

function commit(fn, msg) {
  var attempt = 0;
  function go() {
    return readLatest().then(function (cur) {
      if (cur.sha == null) throw new Error('нет доступа на запись');
      fn(cur.data);
      var body = { message: msg, content: b64enc(JSON.stringify(cur.data, null, 2) + '\n'), sha: cur.sha, branch: CFG.branch };
      return fetch(contentsUrl(), { method: 'PUT', headers: ghHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) }).then(function (r) {
        if (r.ok) {
          return r.json().then(function (j) {
            if (S.saving <= 1) { S.data = cur.data; render(); }
            return j;
          });
        }
        if ((r.status === 409 || r.status === 422) && ++attempt < 4) return go();
        if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw new Error('Лимит запросов GitHub, подождите минуту.');
        if (r.status === 401) { S.keyProblem = 'Ключ не подходит или истек. Введите новый ключ.'; S.canWrite = false; }
        if (r.status === 403) { S.keyProblem = 'У ключа нет права записи. Нужно право Contents: Read and write.'; S.canWrite = false; }
        return r.text().then(function (t) {
          var m = ''; try { m = JSON.parse(t).message; } catch (e) { m = 'ошибка ' + r.status; }
          throw new Error(m);
        });
      });
    });
  }
  return go();
}

function mutate(fn, msg) {
  if (!S.canWrite) { toast('Нет ключа доступа, сейчас только просмотр', 'err'); return Promise.resolve(false); }
  var who = meUser() ? meUser().name : '?';
  fn(S.data);
  render();
  S.saving++;
  setSync();
  var job = queue.then(function () { return commit(fn, who + ': ' + msg); });
  queue = job.catch(function () { /* цепочку не рвем */ });
  return job.then(function () { return true; }, function (e) {
    toast('Не удалось сохранить: ' + errText(e), 'err');
    return false;
  }).then(function (ok) {
    S.saving--;
    if (ok) { S.lastSync = new Date(); setSync(); return true; }
    return refresh(true).then(function () { return false; });
  });
}

function refresh(manual) {
  return readLatest().then(function (cur) {
    if (S.saving > 0 && !manual) return;
    S.data = cur.data;
    S.error = '';
    S.lastSync = new Date();
    render();
  }).catch(function (e) {
    S.error = errText(e);
    setSync();
    if (!S.data) fatal(S.error);
  });
}

function errText(e) { return e instanceof TypeError ? 'нет связи с GitHub' : e.message; }

function fatal(msg) {
  $('board').replaceChildren(h('div', { class: 'empty' }, 'Не удалось загрузить задачи. ' + msg));
}

/* ---------- файлы ---------- */
/* Файл кладется в репозиторий как files/<id>.bin: расширение всегда .bin, чтобы Pages
   отдавал его как поток байтов и никогда не исполнял (html/js на общем домене github.io).
   Настоящее имя хранится в tasks.json. */

function okPath(p) { return typeof p === 'string' && /^files\/[a-z0-9]+\.bin$/.test(p); }
function cleanName(n) { return String(n).replace(/[‪-‮⁦-⁩]/g, ''); }

function fmtSize(n) {
  if (n < 1024) return n + ' Б';
  if (n < 1048576) return Math.round(n / 1024) + ' КБ';
  return (n / 1048576).toFixed(1).replace('.0', '').replace('.', ',') + ' МБ';
}

function readB64(file) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
    r.onerror = function () { reject(new Error('не удалось прочитать файл «' + file.name + '»')); };
    r.readAsDataURL(file);
  });
}

function uploadFile(file) {
  if (!S.canWrite) return Promise.reject(new Error('нет ключа доступа'));
  if (!file.size) return Promise.reject(new Error('файл «' + file.name + '» пустой'));
  if (file.size > MAX_FILE) return Promise.reject(new Error('файл «' + file.name + '» больше ' + fmtSize(MAX_FILE)));
  var id = uid(), path = FILES_DIR + '/' + id + '.bin';
  var who = meUser() ? meUser().name : '?';
  return readB64(file).then(function (b64) {
    var attempt = 0;
    function go() {
      var body = { message: who + ': файл «' + file.name.slice(0, 80) + '»', content: b64, branch: CFG.branch };
      return fetch(contentsUrl(path), { method: 'PUT', headers: ghHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) }).then(function (r) {
        if (r.ok) return { id: id, name: cleanName(file.name), size: file.size, path: path, by: S.me, at: nowIso() };
        if ((r.status === 409 || r.status === 422) && ++attempt < 4) {
          return new Promise(function (res) { setTimeout(res, 700 * attempt); }).then(go);
        }
        if (r.status === 401 || r.status === 403) { S.keyProblem = 'У ключа нет права записи. Нужно право Contents: Read and write.'; S.canWrite = false; render(); }
        return r.json().then(function (j) { return j.message; }, function () { return ''; }).then(function (m) {
          throw new Error(m || 'ошибка ' + r.status);
        });
      });
    }
    return go();
  });
}

/* Грузит по очереди, возвращает уже загруженные и список ошибок. */
function uploadAll(files, onEach) {
  var metas = [], errors = [];
  S.uploading++;
  setSync();
  return files.reduce(function (p, f) {
    return p.then(function () {
      return uploadFile(f).then(function (m) { metas.push(m); return onEach ? onEach(m) : null; },
        function (e) { errors.push(errText(e)); });
    });
  }, Promise.resolve()).then(function () {
    S.uploading--;
    setSync();
    return { metas: metas, errors: errors };
  });
}

function deleteBlob(path, name) {
  if (!S.canWrite || !okPath(path)) return Promise.resolve();
  var who = meUser() ? meUser().name : '?';
  return fetch(contentsUrl(path) + '?ref=' + CFG.branch, { headers: ghHeaders(), cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.sha) return;
      return fetch(contentsUrl(path), { method: 'DELETE', headers: ghHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: who + ': удален файл «' + String(name).slice(0, 80) + '»', sha: j.sha, branch: CFG.branch }) });
    })
    .catch(function () { /* файл-сирота не страшен, задача уже обновлена */ });
}

function downloadFile(f, ev) {
  if (!okPath(f.path)) { ev.preventDefault(); toast('Некорректная запись о файле', 'err'); return; }
  if (!S.token || S.keyProblem) return; // без ключа работает обычная ссылка на Pages
  ev.preventDefault();
  fetch(contentsUrl(f.path) + '?ref=' + CFG.branch, { headers: ghHeaders({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('ошибка ' + r.status);
      return r.blob();
    })
    .then(function (b) {
      var url = URL.createObjectURL(b);
      var a = h('a', { href: url, download: f.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
    })
    .catch(function (e) { toast('Не удалось скачать: ' + errText(e), 'err'); });
}

/* ---------- изменения ---------- */

function patchTask(id, patch, msg) {
  var p = clone(patch);
  return mutate(function (d) {
    var t = d.tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    Object.keys(p).forEach(function (k) { t[k] = p[k]; });
    t.updated = nowIso();
    if ('status' in p) t.closed = p.status === 'done' ? nowIso() : null;
  }, msg);
}

/* ---------- отрисовка ---------- */

function setSync() {
  var s = $('sync');
  s.className = 'sync';
  if (S.saving > 0 || S.uploading > 0) s.textContent = 'Сохраняю...';
  else if (S.error) { s.textContent = 'Нет связи'; s.className = 'sync err'; }
  else if (!S.canWrite) s.textContent = 'Только просмотр';
  else s.textContent = S.lastSync ? 'Сохранено, ' + pad(S.lastSync.getHours()) + ':' + pad(S.lastSync.getMinutes()) : '';
}

function render() {
  if (!S.data) return;
  $('keyBtn').textContent = S.canWrite ? 'Ключ: есть' : 'Ввести ключ';
  var sel = $('me');
  var cur = S.me;
  sel.replaceChildren.apply(sel, S.data.users.map(function (u) { return opt(u.id, u.name); }));
  sel.value = cur || '';
  renderBanner();
  renderStats();
  renderToolbarState();
  renderBoard();
  setSync();
}

function renderBanner() {
  var b = $('banner');
  if (S.canWrite) { b.replaceChildren(); return; }
  var text = S.keyProblem || 'Режим просмотра. Чтобы добавлять и менять задачи, нужен ключ доступа, его выдает Роман.';
  b.replaceChildren(h('div', { class: 'banner' + (S.keyProblem ? ' err' : '') },
    h('span', null, text),
    h('button', { class: 'btn small', type: 'button', onclick: openKey }, 'Ввести ключ')));
}

function renderStats() {
  var d = S.data, T = d.tasks, today = todayStr();
  var open = T.filter(function (t) { return t.status !== 'done'; });
  var week = Date.now() - 7 * 864e5;
  var items = [
    ['Открыто', open.length, ''],
    ['В работе', T.filter(function (t) { return t.status === 'progress'; }).length, ''],
    ['Просрочено', open.filter(function (t) { return t.due && t.due < today; }).length, 'bad'],
    ['Без исполнителя', open.filter(function (t) { return !t.assignee; }).length, 'warn'],
    ['Готово за 7 дней', T.filter(function (t) { return t.status === 'done' && t.closed && Date.parse(t.closed) > week; }).length, 'good']
  ];
  var loads = d.users.map(function (u) {
    var n = open.filter(function (t) { return t.assignee === u.id; }).length;
    return h('span', null, u.name + ': ', h('b', null, n + ' откр.'));
  });
  $('stats').replaceChildren.apply($('stats'), items.map(function (it) {
    return h('div', { class: 'stat ' + it[2] }, h('b', null, it[1]), h('span', null, it[0]));
  }).concat([h('div', { class: 'loads' }, loads)]));
}

function buildToolbar() {
  var tb = $('toolbar');
  var segAll = h('button', { type: 'button', id: 'segAll', onclick: function () { S.filter.who = 'all'; render(); } }, 'Все задачи');
  var segMe = h('button', { type: 'button', id: 'segMe', onclick: function () { S.filter.who = 'me'; render(); } }, 'Мои');
  var st = h('select', { id: 'fStatus', 'aria-label': 'Статус', onchange: function () { S.filter.status = this.value; renderBoard(); } },
    opt('', 'Все статусы'), STATUSES.map(function (s) { return opt(s[0], s[1]); }));
  var ex = h('select', { id: 'fExec', 'aria-label': 'Исполнитель', onchange: function () { S.filter.exec = this.value; renderBoard(); } });
  var q = h('input', { type: 'search', id: 'fQ', placeholder: 'Поиск по задачам', 'aria-label': 'Поиск', oninput: function () { S.filter.q = this.value.trim().toLowerCase(); renderBoard(); } });
  var add = h('button', { class: 'btn primary', id: 'addBtn', type: 'button', onclick: function () { openTask(null); } }, '+ Задача');
  var th = h('button', { class: 'btn', id: 'themesBtn', type: 'button', onclick: openThemes }, 'Тематики');
  tb.replaceChildren(h('div', { class: 'seg' }, segAll, segMe), st, ex, q, h('span', { class: 'grow' }), th, add);
}

function renderToolbarState() {
  $('segAll').className = S.filter.who === 'all' ? 'on' : '';
  $('segMe').className = S.filter.who === 'me' ? 'on' : '';
  var ex = $('fExec');
  var keep = S.filter.exec;
  ex.replaceChildren.apply(ex, [opt('', 'Все исполнители')].concat(S.data.users.map(function (u) { return opt(u.id, u.name); }), [opt('_none', 'Без исполнителя')]));
  ex.value = keep;
  $('addBtn').hidden = !S.canWrite || !S.data.themes.length;
  $('themesBtn').hidden = !(S.canWrite && isAdmin());
}

function visible(t) {
  var f = S.filter;
  if (f.who === 'me' && t.assignee !== S.me && t.author !== S.me) return false;
  if (f.status && t.status !== f.status) return false;
  if (f.exec === '_none' && t.assignee) return false;
  if (f.exec && f.exec !== '_none' && t.assignee !== f.exec) return false;
  if (f.q && (t.title + ' ' + (t.desc || '')).toLowerCase().indexOf(f.q) < 0) return false;
  return true;
}

function sortOpen(list) {
  return list.slice().sort(function (a, b) {
    var pa = a.priority === 'high' ? 0 : 1, pb = b.priority === 'high' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    var da = a.due || '9999', db = b.due || '9999';
    if (da !== db) return da < db ? -1 : 1;
    return (a.created || '').localeCompare(b.created || '');
  });
}

function renderBoard() {
  var d = S.data, f = S.filter;
  var filtered = f.who === 'me' || f.status || f.exec || f.q;
  var out = [];
  d.themes.forEach(function (th) {
    var all = d.tasks.filter(function (t) { return t.theme === th.id; });
    var vis = all.filter(visible);
    if (filtered && !vis.length) return;
    var open = sortOpen(vis.filter(function (t) { return t.status !== 'done'; }));
    var done = vis.filter(function (t) { return t.status === 'done'; })
      .sort(function (a, b) { return (b.closed || '').localeCompare(a.closed || ''); });
    var doneOpen = S.showDone[th.id] || f.status === 'done' || !!f.q;
    var sec = h('div', { class: 'theme' });
    sec.style.setProperty('--dot', th.color || '#6b7280');
    var ownerEl = th.owner ? h('span', { class: 'owner' }, 'Исполнитель: ' + uname(th.owner)) : h('span', { class: 'owner none' }, 'Исполнитель не назначен');
    sec.append(h('div', { class: 'theme-h' },
      h('span', { class: 'dot' }), h('h2', null, th.name), ownerEl,
      h('span', { class: 'count' }, open.length + ' откр.' + (done.length ? ', ' + done.length + ' готово' : '')),
      S.canWrite ? h('button', { class: 'btn small', type: 'button', onclick: function () { openTask(null, th.id); } }, '+ Задача') : null));
    if (!open.length && !done.length) sec.append(h('div', { class: 'none-msg' }, 'Задач пока нет'));
    open.forEach(function (t) { sec.append(taskRow(t)); });
    if (done.length) {
      if (doneOpen) done.forEach(function (t) { sec.append(taskRow(t)); });
      else sec.append(h('div', { class: 'theme-f' }, h('button', { class: 'linkbtn', type: 'button', onclick: function () { S.showDone[th.id] = true; renderBoard(); } }, 'Показать готовые (' + done.length + ')')));
    }
    out.push(sec);
  });
  if (!out.length) {
    var msg = !d.themes.length ? 'Тематик пока нет.' + (isAdmin() && S.canWrite ? ' Нажмите «Тематики», чтобы создать первую.' : '') : (filtered ? 'По этим фильтрам задач нет.' : 'Задач пока нет.');
    out.push(h('div', { class: 'empty' }, msg));
  }
  $('board').replaceChildren.apply($('board'), out);
}

function taskRow(t) {
  var editable = canEditTask(t);
  var today = todayStr();
  var sel = h('select', { class: 'st st-' + t.status, 'aria-label': 'Статус задачи', disabled: !editable, value: t.status,
    onchange: function () { patchTask(t.id, { status: this.value }, 'задача «' + t.title + '»: ' + stLabel(this.value)); } },
    STATUSES.map(function (s) { return opt(s[0], s[1]); }));
  sel.value = t.status;
  var meta = [];
  meta.push(h('span', { class: 'chip' + (t.assignee ? '' : ' none') }, uname(t.assignee)));
  if (t.priority === 'high') meta.push(h('span', { class: 'chip high' }, 'Срочно'));
  if (t.due) meta.push(h('span', { class: 'due' + (t.status !== 'done' && t.due < today ? ' over' : '') }, 'до ' + fmtDue(t.due)));
  if (t.files.length) meta.push(h('span', null, 'файлов ' + t.files.length));
  if (t.comments.length) meta.push(h('span', null, 'комм. ' + t.comments.length));
  return h('div', { class: 'task' + (t.status === 'done' ? ' is-done' : '') },
    sel,
    h('button', { class: 'ttl', type: 'button', onclick: function () { openTask(t.id); } }, t.title),
    h('div', { class: 'meta' }, meta));
}

/* ---------- диалоги ---------- */

var dlg;
var dlgLocked = false;
function showDlg(nodes, locked) {
  dlgLocked = !!locked;
  dlg.replaceChildren(h('div', { class: 'dlg-in' }, nodes));
  if (!dlg.open) dlg.showModal();
}
function closeDlg() { dlgLocked = false; if (dlg.open) dlg.close(); }

function field(label, control) { return h('label', { class: 'field' }, h('span', null, label), control); }

function openWho() {
  showDlg([
    h('h3', null, 'Кто вы?'),
    h('p', { class: 'hint' }, 'Выбор запомнится в этом браузере. Поменять можно вверху страницы.'),
    h('div', { class: 'who-btns' }, S.data.users.map(function (u) {
      return h('button', { class: 'btn', type: 'button', onclick: function () { setMe(u.id); closeDlg(); } }, u.name);
    }))
  ], true);
}

function setMe(id) {
  S.me = id;
  lsSet(LS_ME, id);
  S.filter.who = isAdmin() ? 'all' : 'me';
  render();
}

function openKey() {
  var inp = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Вставьте ключ сюда', spellcheck: false });
  var err = h('div', { class: 'err-msg' });
  var save = h('button', { class: 'btn primary', type: 'button' }, 'Проверить и сохранить');
  save.addEventListener('click', function () {
    var v = inp.value.trim();
    if (!v) { err.textContent = 'Вставьте ключ.'; return; }
    save.disabled = true; err.textContent = 'Проверяю...';
    S.token = v;
    checkToken().then(function () {
      if (S.canWrite) {
        lsSet(LS_TOKEN, v);
        closeDlg();
        return refresh(true).then(function () { toast('Ключ принят, можно менять задачи'); });
      }
      err.textContent = S.keyProblem || 'Ключ не подошел.';
      S.token = lsGet(LS_TOKEN);
      return checkToken().then(function () { render(); save.disabled = false; });
    });
  });
  var nodes = [
    h('h3', null, 'Ключ доступа'),
    h('p', { class: 'hint' }, 'Ключ нужен, чтобы добавлять и менять задачи. Его выдает Роман. Ключ хранится только в этом браузере, никому не пересылайте его и не вставляйте в задачи.'),
    field('Ключ', inp), err,
    h('div', { class: 'dlg-btns' },
      S.token ? h('button', { class: 'btn danger left', type: 'button', onclick: function () {
        S.token = null; lsSet(LS_TOKEN, null); S.canWrite = false; S.keyProblem = '';
        closeDlg(); refresh(true);
      } }, 'Удалить ключ из браузера') : null,
      h('button', { class: 'btn', type: 'button', onclick: closeDlg }, 'Закрыть'), save)
  ];
  showDlg(nodes);
  inp.focus();
}

function openTask(id, presetTheme) {
  var d = S.data;
  var isNew = !id;
  var t;
  if (isNew) {
    var thId = presetTheme || (d.themes[0] && d.themes[0].id);
    var th0 = theme(thId);
    t = { theme: thId, title: '', desc: '', assignee: th0 ? th0.owner || null : null, status: 'new', priority: 'normal', due: null, comments: [], files: [] };
  } else {
    t = d.tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
  }
  var admin = isAdmin();
  var editable = isNew ? S.canWrite : canEditTask(t);
  var origTheme = t.theme;

  var title = h('input', { type: 'text', value: t.title, maxLength: 200, disabled: !editable, placeholder: 'Что нужно сделать' });
  var desc = h('textarea', { value: t.desc || '', disabled: !editable, placeholder: 'Подробности, ссылки, что считать результатом' });
  var themeSel = h('select', { disabled: !editable, value: t.theme }, d.themes.map(function (x) { return opt(x.id, x.name); }));
  themeSel.value = t.theme;
  var assSel = h('select', { disabled: !editable || !admin }, opt('', 'Не назначен'), d.users.map(function (u) { return opt(u.id, u.name); }));
  assSel.value = t.assignee || '';
  var statSel = h('select', { disabled: !editable }, STATUSES.map(function (s) { return opt(s[0], s[1]); }));
  statSel.value = t.status;
  var prioSel = h('select', { disabled: !editable }, opt('normal', 'Обычный'), opt('high', 'Срочно'));
  prioSel.value = t.priority || 'normal';
  var due = h('input', { type: 'date', value: t.due || '', disabled: !editable });
  var err = h('div', { class: 'err-msg' });

  themeSel.addEventListener('change', function () {
    if (!isNew && !admin) return;
    var prev = theme(origTheme), next = theme(themeSel.value);
    var prevOwner = prev && prev.owner || '';
    if (!assSel.value || assSel.value === prevOwner || !admin) assSel.value = next && next.owner || '';
    origTheme = themeSel.value;
  });

  var pending = [];
  var fileBox = h('div', { class: 'files' });
  function drawFiles() {
    var cur = isNew ? t : (S.data.tasks.filter(function (x) { return x.id === id; })[0] || t);
    var canAttach = isNew ? S.canWrite : (S.canWrite && editable);
    var rows = [];
    if (isNew) {
      pending.forEach(function (f) {
        rows.push(h('div', { class: 'frow' }, h('span', { class: 'fname' }, cleanName(f.name)), h('span', { class: 'hint' }, fmtSize(f.size) + ', загрузится при создании'),
          h('button', { class: 'xbtn', type: 'button', 'aria-label': 'Убрать файл', onclick: function () { pending.splice(pending.indexOf(f), 1); drawFiles(); } }, '×')));
      });
    } else {
      cur.files.forEach(function (f) {
        var canRemove = S.canWrite && (admin || f.by === S.me);
        rows.push(h('div', { class: 'frow' },
          okPath(f.path)
            ? h('a', { class: 'fname', href: f.path, download: cleanName(f.name), rel: 'noopener', onclick: function (ev) { downloadFile(f, ev); } }, cleanName(f.name))
            : h('span', { class: 'fname' }, cleanName(f.name)),
          h('span', { class: 'hint' }, fmtSize(f.size) + ', ' + uname(f.by) + ', ' + fmtStamp(f.at)),
          canRemove ? h('button', { class: 'xbtn', type: 'button', 'aria-label': 'Удалить файл', onclick: function () { removeFile(f); } }, '×') : null));
      });
    }
    var nodes = [h('div', { class: 'hint' }, rows.length ? 'Файлы' : 'Файлов пока нет')].concat(rows);
    if (canAttach) {
      var status = h('span', { class: 'hint' });
      var inp = h('input', { type: 'file', multiple: true, class: 'sr',
        onchange: function () {
          var files = [].slice.call(inp.files);
          inp.value = '';
          if (!files.length) return;
          if (isNew) {
            files.forEach(function (f) {
              if (f.size > MAX_FILE) toast('Файл «' + f.name + '» больше ' + fmtSize(MAX_FILE), 'err');
              else if (!f.size) toast('Файл «' + f.name + '» пустой', 'err');
              else pending.push(f);
            });
            drawFiles();
            return;
          }
          inp.disabled = true;
          status.textContent = 'Загружаю...';
          uploadAll(files, function (m) {
            return mutate(function (dd) {
              var tt = dd.tasks.filter(function (x) { return x.id === id; })[0];
              if (tt && !tt.files.some(function (x) { return x.id === m.id; })) tt.files.push(clone(m));
            }, 'файл «' + m.name + '» к задаче «' + t.title + '»').then(function (ok) {
              if (!ok) deleteBlob(m.path, m.name);
              drawFiles();
            });
          }).then(function (res) {
            if (res.errors.length) toast('Не загрузилось: ' + res.errors.join('; '), 'err');
            drawFiles();
          });
        } });
      nodes.push(h('div', { class: 'fadd' }, h('label', { class: 'btn fbtn' }, inp, 'Прикрепить файл'), status));
      nodes.push(h('div', { class: 'hint warn' }, 'Файлы хранятся в публичном репозитории: их может скачать любой, у кого есть ссылка. Не прикрепляйте договоры, реквизиты, пароли. До ' + fmtSize(MAX_FILE) + ' на файл.'));
    } else {
      nodes.push(h('div', { class: 'hint warn' }, !S.canWrite
        ? 'Чтобы прикреплять файлы, введите ключ доступа: кнопка «Ввести ключ» вверху страницы.'
        : 'Прикреплять файлы к этой задаче могут Роман, исполнитель и автор.'));
    }
    fileBox.replaceChildren.apply(fileBox, nodes);
  }
  function removeFile(f) {
    if (!confirm('Удалить файл «' + f.name + '» из задачи?')) return;
    mutate(function (dd) {
      var tt = dd.tasks.filter(function (x) { return x.id === id; })[0];
      if (tt) tt.files = tt.files.filter(function (x) { return x.id !== f.id; });
    }, 'удален файл «' + f.name + '» из задачи «' + t.title + '»').then(function (ok) {
      if (ok) deleteBlob(f.path, f.name);
      drawFiles();
    });
    drawFiles();
  }

  var cmBox = h('div', { class: 'cm-list' });
  function drawComments() {
    var cur = isNew ? t : (S.data.tasks.filter(function (x) { return x.id === id; })[0] || t);
    var list = cur.comments.map(function (c) {
      return h('div', { class: 'cm' }, h('small', null, uname(c.by) + ', ' + fmtStamp(c.at)), h('p', null, c.text));
    });
    var nodes = [h('div', { class: 'hint' }, cur.comments.length ? 'Комментарии' : 'Комментариев пока нет')].concat(list);
    if (!isNew && S.canWrite) {
      var ci = h('input', { type: 'text', placeholder: 'Написать комментарий', maxLength: 1000 });
      var send = function () {
        var text = ci.value.trim();
        if (!text) return;
        var c = { by: S.me, at: nowIso(), text: text };
        ci.value = '';
        mutate(function (dd) {
          var tt = dd.tasks.filter(function (x) { return x.id === id; })[0];
          if (tt) tt.comments.push(clone(c));
        }, 'комментарий к задаче «' + t.title + '»').then(drawComments);
        drawComments();
      };
      ci.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      nodes.push(h('div', { class: 'cm-add' }, ci, h('button', { class: 'btn', type: 'button', onclick: send }, 'Отправить')));
    }
    cmBox.replaceChildren.apply(cmBox, nodes);
  }

  var save = h('button', { class: 'btn primary', type: 'button' }, isNew ? 'Создать' : 'Сохранить');
  save.addEventListener('click', function () {
    var vals = { theme: themeSel.value, title: title.value.trim(), desc: desc.value.trim(), status: statSel.value, priority: prioSel.value, due: due.value || null };
    if (admin) vals.assignee = assSel.value || null;
    if (!vals.title) { err.textContent = 'Напишите название задачи.'; title.focus(); return; }
    if (isNew) {
      if (!admin) { var th = theme(vals.theme); vals.assignee = th && th.owner || null; }
      var task = Object.assign({ id: uid(), author: S.me, created: nowIso(), updated: nowIso(), closed: vals.status === 'done' ? nowIso() : null, comments: [], files: [] }, vals);
      closeDlg();
      if (!pending.length) { mutate(function (dd) { dd.tasks.push(clone(task)); }, 'новая задача «' + vals.title + '»'); return; }
      toast('Загружаю файлы (' + pending.length + ')...');
      uploadAll(pending).then(function (res) {
        task.files = res.metas;
        if (res.errors.length) toast('Не загрузилось: ' + res.errors.join('; '), 'err');
        return mutate(function (dd) { dd.tasks.push(clone(task)); }, 'новая задача «' + vals.title + '»').then(function (ok) {
          if (!ok) res.metas.forEach(function (m) { deleteBlob(m.path, m.name); });
        });
      });
      return;
    }
    var patch = {};
    Object.keys(vals).forEach(function (k) { if ((vals[k] == null ? '' : vals[k]) !== (t[k] == null ? '' : t[k])) patch[k] = vals[k]; });
    closeDlg();
    if (Object.keys(patch).length) patchTask(id, patch, 'правка задачи «' + vals.title + '»');
  });

  var btns = h('div', { class: 'dlg-btns' },
    (!isNew && admin && S.canWrite) ? h('button', { class: 'btn danger left', type: 'button', onclick: function () {
      if (!confirm('Удалить задачу «' + t.title + '»? Это нельзя отменить со страницы.')) return;
      closeDlg();
      var gone = [];
      mutate(function (dd) {
        var tt = dd.tasks.filter(function (x) { return x.id === id; })[0];
        gone = tt ? tt.files.slice() : gone;
        dd.tasks = dd.tasks.filter(function (x) { return x.id !== id; });
      }, 'удалена задача «' + t.title + '»').then(function (ok) {
        if (!ok) return;
        gone.reduce(function (p, f) { return p.then(function () { return deleteBlob(f.path, f.name); }); }, Promise.resolve());
      });
    } }, 'Удалить') : null,
    h('button', { class: 'btn', type: 'button', onclick: closeDlg }, 'Закрыть'),
    editable ? save : null);

  var info = (!isNew && t.created) ? h('p', { class: 'hint' }, 'Поставил(а): ' + uname(t.author) + ', ' + fmtStamp(t.created) + (editable ? '' : '. Менять статус может исполнитель или Роман.')) : null;
  var assField = field(admin ? 'Исполнитель' : 'Исполнитель (назначает Роман)', assSel);

  showDlg([
    h('h3', null, isNew ? 'Новая задача' : 'Задача'),
    field('Название', title),
    field('Описание', desc),
    fileBox,
    h('div', { class: 'row2' }, field('Тематика', themeSel), assField),
    h('div', { class: 'row2' }, field('Статус', statSel), field('Приоритет', prioSel)),
    field('Срок', due),
    info, err, btns, cmBox
  ]);
  drawFiles();
  drawComments();
  if (isNew) title.focus();
}

function openThemes() {
  var d = S.data;
  var rows = d.themes.map(function (t) {
    return { id: t.id, isNew: false, name: t.name, color: t.color || '#6b7280', owner: t.owner || '', origOwner: t.owner || '', reassign: false, del: false };
  });
  var err = h('div', { class: 'err-msg' });
  var listBox = h('div');

  function taskCount(id) { return d.tasks.filter(function (t) { return t.theme === id; }).length; }
  function openCount(id) { return d.tasks.filter(function (t) { return t.theme === id && t.status !== 'done'; }).length; }

  function draw() {
    var nodes = rows.map(function (r) {
      var color = h('input', { type: 'color', value: r.color, 'aria-label': 'Цвет', oninput: function () { r.color = this.value; } });
      var name = h('input', { type: 'text', value: r.name, maxLength: 80, placeholder: 'Название тематики', oninput: function () { r.name = this.value; } });
      var owner = h('select', { 'aria-label': 'Исполнитель тематики', onchange: function () { r.owner = this.value; draw(); } },
        opt('', 'Исполнитель не назначен'), d.users.map(function (u) { return opt(u.id, u.name); }));
      owner.value = r.owner;
      var has = r.isNew ? 0 : taskCount(r.id);
      var del = h('button', { class: 'xbtn', type: 'button', title: has ? 'Сначала удалите задачи этой тематики (' + has + ', включая готовые)' : 'Удалить тематику', 'aria-label': 'Удалить тематику', disabled: has > 0,
        onclick: function () { if (r.isNew) rows.splice(rows.indexOf(r), 1); else r.del = !r.del; draw(); } }, r.del ? '↺' : '×');
      var rowEl = h('div', { class: 'trow' + (r.del ? ' gone' : '') }, color, name, owner, del);
      if (!r.isNew && r.owner !== r.origOwner && openCount(r.id) > 0 && !r.del) {
        rowEl.append(h('label', { class: 're' },
          h('input', { type: 'checkbox', checked: r.reassign, onchange: function () { r.reassign = this.checked; } }),
          ' Переназначить ' + openCount(r.id) + ' открытых задач на ' + (r.owner ? uname(r.owner) : 'никого')));
      }
      return rowEl;
    });
    listBox.replaceChildren.apply(listBox, nodes);
  }
  draw();

  var add = h('button', { class: 'btn', type: 'button', onclick: function () {
    rows.push({ id: uid(), isNew: true, name: '', color: COLORS[rows.length % COLORS.length], owner: '', origOwner: '', reassign: false, del: false });
    draw();
  } }, '+ Тематика');

  var save = h('button', { class: 'btn primary', type: 'button', onclick: function () {
    var alive = rows.filter(function (r) { return !r.del; });
    if (alive.some(function (r) { return !r.name.trim(); })) { err.textContent = 'У каждой тематики должно быть название.'; return; }
    var plan = clone(rows);
    closeDlg();
    mutate(function (dd) {
      plan.forEach(function (r) {
        if (!r.del) return;
        if (!dd.tasks.some(function (t) { return t.theme === r.id; })) dd.themes = dd.themes.filter(function (x) { return x.id !== r.id; });
      });
      plan.forEach(function (r) {
        if (r.del) return;
        var th = dd.themes.filter(function (x) { return x.id === r.id; })[0];
        if (!th) { th = { id: r.id }; dd.themes.push(th); }
        var oldOwner = th.owner || null;
        th.name = r.name.trim();
        th.color = r.color;
        th.owner = r.owner || null;
        if (r.reassign && oldOwner !== th.owner) {
          dd.tasks.forEach(function (t) {
            if (t.theme === r.id && t.status !== 'done') { t.assignee = th.owner; t.updated = nowIso(); }
          });
        }
      });
    }, 'тематики и исполнители обновлены');
  } }, 'Сохранить');

  showDlg([
    h('h3', null, 'Тематики и исполнители'),
    h('p', { class: 'hint' }, 'У каждой тематики свой исполнитель. Новые задачи в тематике по умолчанию достаются ему.'),
    listBox, add, err,
    h('div', { class: 'dlg-btns' }, h('button', { class: 'btn', type: 'button', onclick: closeDlg }, 'Закрыть'), save)
  ]);
}

/* ---------- запуск ---------- */

function init() {
  dlg = $('dlg');
  var downOnBackdrop = false;
  dlg.addEventListener('mousedown', function (e) { downOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', function (e) { if (e.target === dlg && downOnBackdrop && !dlgLocked) closeDlg(); });
  dlg.addEventListener('cancel', function (e) { if (dlgLocked) e.preventDefault(); });
  dlg.addEventListener('close', function () { if (S.data && !meUser()) openWho(); });
  window.addEventListener('beforeunload', function (e) {
    if (S.saving > 0 || S.uploading > 0) { e.preventDefault(); e.returnValue = ''; }
  });
  $('keyBtn').addEventListener('click', openKey);
  $('me').addEventListener('change', function () { setMe(this.value); });
  buildToolbar();

  checkToken().then(function () { return refresh(true); }).then(function () {
    if (!S.data) return;
    if (!meUser()) openWho();
    else S.filter.who = isAdmin() ? 'all' : 'me';
    render();
  });

  setInterval(function () { if (!document.hidden && S.data && S.saving === 0 && !dlg.open) refresh(false); }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.data && S.saving === 0 && !dlg.open) refresh(false); });
}

init();
})();
