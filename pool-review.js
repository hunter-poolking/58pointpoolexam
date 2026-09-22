// Poolie — Pool Review tab.
// Reviews a client's property list side by side: 58-point exam results, category, inspection
// result, Poolbrain link, pricing, needed work and photos. Exam results fill in from the matching
// submitted inspection; anything changed here is saved to the review only (the inspection is
// never modified). Several staff can edit at once; changes save automatically and show up live.
(function () {
  "use strict";
  const P = window.POOLIE;
  if (!P) { console.error('Pool Review: window.POOLIE missing — load pool-review.js after the main script.'); return; }
  const { sb, BUCKET, $, escapeHtml: esc } = P;

  // ---------------------------------------------------------------- constants
  const itemName = it => typeof it === 'string' ? it : it.name;
  const SECTIONS = [
    { key: 'chemistry',   title: 'Pool water chemistry',                scored: true,  items: P.chemistry.map(itemName) },
    { key: 'surface',     title: 'Pool surface & decking',              scored: true,  items: P.surface.slice() },
    { key: 'equipment',   title: 'Pool equipment inspection',           scored: true,  items: P.equipment.slice() },
    { key: 'safety',      title: 'Safety & general inspection',         scored: true,  items: P.safety.slice() },
    { key: 'commercial',  title: 'Commercial signs & safety equipment', scored: true,  items: P.commercial.slice() },
    { key: 'surrounding', title: 'Surrounding pool area',               scored: false, items: P.surrounding.slice(), yesno: true },
  ];
  const TOTAL_POINTS = SECTIONS.filter(s => s.scored).reduce((a, s) => a + s.items.length, 0);
  const CHEM_READING = P.chemistry.map(c => !!c.hasValue);
  const CHEM_UNITS = { 'Chlorine': 'ppm', 'pH': '', 'Alkalinity': 'ppm', 'Cyanuric Acid (CYA)': 'ppm', 'Calcium': 'ppm', 'Salt': 'ppm', 'Phosphates': 'ppb', 'TDS': 'ppm' };
  const ST_LABEL = { pass: 'Pass', caution: 'Caution', failed: 'Failed', na: 'N/A', yes: 'Yes', no: 'No' };
  const CAT_LABELS = ['Needs major work', 'Significant repairs', 'Several repairs', 'Minor repairs', 'Nearly ready', 'Good for service'];
  const RESULTS = [['fail', 'Fail'], ['at_risk', 'At risk'], ['pass', 'Pass']];
  const resLabel = k => (RESULTS.find(r => r[0] === k) || [])[1] || '';
  const PHOTO_CATS = P.PHOTO_CATEGORIES.map(c => ({ key: c.key, label: c.label.replace(/ \(.*\)$/, '').replace(/ detailed photos$/, '') }));
  const SUMMER_MONTHS = 7, WINTER_MONTHS = 5;
  const CLIENT_NOTES = { 'NRP Group': 'Bid due October 2, 2026.' };
  const JSON_FIELDS = ['exam', 'chem_readings', 'exam_notes'];

  // ---------------------------------------------------------------- state
  let loaded = false, loading = null, channel = null, session = null;
  let props = [], reviews = {}, inspections = [], rphotos = {};
  const pending = {}, timers = {}, inflight = {};
  const signed = {}, examPhotos = {}, uploads = [];
  let sel = null, pbEdit = false, pbDraft = '', confirmDel = null, lb = null, lbList = [];
  let uploadCat = 'equipment_pad', activeUploads = 0;
  const ui = { region: '', q: '', cat: '', res: '', sort: 'order' };

  // ---------------------------------------------------------------- helpers
  const num = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
  const money = n => n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const norm = s => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/\bapartments?\b|\bapts?\b/g, '').replace(/[^a-z0-9]/g, '');
  const catColor = c => c == null ? 'var(--pr-line)' : `var(--pr-c${c})`;
  function normUrl(u) {
    u = String(u || '').trim(); if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; }
  }
  const setSync = t => { const el = $('prSync'); if (el) el.textContent = t; };
  const fmtSaved = r => r && r.updated_at ? `Last saved ${new Date(r.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${r.updated_by_email ? ' by ' + esc(r.updated_by_email.split('@')[0]) : ''}` : '';

  function review(id) {
    const d = reviews[id] || {}, p = pending[id] || {};
    const out = { ...d, ...p };
    for (const k of JSON_FIELDS) out[k] = { ...(d[k] || {}), ...(p[k] || {}) };
    return out;
  }
  function yearly(r) {
    const a = num(r.price_3x), b = num(r.price_2x);
    if (a == null && b == null) return null;
    return (a || 0) * SUMMER_MONTHS + (b || 0) * WINTER_MONTHS;
  }

  // ---------------------------------------------------------------- inspection matching
  function matchedInspections(p) {
    const n = norm(p.name);
    const hit = s => { const a = norm(s); return a && (a === n || (a.length > 5 && n.length > 5 && (a.includes(n) || n.includes(a)))); };
    return inspections.filter(i => hit(i.property) || hit(i.customer));
  }
  function inspFor(p) {
    const r = review(p.id);
    if (r.inspection_id) return { insp: inspections.find(i => i.id === r.inspection_id) || null, auto: false };
    return { insp: matchedInspections(p)[0] || null, auto: true };
  }
  // the exam as shown: each section from the review if edited there, otherwise from the inspection
  function examView(p) {
    const r = review(p.id), { insp, auto } = inspFor(p);
    const ex = {}, overridden = {};
    for (const s of SECTIONS) {
      const own = r.exam && Array.isArray(r.exam[s.key]) ? r.exam[s.key] : null;
      let from = [];
      if (insp) from = s.yesno ? (insp.surrounding || []).map(q => q.answer || '') : (insp[s.key] || []).map(i => i.rating || '');
      ex[s.key] = Array.from({ length: s.items.length }, (_, i) => (own ? own[i] : from[i]) || '');
      overridden[s.key] = !!own;
    }
    const readings = {};
    if (insp) (insp.chemistry || []).forEach((c, i) => { if (c.value) readings[i] = c.value; });
    Object.assign(readings, r.chem_readings || {});
    const notes = {};
    if (insp) { Object.assign(notes, insp.section_notes || {}); if (insp.notes) notes.general = insp.notes; }
    for (const k in (r.exam_notes || {})) notes[k] = r.exam_notes[k];
    return {
      ex, overridden, readings, notes, insp, auto,
      date: r.exam_date || (insp && insp.inspection_date) || '',
      tech: r.exam_tech || (insp && insp.technician) || '',
      size: r.pool_size || (insp && insp.pool_size) || '',
      anyOwn: Object.values(overridden).some(Boolean) || Object.keys(r.chem_readings || {}).length > 0 || Object.keys(r.exam_notes || {}).length > 0,
    };
  }
  function secScore(arr, s) {
    const c = { p: 0, c: 0, f: 0, na: 0, yes: 0, no: 0, rated: 0, n: s.items.length };
    arr.forEach(v => { if (v === 'pass') c.p++; else if (v === 'caution') c.c++; else if (v === 'failed') c.f++; else if (v === 'na') c.na++; else if (v === 'yes') c.yes++; else if (v === 'no') c.no++; if (v) c.rated++; });
    return c;
  }
  function examScore(v) {
    const out = { p: 0, c: 0, f: 0, na: 0, rated: 0, per: {} };
    for (const s of SECTIONS) {
      const r = secScore(v.ex[s.key], s); out.per[s.key] = r;
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
    if (pct >= 90) return { label: 'Excellent', cls: 'pass' };
    if (pct >= 75) return { label: 'Good', cls: 'pass' };
    if (pct >= 60) return { label: 'Fair', cls: 'caution' };
    return { label: 'Poor', cls: 'fail' };
  }

  const photosFor = pid => Object.values(rphotos).filter(r => r.property_id === pid)
    .sort((a, b) => (PHOTO_CATS.findIndex(c => c.key === a.category_key) - PHOTO_CATS.findIndex(c => c.key === b.category_key)) || String(a.created_at).localeCompare(String(b.created_at)));
  const photoCount = pid => { let n = 0; for (const k in rphotos) if (rphotos[k].property_id === pid) n++; return n; };
  async function signPaths(paths) {
    const now = Date.now();
    const need = [...new Set(paths)].filter(p => p && !(signed[p] && signed[p].exp > now + 60000));
    for (let i = 0; i < need.length; i += 100) {
      const { data } = await sb.storage.from(BUCKET).createSignedUrls(need.slice(i, i + 100), 3600);
      (data || []).forEach(s => { if (s.path && s.signedUrl) signed[s.path] = { url: s.signedUrl, exp: now + 3600 * 1000 }; });
    }
  }
  const urlFor = path => (signed[path] && signed[path].url) || '';

  // ---------------------------------------------------------------- load + live updates
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      setSync('Loading…');
      $('prList').innerHTML = '<div class="pr-empty-list">Loading…</div>';
      const s = await sb.auth.getSession(); session = s.data && s.data.session;
      const [pr, rv, ph, ins] = await Promise.all([
        sb.from('pool_review_properties').select('*').order('sort_order', { ascending: true }),
        sb.from('pool_reviews').select('*'),
        sb.from('pool_review_photos').select('*'),
        sb.from('inspections').select('id,created_at,inspection_date,technician,customer,property,address,city,dimensions,pool_size,notes,section_notes,chemistry,surface,equipment,safety,commercial,surrounding,photo_count')
          .order('inspection_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(1000),
      ]);
      const err = pr.error || rv.error || ph.error || ins.error;
      if (err) {
        const missing = /does not exist|could not find/i.test(err.message || '');
        $('prList').innerHTML = `<div class="pr-empty-list">${missing ? 'The Pool Review tables aren\'t set up yet. Run <code>supabase/pool_review.sql</code> in the Supabase SQL editor, then refresh.' : 'Could not load the review: ' + esc(err.message)}</div>`;
        setSync(''); loading = null; return;
      }
      props = pr.data || [];
      reviews = {}; (rv.data || []).forEach(r => { reviews[r.property_id] = r; });
      rphotos = {}; (ph.data || []).forEach(r => { rphotos[r.id] = r; });
      inspections = ins.data || [];
      loaded = true; loading = null;
      const clients = [...new Set(props.map(p => p.client).filter(Boolean))];
      $('prTitle').textContent = clients.length === 1 ? `${clients[0]} pool review` : 'Pool review';
      $('prSub').textContent = '58-point exam results, service pricing and needed work.' + (clients.length === 1 && CLIENT_NOTES[clients[0]] ? ' ' + CLIENT_NOTES[clients[0]] : '');
      const regions = [...new Set(props.map(p => p.region).filter(Boolean))];
      $('prRegions').innerHTML = ['', ...regions].map(r => `<button type="button" data-r="${esc(r)}" aria-pressed="${ui.region === r}">${esc(r || 'All')}</button>`).join('');
      subscribe();
      setSync('Changes save automatically for everyone.');
      renderStats(); renderList(); renderDetail();
    })();
    return loading;
  }
  function subscribe() {
    if (channel) return;
    channel = sb.channel('pool-review')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pool_reviews' }, payload => {
        if (payload.eventType === 'DELETE') delete reviews[payload.old.property_id];
        else reviews[payload.new.property_id] = payload.new;
        renderStats(); renderList(); if (sel === (payload.new || payload.old).property_id) softRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pool_review_photos' }, payload => {
        if (payload.eventType === 'DELETE') delete rphotos[payload.old.id]; else rphotos[payload.new.id] = payload.new;
        renderList(); renderPhotos();
      })
      .subscribe();
  }

  // ---------------------------------------------------------------- header + list
  function renderStats() {
    let inspected = 0, priced = 0, total = 0, cats = 0;
    for (const p of props) {
      const r = review(p.id); if (examScore(examView(p)).rated > 0) inspected++;
      const y = yearly(r); if (y != null) { priced++; total += y; }
      if (r.category != null) cats++;
    }
    $('prStats').innerHTML = [[props.length, 'properties'], [inspected, 'inspected'], [cats, 'categorized'], [priced, 'priced'], [money(total), 'total yearly']]
      .map(([b, s]) => `<div class="pr-stat"><b>${b}</b><span>${s}</span></div>`).join('');
  }
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    let rows = props.map((p, i) => ({ p, i, r: review(p.id) }));
    rows = rows.filter(({ p, r }) => {
      if (ui.region && p.region !== ui.region) return false;
      if (q && !`${p.name} ${p.city} ${p.manager} ${p.address}`.toLowerCase().includes(q)) return false;
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
      score: x => { const s = examScore(examView(x.p)).pct; return s == null ? big : s; },
      year: x => { const y = yearly(x.r); return y == null ? big : -y; },
    }[ui.sort];
    rows.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : a.i - b.i; });
    return rows;
  }
  function renderList() {
    if (!loaded) return;
    const rows = filtered(), el = $('prList');
    if (!rows.length) { el.innerHTML = '<div class="pr-empty-list">No properties match these filters.</div>'; return; }
    const grouped = ui.sort === 'order';
    let html = '', last = null;
    for (const { p, r } of rows) {
      if (grouped && p.region !== last) {
        last = p.region;
        html += `<div class="pr-group-h"><span>${esc(last || 'Other')}</span><span>${rows.filter(x => x.p.region === last).length}</span></div>`;
      }
      const sc = examScore(examView(p)), y = yearly(r), n = photoCount(p.id);
      html += `<button type="button" class="pr-row" data-id="${esc(p.id)}" aria-current="${sel === p.id}">
        <span class="pr-strip" style="background:${catColor(r.category)}"></span>
        <span><span class="pr-nm">${esc(p.name)}</span><span class="pr-sub">${r.inspection_result ? `<span class="pr-rtag ${r.inspection_result}">${resLabel(r.inspection_result)}</span>, ` : ''}${esc(p.city || '')}${r.category != null ? `, category ${r.category}` : ''}${n ? `, ${n} photo${n > 1 ? 's' : ''}` : ''}</span></span>
        <span class="pr-rt"><b>${sc.rated ? `${sc.p}/${TOTAL_POINTS}` : 'No exam'}</b>${y != null ? money(y) + '/yr' : 'Not priced'}</span>
      </button>`;
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- detail
  const EXT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';
  function statusBtns(s, i, v) {
    const opts = s.yesno ? ['yes', 'no'] : ['pass', 'caution', 'failed', 'na'];
    return `<span class="pr-st" role="group" aria-label="Result">${opts.map(k => `<button type="button" data-sec="${s.key}" data-i="${i}" data-v="${k}" aria-pressed="${v === k}">${ST_LABEL[k]}</button>`).join('')}</span>`;
  }
  function meter(r) {
    const t = r.n || 1;
    return `<div class="pr-meter" aria-hidden="true"><i style="width:${r.p / t * 100}%;background:var(--pr-pass)"></i><i style="width:${r.c / t * 100}%;background:var(--pr-caution)"></i><i style="width:${r.f / t * 100}%;background:var(--pr-fail)"></i><i style="width:${r.na / t * 100}%;background:var(--pr-na)"></i></div>`;
  }

  function renderDetail() {
    $('viewReview').classList.toggle('pr-has-sel', !!sel);
    const el = $('prDetail');
    if (!sel) { el.innerHTML = `<div class="pr-card"><h3>Pick a property</h3><p class="pr-msg">Choose a property on the left to see its exam results, set a category, and enter pricing and needed work.</p></div>`; return; }
    const p = props.find(x => x.id === sel); if (!p) { sel = null; renderDetail(); return; }
    const r = review(p.id), v = examView(p), sc = examScore(v), rt = rating(sc), y = yearly(r);
    const openSecs = new Set([...el.querySelectorAll('details.pr-sec[open]')].map(x => x.dataset.key));
    const matches = matchedInspections(p), others = inspections.filter(i => !matches.includes(i));
    const optLabel = i => `${i.property || i.customer || 'Unnamed'}, ${i.inspection_date || new Date(i.created_at).toLocaleDateString()}, ${i.technician || 'unknown tech'}`;

    el.innerHTML = `
    <button type="button" class="pr-btn pr-back" id="prBack">All properties</button>
    <div class="pr-card">
      <div class="pr-ph">
        <div>
          <div class="pr-title-row"><h2>${esc(p.name)}</h2>${
            r.poolbrain_url && !pbEdit ? `<a class="pr-pb" href="${esc(r.poolbrain_url)}" target="_blank" rel="noopener">${EXT}Poolbrain</a><button type="button" class="pr-lnk" id="prPbEdit">Edit link</button>`
            : (!pbEdit ? `<button type="button" class="pr-pb add" id="prPbEdit">+ Add Poolbrain link</button>` : '')}</div>
          <div class="pr-addr">${esc(p.address || '')}</div>
          ${pbEdit ? `<div class="pr-pb-edit"><label class="pr-sr" for="prPbIn">Poolbrain link</label><input class="pr-in" id="prPbIn" type="url" value="${esc(pbDraft)}" placeholder="Paste the Poolbrain link for this property">
            <button type="button" class="pr-btn primary" id="prPbSave">Save link</button><button type="button" class="pr-btn" id="prPbCancel">Cancel</button>${r.poolbrain_url ? '<button type="button" class="pr-lnk danger" id="prPbRemove">Remove</button>' : ''}<span class="pr-msg" id="prPbMsg"></span></div>` : ''}
        </div>
        <div class="pr-saved" id="prSaved">${fmtSaved(r)}</div>
      </div>
      <div class="pr-facts">
        <div><span>Property manager</span>${esc(p.manager || '—')}</div>
        <div><span>Phone</span>${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^0-9]/g, ''))}">${esc(p.phone)}</a>` : '—'}</div>
        <div><span>Exam days</span>${esc(p.exam_days || '—')}</div>
        <div><span>Techs</span>${esc(p.techs || '—')}</div>
        <div><span>Website</span>${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : 'Not on file'}</div>
      </div>
    </div>

    <div class="pr-card">
      <h3>Category</h3>
      <div class="pr-cat" role="group" aria-label="Category">
        ${CAT_LABELS.map((l, i) => `<button type="button" data-cat="${i}" aria-pressed="${r.category === i}"><i style="background:var(--pr-c${i})"></i><b>${i}</b>${l}</button>`).join('')}
      </div>
      <div class="pr-help">0 means the pool needs major work before service. 5 means it's good for service as is.${r.category != null ? ' <button type="button" class="pr-btn pr-xs" id="prClearCat">Clear</button>' : ''}</div>
      <h3 class="pr-sub-h">Inspection result</h3>
      <div class="pr-res" role="group" aria-label="Inspection result">
        ${RESULTS.map(([k, l]) => `<button type="button" data-res="${k}" aria-pressed="${r.inspection_result === k}"><i></i>${l}</button>`).join('')}
      </div>
    </div>

    <div class="pr-card">
      <h3>58-point exam</h3>
      ${sc.rated === 0 ? `<div class="pr-not-yet">No exam results yet. Results from a submitted inspection with this property's name fill in here automatically, or mark items below as the exam is reviewed.</div>` : `
      <div class="pr-overall">
        <div class="pr-big">${sc.p}<small> / ${TOTAL_POINTS} passed</small></div>
        <div>${rt ? `<span class="pr-pill ${rt.cls}">${rt.label}</span>` : ''} <span class="pr-msg">${sc.pct != null ? Math.round(sc.pct * 100) + '% of rated items passed' : ''}${sc.complete ? '' : `. ${TOTAL_POINTS - sc.rated} of ${TOTAL_POINTS} not rated yet`}</span></div>
        <div class="pr-counts"><span class="pr-pill caution">${sc.c} caution</span><span class="pr-pill fail">${sc.f} failed</span>${sc.na ? `<span class="pr-pill na">${sc.na} N/A</span>` : ''}</div>
      </div>`}
      <div class="pr-source">
        <label class="pr-f" for="prExamSel">Inspection on file</label>
        <select class="pr-in" id="prExamSel">
          <option value="" ${!r.inspection_id ? 'selected' : ''}>${matches.length ? 'Latest matching inspection' + (v.auto && v.insp ? ` (${esc(optLabel(v.insp))})` : '') : 'None matched by name yet'}</option>
          ${matches.length ? `<optgroup label="Matched by property name">${matches.map(i => `<option value="${i.id}" ${r.inspection_id === i.id ? 'selected' : ''}>${esc(optLabel(i))}</option>`).join('')}</optgroup>` : ''}
          ${others.length ? `<optgroup label="Other inspections">${others.map(i => `<option value="${i.id}" ${r.inspection_id === i.id ? 'selected' : ''}>${esc(optLabel(i))}</option>`).join('')}</optgroup>` : ''}
        </select>
        <div class="pr-msg">${v.insp ? `Results below start from this inspection. Changes you make here are saved to the review only.${v.anyOwn ? ' <button type="button" class="pr-lnk" id="prResetExam">Reset to inspection results</button>' : ''} <button type="button" class="pr-lnk" id="prOpenExam">Open inspection</button>` : 'Mark items below, or submit a New Inspection with this property\'s name.'}</div>
      </div>
      <div class="pr-exam-meta">
        <div><label class="pr-f" for="prExamDate">Exam date</label><input class="pr-in" id="prExamDate" data-f="exam_date" type="date" value="${esc(v.date)}"></div>
        <div><label class="pr-f" for="prExamTech">Technician</label><input class="pr-in" id="prExamTech" data-f="exam_tech" value="${esc(v.tech)}" placeholder="${esc(p.techs || '')}"></div>
        <div><label class="pr-f" for="prPoolSize">Pool size</label><input class="pr-in" id="prPoolSize" data-f="pool_size" value="${esc(v.size)}" placeholder="e.g. 45,000 gal"></div>
      </div>
      <div class="pr-sections">
        ${SECTIONS.map(s => {
          const rr = sc.per[s.key], arr = v.ex[s.key], n = s.items.length;
          const scoreTxt = s.yesno ? `${rr.rated} / ${n}` : (rr.rated ? `${rr.p} / ${n}` : `— / ${n}`);
          const subTxt = s.yesno ? (rr.rated ? `${rr.yes} yes, ${rr.no} no` : 'Not answered')
            : rr.rated ? [rr.c ? `${rr.c} caution` : '', rr.f ? `${rr.f} failed` : '', rr.na ? `${rr.na} N/A` : '', rr.rated < n ? `${n - rr.rated} unrated` : ''].filter(Boolean).join(', ') || 'All passed' : 'Not rated';
          return `<details class="pr-sec" data-key="${s.key}" ${openSecs.has(s.key) ? 'open' : ''}>
            <summary><span class="t">${esc(s.title)}<small>${s.scored ? `${n} points` : 'Not part of the 58 points'}</small></span>
              <span class="mt">${s.yesno ? '' : meter(rr)}</span>
              <span class="sc">${scoreTxt}<small>${subTxt}</small></span><span class="chev">›</span></summary>
            <div class="pr-items">
              ${s.items.map((it, i) => {
                const rd = s.key === 'chemistry' && CHEM_READING[i];
                return `<div class="pr-item${rd ? ' has-rd' : ''}"><span>${i + 1}. ${esc(it)}</span>${rd ? `<span class="pr-rd"><input class="pr-in" inputmode="decimal" data-reading="${i}" value="${esc(v.readings[i] ?? '')}" placeholder="—" aria-label="${esc(it)} reading"><small>${CHEM_UNITS[it] || ''}</small></span>` : ''}${statusBtns(s, i, arr[i])}</div>`;
              }).join('')}
              <label class="pr-sr" for="prSn-${s.key}">${esc(s.title)} notes</label>
              <textarea class="pr-in" id="prSn-${s.key}" data-note="${s.key}" placeholder="${esc(s.title)} notes">${esc(v.notes[s.key] || '')}</textarea>
            </div></details>`;
        }).join('')}
      </div>
      <div style="margin-top:14px"><label class="pr-f" for="prSnGeneral">Overall / general notes from the exam</label>
        <textarea class="pr-in" id="prSnGeneral" data-note="general" placeholder="Additional notes, recommendations or follow-up items">${esc(v.notes.general || '')}</textarea></div>
    </div>

    <div class="pr-card" id="prPhotosCard">${photosInner()}</div>

    <div class="pr-card">
      <h3>Summary</h3>
      <label class="pr-sr" for="prSummary">Summary</label>
      <textarea class="pr-in" id="prSummary" data-f="summary" placeholder="2–3 sentences on the pool's condition and what it needs">${esc(r.summary || '')}</textarea>
    </div>

    <div class="pr-card">
      <h3>Service pricing</h3>
      <div class="pr-price-wrap"><table class="pr-price">
        <thead><tr><th>Service / charge</th><th>Unit</th><th>Proposed price</th></tr></thead>
        <tbody>
          <tr><td>April–October pool service, 3 visits per week</td><td>Monthly</td><td><span class="pr-money">$<input class="pr-in" inputmode="decimal" data-f="price_3x" aria-label="3 visits per week monthly price" value="${esc(r.price_3x ?? '')}" placeholder="0"></span></td></tr>
          <tr><td>November–March pool service, 2 visits per week</td><td>Monthly</td><td><span class="pr-money">$<input class="pr-in" inputmode="decimal" data-f="price_2x" aria-label="2 visits per week monthly price" value="${esc(r.price_2x ?? '')}" placeholder="0"></span></td></tr>
        </tbody>
        <tfoot><tr><td>Yearly price</td><td>12 months</td><td class="pr-yr" id="prYearly">${money(y)}</td></tr></tfoot>
      </table></div>
      <div class="pr-fine">Yearly price is 7 months at the 3x/week price plus 5 months at the 2x/week price.</div>
    </div>

    <div class="pr-card">
      <h3>Work needed</h3>
      <div class="pr-needs">
        <div><label class="pr-f" for="prRepairs">Repairs needed</label><textarea class="pr-in" id="prRepairs" data-f="repairs" placeholder="e.g. Replace cracked skimmer lid">${esc(r.repairs || '')}</textarea></div>
        <div><label class="pr-f" for="prReno">Renovations needed</label><textarea class="pr-in" id="prReno" data-f="renovations" placeholder="e.g. Replaster within 12 months">${esc(r.renovations || '')}</textarea></div>
        <div><label class="pr-f" for="prMaint">Maintenance needed</label><textarea class="pr-in" id="prMaint" data-f="maintenance" placeholder="e.g. Clean filter, trim vegetation at pad">${esc(r.maintenance || '')}</textarea></div>
      </div>
    </div>`;
  }
  function softRefresh() {
    const a = document.activeElement, d = $('prDetail');
    if (a && d.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      const yEl = $('prYearly'); if (yEl) yEl.textContent = money(yearly(review(sel)));
      const s = $('prSaved'); if (s) s.innerHTML = fmtSaved(review(sel));
      return;
    }
    const y = window.scrollY; renderDetail(); window.scrollTo(0, y);
  }
  function selectProp(id) {
    sel = id; pbEdit = false; confirmDel = null;
    renderList(); renderDetail();
    if (window.matchMedia('(max-width: 820px)').matches) window.scrollTo(0, $('viewReview').offsetTop);
    loadDetailPhotos();
  }
  async function loadDetailPhotos() {
    const id = sel; const p = props.find(x => x.id === id); if (!p) return;
    const { insp } = inspFor(p);
    if (insp && !examPhotos[insp.id]) {
      const { data } = await sb.from('inspection_photos').select('*').eq('inspection_id', insp.id).order('sort_order', { ascending: true });
      examPhotos[insp.id] = data || [];
    }
    await signPaths(photosFor(id).map(r => r.storage_path).concat(insp ? (examPhotos[insp.id] || []).map(r => r.storage_path) : []));
    if (sel === id) renderPhotos(true);
  }

  // ---------------------------------------------------------------- saving
  function queue(id, patch) {
    const cur = pending[id] || (pending[id] = {});
    for (const k in patch) {
      if (JSON_FIELDS.includes(k)) cur[k] = { ...(cur[k] || {}), ...patch[k] };
      else cur[k] = patch[k];
    }
    setSync('Saving…');
    clearTimeout(timers[id]); timers[id] = setTimeout(() => flush(id), 650);
  }
  async function flush(id) {
    if (inflight[id]) await inflight[id];
    const patch = pending[id]; if (!patch) return;
    delete pending[id];
    const base = reviews[id] || {};
    const body = { property_id: id };
    for (const k of Object.keys(patch)) {
      let val = patch[k];
      if (JSON_FIELDS.includes(k)) val = Object.keys(val).length ? { ...(base[k] || {}), ...val } : {};
      else if (k === 'price_3x' || k === 'price_2x') val = num(val);
      else if (typeof val === 'string') val = val.trim() === '' ? null : val;
      body[k] = val;
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
        if (sel === id) { const s = $('prSaved'); if (s) s.innerHTML = fmtSaved(data); }
      }
    })();
    await inflight[id]; inflight[id] = null;
  }
  function changed(rerender) {
    renderStats(); renderList();
    if (rerender) { const y = window.scrollY; renderDetail(); window.scrollTo(0, y); }
  }
  function savePb() {
    const u = normUrl($('prPbIn') && $('prPbIn').value);
    if (!u) { const m = $('prPbMsg'); if (m) { m.classList.add('err'); m.textContent = 'Enter a web link, like https://app.poolbrain.com/…'; } return; }
    queue(sel, { poolbrain_url: u }); pbEdit = false; changed(true);
  }

  // ---------------------------------------------------------------- photos
  function photosInner() {
    const p = props.find(x => x.id === sel); if (!p) return '';
    const { insp } = inspFor(p);
    const mine = photosFor(sel), ups = uploads.filter(u => u.pid === sel), exPh = insp ? (examPhotos[insp.id] || []) : [];
    const total = mine.length + exPh.length;
    let html = `<div class="pr-sumrow"><h3>Photos</h3><span class="pr-msg">${total ? `${total} photo${total > 1 ? 's' : ''}` : ''}</span></div>
      <div class="pr-drop" id="prDrop">
        <div><b>Drop photos here</b></div>
        <div class="pr-row2"><span>or</span><button type="button" class="pr-btn" id="prPick">Choose photos</button>
          <label for="prUpCat">File under</label><select id="prUpCat">${PHOTO_CATS.map(c => `<option value="${c.key}" ${c.key === uploadCat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div class="pr-row2">Add as many as you like at once. You can change a photo's category after upload.</div>
        <input type="file" id="prFileIn" multiple accept="image/*,.heic,.heif" hidden>
      </div>`;
    const all = [];
    for (const c of PHOTO_CATS) {
      const ps = mine.filter(x => (x.category_key || 'additional') === c.key), us = ups.filter(u => u.cat === c.key);
      if (!ps.length && !us.length) continue;
      html += `<div class="pr-pgroup"><h4>${esc(c.label)} <small>${ps.length}</small></h4><div class="pr-pgrid">`;
      for (const ph of ps) {
        const u = urlFor(ph.storage_path), idx = all.push({ url: u, cap: ph.caption, cat: c.label }) - 1;
        html += `<figure class="pr-tile"><button type="button" class="pr-thumb" data-open="${idx}" aria-label="Open ${esc(ph.caption || c.label)}">${u ? `<img src="${esc(u)}" alt="${esc(ph.caption || c.label)}" loading="lazy">` : '<span class="pr-ov">Loading…</span>'}</button>
          <div class="pr-meta"><input data-pcap="${ph.id}" value="${esc(ph.caption || '')}" placeholder="Add a caption" aria-label="Caption">
          <select data-pcat="${ph.id}" aria-label="Photo category">${PHOTO_CATS.map(cc => `<option value="${cc.key}" ${cc.key === (ph.category_key || 'additional') ? 'selected' : ''}>${esc(cc.label)}</option>`).join('')}</select>
          <div class="pr-acts">${confirmDel === ph.id ? `<button type="button" class="pr-lnk danger" data-pdel-yes="${ph.id}">Yes, delete</button><button type="button" class="pr-lnk" data-pdel-no="1">Keep</button>` : `<button type="button" class="pr-lnk" data-pdel="${ph.id}">Delete</button>`}</div></div></figure>`;
      }
      for (const u of us) {
        html += `<figure class="pr-tile"><div class="pr-thumb" style="cursor:default"><img src="${u.url}" alt=""><span class="pr-ov ${u.state === 'error' ? 'err' : ''}">${u.state === 'error' ? esc(u.msg) : u.state === 'uploading' ? 'Uploading…' : 'Waiting…'}</span></div>
          ${u.state === 'error' ? `<div class="pr-meta"><div class="pr-acts"><button type="button" class="pr-lnk" data-uretry="${u.key}">Try again</button><button type="button" class="pr-lnk" data-udismiss="${u.key}">Dismiss</button></div></div>` : ''}</figure>`;
      }
      html += '</div></div>';
    }
    if (exPh.length) {
      html += `<div class="pr-pgroup"><h4>From the inspection <small>${exPh.length}</small></h4><div class="pr-pgrid">`;
      for (const ph of exPh) {
        const u = urlFor(ph.storage_path), idx = all.push({ url: u, cap: ph.caption, cat: ph.category || 'Inspection photo' }) - 1;
        html += `<figure class="pr-tile"><button type="button" class="pr-thumb" data-open="${idx}" aria-label="Open photo">${u ? `<img src="${esc(u)}" alt="${esc(ph.caption || ph.category || '')}" loading="lazy">` : '<span class="pr-ov">Loading…</span>'}</button>
          <div class="pr-meta pr-meta-ro">${esc(ph.caption || ph.category || '')}</div></figure>`;
      }
      html += '</div></div>';
    }
    lbList = all;
    return html;
  }
  function renderPhotos(force) {
    const c = $('prPhotosCard'); if (!c || !sel) return;
    const a = document.activeElement;
    if (!force && a && c.contains(a) && a.matches('input[data-pcap]')) return;
    c.innerHTML = photosInner();
    const need = photosFor(sel).map(r => r.storage_path).filter(pth => !urlFor(pth));
    if (need.length) signPaths(need).then(() => { if (sel) renderPhotos(); });
  }
  const looksImage = f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name);
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
      const ins = await sb.from('pool_review_photos').insert({
        property_id: u.pid, category_key: u.cat, file_name: prepared.name, storage_path: path,
        mime_type: prepared.type || null, size_bytes: prepared.blob.size,
        uploaded_by: session && session.user ? session.user.id : null,
        uploaded_by_email: session && session.user ? session.user.email : null,
      }).select().single();
      if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
      rphotos[ins.data.id] = ins.data;
      signed[path] = { url: u.url, exp: Date.now() + 3600 * 1000 };
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
    if (rm.error || del.error) setSync('Couldn\'t delete the photo: ' + (rm.error || del.error).message);
    else { delete rphotos[id]; setSync('Photo deleted.'); }
    renderPhotos(true); renderList();
  }
  function openLb(i) { lb = i; showLb(); $('prLb').classList.remove('hidden'); $('prLbClose').focus(); }
  function showLb() {
    if (!lbList.length) { closeLb(); return; }
    lb = (lb + lbList.length) % lbList.length; const ph = lbList[lb];
    $('prLbImg').src = ph.url; $('prLbImg').alt = ph.cap || ph.cat;
    $('prLbCap').innerHTML = `${esc(ph.cap || ph.cat)}<small>${esc(ph.cat)}, ${lb + 1} of ${lbList.length}</small>`;
    $('prLbPrev').classList.toggle('hidden', lbList.length < 2); $('prLbNext').classList.toggle('hidden', lbList.length < 2);
  }
  function closeLb() { $('prLb').classList.add('hidden'); lb = null; }

  // ---------------------------------------------------------------- CSV
  function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportCsv() {
    const chemIdx = CHEM_READING.map((h, i) => h ? i : -1).filter(i => i >= 0);
    const head = ['Property', 'Region', 'City', 'Address', 'Manager', 'Phone', 'Poolbrain', 'Inspection result', 'Category',
      'Exam date', 'Technician', 'Exam passed', 'Of', 'Caution', 'Failed', 'N/A', 'Rating', 'Summary',
      '3x/week monthly (Apr-Oct)', '2x/week monthly (Nov-Mar)', 'Yearly', 'Repairs', 'Renovations', 'Maintenance', 'Review photos',
      ...chemIdx.map(i => SECTIONS[0].items[i] + (CHEM_UNITS[SECTIONS[0].items[i]] ? ` (${CHEM_UNITS[SECTIONS[0].items[i]]})` : ''))];
    const rows = [head];
    for (const p of props) {
      const r = review(p.id), v = examView(p), sc = examScore(v), rt = rating(sc);
      rows.push([p.name, p.region, p.city, p.address, p.manager, p.phone, r.poolbrain_url || '', resLabel(r.inspection_result), r.category ?? '',
        v.date, v.tech, sc.rated ? sc.p : '', TOTAL_POINTS, sc.rated ? sc.c : '', sc.rated ? sc.f : '', sc.rated ? sc.na : '', rt ? rt.label : '',
        r.summary || '', num(r.price_3x) ?? '', num(r.price_2x) ?? '', yearly(r) ?? '', r.repairs || '', r.renovations || '', r.maintenance || '',
        photoCount(p.id), ...chemIdx.map(i => v.readings[i] || '')]);
    }
    const blob = new Blob(['\ufeff' + rows.map(x => x.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'poolie-pool-review-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------------------------------------------------------------- events
  $('tabReview').addEventListener('click', () => { P.showTab('Review'); if (!loaded) load(); });
  $('prRefresh').addEventListener('click', () => { loaded = false; Object.keys(examPhotos).forEach(k => delete examPhotos[k]); load().then(() => { if (sel) loadDetailPhotos(); }); });
  $('prExport').addEventListener('click', () => { if (loaded) exportCsv(); });
  $('prQ').addEventListener('input', e => { ui.q = e.target.value; renderList(); });
  $('prCatF').addEventListener('change', e => { ui.cat = e.target.value; renderList(); });
  $('prResF').addEventListener('change', e => { ui.res = e.target.value; renderList(); });
  $('prSort').addEventListener('change', e => { ui.sort = e.target.value; renderList(); });
  $('prRegions').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    ui.region = b.dataset.r; [...$('prRegions').children].forEach(x => x.setAttribute('aria-pressed', x === b)); renderList();
  });
  $('prList').addEventListener('click', e => { const b = e.target.closest('.pr-row'); if (b) selectProp(b.dataset.id); });

  const D = $('prDetail');
  D.addEventListener('click', async e => {
    const t = e.target;
    if (t.id === 'prBack') { sel = null; renderList(); renderDetail(); return; }
    if (t.id === 'prPbEdit') { pbEdit = true; pbDraft = review(sel).poolbrain_url || ''; renderDetail(); const i = $('prPbIn'); if (i) i.focus(); return; }
    if (t.id === 'prPbCancel') { pbEdit = false; renderDetail(); return; }
    if (t.id === 'prPbRemove') { queue(sel, { poolbrain_url: '' }); pbEdit = false; changed(true); return; }
    if (t.id === 'prPbSave') { savePb(); return; }
    if (t.id === 'prClearCat') { queue(sel, { category: null }); changed(true); return; }
    if (t.id === 'prOpenExam') { const { insp } = inspFor(props.find(x => x.id === sel)); if (insp) P.openInspection(insp.id); return; }
    if (t.id === 'prResetExam') {
      const id = sel; clearTimeout(timers[id]);
      const keep = { ...(pending[id] || {}) }; delete keep.exam; delete keep.chem_readings; delete keep.exam_notes;
      pending[id] = { ...keep, exam: {}, chem_readings: {}, exam_notes: {} };
      reviews[id] = { ...(reviews[id] || {}), exam: {}, chem_readings: {}, exam_notes: {} };
      await flush(id); changed(true); return;
    }
    const cb = t.closest('[data-cat]');
    if (cb) { const v = Number(cb.dataset.cat); queue(sel, { category: review(sel).category === v ? null : v }); changed(true); return; }
    const rb = t.closest('[data-res]');
    if (rb) { const v = rb.dataset.res; queue(sel, { inspection_result: review(sel).inspection_result === v ? null : v }); changed(true); return; }
    const sb2 = t.closest('.pr-st button');
    if (sb2) {
      const key = sb2.dataset.sec, i = Number(sb2.dataset.i), val = sb2.dataset.v;
      const arr = examView(props.find(x => x.id === sel)).ex[key].slice();
      arr[i] = arr[i] === val ? '' : val;
      queue(sel, { exam: { [key]: arr } }); changed(true); return;
    }
    if (t.id === 'prPick') { const f = $('prFileIn'); if (f) f.click(); return; }
    const o = t.closest('[data-open]'); if (o) { openLb(Number(o.dataset.open)); return; }
    if (t.dataset.pdel) { confirmDel = t.dataset.pdel; renderPhotos(true); return; }
    if (t.dataset.pdelNo) { confirmDel = null; renderPhotos(true); return; }
    if (t.dataset.pdelYes) { deletePhoto(t.dataset.pdelYes); return; }
    if (t.dataset.uretry) { const u = uploads.find(x => x.key === t.dataset.uretry); if (u) { u.state = 'queued'; pump(); renderPhotos(true); } return; }
    if (t.dataset.udismiss) { const i = uploads.findIndex(x => x.key === t.dataset.udismiss); if (i >= 0) { URL.revokeObjectURL(uploads[i].url); uploads.splice(i, 1); } renderPhotos(true); }
  });
  D.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'prPbIn') { pbDraft = t.value; return; }
    if (t.dataset.f) {
      queue(sel, { [t.dataset.f]: t.value });
      if (t.dataset.f === 'price_3x' || t.dataset.f === 'price_2x') $('prYearly').textContent = money(yearly(review(sel)));
      renderStats(); renderList(); return;
    }
    if (t.dataset.reading !== undefined) { queue(sel, { chem_readings: { [t.dataset.reading]: t.value.trim() } }); return; }
    if (t.dataset.note) { queue(sel, { exam_notes: { [t.dataset.note]: t.value } }); return; }
    if (t.dataset.pcap) {
      const id = t.dataset.pcap, val = t.value; rphotos[id] = { ...rphotos[id], caption: val };
      clearTimeout(timers['cap' + id]); timers['cap' + id] = setTimeout(async () => {
        const { error } = await sb.from('pool_review_photos').update({ caption: val.trim() || null }).eq('id', id);
        setSync(error ? 'Couldn\'t save the caption.' : 'All changes saved.');
      }, 600);
    }
  });
  D.addEventListener('change', async e => {
    const t = e.target;
    if (t.id === 'prFileIn') { enqueue([...t.files]); t.value = ''; return; }
    if (t.id === 'prUpCat') { uploadCat = t.value; return; }
    if (t.id === 'prExamSel') { queue(sel, { inspection_id: t.value || null }); await flush(sel); changed(true); loadDetailPhotos(); return; }
    if (t.dataset.pcat) {
      const id = t.dataset.pcat; rphotos[id] = { ...rphotos[id], category_key: t.value };
      const { error } = await sb.from('pool_review_photos').update({ category_key: t.value }).eq('id', id);
      if (error) setSync('Couldn\'t save the photo category.');
      renderPhotos(true);
    }
  });
  D.addEventListener('keydown', e => {
    if (e.target.id !== 'prPbIn') return;
    if (e.key === 'Enter') { e.preventDefault(); savePb(); } else if (e.key === 'Escape') { pbEdit = false; renderDetail(); }
  });
  let dragDepth = 0;
  const inPhotos = e => e.target.closest && e.target.closest('#prPhotosCard');
  D.addEventListener('dragenter', e => { if (!inPhotos(e)) return; e.preventDefault(); dragDepth++; const d = $('prDrop'); if (d) d.classList.add('over'); });
  D.addEventListener('dragleave', e => { if (!inPhotos(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { const d = $('prDrop'); if (d) d.classList.remove('over'); } });
  D.addEventListener('dragover', e => { if (inPhotos(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  D.addEventListener('drop', e => {
    if (!inPhotos(e)) return;
    e.preventDefault(); dragDepth = 0; const d = $('prDrop'); if (d) d.classList.remove('over');
    enqueue([...((e.dataTransfer && e.dataTransfer.files) || [])]);
  });
  window.addEventListener('dragover', e => { if (!$('viewReview').classList.contains('hidden')) e.preventDefault(); });
  window.addEventListener('drop', e => { if (!$('viewReview').classList.contains('hidden')) e.preventDefault(); });

  $('prLbClose').addEventListener('click', closeLb);
  $('prLbPrev').addEventListener('click', () => { lb--; showLb(); });
  $('prLbNext').addEventListener('click', () => { lb++; showLb(); });
  $('prLb').addEventListener('click', e => { if (e.target.id === 'prLb') closeLb(); });
  document.addEventListener('keydown', e => {
    if (lb == null) return;
    if (e.key === 'Escape') closeLb(); else if (e.key === 'ArrowLeft') { lb--; showLb(); } else if (e.key === 'ArrowRight') { lb++; showLb(); }
  });

  window.addEventListener('poolie:inspection-saved', () => { loaded = false; });
  window.addEventListener('poolie:signed-out', () => {
    loaded = false; sel = null; props = []; reviews = {}; inspections = []; rphotos = {};
    if (channel) { sb.removeChannel(channel); channel = null; }
  });
})();
