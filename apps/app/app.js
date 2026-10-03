import { ago, pick, t } from './i18n.js';

const COMMUNITY_REGISTRY = 'https://traxito.github.io/oosr/skills/index.json';
const COMMUNITY_PUBLISHER = 'did:web:traxito.github.io:oosr';
const TOKEN_KEY = 'oosr.owner_token';

// ------------------------------------------------------------------ DOM helpers
// Robot- and manifest-supplied strings are untrusted: everything goes through textContent.

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const chip = (text, cls = '') => h('span', { class: `chip ${cls}` }, text);
const card = (...children) => h('section', { class: 'card' }, ...children);
const section = (title, ...children) => h('div', { class: 'section' }, h('h2', {}, title), ...children);

function toast(msg, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// ------------------------------------------------------------------ storage & API

const store = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: the session simply won't persist */
    }
  },
};

let token = store.get();

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => undefined);
  if (res.status === 401) {
    logout();
    throw new ApiError(401, json);
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

const enc = encodeURIComponent;

/** Skill packages are immutable per version, so they are cached for the session. */
const skillCache = new Map();
async function skill(ref) {
  if (!skillCache.has(ref)) {
    const at = ref.lastIndexOf('@');
    skillCache.set(ref, api('GET', `/v0/skills/${enc(ref.slice(0, at))}@${ref.slice(at + 1)}`).catch(() => null));
  }
  return skillCache.get(ref);
}

async function taskTitle(ref, task) {
  const pkg = ref ? await skill(ref) : null;
  const key = pkg?.manifest.tasks.find((x) => x.name === task)?.title_key;
  return pick(pkg?.manifest.messages?.[key]) ?? task.replace(/_/g, ' ');
}

// ------------------------------------------------------------------ formatting

const attestationChip = (a) =>
  a
    ? h('div', { class: 'chips' }, chip(`✓ ${t('certified_by')} ${a.iss.replace(/^did:web:/, '')}${a.key_storage ? ` · ${a.key_storage}` : ''}`, 'ok'))
    : h('div', { class: 'chips' }, chip(`⚠ ${t('no_device_cert')}`, 'warn'));

const shortUrn = (urn) => urn?.split(':').slice(-2).join(':') ?? '';
const robotLabel = (urn) => (urn ? urn.replace(/^urn:oosr:robot:/, '').replace(':', ' · ') : '');
const pct = (v) => `${Math.round(v * 100)} %`;

function moistureBar(m) {
  if (!m) return h('div', { class: 'muted' }, t('no_data'));
  const v = m.value;
  const cls = v < 0.2 ? 'dry' : v > 0.45 ? 'wet' : 'ok';
  return h(
    'div',
    { class: 'meter' },
    h('div', { class: 'meter-track' }, h('div', { class: `meter-fill ${cls}`, style: `width:${Math.min(100, (v / 0.6) * 100)}%` })),
    h('div', { class: 'meter-label' }, h('strong', {}, pct(v)), ' · ', ago(m.at)),
  );
}

async function eventLabel(ev) {
  const m = /^oosr\.task\.([a-z0-9_]+)\.(started|completed|failed)$/.exec(ev.type);
  if (m) return `${await taskTitle(ev.oosrskill, m[1])} · ${t(`phase_${m[2]}`)}`;
  const map = {
    'oosr.object.enrolled': 'ev_enrolled',
    'oosr.object.updated': 'ev_updated',
    'oosr.binding.revoked': 'ev_revoked',
    'oosr.observation.recorded': 'ev_observation',
    'oosr.approval.granted': 'ev_approval_granted',
    'oosr.approval.denied': 'ev_approval_denied',
    'oosr.alert.acknowledged': 'ev_alert_ack',
  };
  return map[ev.type] ? t(map[ev.type]) : ev.type;
}

function eventDetail(ev) {
  const d = ev.data ?? {};
  const bits = [];
  if (d.volume_ml !== undefined) bits.push(`${d.volume_ml} ml`);
  if (d.soil_moisture_before !== undefined && d.soil_moisture_after !== undefined) bits.push(`${pct(d.soil_moisture_before)} → ${pct(d.soil_moisture_after)}`);
  if (d.measurements?.soil_moisture !== undefined) bits.push(`${t('soil_moisture').toLowerCase()} ${pct(d.measurements.soil_moisture)}`);
  if (d.notify) bits.push(`⚠ ${d.notify.message_key}`);
  if (d.code) bits.push(d.code);
  if (d.lease_s) bits.push(`lease ${d.lease_s}s`);
  return bits.join(' · ');
}

// ------------------------------------------------------------------ views

async function viewLogin(root) {
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'oosr_own_…', 'aria-label': t('login_token') });
  const err = h('p', { class: 'error', hidden: true });
  const submit = async (e) => {
    e.preventDefault();
    token = input.value.trim();
    try {
      const res = await fetch('/v0/policy', { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      store.set(token);
      location.hash = '#/';
      start();
    } catch {
      err.hidden = false;
      err.textContent = t('login_bad');
    }
  };
  root.append(
    h(
      'div',
      { class: 'login' },
      h('div', { class: 'logo', 'aria-hidden': 'true' }, '◎'),
      h('h1', {}, t('login_title')),
      h('p', { class: 'muted' }, t('login_help')),
      h('form', { onsubmit: submit }, h('label', {}, t('login_token'), input), err, h('button', { class: 'primary', type: 'submit' }, t('login_go'))),
    ),
  );
}

async function viewHome(root, pairCode) {
  const [pairing, enrolments, approvals, objects] = await Promise.all([
    api('GET', '/v0/pair/requests'),
    api('GET', '/v0/enrolments?status=pending'),
    api('GET', '/v0/approvals?status=pending'),
    api('GET', '/v0/objects'),
  ]);
  const names = Object.fromEntries(objects.map((o) => [o.id, o.name ?? o.type]));
  const inbox = [];

  for (const p of pairing) {
    const highlight = pairCode && pairCode.toUpperCase() === p.user_code;
    inbox.push(
      card(
        h('div', { class: 'card-kicker' }, t('pair_title')),
        h('div', { class: `code ${highlight ? 'match' : ''}` }, p.user_code),
        h('p', { class: 'muted small' }, t('pair_check')),
        h('div', { class: 'row' }, h('strong', {}, p.capability.model), h('span', { class: 'muted mono' }, robotLabel(p.capability.robot))),
        h('div', { class: 'chips' }, p.capability.primitives.map((x) => chip(x))),
        attestationChip(p.device_attestation),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', onclick: () => act(() => api('POST', '/v0/pair/approve', { user_code: p.user_code })) }, t('approve')),
          h('button', { onclick: () => act(() => api('POST', '/v0/pair/deny', { user_code: p.user_code })) }, t('deny')),
        ),
      ),
    );
  }

  for (const e of enrolments) {
    const name = h('input', { placeholder: e.proposed_type.split('/').pop() });
    const type = h('input', { value: e.proposed_type });
    const zone = h('input', { value: e.zone ?? '', placeholder: 'living-room' });
    const pot = h('input', { type: 'number', min: '0', step: '0.5', placeholder: '3' });
    inbox.push(
      card(
        h('div', { class: 'card-kicker' }, t('enrol_title')),
        h(
          'div',
          { class: 'row' },
          h('strong', {}, e.proposed_type),
          e.confidence !== undefined ? chip(`${Math.round(e.confidence * 100)} % ${t('enrol_confidence')}`) : null,
        ),
        h('p', { class: 'muted small' }, `${t('enrol_tag')} ${e.tag_family} #${e.tag_id} (${e.tag_size_mm} mm) · ${t('enrol_seen_by')} ${robotLabel(e.robot)}`),
        e.skills?.length ? h('div', { class: 'chips' }, e.skills.map((s) => chip(s.ref.split('/').pop(), 'accent'))) : null,
        h(
          'div',
          { class: 'grid2' },
          h('label', {}, t('field_name'), name),
          h('label', {}, t('field_zone'), zone),
          h('label', {}, t('field_type'), type),
          h('label', {}, t('field_pot'), pot),
        ),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'primary',
              onclick: () =>
                act(async () => {
                  const body = { type: type.value.trim() || e.proposed_type };
                  if (name.value.trim()) body.name = name.value.trim();
                  if (zone.value.trim()) body.zone = zone.value.trim().toLowerCase();
                  if (pot.value) body.attributes = { pot_volume_l: Number(pot.value) };
                  const res = await api('POST', `/v0/enrolments/${e.id}/confirm`, body);
                  if (res.skill_errors?.length) toast(res.skill_errors.join(' · '), 'warn');
                }),
            },
            t('confirm'),
          ),
          h('button', { onclick: () => act(() => api('POST', `/v0/enrolments/${e.id}/reject`)) }, t('reject')),
        ),
      ),
    );
  }

  for (const a of approvals) {
    inbox.push(
      card(
        h('div', { class: 'card-kicker' }, t('approval_title')),
        h('div', { class: 'row' }, h('strong', {}, await taskTitle(a.skill, a.task)), h('span', {}, names[a.object] ?? shortUrn(a.object))),
        h('p', { class: 'muted small' }, `${t('by')} ${robotLabel(a.robot)} · ${a.skill}`),
        h('div', { class: 'chips' }, t('approval_requires'), ' ', a.requires.map((r) => chip(r, ['cut', 'grasp', 'place'].includes(r.split(':')[0]) ? 'warn' : ''))),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', onclick: () => act(() => api('POST', `/v0/approvals/${a.id}/grant`)) }, t('grant')),
          h('button', { onclick: () => act(() => api('POST', `/v0/approvals/${a.id}/deny`)) }, t('deny')),
        ),
      ),
    );
  }

  for (const o of objects) {
    for (const al of (await api('GET', `/v0/objects/${enc(o.id)}/state`)).open_alerts) {
      inbox.push(
        card(
          h('div', { class: `card-kicker sev-${al.severity}` }, t('alert_title')),
          h('div', { class: 'row' }, h('strong', {}, pick(al.messages) ?? al.message_key), h('a', { href: `#/objects/${enc(o.id)}` }, o.name ?? o.type)),
          h('p', { class: 'muted small' }, `${robotLabel(al.source)} · ${ago(al.at)}`),
          h('div', { class: 'actions' }, h('button', { onclick: () => act(() => api('POST', `/v0/objects/${enc(o.id)}/alerts/${enc(al.message_key)}/ack`)) }, t('ack'))),
        ),
      );
    }
  }

  root.append(
    section(t('inbox'), inbox.length ? h('div', { class: 'stack' }, inbox) : h('p', { class: 'empty' }, t('inbox_empty'))),
    section(
      t('objects'),
      objects.length
        ? h(
            'div',
            { class: 'tiles' },
            objects.map((o) =>
              h(
                'a',
                { class: 'tile', href: `#/objects/${enc(o.id)}` },
                h('div', { class: 'tile-head' }, h('strong', {}, o.name ?? o.type), o.state.open_alerts.length ? chip('⚠', 'warn') : null),
                h('div', { class: 'muted small' }, `${o.type} · ${o.location?.zone ?? '—'}`),
                moistureBar(o.state.measurements?.soil_moisture),
                h('div', { class: 'small' }, `${t('last_watered')}: `, h('strong', {}, ago(o.state.last_watered))),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('objects_empty')),
    ),
  );
}

async function viewObject(root, urn) {
  const [o, state, tasks, events] = await Promise.all([
    api('GET', `/v0/objects/${enc(urn)}`),
    api('GET', `/v0/objects/${enc(urn)}/state`),
    api('GET', `/v0/objects/${enc(urn)}/tasks`),
    api('GET', `/v0/objects/${enc(urn)}/events`),
  ]);

  const taskRows = await Promise.all(
    tasks.map(async (tk) => {
      let status;
      if (tk.lease) status = chip(`${t('task_in_progress')} ${robotLabel(tk.lease.robot)}`, 'accent');
      else if (!tk.in_season) status = chip(t('task_out_of_season'));
      else if (tk.trigger === true) status = chip(t('task_due'), 'warn');
      else if (tk.trigger === null) status = chip(t('task_unknown'));
      else status = chip(t('task_not_due'), 'ok');
      return h(
        'li',
        { class: 'task' },
        h('div', { class: 'row' }, h('strong', {}, await taskTitle(tk.skill, tk.task)), status),
        h(
          'div',
          { class: 'chips small' },
          tk.needs_approval ? chip(t('task_needs_approval'), 'warn') : null,
          tk.robots?.length ? chip(`${tk.robots.length} ${t('task_robots')}`) : chip(t('task_no_robot'), 'muted'),
          tk.physical ? chip('⚙ physical') : null,
        ),
      );
    }),
  );

  const timeline = await Promise.all(
    [...events].reverse().slice(0, 60).map(async (ev) =>
      h(
        'li',
        { class: `ev ${ev.type.endsWith('.failed') ? 'failed' : ''}` },
        h('div', { class: 'row' }, h('strong', {}, await eventLabel(ev)), h('time', { datetime: ev.time, title: ev.time }, ago(ev.time))),
        h('div', { class: 'muted small' }, [eventDetail(ev), robotLabel(ev.source) || ev.source].filter(Boolean).join(' · ')),
      ),
    ),
  );

  const name = h('input', { value: o.name ?? '' });
  const zone = h('input', { value: o.location?.zone ?? '' });
  const pot = h('input', { type: 'number', min: '0', step: '0.5', value: o.attributes?.pot_volume_l ?? '' });
  const save = () =>
    act(async () => {
      const changes = {};
      if (name.value.trim()) changes.name = name.value.trim();
      if (zone.value.trim()) changes.location = { ...(o.location ?? {}), zone: zone.value.trim().toLowerCase() };
      if (pot.value) changes.attributes = { ...(o.attributes ?? {}), pot_volume_l: Number(pot.value) };
      await api('PATCH', `/v0/objects/${enc(urn)}`, changes);
      toast(t('saved'));
    });

  root.append(
    h('a', { class: 'back', href: '#/' }, `← ${t('back')}`),
    h('h1', {}, o.name ?? o.type),
    h('p', { class: 'muted' }, `${o.type} · ${o.location?.zone ?? '—'} · ${(o.bindings ?? []).map((b) => `${b.tag_family} #${b.tag_id}`).join(', ')}`),
    h(
      'div',
      { class: 'grid2 stats' },
      card(h('div', { class: 'card-kicker' }, t('soil_moisture')), moistureBar(state.measurements?.soil_moisture)),
      card(h('div', { class: 'card-kicker' }, t('last_watered')), h('div', { class: 'big' }, ago(state.last_watered))),
    ),
    state.open_alerts.length
      ? h(
          'div',
          { class: 'stack' },
          state.open_alerts.map((al) =>
            card(
              h('div', { class: `card-kicker sev-${al.severity}` }, t('alert_title')),
              h('strong', {}, pick(al.messages) ?? al.message_key),
              h('div', { class: 'actions' }, h('button', { onclick: () => act(() => api('POST', `/v0/objects/${enc(urn)}/alerts/${enc(al.message_key)}/ack`)) }, t('ack'))),
            ),
          ),
        )
      : null,
    section(t('tasks'), tasks.length ? h('ul', { class: 'list' }, taskRows) : h('p', { class: 'empty' }, '—')),
    section(t('history'), h('ul', { class: 'timeline' }, timeline)),
    section(
      t('details'),
      card(
        h('div', { class: 'grid2' }, h('label', {}, t('field_name'), name), h('label', {}, t('field_zone'), zone), h('label', {}, t('field_pot'), pot)),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: save }, t('save'))),
        h('p', { class: 'muted small mono' }, o.id),
      ),
    ),
  );
}

/** Robot-role conformance report, loaded on demand. */
function auditBox(robot) {
  const box = h('div', { class: 'audit' });
  const run = async () => {
    box.replaceChildren(h('p', { class: 'muted small' }, '…'));
    try {
      const report = await api('GET', `/v0/robots/${enc(robot)}/audit`);
      const icon = { pass: '✓', warn: '!', fail: '✗' };
      box.replaceChildren(
        h('div', { class: 'row' }, h('strong', {}, t('audit_title')), chip(report.ok ? t('audit_ok') : t('audit_bad'), report.ok ? 'ok' : 'warn')),
        h(
          'ul',
          { class: 'checks' },
          report.checks.map((c) => h('li', { class: `check-${c.status}` }, h('span', { class: 'mono' }, `${icon[c.status]} ${c.id}`), h('span', { class: 'muted small' }, c.detail))),
        ),
      );
    } catch (e) {
      box.replaceChildren(h('p', { class: 'error' }, e.message));
    }
  };
  box.append(h('button', { onclick: run }, t('audit_run')));
  return box;
}

async function viewRobots(root) {
  const robots = await api('GET', '/v0/robots');
  root.append(
    section(
      t('nav_robots'),
      robots.length
        ? h(
            'div',
            { class: 'stack' },
            robots.map((r) =>
              card(
                h('div', { class: 'row' }, h('strong', {}, r.capability.model), r.revoked_at ? chip(t('revoked'), 'warn') : chip('●', 'ok')),
                h('p', { class: 'muted small mono' }, r.robot),
                attestationChip(r.device_attestation),
                h('div', { class: 'kv' }, h('span', {}, t('primitives')), h('div', { class: 'chips' }, r.capability.primitives.map((x) => chip(x)))),
                r.capability.limits
                  ? h('div', { class: 'kv' }, h('span', {}, t('limits')), h('div', { class: 'chips' }, Object.entries(r.capability.limits).map(([k, v]) => chip(`${k}=${v}`))))
                  : null,
                h('div', { class: 'kv' }, h('span', {}, t('scopes')), h('div', { class: 'chips' }, (r.policy.write ?? []).map((x) => chip(x, 'accent')))),
                h('div', { class: 'kv' }, h('span', {}, t('zones')), h('div', {}, (r.policy.zones ?? []).join(', ') || t('all_zones'))),
                auditBox(r.robot),
                r.revoked_at
                  ? null
                  : h(
                      'div',
                      { class: 'actions' },
                      h('button', { class: 'danger', onclick: () => confirm(t('revoke_confirm')) && act(() => api('DELETE', `/v0/robots/${enc(r.robot)}`)) }, t('revoke')),
                    ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('robots_empty')),
    ),
  );
}

async function viewSkills(root) {
  const [installed, policy] = await Promise.all([api('GET', '/v0/skills'), api('GET', '/v0/policy')]);
  const have = new Set(installed.map((s) => `${s.id}@${s.version}`));
  const trusted = new Set(policy.trusted_publishers);

  const trustBtn = (did) =>
    h(
      'button',
      { onclick: () => act(() => api('PUT', '/v0/policy', { ...policy, trusted_publishers: [...new Set([...policy.trusted_publishers, did])] })) },
      t('trust'),
    );

  const community = h('div', { class: 'stack' }, h('p', { class: 'muted' }, '…'));
  fetch(COMMUNITY_REGISTRY)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((index) => {
      community.replaceChildren(
        trusted.has(index.publisher) ? chip(`${index.publisher} · ${t('trusted')}`, 'ok') : h('div', { class: 'row' }, chip(index.publisher), trustBtn(index.publisher)),
        ...index.skills.map((s) =>
          card(
            h('div', { class: 'row' }, h('strong', {}, s.title ?? s.id), chip(s.latest)),
            h('p', { class: 'muted small' }, `${t('applies_to')}: ${s.applies_to.join(', ')}`),
            h(
              'div',
              { class: 'actions' },
              have.has(`${s.id}@${s.latest}`)
                ? chip(t('installed'), 'ok')
                : h('button', { class: 'primary', disabled: !trusted.has(index.publisher), onclick: () => act(() => api('POST', '/v0/skills/fetch', { ref: s.id })) }, t('install')),
            ),
          ),
        ),
      );
    })
    .catch(() => community.replaceChildren(h('p', { class: 'muted' }, t('registry_unreachable'))));

  const ref = h('input', { placeholder: 'skill:traxito.github.io/oosr/ficus-lyrata-care' });
  root.append(
    section(
      t('skills_installed'),
      installed.length
        ? h(
            'div',
            { class: 'stack' },
            installed.map((s) =>
              card(
                h('div', { class: 'row' }, h('strong', {}, s.title ?? s.id), chip(s.version)),
                h('p', { class: 'muted small mono' }, s.id),
                h('div', { class: 'chips' }, chip(s.trusted ? t('trusted') : t('untrusted'), s.trusted ? 'ok' : 'warn'), s.tasks.map((x) => chip(x))),
                h('p', { class: 'muted small' }, `${t('applies_to')}: ${s.applies_to.join(', ')} · ${s.publisher}`),
              ),
            ),
          )
        : h('p', { class: 'empty' }, t('skills_empty')),
    ),
    section(t('skills_community'), community),
    section(
      t('install_ref'),
      card(h('div', { class: 'row' }, ref, h('button', { onclick: () => ref.value.trim() && act(() => api('POST', '/v0/skills/fetch', { ref: ref.value.trim() })) }, t('install')))),
    ),
  );
}

async function viewSettings(root) {
  const policy = await api('GET', '/v0/policy');
  const savePolicy = (next) => act(async () => (await api('PUT', '/v0/policy', next), toast(t('saved'))));

  const newPub = h('input', { placeholder: COMMUNITY_PUBLISHER });
  const vendor = h('input', { placeholder: 'acme' });
  const maker = h('input', { placeholder: 'did:web:acme.example' });
  const from = h('input', { type: 'time', value: policy.quiet_hours?.from ?? '' });
  const to = h('input', { type: 'time', value: policy.quiet_hours?.to ?? '' });
  const tz = h('input', { value: policy.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
  const hemi = h(
    'select',
    {},
    h('option', { value: 'north', selected: policy.hemisphere !== 'south' }, t('north')),
    h('option', { value: 'south', selected: policy.hemisphere === 'south' }, t('south')),
  );
  const physical = ['grasp', 'place', 'dispense', 'cut'];
  const checks = physical.map((p) => h('input', { type: 'checkbox', value: p, checked: (policy.always_require_approval ?? []).includes(p) }));
  const raw = h('textarea', { rows: '14', spellcheck: 'false', class: 'mono' }, JSON.stringify(policy, null, 2));

  root.append(
    section(
      t('settings_trust'),
      card(
        h(
          'ul',
          { class: 'list' },
          policy.trusted_publishers.map((p) =>
            h(
              'li',
              { class: 'row' },
              h('span', { class: 'mono' }, p),
              h('button', { class: 'link', onclick: () => savePolicy({ ...policy, trusted_publishers: policy.trusted_publishers.filter((x) => x !== p) }) }, t('remove')),
            ),
          ),
        ),
        h(
          'div',
          { class: 'row' },
          newPub,
          h(
            'button',
            { onclick: () => /^did:web:/.test(newPub.value.trim()) && savePolicy({ ...policy, trusted_publishers: [...new Set([...policy.trusted_publishers, newPub.value.trim()])] }) },
            t('add'),
          ),
        ),
      ),
    ),
    section(
      t('settings_devices'),
      card(
        h('p', { class: 'muted small' }, t('settings_devices_help')),
        h(
          'ul',
          { class: 'list' },
          Object.entries(policy.trusted_manufacturers ?? {}).map(([vendor, did]) =>
            h(
              'li',
              { class: 'row' },
              h('span', { class: 'mono' }, `${vendor} → ${did}`),
              h(
                'button',
                {
                  class: 'link',
                  onclick: () => {
                    const next = { ...(policy.trusted_manufacturers ?? {}) };
                    delete next[vendor];
                    savePolicy({ ...policy, trusted_manufacturers: next });
                  },
                },
                t('remove'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { class: 'grid2' },
          h('label', {}, t('vendor'), vendor),
          h('label', {}, t('manufacturer_did'), maker),
        ),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              onclick: () =>
                /^[a-z0-9-]+$/.test(vendor.value.trim()) &&
                /^did:web:/.test(maker.value.trim()) &&
                savePolicy({ ...policy, trusted_manufacturers: { ...(policy.trusted_manufacturers ?? {}), [vendor.value.trim()]: maker.value.trim() } }),
            },
            t('add'),
          ),
        ),
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: policy.require_device_cert === true, onchange: (e) => savePolicy({ ...policy, require_device_cert: e.target.checked }) }),
          t('require_device_cert'),
        ),
      ),
    ),
    section(
      t('settings_quiet'),
      card(
        h('p', { class: 'muted small' }, t('settings_quiet_help')),
        h('div', { class: 'grid2' }, h('label', {}, t('from'), from), h('label', {}, t('to'), to), h('label', {}, t('settings_tz'), tz), h('label', {}, t('settings_hemisphere'), hemi)),
        h('div', { class: 'kv' }, h('span', {}, t('settings_approval')), h('div', { class: 'chips' }, physical.map((p, i) => h('label', { class: 'check' }, checks[i], p)))),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'primary',
              onclick: () => {
                const next = { ...policy, timezone: tz.value.trim() || undefined, hemisphere: hemi.value };
                const keep = (policy.always_require_approval ?? []).filter((p) => !physical.includes(p));
                next.always_require_approval = [...keep, ...checks.filter((c) => c.checked).map((c) => c.value)];
                if (from.value && to.value) next.quiet_hours = { from: from.value, to: to.value };
                else delete next.quiet_hours;
                savePolicy(next);
              },
            },
            t('save'),
          ),
        ),
      ),
    ),
    section(
      t('settings_advanced'),
      card(
        raw,
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              onclick: () => {
                try {
                  savePolicy(JSON.parse(raw.value));
                } catch (e) {
                  toast(e.message, 'error');
                }
              },
            },
            t('save'),
          ),
        ),
      ),
    ),
    h('div', { class: 'actions' }, h('button', { class: 'danger', onclick: logout }, t('logout'))),
  );
}

// ------------------------------------------------------------------ shell

const main = document.getElementById('main');
const statusDot = document.getElementById('live');
let rendering = false;
let pendingRender = false;

async function act(fn) {
  try {
    await fn();
    render();
  } catch (e) {
    toast(`${t('error')}: ${e.message}`, 'error');
  }
}

async function render() {
  if (rendering) {
    pendingRender = true;
    return;
  }
  rendering = true;
  try {
    const hash = location.hash.replace(/^#/, '') || '/';
    document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', hash === a.getAttribute('href').slice(1) || (a.dataset.root && hash.startsWith(a.dataset.root))));
    const root = h('div', { class: 'view' });
    if (!token) {
      document.body.classList.add('anon');
      await viewLogin(root);
    } else {
      document.body.classList.remove('anon');
      const [, page, arg] = hash.split('/');
      if (page === 'objects' && arg) await viewObject(root, decodeURIComponent(arg));
      else if (page === 'robots') await viewRobots(root);
      else if (page === 'skills') await viewSkills(root);
      else if (page === 'settings') await viewSettings(root);
      else await viewHome(root, page === 'pair' ? arg : undefined);
    }
    main.replaceChildren(root);
  } catch (e) {
    if (token) main.replaceChildren(h('p', { class: 'error' }, `${t('error')}: ${e.message}`));
  } finally {
    rendering = false;
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  }
}

let source;
let debounce;
function connect() {
  source?.close();
  if (!token) return;
  source = new EventSource(`/v0/stream?token=${enc(token)}`);
  source.onopen = () => {
    statusDot.className = 'live on';
    statusDot.title = t('live');
  };
  source.onerror = () => {
    statusDot.className = 'live off';
    statusDot.title = t('offline');
  };
  const refresh = () => {
    clearTimeout(debounce);
    debounce = setTimeout(render, 250);
  };
  source.addEventListener('event', refresh);
  source.addEventListener('inbox', refresh);
}

function logout() {
  token = null;
  store.set(null);
  source?.close();
  location.hash = '#/';
  render();
}

function start() {
  connect();
  render();
}

document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
window.addEventListener('hashchange', render);
start();
