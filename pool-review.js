// Poolie — Pool Review tab.
// Reviews a client's property list: 58-point exam results (from the inspections table),
// category, inspection result, pricing, needed work and photos. Several staff can edit at once;
// changes save automatically and show up live for everyone.
(function () {
  "use strict";
  const P = window.POOLIE;
  if (!P) { console.error('Pool Review: window.POOLIE missing — load pool-review.js after the main script.'); return; }
  const { sb, BUCKET, $, escapeHtml: esc } = P;

  // ---------------------------------------------------------------- constants
  const SECTIONS = [
    { key: 'chemistry',  title: 'Pool Water Chemistry',                 scored: true },
    { key: 'surface',    title: 'Pool Surface & Decking',               scored: true },
    { key: 'equipment',  title: 'Pool Equipment Inspection',            scored: true },
    { key: 'safety',     title: 'Safety & General Inspection',          scored: true },
    { key: 'commercial', title: 'Commercial Signs & Safety Equipment',  scored: true },
    { key: 'surrounding',title: 'Surrounding Pool Area',                scored: false },
  ];
  const SECTION_SIZE = {
    chemistry: P.chemistry.length, surface: P.surface.length, equipment: P.equipment.length,
    safety: P.safety.length, commercial: P.commercial.length, surrounding: P.surrounding.length,
  };
  const TOTAL_POINTS = P.TOTAL_POINTS;
  const RATING_LABELS = { pass: 'Pass', caution: 'Caution', failed: 'Failed', na: 'N/A' };
  const CAT_LABELS = ['Needs major work', 'Significant repairs', 'Several repairs', 'Minor repairs', 'Nearly ready', 'Good for service'];
  const CAT_COLORS = ['#c0392b', '#dd6a38', '#e3a23a', '#c9b838', '#7dae48', '#1e8e5a'];
  const RESULTS = [['fail', 'Fail'], ['at_risk', 'At risk'], ['pass', 'Pass']];
  const resLabel = k => (RESULTS.find(r => r[0] === k) || [])[1] || '';
  const PHOTO_CATS = P.PHOTO_CATEGORIES.map(c => ({ key: c.key, label: c.label.replace(/ \(.*\)$/, '') }));
  const photoCatLabel = k => (PHOTO_CATS.find(c => c.key === k) || { label: 'Additional photos' }).label;
  const SUMMER_MONTHS = 7, WINTER_MONTHS = 5;
  const FIELDS = ['poolbrain_url', 'category', 'inspection_result', 'summary', 'price_3x', 'price_2x',
                  'repairs', 'renovations', 'maintenance', 'inspection_id'];

  // ---------------------------------------------------------------- state
  let loaded = false, loading = null, channel = null, session = null;
  let props = [], reviews = {}, inspections = [], rphotos = {};   // rphotos: id -> row
  const pending = {}, timers = {}, inflight = {};
  const signed = {};      // storage_path -> {url, exp}
  const examPhotos = {};  // inspection_id -> rows
  const uploads = [];
  let sel = null, pbEdit = false, pbDraft = '', confirmDel = null, lb = null, uploadCat = 'equipment_pad', activeUploads = 0;
  const ui = { q: '', region: '', cat: '', res: '', sort: 'order' };

  // ---------------------------------------------------------------- helpers
  const num = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
  const money = n => n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const norm = s => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/\bapartments?\b|\bapts?\b/g, '').replace(/[^a-z0-9]/g, '');
  function normUrl(u) {
    u = String(u || '').trim(); if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; }
  }
  function setSync(t) { const el = $('rvSync'); if (el) el.textContent = t; }

  function review(id) { return { ...(reviews[id] || {}), ...(pending[id] || {}) }; }
  function yearly(r) {
    const a = num(r.price_3x), b = num(r.price_2x);
    if (a == null && b == null) return null;
    return (a || 0) * SUMMER_MONTHS + (b || 0) * WINTER_MONTHS;
  }

  // inspection matched to a property: explicit link wins, else newest with a matching name
  function matchedInspections(p) {
    const n = norm(p.name);
    return inspections.filter(i => {
      const a = norm(i.property), b = norm(i.customer);
      return (a && (a === n || (a.length > 5 && (a.includes(n) || n.includes(a))))) ||
             (b && (b === n || (b.length > 5 && (b.includes(n) || n.includes(b)))));
    });
  }
  function examFor(p) {
    const r = review(p.id);
    if (r.inspection_id) return { exam: inspections.find(i => i.id === r.inspection_id) || null, auto: false };
    const m = matchedInspections(p);
    return { exam: m[0] || null, auto: true };
  }
  function examScore(e) {
    const out = { p: 0, c: 0, f: 0, na: 0, rated: 0, per: {}, judged: 0, pct: null, complete: false };
    if (!e) return out;
    for (const s of SECTIONS) {
      const items = e[s.key] || [];
      const r = { p: 0, c: 0, f: 0, na: 0, yes: 0, no: 0, rated: 0, n: items.length || SECTION_SIZE[s.key] };
      items.forEach(it => {
        if (s.key === 'surrounding') { if (it.answer === 'yes') r.yes++; else if (it.answer === 'no') r.no++; if (it.answer) r.rated++; return; }
        if (it.rating === 'pass') r.p++; else if (it.rating === 'caution') r.c++; else if (it.rating === 'failed') r.f++; else if (it.rating === 'na') r.na++;
        if (it.rating) r.rated++;
      });
      out.per[s.key] = r;
      if (s.scored) { out.p += r.p; out.c += r.c; out.f += r.f; out.na += r.na; out.rated += r.rated; }
    }
    out.judged = out.p + out.c + out.f;
    out.pct = out.judged ? out.p / out.judged : null;
    out.complete = out.rated >= TOTAL_POINTS;
    return out;
  }
  function rating(sc) {
    if (sc.pct == null) return null;
    if (!sc.complete) return { label: 'In progress', cls: 'na' };
    const pct = sc.pct * 100;
    if (pct >= 90) return { label: 'Excellent', cls: 'ok' };
    if (pct >= 75) return { label: 'Good', cls: 'ok' };
    if (pct >= 60) return { label: 'Fair', cls: 'caution' };
    return { label: 'Poor', cls: 'failed' };
  }
  const photosFor = pid => Object.values(rphotos).filter(r => r.property_id === pid)
    .sort((a, b) => (PHOTO_CATS.findIndex(c => c.key === a.category_key) - PHOTO_CATS.findIndex(c => c.key === b.category_key)) || String(a.created_at).localeCompare(String(b.created_at)));
  const photoCount = pid => { let n = 0; for (const k in rphotos) if (rphotos[k].property_id === pid) n++; return n; };

  async function signPaths(paths) {
    const now = Date.now();
    const need = [...new Set(paths)].filter(p => p && !(signed[p] && signed[p].exp > now + 60000));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const { data } = await sb.storage.from(BUCKET).createSignedUrls(chunk, 3600);
      (data || []).forEach(s => { if (s.path && s.signedUrl) signed[s.path] = { url: s.signedUrl, exp: now + 3600 * 1000 }; });
    }
  }
  const urlFor = path => (signed[path] && signed[path].url) || '';

  // ---------------------------------------------------------------- load
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      setSync('Loading…');
      $('rvList').innerHTML = '<div class="log-empty">Loading…</div>';
      const s = await sb.auth.getSession(); session = s.data && s.data.session;
      const [pr, rv, ph, ins] = await Promise.all([
        sb.from('pool_review_properties').select('*').order('sort_order', { ascending: true }),
        sb.from('pool_reviews').select('*'),
        sb.from('pool_review_photos').select('*'),
        sb.from('inspections').select('id,created_at,inspection_date,technician,customer,property,address,city,dimensions,pool_size,notes,section_notes,chemistry,surface,equipment,safety,commercial,surrounding,pass_count,caution_count,failed_count,na_count,unrated_count,status,photo_count')
          .order('inspection_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(1000),
      ]);
      const err = pr.error || rv.error || ph.error || ins.error;
      if (err) {
        const missing = /relation .* does not exist|could not find the table/i.test(err.message || '');
        $('rvList').innerHTML = `<div class="log-empty">${missing ? 'The Pool Review tables aren\'t set up yet. Run <code>supabase/pool_review.sql</code> in the Supabase SQL editor, then refresh.' : 'Could not load the review: ' + esc(err.message)}</div>`;
        setSync(''); loading = null; return;
      }
      props = pr.data || [];
      reviews = {}; (rv.data || []).forEach(r => { reviews[r.property_id] = r; });
      rphotos = {}; (ph.data || []).forEach(r => { rphotos[r.id] = r; });
      inspections = ins.data || [];
      loaded = true; loading = null;
      buildRegionFilter();
      subscribe();
      setSync('Changes save automatically for everyone.');
      renderAll();
    })();
    return loading;
  }

  function subscribe() {
    if (channel) return;
    channel = sb.channel('pool-review')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pool_reviews' }, payload => {
        if (payload.eventType === 'DELETE') { delete reviews[payload.old.property_id]; }
        else reviews[payload.new.property_id] = payload.new;
        onRemote();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pool_review_photos' }, payload => {
        if (payload.eventType === 'DELETE') delete rphotos[payload.old.id];
        else rphotos[payload.new.id] = payload.new;
        onRemote(true);
      })
      .subscribe();
  }
  function onRemote(photosChanged) {
    renderStats(); renderList();
    if (!sel) return;
    if (photosChanged) { renderPhotos(); return; }
    softRefresh();
  }

  // ---------------------------------------------------------------- list
  function buildRegionFilter() {
    const regions = [...new Set(props.map(p => p.region).filter(Boolean))];
    $('rvRegion').innerHTML = '<option value="">All regions</option>' + regions.map(r => `<option>${esc(r)}</option>`).join('');
    const clients = [...new Set(props.map(p => p.client).filter(Boolean))];
    $('rvTitle').textContent = clients.length === 1 ? `Pool Review · ${clients[0]}` : 'Pool Review';
  }
  function renderStats() {
    let inspected = 0, priced = 0, total = 0, cats = 0, results = 0;
    for (const p of props) {
      const r = review(p.id); if (examFor(p).exam) inspected++;
      const y = yearly(r); if (y != null) { priced++; total += y; }
      if (r.category != null) cats++; if (r.inspection_result) results++;
    }
    $('rvStats').innerHTML = [
      [props.length, 'properties'], [inspected, 'inspected'], [results, 'with a result'],
      [cats, 'categorized'], [priced, 'priced'], [money(total), 'total yearly'],
    ].map(([b, s]) => `<div class="rv-stat"><b>${b}</b><span>${s}</span></div>`).join('');
  }
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    let rows = props.map((p, i) => ({ p, i, r: review(p.id) }));
    rows = rows.filter(({ p, r }) => {
      if (ui.region && p.region !== ui.region) return false;
      if (q && !`${p.name} ${p.city} ${p.manager} ${p.address} ${p.techs}`.toLowerCase().includes(q)) return false;
      if (ui.cat === 'none' && r.category != null) return false;
      if (ui.cat !== '' && ui.cat !== 'none' && r.category !== Number(ui.cat)) return false;
      if (ui.res === 'none' && r.inspection_result) return false;
      if (ui.res && ui.res !== 'none' && r.inspection_result !== ui.res) return false;
      return true;
    });
    const big = 1e12;
    const key = {
      order: x => x.i, name: x => x.p.name.toLowerCase(),
      cat: x => x.r.category == null ? big : x.r.category,
      score: x => { const s = examScore(examFor(x.p).exam).pct; return s == null ? big : s; },
      year: x => { const y = yearly(x.r); return y == null ? big : -y; },
    }[ui.sort];
    rows.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : a.i - b.i; });
    return rows;
  }
  function renderList() {
    if (!loaded) return;
    const rows = filtered(), el = $('rvList');
    if (!rows.length) { el.innerHTML = '<div class="log-empty">No properties match these filters.</div>'; return; }
    const grouped = ui.sort === 'order';
    let html = '', last = null;
    for (const { p, r } of rows) {
      if (grouped && p.region !== last) {
        last = p.region;
        html += `<div class="rv-group">${esc(last || 'Other')} <span>${rows.filter(x => x.p.region === last).length}</span></div>`;
      }
      const { exam } = examFor(p), sc = examScore(exam), y = yearly(r), n = photoCount(p.id);
      html += `<div class="log-entry rv-entry" data-id="${esc(p.id)}" tabindex="0" role="button">
        <span class="rv-strip" style="background:${r.category != null ? CAT_COLORS[r.category] : 'var(--border)'}"></span>
        <div class="rv-entry-main">
          <div class="log-entry-title">${esc(p.name)}</div>
          <div class="log-entry-sub">${esc(p.city || '')}${p.techs ? ' · ' + esc(p.techs) : ''}${n ? ` · ${n} photo${n > 1 ? 's' : ''}` : ''}</div>
          <div class="rv-tags">
            ${r.inspection_result ? `<span class="status-pill ${r.inspection_result === 'pass' ? 'ok' : r.inspection_result === 'fail' ? 'failed' : 'caution'}">${resLabel(r.inspection_result)}</span>` : ''}
            ${r.category != null ? `<span class="rv-catpill"><i style="background:${CAT_COLORS[r.category]}"></i>Category ${r.category}</span>` : ''}
          </div>
        </div>
        <div class="rv-entry-right"><b>${exam ? `${sc.p}/${TOTAL_POINTS}` : 'No exam'}</b><span>${y != null ? money(y) + '/yr' : 'Not priced'}</span></div>
      </div>`;
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- detail
  const EXT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';

  function openDetail(id) {
    sel = id; pbEdit = false; confirmDel = null;
    $('rvListCard').classList.add('hidden'); $('rvDetail').classList.remove('hidden');
    renderDetail(); window.scrollTo(0, 0);
    loadDetailPhotos();
  }
  function closeDetail() {
    sel = null; $('rvDetail').classList.add('hidden'); $('rvListCard').classList.remove('hidden'); renderList();
  }
  async function loadDetailPhotos() {
    const id = sel; const p = props.find(x => x.id === id); if (!p) return;
    const { exam } = examFor(p);
    if (exam && !examPhotos[exam.id]) {
      const { data } = await sb.from('inspection_photos').select('*').eq('inspection_id', exam.id).order('sort_order', { ascending: true });
      examPhotos[exam.id] = data || [];
    }
    const paths = photosFor(id).map(r => r.storage_path).concat(exam ? (examPhotos[exam.id] || []).map(r => r.storage_path) : []);
    await signPaths(paths);
    if (sel === id) renderPhotos(true);
  }

  function renderDetail() {
    const el = $('rvDetail');
    const p = props.find(x => x.id === sel); if (!p) { closeDetail(); return; }
    const r = review(p.id), { exam, auto } = examFor(p), sc = examScore(exam), rt = rating(sc), y = yearly(r);
    const openSecs = new Set([...el.querySelectorAll('details.rv-sec[open]')].map(x => x.dataset.key));
    const saved = r.updated_at ? `Last saved ${new Date(r.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${r.updated_by_email ? ' by ' + esc(r.updated_by_email.split('@')[0]) : ''}` : '';
    const matches = matchedInspections(p);
    const others = inspections.filter(i => !matches.includes(i));
    const optLabel = i => `${i.property || i.customer || 'Unnamed'} · ${i.inspection_date || new Date(i.created_at).toLocaleDateString()} · ${i.technician || 'Unknown tech'}`;

    // needs-attention list from the exam
    const attention = [];
    if (exam) SECTIONS.filter(s => s.scored).forEach(s => (exam[s.key] || []).forEach(it => {
      if (it.rating === 'failed' || it.rating === 'caution') attention.push({ sev: it.rating, name: it.name, sec: s.title });
    }));
    attention.sort((a, b) => (a.sev === 'failed' ? 0 : 1) - (b.sev === 'failed' ? 0 : 1));

    el.innerHTML = `
    <button type="button" class="log-detail-back" id="rvBack">&larr; Back to Pool Review</button>

    <div class="card">
      <div class="rv-head">
        <div>
          <div class="rv-title-row"><h2 class="rv-name">${esc(p.name)}</h2>${
            r.poolbrain_url && !pbEdit ? `<a class="rv-pb" href="${esc(r.poolbrain_url)}" target="_blank" rel="noopener">${EXT}Poolbrain</a><button type="button" class="rv-lnk" id="rvPbEdit">Edit link</button>`
            : (!pbEdit ? `<button type="button" class="rv-pb add" id="rvPbEdit">+ Add Poolbrain link</button>` : '')}</div>
          <div class="rv-addr">${esc(p.address || '')}</div>
          ${pbEdit ? `<div class="rv-pb-edit"><input type="text" id="rvPbIn" value="${esc(pbDraft)}" placeholder="Paste the Poolbrain link for this property" aria-label="Poolbrain link">
            <button type="button" class="primary rv-sm" id="rvPbSave">Save link</button><button type="button" class="secondary rv-sm" id="rvPbCancel">Cancel</button>
            ${r.poolbrain_url ? '<button type="button" class="rv-lnk danger" id="rvPbRemove">Remove</button>' : ''}<span class="rv-msg" id="rvPbMsg"></span></div>` : ''}
        </div>
        <div class="rv-saved" id="rvSaved">${saved}</div>
      </div>
      <div class="rv-facts">
        <div><span>Property manager</span>${esc(p.manager || '—')}</div>
        <div><span>Phone</span>${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^0-9]/g, ''))}">${esc(p.phone)}</a>` : '—'}</div>
        <div><span>Exam days</span>${esc(p.exam_days || '—')}</div>
        <div><span>Techs</span>${esc(p.techs || '—')}</div>
        <div><span>Website</span>${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : 'Not on file'}</div>
      </div>
    </div>

    <div class="card">
      <h2>Category</h2>
      <div class="rv-cat" role="group" aria-label="Category">
        ${CAT_LABELS.map((l, i) => `<button type="button" data-cat="${i}" aria-pressed="${r.category === i}"><i style="background:${CAT_COLORS[i]}"></i><b>${i}</b>${l}</button>`).join('')}
      </div>
      <p class="rv-help">0 means the pool needs major work before service. 5 means it's good for service as is.</p>
      <h2 style="margin-top:22px">Inspection Result</h2>
      <div class="rv-res" role="group" aria-label="Inspection result">
        ${RESULTS.map(([k, l]) => `<button type="button" data-res="${k}" aria-pressed="${r.inspection_result === k}"><i></i>${l}</button>`).join('')}
      </div>
      <p class="rv-help">Tap a selected option again to clear it.</p>
    </div>

    <div class="card">
      <h2>58-Point Exam ${exam ? `<span class="count">${esc(exam.inspection_date || new Date(exam.created_at).toLocaleDateString())} · ${esc(exam.technician || 'Unknown tech')}</span>` : ''}</h2>
      <label class="field-label" for="rvExamSel">Inspection on file</label>
      <select id="rvExamSel">
        <option value="" ${!r.inspection_id ? 'selected' : ''}>${matches.length ? 'Latest matching inspection' + (auto && exam ? ` (${esc(optLabel(exam))})` : '') : 'No inspection matched by name yet'}</option>
        ${matches.length ? `<optgroup label="Matched by property name">${matches.map(i => `<option value="${i.id}" ${r.inspection_id === i.id ? 'selected' : ''}>${esc(optLabel(i))}</option>`).join('')}</optgroup>` : ''}
        ${others.length ? `<optgroup label="Other inspections">${others.map(i => `<option value="${i.id}" ${r.inspection_id === i.id ? 'selected' : ''}>${esc(optLabel(i))}</option>`).join('')}</optgroup>` : ''}
      </select>
      ${!exam ? `<div class="rv-empty">No exam results yet. Once a tech submits a New Inspection with this property's name, the results show up here automatically.</div>` : `
      <div class="rv-overall">
        <div class="rv-big">${sc.p}<small> / ${TOTAL_POINTS} passed</small></div>
        <div>${rt ? `<span class="status-pill ${rt.cls}">${rt.label}</span>` : ''}
          <div class="rv-msg">${sc.pct != null ? Math.round(sc.pct * 100) + '% of rated items passed' : ''}${sc.complete ? '' : `. ${TOTAL_POINTS - sc.rated} of ${TOTAL_POINTS} not rated`}</div></div>
        <div class="rv-counts"><span class="status-pill caution">${sc.c} caution</span><span class="status-pill failed">${sc.f} failed</span>${sc.na ? `<span class="status-pill na">${sc.na} N/A</span>` : ''}</div>
      </div>
      ${attention.length ? `<div class="rv-attn"><p class="field-label">Needs attention</p><ul>${attention.map(a => `<li><span class="status-pill ${a.sev}">${RATING_LABELS[a.sev]}</span> ${esc(a.name)} <small>${esc(a.sec)}</small></li>`).join('')}</ul></div>` : ''}
      <div class="rv-secs">
        ${SECTIONS.map(s => {
          const items = exam[s.key] || [], rr = sc.per[s.key], sn = (exam.section_notes || {})[s.key];
          const n = items.length || SECTION_SIZE[s.key];
          const right = s.key === 'surrounding'
            ? `${rr.rated}/${n}<small>answered</small>`
            : `${rr.p} / ${n}<small>${[rr.c ? rr.c + ' caution' : '', rr.f ? rr.f + ' failed' : '', rr.na ? rr.na + ' N/A' : '', rr.rated < n ? (n - rr.rated) + ' unrated' : ''].filter(Boolean).join(', ') || 'All passed'}</small>`;
          return `<details class="rv-sec" data-key="${s.key}" ${openSecs.has(s.key) ? 'open' : ''}>
            <summary><span class="t">${s.title}<small>${s.scored ? n + ' points' : 'Not part of the 58 points'}</small></span>
              ${s.key !== 'surrounding' ? `<span class="rv-meter" aria-hidden="true"><i style="width:${rr.p / n * 100}%;background:var(--pass)"></i><i style="width:${rr.c / n * 100}%;background:var(--caution)"></i><i style="width:${rr.f / n * 100}%;background:var(--failed)"></i><i style="width:${rr.na / n * 100}%;background:var(--na)"></i></span>` : '<span></span>'}
              <span class="sc">${right}</span><span class="chev">›</span></summary>
            <div class="rv-items">
              ${items.map((it, i) => s.key === 'surrounding'
                ? `<div class="detail-row"><span class="drname">${i + 1}. ${esc(it.question)}</span><span class="drval">${it.answer ? (it.answer === 'yes' ? 'Yes' : 'No') : 'Not answered'}</span></div>`
                : `<div class="detail-row"><span class="drname">${i + 1}. ${esc(it.name)}</span><span class="drval">${it.value ? `<b class="rv-val">${esc(it.value)}</b>` : ''}${it.rating ? `<span class="status-pill ${it.rating === 'pass' ? 'ok' : it.rating}">${RATING_LABELS[it.rating]}</span>` : 'Not rated'}</span></div>`).join('')}
              ${sn ? `<p class="rv-note"><strong>Notes:</strong> ${esc(sn)}</p>` : ''}
            </div></details>`;
        }).join('')}
      </div>
      ${exam.notes ? `<p class="rv-note"><strong>Overall notes:</strong> ${esc(exam.notes)}</p>` : ''}
      <p style="margin:12px 0 0"><button type="button" class="rv-lnk" id="rvOpenExam">Open the full inspection in the Inspection Log</button></p>`}
    </div>

    <div class="card" id="rvPhotosCard">${photosInner()}</div>

    <div class="card">
      <h2>Summary</h2>
      <label class="field-label sr" for="rvSummary">Summary</label>
      <textarea id="rvSummary" data-f="summary" rows="4" placeholder="2–3 sentences on the pool's condition and what it needs">${esc(r.summary || '')}</textarea>
    </div>

    <div class="card">
      <h2>Service Pricing</h2>
      <div class="rv-price-wrap"><table class="rv-price">
        <thead><tr><th>Service / Charge</th><th>Unit</th><th>Proposed Price</th></tr></thead>
        <tbody>
          <tr><td>April–October pool service, 3 visits per week</td><td>Monthly</td><td><span class="rv-money">$<input type="text" inputmode="decimal" data-f="price_3x" aria-label="3 visits per week monthly price" value="${esc(r.price_3x ?? '')}" placeholder="0"></span></td></tr>
          <tr><td>November–March pool service, 2 visits per week</td><td>Monthly</td><td><span class="rv-money">$<input type="text" inputmode="decimal" data-f="price_2x" aria-label="2 visits per week monthly price" value="${esc(r.price_2x ?? '')}" placeholder="0"></span></td></tr>
        </tbody>
        <tfoot><tr><td>Yearly price</td><td>12 months</td><td id="rvYearly">${money(y)}</td></tr></tfoot>
      </table></div>
      <p class="rv-help">Yearly price is 7 months at the 3x/week price plus 5 months at the 2x/week price.</p>
    </div>

    <div class="card">
      <h2>Work Needed</h2>
      <div class="rv-needs">
        <div><label class="field-label" for="rvRepairs">Repairs needed</label><textarea id="rvRepairs" data-f="repairs" rows="4" placeholder="e.g. Replace cracked skimmer lid">${esc(r.repairs || '')}</textarea></div>
        <div><label class="field-label" for="rvReno">Renovations needed</label><textarea id="rvReno" data-f="renovations" rows="4" placeholder="e.g. Replaster within 12 months">${esc(r.renovations || '')}</textarea></div>
        <div><label class="field-label" for="rvMaint">Maintenance needed</label><textarea id="rvMaint" data-f="maintenance" rows="4" placeholder="e.g. Clean filter, trim vegetation at pad">${esc(r.maintenance || '')}</textarea></div>
      </div>
    </div>`;
  }
  function softRefresh() {
    const a = document.activeElement, d = $('rvDetail');
    if (a && d.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      const yEl = $('rvYearly'); if (yEl) yEl.textContent = money(yearly(review(sel)));
      return;
    }
    const y = window.scrollY; renderDetail(); window.scrollTo(0, y);
  }

  // ---------------------------------------------------------------- saving
  function queue(id, patch) {
    const cur = pending[id] || (pending[id] = {});
    Object.assign(cur, patch);
    setSync('Saving…');
    clearTimeout(timers[id]); timers[id] = setTimeout(() => flush(id), 650);
  }
  async function flush(id) {
    if (inflight[id]) await inflight[id];
    const patch = pending[id]; if (!patch) return;
    delete pending[id];
    const body = { property_id: id };
    for (const k of Object.keys(patch)) {
      let v = patch[k];
      if (k === 'price_3x' || k === 'price_2x') v = num(v);
      else if (typeof v === 'string') v = v.trim() === '' ? null : v;
      body[k] = v;
    }
    if (session && session.user) { body.updated_by = session.user.id; body.updated_by_email = session.user.email || null; }
    inflight[id] = (async () => {
      const { data, error } = await sb.from('pool_reviews').upsert(body, { onConflict: 'property_id' }).select().single();
      if (error) {
        pending[id] = { ...patch, ...(pending[id] || {}) };
        setSync('Couldn\'t save: ' + error.message + '. Retrying…');
        clearTimeout(timers[id]); timers[id] = setTimeout(() => flush(id), 3000);
      } else {
        reviews[id] = data;
        setSync(Object.keys(pending).length ? 'Saving…' : 'All changes saved.');
        if (sel === id) { const s = $('rvSaved'); if (s) s.textContent = `Last saved ${new Date(data.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${data.updated_by_email ? ' by ' + data.updated_by_email.split('@')[0] : ''}`; }
      }
    })();
    await inflight[id]; inflight[id] = null;
  }
  function changed(rerender) {
    renderStats(); renderList();
    if (rerender) { const y = window.scrollY; renderDetail(); window.scrollTo(0, y); }
  }
  function savePb() {
    const u = normUrl($('rvPbIn') && $('rvPbIn').value);
    if (!u) { const m = $('rvPbMsg'); if (m) { m.classList.add('err'); m.textContent = 'Enter a web link, like https://app.poolbrain.com/…'; } return; }
    queue(sel, { poolbrain_url: u }); pbEdit = false; changed(true);
  }

  // ---------------------------------------------------------------- photos
  function photosInner() {
    const p = props.find(x => x.id === sel); if (!p) return '';
    const { exam } = examFor(p);
    const mine = photosFor(sel), ups = uploads.filter(u => u.pid === sel), exPh = exam ? (examPhotos[exam.id] || []) : [];
    let html = `<h2>Photos <span class="count">${mine.length + exPh.length ? (mine.length + exPh.length) + ' photo' + (mine.length + exPh.length > 1 ? 's' : '') : ''}</span></h2>
      <div class="rv-drop" id="rvDrop">
        <div><b>Drop photos here</b></div>
        <div class="rv-drop-row"><span>or</span><button type="button" class="secondary rv-sm" id="rvPick">Choose photos</button>
          <label for="rvUpCat">File under</label><select id="rvUpCat">${PHOTO_CATS.map(c => `<option value="${c.key}" ${c.key === uploadCat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div class="rv-drop-row">Add as many as you like at once. You can change a photo's category after upload.</div>
        <input type="file" id="rvFileIn" multiple accept="image/*,.heic,.heif" hidden>
      </div>`;
    const all = [];  // for the lightbox
    for (const c of PHOTO_CATS) {
      const ps = mine.filter(x => (x.category_key || 'additional') === c.key), us = ups.filter(u => u.cat === c.key);
      if (!ps.length && !us.length) continue;
      html += `<div class="rv-pgroup"><p class="field-label">${esc(c.label)} (${ps.length})</p><div class="rv-pgrid">`;
      for (const ph of ps) {
        const idx = all.push({ url: urlFor(ph.storage_path), cap: ph.caption, cat: c.label }) - 1;
        html += `<figure class="rv-tile"><button type="button" class="rv-thumb" data-open="${idx}" aria-label="Open photo">${urlFor(ph.storage_path) ? `<img src="${esc(urlFor(ph.storage_path))}" alt="${esc(ph.caption || c.label)}" loading="lazy">` : '<span class="rv-ov">Loading…</span>'}</button>
          <div class="rv-meta"><input type="text" data-pcap="${ph.id}" value="${esc(ph.caption || '')}" placeholder="Add a caption" aria-label="Caption">
          <select data-pcat="${ph.id}" aria-label="Photo category">${PHOTO_CATS.map(cc => `<option value="${cc.key}" ${cc.key === (ph.category_key || 'additional') ? 'selected' : ''}>${esc(cc.label)}</option>`).join('')}</select>
          <div class="rv-acts">${confirmDel === ph.id ? `<button type="button" class="rv-lnk danger" data-pdel-yes="${ph.id}">Yes, delete</button><button type="button" class="rv-lnk" data-pdel-no="1">Keep</button>` : `<button type="button" class="rv-lnk" data-pdel="${ph.id}">Delete</button>`}</div></div></figure>`;
      }
      for (const u of us) {
        html += `<figure class="rv-tile"><div class="rv-thumb" style="cursor:default"><img src="${u.url}" alt=""><span class="rv-ov ${u.state === 'error' ? 'err' : ''}">${u.state === 'error' ? esc(u.msg) : u.state === 'uploading' ? 'Uploading…' : 'Waiting…'}</span></div>
          ${u.state === 'error' ? `<div class="rv-meta"><div class="rv-acts"><button type="button" class="rv-lnk" data-uretry="${u.key}">Try again</button><button type="button" class="rv-lnk" data-udismiss="${u.key}">Dismiss</button></div></div>` : ''}</figure>`;
      }
      html += '</div></div>';
    }
    if (exPh.length) {
      html += `<div class="rv-pgroup"><p class="field-label">From the inspection (${exPh.length})</p><div class="rv-pgrid">`;
      for (const ph of exPh) {
        const u = urlFor(ph.storage_path);
        const idx = all.push({ url: u, cap: ph.caption, cat: (ph.category || 'Inspection photo') }) - 1;
        html += `<figure class="rv-tile"><button type="button" class="rv-thumb" data-open="${idx}" aria-label="Open photo">${u ? `<img src="${esc(u)}" alt="${esc(ph.caption || ph.category || '')}" loading="lazy">` : '<span class="rv-ov">Loading…</span>'}</button>
          <div class="rv-meta rv-meta-ro">${esc(ph.caption || ph.category || '')}</div></figure>`;
      }
      html += '</div></div>';
    }
    lbList = all;
    return html;
  }
  let lbList = [];
  function renderPhotos(force) {
    const c = $('rvPhotosCard'); if (!c || !sel) return;
    const a = document.activeElement;
    if (!force && a && c.contains(a) && a.matches('input[data-pcap]')) return;
    c.innerHTML = photosInner();
    const need = photosFor(sel).map(r => r.storage_path).filter(pth => !urlFor(pth));
    if (need.length) signPaths(need).then(() => { if (sel) renderPhotos(); });
  }

  function looksImage(f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name); }
  function enqueue(files) {
    if (!sel) return;
    let skipped = 0;
    for (const f of files) {
      if (!looksImage(f)) { skipped++; continue; }
      uploads.push({ key: Math.random().toString(36).slice(2), pid: sel, cat: uploadCat, file: f, url: URL.createObjectURL(f), state: 'queued' });
    }
    renderPhotos(true);
    if (skipped) setSync(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped because ${skipped > 1 ? 'they aren\'t photos' : 'it isn\'t a photo'}.`);
    pump();
  }
  function pump() {
    while (activeUploads < 3) {
      const u = uploads.find(x => x.state === 'queued'); if (!u) break;
      activeUploads++; u.state = 'uploading';
      runUpload(u).finally(() => { activeUploads--; if (sel === u.pid) renderPhotos(); pump(); });
    }
    const left = uploads.filter(x => x.state === 'queued' || x.state === 'uploading').length;
    if (left) setSync(`Uploading ${left} photo${left > 1 ? 's' : ''}…`);
  }
  async function runUpload(u) {
    if (sel === u.pid) renderPhotos();
    try {
      if (/heic|heif/i.test(u.file.type + u.file.name)) {
        try { await createImageBitmap(u.file); } catch (e) { throw new Error('HEIC photo can\'t be read in this browser. Try Safari or export as JPEG.'); }
      }
      const prepared = await P.prepareImage(u.file);
      const path = `reviews/${u.pid}/${u.cat}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${P.safeName(prepared.name)}`;
      const up = await sb.storage.from(BUCKET).upload(path, prepared.blob, { contentType: prepared.type || 'image/jpeg', upsert: false, cacheControl: '3600' });
      if (up.error) throw up.error;
      const row = {
        property_id: u.pid, category_key: u.cat, file_name: prepared.name, storage_path: path,
        mime_type: prepared.type || null, size_bytes: prepared.blob.size,
        uploaded_by: session && session.user ? session.user.id : null,
        uploaded_by_email: session && session.user ? session.user.email : null,
      };
      const ins = await sb.from('pool_review_photos').insert(row).select().single();
      if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
      rphotos[ins.data.id] = ins.data;
      signed[path] = { url: u.url, exp: Date.now() + 3600 * 1000 };   // show the local copy until the page reloads
      uploads.splice(uploads.indexOf(u), 1);
      if (!uploads.some(x => x.state !== 'error')) setSync('All changes saved.');
      renderList();
    } catch (e) {
      u.state = 'error';
      u.msg = /HEIC/.test(e.message || '') ? e.message : /exceed|too large|size/i.test(e.message || '') ? 'Photo is too large.' : 'Upload failed. Try again.';
    }
  }
  async function deletePhoto(id) {
    confirmDel = null;
    const row = rphotos[id]; if (!row) return;
    const rm = await sb.storage.from(BUCKET).remove([row.storage_path]);
    const del = await sb.from('pool_review_photos').delete().eq('id', id);
    if (rm.error || del.error) setSync('Couldn\'t delete the photo: ' + ((rm.error || del.error).message));
    else { delete rphotos[id]; setSync('Photo deleted.'); }
    renderPhotos(true); renderList();
  }

  // lightbox
  function openLb(i) { lb = i; showLb(); $('rvLb').classList.remove('hidden'); $('rvLbClose').focus(); }
  function showLb() {
    if (!lbList.length) { closeLb(); return; }
    lb = (lb + lbList.length) % lbList.length; const ph = lbList[lb];
    $('rvLbImg').src = ph.url; $('rvLbImg').alt = ph.cap || ph.cat;
    $('rvLbCap').innerHTML = `${esc(ph.cap || ph.cat)}<small>${esc(ph.cat)}, ${lb + 1} of ${lbList.length}</small>`;
    $('rvLbPrev').classList.toggle('hidden', lbList.length < 2); $('rvLbNext').classList.toggle('hidden', lbList.length < 2);
  }
  function closeLb() { $('rvLb').classList.add('hidden'); lb = null; }

  // ---------------------------------------------------------------- CSV
  function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportCsv() {
    const chemNames = P.chemistry.filter(c => c.hasValue).map(c => c.name);
    const head = ['Property', 'Client', 'Region', 'City', 'Address', 'Manager', 'Phone', 'Poolbrain', 'Inspection result', 'Category',
      'Exam date', 'Exam passed', 'Of', 'Caution', 'Failed', 'N/A', 'Rating', 'Summary',
      '3x/week monthly (Apr-Oct)', '2x/week monthly (Nov-Mar)', 'Yearly', 'Repairs', 'Renovations', 'Maintenance', 'Review photos', ...chemNames];
    const rows = [head];
    for (const p of props) {
      const r = review(p.id), { exam } = examFor(p), sc = examScore(exam), rt = rating(sc);
      const chem = chemNames.map(n => { const it = exam && (exam.chemistry || []).find(x => x.name === n); return it && it.value || ''; });
      rows.push([p.name, p.client, p.region, p.city, p.address, p.manager, p.phone, r.poolbrain_url || '', resLabel(r.inspection_result),
        r.category ?? '', exam ? (exam.inspection_date || '') : '', exam ? sc.p : '', TOTAL_POINTS, exam ? sc.c : '', exam ? sc.f : '', exam ? sc.na : '',
        rt ? rt.label : '', r.summary || '', num(r.price_3x) ?? '', num(r.price_2x) ?? '', yearly(r) ?? '',
        r.repairs || '', r.renovations || '', r.maintenance || '', photoCount(p.id), ...chem]);
    }
    const blob = new Blob(['\ufeff' + rows.map(x => x.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'poolie-pool-review-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function renderAll() { renderStats(); renderList(); if (sel) renderDetail(); }

  // ---------------------------------------------------------------- events
  $('tabReview').addEventListener('click', () => {
    P.showTab('Review');
    if (!loaded) load();
  });
  $('rvRefresh').addEventListener('click', () => { loaded = false; Object.keys(examPhotos).forEach(k => delete examPhotos[k]); load().then(() => { if (sel) loadDetailPhotos(); }); });
  $('rvExport').addEventListener('click', () => { if (loaded) exportCsv(); });
  $('rvSearch').addEventListener('input', e => { ui.q = e.target.value; renderList(); });
  $('rvRegion').addEventListener('change', e => { ui.region = e.target.value; renderList(); });
  $('rvCatF').addEventListener('change', e => { ui.cat = e.target.value; renderList(); });
  $('rvResF').addEventListener('change', e => { ui.res = e.target.value; renderList(); });
  $('rvSort').addEventListener('change', e => { ui.sort = e.target.value; renderList(); });
  $('rvList').addEventListener('click', e => { const r = e.target.closest('.rv-entry'); if (r) openDetail(r.dataset.id); });
  $('rvList').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const r = e.target.closest('.rv-entry'); if (r) { e.preventDefault(); openDetail(r.dataset.id); } } });

  const D = $('rvDetail');
  D.addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'rvBack') { closeDetail(); return; }
    if (t.id === 'rvPbEdit') { pbEdit = true; pbDraft = review(sel).poolbrain_url || ''; renderDetail(); const i = $('rvPbIn'); if (i) i.focus(); return; }
    if (t.id === 'rvPbCancel') { pbEdit = false; renderDetail(); return; }
    if (t.id === 'rvPbRemove') { queue(sel, { poolbrain_url: '' }); pbEdit = false; changed(true); return; }
    if (t.id === 'rvPbSave') { savePb(); return; }
    if (t.id === 'rvOpenExam') { const { exam } = examFor(props.find(x => x.id === sel)); if (exam) P.openInspection(exam.id); return; }
    const cb = t.closest('[data-cat]');
    if (cb) { const v = Number(cb.dataset.cat); queue(sel, { category: review(sel).category === v ? null : v }); changed(true); return; }
    const rb = t.closest('[data-res]');
    if (rb) { const v = rb.dataset.res; queue(sel, { inspection_result: review(sel).inspection_result === v ? null : v }); changed(true); return; }
    // photos
    if (t.id === 'rvPick') { const f = $('rvFileIn'); if (f) f.click(); return; }
    const o = t.closest('[data-open]'); if (o) { openLb(Number(o.dataset.open)); return; }
    if (t.dataset.pdel) { confirmDel = t.dataset.pdel; renderPhotos(true); return; }
    if (t.dataset.pdelNo) { confirmDel = null; renderPhotos(true); return; }
    if (t.dataset.pdelYes) { deletePhoto(t.dataset.pdelYes); return; }
    if (t.dataset.uretry) { const u = uploads.find(x => x.key === t.dataset.uretry); if (u) { u.state = 'queued'; pump(); renderPhotos(true); } return; }
    if (t.dataset.udismiss) { const i = uploads.findIndex(x => x.key === t.dataset.udismiss); if (i >= 0) { URL.revokeObjectURL(uploads[i].url); uploads.splice(i, 1); } renderPhotos(true); return; }
  });
  D.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'rvPbIn') { pbDraft = t.value; return; }
    if (t.dataset.f) {
      queue(sel, { [t.dataset.f]: t.value });
      if (t.dataset.f === 'price_3x' || t.dataset.f === 'price_2x') $('rvYearly').textContent = money(yearly(review(sel)));
      renderStats(); renderList(); return;
    }
    if (t.dataset.pcap) {
      const id = t.dataset.pcap, v = t.value; rphotos[id] = { ...rphotos[id], caption: v };
      clearTimeout(timers['cap' + id]); timers['cap' + id] = setTimeout(async () => {
        const { error } = await sb.from('pool_review_photos').update({ caption: v.trim() || null }).eq('id', id);
        setSync(error ? 'Couldn\'t save the caption.' : 'All changes saved.');
      }, 600);
    }
  });
  D.addEventListener('change', async e => {
    const t = e.target;
    if (t.id === 'rvFileIn') { enqueue([...t.files]); t.value = ''; return; }
    if (t.id === 'rvUpCat') { uploadCat = t.value; return; }
    if (t.id === 'rvExamSel') {
      queue(sel, { inspection_id: t.value || null }); await flush(sel);
      changed(true); loadDetailPhotos(); return;
    }
    if (t.dataset.pcat) {
      const id = t.dataset.pcat; rphotos[id] = { ...rphotos[id], category_key: t.value };
      const { error } = await sb.from('pool_review_photos').update({ category_key: t.value }).eq('id', id);
      if (error) setSync('Couldn\'t save the photo category.');
      renderPhotos(true);
    }
  });
  D.addEventListener('keydown', e => {
    if (e.target.id !== 'rvPbIn') return;
    if (e.key === 'Enter') { e.preventDefault(); savePb(); }
    else if (e.key === 'Escape') { pbEdit = false; renderDetail(); }
  });
  let dragDepth = 0;
  const inPhotos = e => e.target.closest && e.target.closest('#rvPhotosCard');
  D.addEventListener('dragenter', e => { if (!inPhotos(e)) return; e.preventDefault(); dragDepth++; const d = $('rvDrop'); if (d) d.classList.add('over'); });
  D.addEventListener('dragleave', e => { if (!inPhotos(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { const d = $('rvDrop'); if (d) d.classList.remove('over'); } });
  D.addEventListener('dragover', e => { if (inPhotos(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  D.addEventListener('drop', e => {
    if (!inPhotos(e)) return;
    e.preventDefault(); dragDepth = 0; const d = $('rvDrop'); if (d) d.classList.remove('over');
    enqueue([...((e.dataTransfer && e.dataTransfer.files) || [])]);
  });
  // a stray drop anywhere else shouldn't navigate the tab away to the image
  window.addEventListener('dragover', e => { if (!$('viewReview').classList.contains('hidden')) e.preventDefault(); });
  window.addEventListener('drop', e => { if (!$('viewReview').classList.contains('hidden')) e.preventDefault(); });

  $('rvLbClose').addEventListener('click', closeLb);
  $('rvLbPrev').addEventListener('click', () => { lb--; showLb(); });
  $('rvLbNext').addEventListener('click', () => { lb++; showLb(); });
  $('rvLb').addEventListener('click', e => { if (e.target.id === 'rvLb') closeLb(); });
  document.addEventListener('keydown', e => {
    if (lb == null) return;
    if (e.key === 'Escape') closeLb(); else if (e.key === 'ArrowLeft') { lb--; showLb(); } else if (e.key === 'ArrowRight') { lb++; showLb(); }
  });

  // a new inspection submitted from this device: refresh exam matches next time the tab opens
  window.addEventListener('poolie:inspection-saved', () => { if (loaded) { loaded = false; } });
  window.addEventListener('poolie:signed-out', () => {
    loaded = false; sel = null; props = []; reviews = {}; inspections = []; rphotos = {};
    if (channel) { sb.removeChannel(channel); channel = null; }
  });
})();
