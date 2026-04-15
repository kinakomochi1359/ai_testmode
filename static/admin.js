'use strict';

/* ================================================================
   ユーティリティ
================================================================ */
const esc   = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const show  = id => document.getElementById(id).classList.remove('hidden');
const hide  = id => document.getElementById(id).classList.add('hidden');
const setText = (id, t) => { document.getElementById(id).textContent = t; };
const val   = id => document.getElementById(id).value.trim();
const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };

function thumbnailUrl(isbn) {
  const c = String(isbn ?? '').replace(/[^0-9X]/gi, '');
  return c.length === 13 ? `https://ndlsearch.ndl.go.jp/thumbnail/${c}.jpg` : null;
}

function fmtDate(dt) {
  if (!dt) return '-';
  return String(dt).slice(0, 10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ================================================================
   フォームセクション定義（登録プレビュー・編集モーダル共用）
================================================================ */
const FORM_SECTIONS = [
  { legend: '識別子', fields: [
    { id:'isbn',       label:'ISBN',            required:true, roInPreview:true },
    { id:'issn',       label:'ISSN' },
    { id:'ndl_bib_id', label:'書誌ID（NDLBibID）' },
    { id:'ndl_uri',    label:'識別子（URI）' },
  ]},
  { legend: 'タイトル情報', fields: [
    { id:'title',          label:'タイトル',       required:true, span:2 },
    { id:'title_kana',     label:'タイトルよみ',   span:2 },
    { id:'parallel_title', label:'並列タイトル',   span:2 },
    { id:'series_title',   label:'シリーズタイトル', span:2 },
    { id:'edition',  label:'版',       ph:'例: 第2版' },
    { id:'volume',   label:'刊行巻次', ph:'例: 上' },
  ]},
  { legend: '責任表示・出版情報', fields: [
    { id:'responsibility', label:'責任表示',            ph:'例: 蛭田廣一 監修', span:2 },
    { id:'author',         label:'著者（dc:creator）',  ph:'例: 夏目漱石',      span:2 },
    { id:'publisher',      label:'出版者', span:2 },
    { id:'pub_place', label:'出版地（国名コード）', ph:'例: JP' },
    { id:'pub_date',  label:'出版年月日等',         ph:'例: 2024.6' },
    { id:'year',      label:'出版年（W3CDTF）',     type:'number', ph:'例: 2024' },
    { id:'extent',    label:'大きさ、容量等',       ph:'例: 167p ; 21cm' },
  ]},
  { legend: '分類・件名', fields: [
    { id:'ndc',        label:'分類（NDC）',        ph:'例: 014.72' },
    { id:'ndlc',       label:'分類（NDLC）',       ph:'例: UL587' },
    { id:'subject',    label:'件名標目',           ph:'例: 郷土資料--日本', span:2 },
    { id:'genre_form', label:'ジャンル・形式用語', span:2 },
    { id:'call_number', label:'請求記号', ph:'例: UL587-R3' },
    { id:'genre', label:'ジャンル（蔵書管理用）', required:true,
      datalist:'genre-list', hint:'検索画面の絞り込みに使用', hlColor:'#6c5ce7' },
  ]},
  { legend: '補足情報', fields: [
    { id:'notes',         label:'注記',                       ph:'例: 動画解説付', span:2 },
    { id:'language',      label:'本文の言語コード（ISO639-2）', ph:'例: jpn' },
    { id:'material_type', label:'資料種別',  ph:'例: 図書' },
    { id:'material_form', label:'資料形態',  ph:'例: 紙' },
    { id:'access_url',    label:'アクセスURL', type:'url' },
  ]},
];

const FIELD_IDS = FORM_SECTIONS.flatMap(s => s.fields.map(f => f.id));

function buildForm(prefix, isPreview = false) {
  return FORM_SECTIONS.map(sec => `
    <fieldset class="bib-section">
      <legend>${esc(sec.legend)}</legend>
      <div class="form-grid">
        ${sec.fields.map(f => {
          const id      = prefix + f.id;
          const ro      = isPreview && f.roInPreview ? 'readonly' : '';
          const spanCls = f.span === 2 ? ' col-span-2' : '';
          const style   = f.hlColor ? `style="border-color:${f.hlColor}"` : '';
          const dl      = f.datalist ? `list="${f.datalist}"` : '';
          const ph      = f.ph ? `placeholder="${esc(f.ph)}"` : '';
          return `<label class="form-label${spanCls}">
            ${esc(f.label)}${f.required ? ' <span class="required">*</span>' : ''}
            <input type="${f.type || 'text'}" id="${id}" class="form-input" ${ro} ${ph} ${dl} ${style}>
            ${f.hint ? `<span class="form-hint">${esc(f.hint)}</span>` : ''}
          </label>`;
        }).join('')}
      </div>
    </fieldset>`).join('');
}

/* ================================================================
   初期化
================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // フォーム HTML を挿入
  document.getElementById('preview-form').innerHTML = buildForm('f-', true);
  document.getElementById('edit-form').innerHTML    = buildForm('ef-', false);

  // ジャンル datalist
  fetch('/api/search').then(r => r.json()).then(books => {
    const genres = [...new Set(books.map(b => b.genre))].sort();
    document.getElementById('genre-list').innerHTML =
      genres.map(g => `<option value="${esc(g)}">`).join('');
  });

  initTabs();
  initLookup();
  initCSV();
  initOccMaster();
  initOccLinks();
  loadBooks();
  initEditModal();
  initConfirmModal();
});

/* ================================================================
   タブ切り替え
================================================================ */
function initTabs() {
  document.querySelectorAll('.admin-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-main > .tab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });
}

/* ================================================================
   ① ISBN 照会・登録
================================================================ */
function initLookup() {
  const isbnInput = document.getElementById('isbn-input');
  document.getElementById('lookup-btn').addEventListener('click', doLookup);
  isbnInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
  document.getElementById('cancel-btn').addEventListener('click', resetPreview);
  document.getElementById('register-btn').addEventListener('click', () => registerFromPreview());
}

function resetPreview() {
  hide('preview-panel');
  hide('lookup-error');
  hide('register-error');
  hide('register-success');
}

async function doLookup() {
  const isbn = val('isbn-input');
  if (!isbn) return;
  const btn = document.getElementById('lookup-btn');
  btn.disabled = true; btn.textContent = '照会中…';
  hide('lookup-error');
  try {
    const res  = await fetch('/api/admin/lookup?' + new URLSearchParams({ isbn }));
    const data = await res.json();
    if (!res.ok) { setText('lookup-error', data.error); show('lookup-error'); hide('preview-panel'); }
    else         { fillPreview(data); }
  } catch { setText('lookup-error', 'ネットワークエラー'); show('lookup-error'); }
  finally { btn.disabled = false; btn.textContent = '照会'; }
}

function fillPreview(data) {
  FIELD_IDS.forEach(f => setVal('f-' + f, data[f]));
  setVal('f-genre', '');
  const img = document.getElementById('preview-img');
  const nc  = document.getElementById('no-cover');
  if (data.thumbnail_url) { img.src = data.thumbnail_url; img.style.display = ''; nc.style.display = 'none'; }
  else                    { img.style.display = 'none'; nc.style.display = 'flex'; }
  hide('register-error'); hide('register-success');
  show('preview-panel');
  document.getElementById('preview-panel').scrollIntoView({ behavior:'smooth', block:'start' });
}

async function registerFromPreview() {
  hide('register-error'); hide('register-success');
  const body = {};
  FIELD_IDS.forEach(f => { const v = val('f-' + f); if (v) body[f] = v; });
  if (body.year) body.year = parseInt(body.year) || null;
  if (!body.title) { setText('register-error', 'タイトルは必須です'); show('register-error'); return; }
  if (!body.genre) { setText('register-error', 'ジャンル（蔵書管理用）は必須です'); show('register-error'); return; }
  if (!body.isbn)  { setText('register-error', 'ISBN は必須です'); show('register-error'); return; }

  const btn = document.getElementById('register-btn');
  btn.disabled = true; btn.textContent = '登録中…';
  try {
    const { ok, data } = await postBook(body);
    if (!ok) { setText('register-error', data.error); show('register-error'); }
    else {
      setText('register-success', `「${data.title}」を登録しました`); show('register-success');
      document.getElementById('isbn-input').value = '';
      setTimeout(resetPreview, 2000);
      loadBooks();
    }
  } catch { setText('register-error', 'ネットワークエラー'); show('register-error'); }
  finally { btn.disabled = false; btn.textContent = 'この本を登録する'; }
}

async function postBook(body) {
  const res  = await fetch('/api/admin/books', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

/* ================================================================
   ② CSV 一括登録
================================================================ */

// NDL CSV 列名 → DB フィールド名
const NDL_COL_MAP = {
  'タイトル':'title', 'タイトルよみ':'title_kana', '版':'edition',
  'シリーズタイトル':'series_title', '責任表示':'responsibility',
  '出版者':'publisher', '出版地（国名コード）':'pub_place',
  '出版年月日等':'pub_date', '出版年（W3CDTF）':'year', '刊行巻次':'volume',
  '大きさ、容量等':'extent', '分類（NDC）':'ndc', '分類（NDLC）':'ndlc',
  '件名標目':'subject', 'ジャンル・形式用語':'genre_form', '請求記号':'call_number',
  '書誌ID（NDLBibID）':'ndl_bib_id', '識別子（URI）':'ndl_uri',
  'ISBN':'isbn', 'ISSN、ISSN-L':'issn', '並列タイトル':'parallel_title',
  '注記':'notes', '本文の言語コード（ISO639-2）':'language',
  'アクセスURL':'access_url', '資料種別':'material_type', '資料形態':'material_form',
};

let csvBooks = [];   // 解析済みデータ
let csvMode  = '';   // 'ndl' | 'isbn'

function initCSV() {
  document.getElementById('csv-file').addEventListener('change', onCsvFileChange);
  document.getElementById('csv-start-btn').addEventListener('click', startCsvImport);
}

function onCsvFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  setText('csv-filename', file.name);
  hide('csv-progress');
  document.getElementById('csv-results').innerHTML = '';

  const reader = new FileReader();
  reader.onload = ev => parseCsvFile(ev.target.result);
  reader.readAsText(file, 'UTF-8');
}

function parseCsvFile(text) {
  // 区切り文字を自動検出
  const firstLine = text.split('\n')[0];
  const sep = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';
  const rows = text.trim().split('\n').map(l =>
    l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''))
  );
  if (rows.length < 2) { alert('データが見つかりません'); return; }

  const header = rows[0];
  const isNDL  = header.includes('タイトル') && header.includes('ISBN');

  if (isNDL) {
    // NDL CSV エクスポート形式 → 直接パース（API 呼び出しなし）
    csvMode  = 'ndl';
    csvBooks = rows.slice(1)
      .filter(r => r.length > 1 && r.some(c => c))
      .map(r => {
        const book = {};
        header.forEach((h, i) => {
          const key = NDL_COL_MAP[h];
          if (key && r[i]) book[key] = r[i].trim();
        });
        // 書誌ID から R100000002-I プレフィックスを除去
        if (book.ndl_bib_id && book.ndl_bib_id.includes('-I')) {
          book.ndl_bib_id = book.ndl_bib_id.split('-I').pop();
        }
        // アクセス URL を自動生成
        if (!book.access_url && book.ndl_bib_id) {
          book.access_url = `https://ndlsearch.ndl.go.jp/books/R100000002-I${book.ndl_bib_id}`;
        }
        // サムネイル URL
        const isbn13 = (book.isbn || '').replace(/[^0-9]/g, '');
        if (isbn13.length === 13) book.thumbnail_url = `https://ndlsearch.ndl.go.jp/thumbnail/${isbn13}.jpg`;
        // 出版年を数値に
        if (book.year) book.year = parseInt(book.year) || null;
        return book;
      })
      .filter(b => b.isbn);  // ISBN があるものだけ

    setText('csv-detect-msg',
      `NDL CSV 形式を検出しました。${csvBooks.length} 件の書籍が含まれています（API 呼び出しなし）。`);
  } else {
    // ISBN リスト形式
    csvMode  = 'isbn';
    const isbnCol = header.findIndex(h => /isbn/i.test(h));
    csvBooks = rows.slice(1)
      .map(r => {
        const cell = isbnCol >= 0 ? r[isbnCol] : r[0];
        const m = cell && cell.match(/(?:97[89]-?)?(?:\d-?){9}[\dX]/i);
        return m ? { isbn: m[0].replace(/[^0-9X]/gi,'') } : null;
      })
      .filter(Boolean);

    setText('csv-detect-msg',
      `ISBN リスト形式を検出しました。${csvBooks.length} 件の ISBN が見つかりました（NDL API を順次照会します）。`);
  }

  // プレビュー表示
  const listEl = document.getElementById('csv-isbn-list');
  const preview = csvBooks.slice(0, 5);
  listEl.innerHTML = preview.map(b =>
    `<div class="csv-isbn-row">${esc(b.isbn)}${b.title ? ' — ' + esc(b.title) : ''}</div>`
  ).join('') + (csvBooks.length > 5 ? `<div class="csv-isbn-more">…他 ${csvBooks.length - 5} 件</div>` : '');

  show('csv-preview');
}

async function startCsvImport() {
  const genre = val('csv-genre');
  if (!genre) { alert('ジャンル（蔵書管理用）を入力してください'); return; }

  const btn = document.getElementById('csv-start-btn');
  btn.disabled = true;
  show('csv-progress');
  document.getElementById('csv-results').innerHTML = '';

  const total   = csvBooks.length;
  let   done    = 0;
  let   success = 0;

  function updateProgress() {
    const pct = total ? Math.round(done / total * 100) : 0;
    document.getElementById('progress-bar').style.width = pct + '%';
    setText('progress-text', `${done} / ${total} 件処理中… (登録済: ${success} 件)`);
  }
  updateProgress();

  for (const bookBase of csvBooks) {
    let book = { ...bookBase, genre };

    // ISBN リスト形式のみ NDL API 照会
    if (csvMode === 'isbn') {
      try {
        const res  = await fetch('/api/admin/lookup?' + new URLSearchParams({ isbn: book.isbn }));
        const data = await res.json();
        if (res.ok) book = { ...data, genre };
        // 失敗しても isbn のみで続行
      } catch { /* ネットワークエラーは無視して続行 */ }
      await sleep(300);  // API レート制限対策
    }

    // 登録
    let status = '', cls = '';
    try {
      const { ok, data } = await postBook(book);
      if (ok)                    { status = `✓ ${esc(data.title || book.isbn)}`; cls = 'csv-ok';   success++; }
      else if (res?.status === 409) { status = `― ${esc(book.isbn)} 重複のためスキップ`;    cls = 'csv-skip'; }
      else                       { status = `✗ ${esc(book.isbn)} ${esc(data.error || '')}`;  cls = 'csv-err';  }
    } catch {
      status = `✗ ${esc(book.isbn)} ネットワークエラー`; cls = 'csv-err';
    }

    const li = document.createElement('li');
    li.className = cls; li.innerHTML = status;
    document.getElementById('csv-results').appendChild(li);

    done++;
    updateProgress();
  }

  setText('progress-text', `完了: ${total} 件中 ${success} 件を登録しました`);
  btn.disabled = false;
  loadBooks();
}

/* ================================================================
   ③ 登録済み蔵書一覧
================================================================ */
let allBooks = [];

async function loadBooks() {
  const res = await fetch('/api/admin/books');
  allBooks  = await res.json();
  renderTable(allBooks);
}

function renderTable(books) {
  const q = document.getElementById('list-search').value.trim().toLowerCase();
  const filtered = q
    ? books.filter(b =>
        (b.title          ?? '').toLowerCase().includes(q) ||
        (b.responsibility ?? '').toLowerCase().includes(q) ||
        (b.author         ?? '').toLowerCase().includes(q) ||
        (b.isbn           ?? '').replace(/-/g, '').includes(q.replace(/-/g, '')))
    : books;

  setText('list-count', `${filtered.length} 件`);
  const empty = document.getElementById('table-empty');
  const tbody = document.getElementById('book-tbody');

  if (filtered.length === 0) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  tbody.innerHTML = filtered.map(b => {
    const thumb = thumbnailUrl(b.isbn);
    const resp  = b.responsibility || b.author || '';
    return `<tr data-id="${b.id}">
      <td class="col-cover">${thumb
        ? `<img class="thumb" src="${esc(thumb)}" alt="" onerror="this.style.display='none'">`
        : '<span class="no-thumb">-</span>'}</td>
      <td class="col-title">
        <div class="book-title-cell">${esc(b.title)}</div>
        <div class="book-author-cell">${esc(resp)}</div>
        ${b.series_title ? `<div class="book-series-cell">${esc(b.series_title)}</div>` : ''}
      </td>
      <td class="col-genre"><span class="genre-tag">${esc(b.genre)}</span></td>
      <td class="col-ndc">${esc(b.ndc ?? '')}</td>
      <td class="col-year">${b.year ?? '-'}</td>
      <td class="col-reg">${fmtDate(b.registered_at)}</td>
      <td class="col-status">
        <button class="status-btn ${b.available ? 'status-ok':'status-ng'}" data-id="${b.id}" data-toggle>
          ${b.available ? '貸出可':'貸出中'}
        </button>
      </td>
      <td class="col-action">
        <button class="btn-edit"   data-id="${b.id}" data-edit>編集</button>
        <button class="btn-delete" data-id="${b.id}" data-title="${esc(b.title)}" data-del>削除</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-toggle]').forEach(btn =>
    btn.addEventListener('click', () => toggleAvailable(Number(btn.dataset.id))));
  tbody.querySelectorAll('[data-edit]').forEach(btn =>
    btn.addEventListener('click', () => openEditModal(Number(btn.dataset.id))));
  tbody.querySelectorAll('[data-del]').forEach(btn =>
    btn.addEventListener('click', () => confirmDelete(Number(btn.dataset.id), btn.dataset.title)));
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('list-search').addEventListener('input', () => renderTable(allBooks));
});

async function toggleAvailable(id) {
  const res  = await fetch(`/api/admin/books/${id}/available`, { method:'PUT' });
  const data = await res.json();
  allBooks   = allBooks.map(b => b.id === id ? data : b);
  renderTable(allBooks);
}

/* ================================================================
   編集モーダル
================================================================ */
let editingId = null;

function initEditModal() {
  document.getElementById('edit-close').addEventListener('click',  closeEditModal);
  document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('edit-save').addEventListener('click',   saveEdit);
  document.getElementById('edit-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-overlay')) closeEditModal();
  });
}

function openEditModal(id) {
  const book = allBooks.find(b => b.id === id);
  if (!book) return;
  editingId = id;

  setText('edit-modal-title', `編集: ${book.title}`);
  document.getElementById('edit-meta').innerHTML =
    `<span class="edit-meta-item">登録日: ${fmtDate(book.registered_at)}</span>` +
    `<span class="edit-meta-item">ISBN: ${esc(book.isbn)}</span>`;

  FIELD_IDS.forEach(f => setVal('ef-' + f, book[f]));
  // ISBN は読み取り専用
  const isbnEl = document.getElementById('ef-isbn');
  if (isbnEl) isbnEl.readOnly = true;

  hide('edit-error'); hide('edit-success');
  show('edit-overlay');
  document.getElementById('edit-modal').scrollTop = 0;
}

function closeEditModal() {
  hide('edit-overlay');
  editingId = null;
}

async function saveEdit() {
  hide('edit-error'); hide('edit-success');
  const body = {};
  FIELD_IDS.forEach(f => {
    if (f === 'isbn') return;  // ISBN は変更不可
    const v = val('ef-' + f);
    if (v) body[f] = v;
  });
  if (body.year) body.year = parseInt(body.year) || null;
  if (!body.title) { setText('edit-error', 'タイトルは必須です'); show('edit-error'); return; }
  if (!body.genre) { setText('edit-error', 'ジャンルは必須です'); show('edit-error'); return; }

  const btn = document.getElementById('edit-save');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const res  = await fetch(`/api/admin/books/${editingId}`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { setText('edit-error', data.error); show('edit-error'); }
    else {
      allBooks = allBooks.map(b => b.id === editingId ? data : b);
      renderTable(allBooks);
      setText('edit-success', '保存しました'); show('edit-success');
      setTimeout(closeEditModal, 1200);
    }
  } catch { setText('edit-error', 'ネットワークエラー'); show('edit-error'); }
  finally { btn.disabled = false; btn.textContent = '保存する'; }
}

/* ================================================================
   削除確認
================================================================ */
let pendingDeleteId = null;

function initConfirmModal() {
  document.getElementById('confirm-ok').addEventListener('click', async () => {
    if (pendingDeleteId === null) return;
    await fetch(`/api/admin/books/${pendingDeleteId}`, { method:'DELETE' });
    allBooks = allBooks.filter(b => b.id !== pendingDeleteId);
    renderTable(allBooks);
    hide('confirm-overlay');
    pendingDeleteId = null;
  });
  document.getElementById('confirm-cancel').addEventListener('click', () => {
    hide('confirm-overlay'); pendingDeleteId = null;
  });
}

function confirmDelete(id, title) {
  pendingDeleteId = id;
  setText('confirm-msg', `「${title}」を削除します。よろしいですか？`);
  show('confirm-overlay');
}

/* ================================================================
   ③-b 職業マスタ管理
================================================================ */
let allOccMaster = [];

function initOccMaster() {
  document.getElementById('occ-add-btn').addEventListener('click', addOccupation);
  loadOccMaster();
}

async function loadOccMaster() {
  const res    = await fetch('/api/admin/occupations');
  allOccMaster = await res.json();
  renderOccMaster();
}

function renderOccMaster() {
  const list = document.getElementById('occ-master-list');
  setText('occ-master-count', `${allOccMaster.length} 件`);

  if (allOccMaster.length === 0) {
    list.innerHTML = '<p class="no-result">登録された職業はありません。</p>';
    return;
  }

  list.innerHTML = allOccMaster.map(o => `
    <div class="occ-master-card" data-occ-id="${o.id}">
      <div class="occ-master-top">
        <span class="occ-master-icon">${esc(o.icon || '')}</span>
        <input class="occ-master-name form-input" data-field="name" value="${esc(o.name)}" placeholder="職業名">
        <span class="occ-book-count">${o.book_count} 冊</span>
        <button class="btn-primary occ-save-btn" data-occ-id="${o.id}">保存</button>
      </div>
      <div class="occ-master-icon-row">
        <label class="form-label" style="flex:0 0 auto; min-width:0">
          アイコン
          <input class="occ-master-icon-input form-input occ-icon-input" data-field="icon" value="${esc(o.icon || '')}" placeholder="💻" maxlength="4">
        </label>
      </div>
      <textarea class="occ-master-desc form-input occ-desc-input" data-field="desc" rows="2"
                placeholder="解説">${esc(o.description || '')}</textarea>
      <span class="occ-save-msg" id="occ-msg-${o.id}"></span>
    </div>`).join('');

  list.querySelectorAll('.occ-save-btn').forEach(btn =>
    btn.addEventListener('click', () => saveOccupation(Number(btn.dataset.occId)))
  );
}

async function saveOccupation(id) {
  const card = document.querySelector(`.occ-master-card[data-occ-id="${id}"]`);
  const name  = card.querySelector('[data-field="name"]').value.trim();
  const icon  = card.querySelector('[data-field="icon"]').value.trim();
  const desc  = card.querySelector('[data-field="desc"]').value.trim();
  const msg   = document.getElementById(`occ-msg-${id}`);
  msg.textContent = '';

  if (!name) { msg.className = 'occ-save-msg form-error'; msg.textContent = '職業名は必須です'; return; }

  const res  = await fetch(`/api/admin/occupations/${id}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, description: desc, icon }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.className = 'occ-save-msg form-error'; msg.textContent = data.error;
  } else {
    allOccMaster = allOccMaster.map(o => o.id === id ? data : o);
    msg.className = 'occ-save-msg form-success'; msg.textContent = '保存しました';
    setTimeout(() => { msg.textContent = ''; }, 1500);
  }
}

async function addOccupation() {
  const name = document.getElementById('occ-add-name').value.trim();
  const icon = document.getElementById('occ-add-icon').value.trim();
  const desc = document.getElementById('occ-add-desc').value.trim();
  const errEl = document.getElementById('occ-add-error');
  const okEl  = document.getElementById('occ-add-success');
  errEl.textContent = ''; okEl.textContent = '';

  if (!name) { errEl.textContent = '職業名は必須です'; return; }

  const res  = await fetch('/api/admin/occupations', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, description: desc, icon }),
  });
  const data = await res.json();
  if (!res.ok) {
    errEl.textContent = data.error;
  } else {
    okEl.textContent = `「${data.name}」を追加しました`;
    document.getElementById('occ-add-name').value = '';
    document.getElementById('occ-add-icon').value = '';
    document.getElementById('occ-add-desc').value = '';
    allOccMaster = [...allOccMaster, data];
    renderOccMaster();
    setTimeout(() => { okEl.textContent = ''; }, 2000);
  }
}

/* ================================================================
   ④ 職業別おすすめ 紐づけ管理
================================================================ */
let occCsvData  = [];
let allOccLinks = [];

function initOccLinks() {
  document.getElementById('occ-csv-file').addEventListener('change', onOccCsvChange);
  document.getElementById('occ-csv-start-btn').addEventListener('click', startOccCsvImport);
  document.getElementById('occ-links-search').addEventListener('input', () => renderOccLinks(allOccLinks));
  loadOccLinks();
}

function onOccCsvChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  setText('occ-csv-filename', file.name);
  hide('occ-csv-progress');
  document.getElementById('occ-csv-results').innerHTML = '';
  const reader = new FileReader();
  reader.onload = ev => parseOccCsv(ev.target.result);
  reader.readAsText(file, 'UTF-8');
}

function parseOccCsv(text) {
  const firstLine = text.split('\n')[0];
  const sep = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';
  const rows = text.trim().split('\n').map(l =>
    l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''))
  );
  if (rows.length < 1) { alert('データが見つかりません'); return; }

  // ヘッダー行を自動スキップ（先頭セルが "isbn" または "ISBN" の場合）
  const hasHeader = /^isbn$/i.test(rows[0][0]);
  const dataRows  = hasHeader ? rows.slice(1) : rows;

  occCsvData = dataRows
    .filter(r => r.length >= 2 && r[0] && r[1])
    .map(r => ({
      isbn:            r[0].replace(/[^0-9X]/gi, ''),
      occupation_name: r[1].trim(),
      note:            (r[2] || '').trim(),
    }))
    .filter(d => d.isbn.length > 0 && d.occupation_name.length > 0);

  setText('occ-csv-detect-msg', `${occCsvData.length} 件の紐づけデータが見つかりました。`);

  const listEl  = document.getElementById('occ-csv-isbn-list');
  const preview = occCsvData.slice(0, 5);
  listEl.innerHTML = preview.map(d =>
    `<div class="csv-isbn-row">${esc(d.isbn)} → ${esc(d.occupation_name)}${d.note ? ' (' + esc(d.note) + ')' : ''}</div>`
  ).join('') + (occCsvData.length > 5 ? `<div class="csv-isbn-more">…他 ${occCsvData.length - 5} 件</div>` : '');

  show('occ-csv-preview');
}

async function startOccCsvImport() {
  if (occCsvData.length === 0) { alert('データがありません'); return; }
  const btn = document.getElementById('occ-csv-start-btn');
  btn.disabled = true;
  show('occ-csv-progress');
  document.getElementById('occ-csv-results').innerHTML = '';

  const total = occCsvData.length;
  let done = 0, success = 0;

  function updateProgress() {
    const pct = total ? Math.round(done / total * 100) : 0;
    document.getElementById('occ-progress-bar').style.width = pct + '%';
    setText('occ-progress-text', `${done} / ${total} 件処理中… (登録済: ${success} 件)`);
  }
  updateProgress();

  for (const item of occCsvData) {
    let status = '', cls = '';
    try {
      const res  = await fetch('/api/admin/occupation-books', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(item),
      });
      const data = await res.json();
      if (res.ok) {
        status = `✓ ${esc(item.isbn)} → ${esc(item.occupation_name)}`; cls = 'csv-ok'; success++;
      } else if (res.status === 409) {
        status = `― ${esc(item.isbn)} → ${esc(item.occupation_name)} 重複のためスキップ`; cls = 'csv-skip';
      } else {
        status = `✗ ${esc(item.isbn)} ${esc(data.error || '')}`; cls = 'csv-err';
      }
    } catch {
      status = `✗ ${esc(item.isbn)} ネットワークエラー`; cls = 'csv-err';
    }
    const li = document.createElement('li');
    li.className = cls; li.innerHTML = status;
    document.getElementById('occ-csv-results').appendChild(li);
    done++; updateProgress();
  }

  setText('occ-progress-text', `完了: ${total} 件中 ${success} 件を登録しました`);
  btn.disabled = false;
  loadOccLinks();
}

async function loadOccLinks() {
  const res   = await fetch('/api/admin/occupation-books');
  allOccLinks = await res.json();
  renderOccLinks(allOccLinks);
}

function renderOccLinks(links) {
  const q = document.getElementById('occ-links-search').value.trim().toLowerCase();
  const filtered = q
    ? links.filter(l =>
        (l.occupation_name ?? '').toLowerCase().includes(q) ||
        (l.title           ?? '').toLowerCase().includes(q) ||
        (l.isbn            ?? '').includes(q))
    : links;

  setText('occ-links-count', `${filtered.length} 件`);
  const empty = document.getElementById('occ-links-empty');
  const tbody = document.getElementById('occ-links-tbody');

  if (filtered.length === 0) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  tbody.innerHTML = filtered.map(l => {
    const thumb = thumbnailUrl(l.isbn);
    return `<tr>
      <td><span class="genre-tag">${esc(l.occupation_name)}</span></td>
      <td class="col-cover">${thumb
        ? `<img class="thumb" src="${esc(thumb)}" alt="" onerror="this.style.display='none'">`
        : '<span class="no-thumb">-</span>'}</td>
      <td>${esc(l.title)}</td>
      <td>${esc(l.isbn)}</td>
      <td>${esc(l.note || '')}</td>
      <td><button class="btn-delete" data-link-id="${l.id}" data-occ-del>削除</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-occ-del]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.linkId);
      if (!confirm('この紐づけを削除しますか？')) return;
      await fetch(`/api/admin/occupation-books/${id}`, { method: 'DELETE' });
      allOccLinks = allOccLinks.filter(l => l.id !== id);
      renderOccLinks(allOccLinks);
    })
  );
}
