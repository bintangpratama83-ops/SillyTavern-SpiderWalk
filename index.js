/**
 * 🕸️ Spider Walk Web — SillyTavern extension
 *
 * Builds a web of knots (people, places, things, secrets, promises, plans...) from the character card,
 * the active lorebooks and the chat, joined by strands. Before every generation a spider lands on what
 * the newest messages name, hops along the strands, and injects the few connected threads that pull
 * hardest but are not already in view.
 *
 * - The crawl is pure JavaScript (no API call), so it never slows down or blocks a generation.
 * - Story memory is grown in the background by a helper model: the current connection, or any
 *   Connection Profile (OpenRouter, NanoGPT, ...). API keys stay in SillyTavern's secret store.
 */
import {
    emptyWeb, ensureWeb, norm, cleanText, upsertKnot, upsertStrand, removeKnot, findKnot, hebbian, prune,
    buildLoreKnots, linkLoreToWeb, crawl, formatInjection, walkSnapshot, parseHelperJSON, applyHelperResult, KINDS,
} from './src/web.js';
import { HELPER_SYSTEM, helperUserPrompt } from './src/prompts.js';

const MODULE = 'spider_walk_web';
const META_KEY = 'spider_walk_web';
const LOG = '[SpiderWalk]';
const FOLDER = new URL('.', import.meta.url).pathname.replace(/^.*\/scripts\/extensions\//, '').replace(/\/$/, '');

const DEFAULTS = Object.freeze({
    enabled: true,
    // crawl
    hops: 3,
    decay: 0.6,
    topK: 3,
    seedNotes: 2,
    windowMessages: 3,
    dormantAfter: 20,
    useLore: true,
    loreScope: 'story',          // 'story' = character + chat + persona books; 'all' = also global books
    loreSkip: [],                // book names never walked
    useMemory: true,
    hebbian: true,
    stripLedger: true,
    // inject
    injectMode: 'auto',          // 'auto' | 'macro'
    position: 1,                 // extension_prompt_types: 0 in-prompt, 1 in-chat, 2 before-prompt
    depth: 1,
    role: 0,                     // 0 system, 1 user, 2 assistant
    maxChars: 1400,
    loreChars: 350,
    // helper model
    helperSource: 'main',        // 'off' | 'main' | 'profile'
    helperProfileId: '',
    helperMaxTokens: 4000,       // thinking models spend tokens on reasoning before the JSON
    autoBuild: true,
    buildEvery: 4,               // AI replies between background updates
    buildWindow: 12,             // messages sent to the helper per update
    msgCharLimit: 1500,
    cardCharLimit: 5000,
    maxKnots: 150,
    maxStrands: 400,
    toasts: true,
});

/* ---------------------------------------------------------------- state */

let lastInjection = '';
let building = false;
let generating = false;
let loreCache = new Map();          // book name -> { data, at }
let scriptModule = null;            // live bindings to /script.js (is_send_press), loaded lazily
let worldInfoModule = null;         // live bindings to /scripts/world-info.js (selected_world_info, world_info)
const debug = { helper: null };     // tests can set debug.helper = async (system, user) => 'json'

const ctx = () => SillyTavern.getContext();

const SETTINGS_VERSION = 2;

function settings() {
    const all = ctx().extensionSettings;
    const saved = all[MODULE] || {};
    const merged = Object.assign({}, DEFAULTS, saved);
    if ((saved._v || 1) < 2) {
        // 0.1.0 -> 0.2.0: the old 1200-token helper default was too small for thinking models
        if (Number(saved.helperMaxTokens) === 1200) merged.helperMaxTokens = DEFAULTS.helperMaxTokens;
        merged._v = SETTINGS_VERSION;
    }
    if (!Array.isArray(merged.loreSkip)) merged.loreSkip = [];
    all[MODULE] = merged;
    return merged;
}

function save() { ctx().saveSettingsDebounced(); }

function getWeb() {
    const meta = ctx().chatMetadata;
    if (!meta) return emptyWeb();
    meta[META_KEY] = ensureWeb(meta[META_KEY]);
    return meta[META_KEY];
}

function saveWeb() {
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else c.saveMetadata();
}

function hasChat() {
    const c = ctx();
    return !!(c.chatId || c.getCurrentChatId?.()) && (c.characterId !== undefined || c.groupId);
}

function toast(kind, msg) {
    if (settings().toasts || kind === 'error') toastr[kind](msg, 'Spider Walk');
}

async function loadCoreModules() {
    if (!scriptModule) scriptModule = await import('../../../../script.js').catch(() => null);
    if (!worldInfoModule) worldInfoModule = await import('../../../world-info.js').catch(() => null);
}

/* ---------------------------------------------------------------- characters, card, lore */

function activeCharacters() {
    const c = ctx();
    if (c.groupId) {
        const group = (c.groups || []).find(g => g.id === c.groupId);
        return (group?.members || []).map(av => c.characters.find(ch => ch.avatar === av)).filter(Boolean);
    }
    const ch = c.characters?.[c.characterId];
    return ch ? [ch] : [];
}

/** Card owner + persona become 'self' knots: they anchor the web but are never "found". */
function ensureSelfKnots(web) {
    const c = ctx();
    for (const ch of activeCharacters()) {
        const first = String(ch.name || '').split(/\s+/)[0];
        upsertKnot(web, { name: ch.name, kind: 'self', aliases: first !== ch.name ? [first] : [], source: 'self' });
    }
    if (c.name1) upsertKnot(web, { name: c.name1, kind: 'self', source: 'self' });
}

function cardText(limit) {
    const c = ctx();
    const parts = [];
    for (const ch of activeCharacters()) {
        const d = ch.data || {};
        const fields = [
            ['Name', ch.name], ['Description', d.description ?? ch.description], ['Personality', d.personality ?? ch.personality],
            ['Scenario', d.scenario ?? ch.scenario], ['First message', d.first_mes ?? ch.first_mes],
        ];
        parts.push(fields.filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n'));
    }
    let text = parts.join('\n\n');
    text = c.substituteParams ? c.substituteParams(text) : text;
    return cleanText(text).slice(0, limit);
}

function cardKey() {
    return activeCharacters().map(ch => ch.avatar).join(',');
}

/**
 * Every lorebook active for this chat, with where it comes from.
 * kind: 'character' (primary or extra character book), 'chat', 'persona', 'global'
 */
function activeBooks() {
    const c = ctx();
    const out = new Map();
    const add = (name, kind) => { if (name && !out.has(name)) out.set(name, kind); };
    for (const ch of activeCharacters()) {
        add(ch.data?.extensions?.world, 'character');
        const fileName = String(ch.avatar || '').replace(/\.[^/.]+$/, '');
        const extra = worldInfoModule?.world_info?.charLore?.find(e => e.name === fileName);
        for (const b of extra?.extraBooks || []) add(b, 'character');
    }
    add(c.chatMetadata?.world_info, 'chat');
    add(c.powerUserSettings?.persona_description_lorebook, 'persona');
    for (const b of worldInfoModule?.selected_world_info || []) add(b, 'global');
    return [...out.entries()].map(([name, kind]) => ({ name, kind }));
}

/**
 * Books the spider walks. Global books are usually rules, styles or sound libraries rather than story,
 * and their entries reference each other constantly, so by default only story books are walked.
 */
function walkBooks() {
    const s = settings();
    const skip = new Set(s.loreSkip || []);
    return activeBooks().filter(b => !skip.has(b.name) && (s.loreScope === 'all' || b.kind !== 'global'));
}

async function loadBooks(list = walkBooks()) {
    const c = ctx();
    const books = [];
    for (const { name } of list) {
        try {
            let entry = loreCache.get(name);
            if (!entry) {
                const data = await c.loadWorldInfo(name);
                entry = { data };
                loreCache.set(name, entry);
            }
            if (entry.data?.entries) books.push({ name, entries: entry.data.entries });
        } catch (e) {
            console.warn(LOG, 'could not load lorebook', name, e);
        }
    }
    return books;
}

function subst(text) {
    const c = ctx();
    try { return c.substituteParams ? c.substituteParams(String(text ?? '')) : String(text ?? ''); } catch { return String(text ?? ''); }
}

async function loreLayer(web) {
    if (!settings().useLore) return { knots: [], strands: [] };
    const lore = buildLoreKnots(await loadBooks(), { subst });
    lore.strands.push(...linkLoreToWeb(lore.knots, Object.values(web.knots)));
    return lore;
}

/* ---------------------------------------------------------------- the walk (runs before every generation) */

function messageWindows(chatArr, n) {
    const s = settings();
    const out = [];
    const weights = [1, 0.7, 0.5, 0.4, 0.3, 0.25];
    for (let i = chatArr.length - 1; i >= 0 && out.length < n; i--) {
        const m = chatArr[i];
        if (!m || m.is_system) continue;
        const text = cleanText(m.mes, { stripLedger: s.stripLedger });
        if (text) out.push({ text, weight: weights[out.length] ?? 0.2 });
    }
    return out;
}

async function runWalk(chatArr) {
    const s = settings();
    const c = ctx();
    const web = getWeb();
    ensureSelfKnots(web);
    const memoryWeb = s.useMemory ? web : { ...web, knots: Object.fromEntries(Object.entries(web.knots).filter(([, k]) => k.source !== 'memory')) };
    const lore = await loreLayer(web);
    const result = crawl({
        web: memoryWeb, lore, windows: messageWindows(chatArr, s.windowMessages), hops: s.hops, decay: s.decay,
        topK: s.topK, currentIndex: (c.chat?.length || chatArr.length) - 1, dormantAfter: s.dormantAfter,
    });
    const text = formatInjection(result, { maxChars: s.maxChars, loreChars: s.loreChars, seedNotes: s.seedNotes });
    web.lastWalk = walkSnapshot(result);
    return { result, text };
}

function clearPrompt() {
    try { ctx().setExtensionPrompt(MODULE, '', 1, 0); } catch { /* ignore */ }
}

function applyPrompt(text) {
    const s = settings();
    if (s.injectMode === 'auto' && text) ctx().setExtensionPrompt(MODULE, text, Number(s.position), Number(s.depth), false, Number(s.role));
    else clearPrompt();
}

/** Generation interceptor (declared in manifest.json). Runs before World Info and extension prompts are built. */
globalThis.spiderWalkInterceptor = async function (chatArr, _contextSize, _abort, type) {
    const s = settings();
    if (!s.enabled || type === 'quiet' || !hasChat()) { lastInjection = ''; clearPrompt(); return; }
    try {
        await loadCoreModules();
        const { text } = await runWalk(chatArr);
        lastInjection = text;
        applyPrompt(text);
        updateStatus();
    } catch (e) {
        console.error(LOG, 'walk failed', e);
        lastInjection = '';
        clearPrompt();
    }
};

/* ---------------------------------------------------------------- memory builder (helper model) */

async function waitUntilIdle(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const busy = generating || (scriptModule && scriptModule.is_send_press);
        if (!busy) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

async function callHelper(system, user) {
    const s = settings();
    const c = ctx();
    if (debug.helper) { const r = await debug.helper(system, user); return typeof r === 'string' ? { text: r, reasoning: '' } : r; }
    if (s.helperSource === 'profile') {
        if (!s.helperProfileId) throw new Error('Pick a connection profile for the helper model.');
        const res = await c.ConnectionManagerRequestService.sendRequest(
            s.helperProfileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            Number(s.helperMaxTokens),
            { stream: false, extractData: true, includePreset: false, includeInstruct: true },
        );
        return typeof res === 'string' ? { text: res, reasoning: '' } : { text: res?.content ?? '', reasoning: res?.reasoning ?? '' };
    }
    if (s.helperSource === 'main') {
        await waitUntilIdle();
        const text = await c.generateRaw({ prompt: user, systemPrompt: system, responseLength: Number(s.helperMaxTokens) });
        return { text, reasoning: '' };
    }
    throw new Error('Helper model is off.');
}

function chatSlice(fromIndex, toIndex) {
    const c = ctx();
    const s = settings();
    const lines = [];
    for (let i = Math.max(0, fromIndex); i <= toIndex && i < c.chat.length; i++) {
        const m = c.chat[i];
        if (!m || m.is_system) continue;
        const text = cleanText(m.mes, { stripLedger: s.stripLedger }).slice(0, s.msgCharLimit);
        if (text) lines.push(`${m.name || (m.is_user ? c.name1 : c.name2)}: ${text}`);
    }
    return lines.join('\n\n');
}

/**
 * Grow the web from the card (first time per chat) and the newest messages.
 * @param {{force?: boolean, full?: boolean}} opts full = re-read the card and the last buildWindow messages
 */
async function buildWeb({ force = false, full = false } = {}) {
    const s = settings();
    if (building || !hasChat()) return null;
    if (s.helperSource === 'off' && !debug.helper) { if (force) toast('warning', 'Helper model is off. Pick one under Memory builder.'); return null; }
    building = true;
    updateStatus('building…');
    try {
        await loadCoreModules();
        const c = ctx();
        const web = getWeb();
        ensureSelfKnots(web);
        const last = c.chat.length - 1;
        const needCard = full || web.seededFor !== cardKey();
        const from = full ? last - s.buildWindow + 1 : Math.max(web.builtUpTo + 1, last - s.buildWindow + 1);
        const lore = s.useLore ? buildLoreKnots(await loadBooks(), { subst }) : { knots: [] };
        const user = helperUserPrompt({
            card: needCard ? cardText(s.cardCharLimit) : '',
            loreTitles: lore.knots.slice(0, 80).map(k => k.name),
            existing: Object.values(web.knots).filter(k => k.source !== 'self').slice(-80).map(k => ({ name: k.name, kind: k.kind })),
            chat: chatSlice(from, last),
        });
        const reply = await callHelper(HELPER_SYSTEM, user);
        // some providers put everything in the reasoning field when the model runs out of room
        const obj = parseHelperJSON(reply.text) || parseHelperJSON(reply.reasoning);
        if (!obj) {
            console.warn(LOG, 'helper reply had no usable JSON:', reply);
            const why = !String(reply.text || '').trim()
                ? 'The helper model returned nothing. A thinking model may have used all its tokens on reasoning: raise "Helper max tokens" or pick a non-thinking model in a connection profile.'
                : 'The helper model did not return usable JSON. Pick a model that follows instructions well, or raise "Helper max tokens".';
            buildFailed(web, why, force);
            return null;
        }
        // card knots are labelled 'card' on the first (card-reading) pass
        const res = applyHelperResult(web, obj, last, needCard && web.builtUpTo < 0 ? 'card' : 'memory');
        web.builtUpTo = last;
        web.lastBuild = { at: Date.now(), ok: true, msg: `+${res.added} knots, ${res.updated} updated, ${res.strands} strands` };
        if (needCard) web.seededFor = cardKey();
        prune(web, s.maxKnots, s.maxStrands);
        saveWeb();
        if (force || res.added) toast('success', `Web updated: +${res.added} knots, ${res.updated} updated, ${res.strands} strands.`);
        return res;
    } catch (e) {
        console.error(LOG, 'build failed', e);
        buildFailed(getWeb(), `Build failed: ${e.message || e}`, true);
        return null;
    } finally {
        building = false;
        updateStatus();
    }
}

const failToastShown = new Set();

/** Record a failed build in the web (shown in the status line) and tell the user once per chat. */
function buildFailed(web, msg, force) {
    if (web) { web.lastBuild = { at: Date.now(), ok: false, msg }; saveWeb(); }
    const chatId = ctx().getCurrentChatId?.() || '';
    if (force || !failToastShown.has(chatId)) {
        failToastShown.add(chatId);
        toastr.warning(msg, 'Spider Walk', { timeOut: 12000 });
    }
}

/* ---------------------------------------------------------------- events */

function onMessage(messageId) {
    const s = settings();
    if (!s.enabled || !hasChat()) return;
    const c = ctx();
    const idx = Number(messageId);
    const m = c.chat?.[idx];
    if (!m) return;
    const web = getWeb();
    if (s.hebbian) {
        hebbian(web, norm(cleanText(m.mes, { stripLedger: s.stripLedger })), idx);
        saveWeb();
    }
}

function onReply(messageId, type) {
    onMessage(messageId);
    const s = settings();
    if (!s.enabled || !s.autoBuild || s.helperSource === 'off' || type === 'quiet') return;
    const c = ctx();
    const web = getWeb();
    const aiSince = c.chat.slice(Math.max(0, web.builtUpTo + 1)).filter(m => !m.is_user && !m.is_system).length;
    const firstTime = web.builtUpTo < 0 && c.chat.length >= 2;
    if (aiSince >= s.buildEvery || firstTime) {
        // let the main generation fully finish first
        setTimeout(() => buildWeb(), 1500);
    }
}

function onChatChanged() {
    lastInjection = '';
    clearPrompt();
    updateStatus();
    renderBookList();
}

const KIND_LABEL = { character: 'character', chat: 'chat', persona: 'persona', global: 'global' };

/** Checklist of this chat's active lorebooks: which ones the spider walks. */
function renderBookList() {
    const box = document.getElementById('spiderwalk_books');
    if (!box) return;
    const s = settings();
    const books = hasChat() ? activeBooks() : [];
    if (!books.length) { box.innerHTML = '<small class="spiderwalk-muted">No active lorebooks in this chat.</small>'; return; }
    const skip = new Set(s.loreSkip || []);
    box.innerHTML = books.map((b, i) => {
        const offByScope = s.loreScope !== 'all' && b.kind === 'global';
        const on = !offByScope && !skip.has(b.name);
        return `<label class="checkbox_label spiderwalk-book" for="spiderwalk_book_${i}" title="${offByScope ? 'Global books are skipped while “Story lorebooks only” is selected' : ''}">
            <input id="spiderwalk_book_${i}" type="checkbox" data-book="${esc(b.name)}" ${on ? 'checked' : ''} ${offByScope ? 'disabled' : ''}>
            <span>${esc(b.name)} <span class="spiderwalk-badge">${KIND_LABEL[b.kind]}</span></span></label>`;
    }).join('');
    box.querySelectorAll('input[data-book]').forEach(el => el.addEventListener('change', () => {
        const st = settings();
        const set = new Set(st.loreSkip || []);
        if (el.checked) set.delete(el.dataset.book); else set.add(el.dataset.book);
        st.loreSkip = [...set];
        save();
    }));
}

/* ---------------------------------------------------------------- UI: settings drawer */

function statusText() {
    if (!hasChat()) return 'No chat open.';
    const w = getWeb();
    const knots = Object.values(w.knots).filter(k => k.source !== 'self').length;
    const strands = Object.keys(w.strands).length;
    const built = w.builtUpTo >= 0 ? `memory up to message #${w.builtUpTo}` : 'memory not built yet';
    const fail = w.lastBuild && !w.lastBuild.ok ? ' · ⚠ last build failed (see Open web)' : '';
    return `${knots} knots · ${strands} strands · ${built}${fail}`;
}

function updateStatus(extra) {
    const el = document.getElementById('spiderwalk_status');
    if (el) el.textContent = extra ? `${statusText()} · ${extra}` : statusText();
}

function profileOptions() {
    const c = ctx();
    try {
        return c.ConnectionManagerRequestService.getSupportedProfiles().map(p => ({ id: p.id, name: p.name }));
    } catch {
        return [];
    }
}

function fillProfiles() {
    const sel = document.getElementById('spiderwalk_profile');
    if (!sel) return;
    const s = settings();
    const opts = profileOptions();
    sel.innerHTML = '<option value="">— pick a profile —</option>' + opts.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    sel.value = opts.some(o => o.id === s.helperProfileId) ? s.helperProfileId : '';
    document.getElementById('spiderwalk_profile_row')?.classList.toggle('displayNone', s.helperSource !== 'profile');
}

const BINDINGS = [
    // [element id, setting key, type]
    ['spiderwalk_enabled', 'enabled', 'bool'],
    ['spiderwalk_hops', 'hops', 'int'],
    ['spiderwalk_decay', 'decay', 'float'],
    ['spiderwalk_topk', 'topK', 'int'],
    ['spiderwalk_seednotes', 'seedNotes', 'int'],
    ['spiderwalk_window', 'windowMessages', 'int'],
    ['spiderwalk_dormant', 'dormantAfter', 'int'],
    ['spiderwalk_uselore', 'useLore', 'bool'],
    ['spiderwalk_lorescope', 'loreScope', 'str'],
    ['spiderwalk_usememory', 'useMemory', 'bool'],
    ['spiderwalk_hebbian', 'hebbian', 'bool'],
    ['spiderwalk_stripledger', 'stripLedger', 'bool'],
    ['spiderwalk_mode', 'injectMode', 'str'],
    ['spiderwalk_position', 'position', 'int'],
    ['spiderwalk_depth', 'depth', 'int'],
    ['spiderwalk_role', 'role', 'int'],
    ['spiderwalk_maxchars', 'maxChars', 'int'],
    ['spiderwalk_lorechars', 'loreChars', 'int'],
    ['spiderwalk_source', 'helperSource', 'str'],
    ['spiderwalk_profile', 'helperProfileId', 'str'],
    ['spiderwalk_maxtokens', 'helperMaxTokens', 'int'],
    ['spiderwalk_autobuild', 'autoBuild', 'bool'],
    ['spiderwalk_buildevery', 'buildEvery', 'int'],
    ['spiderwalk_buildwindow', 'buildWindow', 'int'],
    ['spiderwalk_toasts', 'toasts', 'bool'],
];

function bindSettings() {
    const s = settings();
    for (const [id, key, type] of BINDINGS) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (type === 'bool') el.checked = !!s[key];
        else el.value = String(s[key]);
        el.addEventListener(type === 'bool' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
            const st = settings();
            if (type === 'bool') st[key] = el.checked;
            else if (type === 'int') { const v = parseInt(el.value, 10); if (!Number.isNaN(v)) st[key] = v; }
            else if (type === 'float') { const v = parseFloat(el.value); if (!Number.isNaN(v)) st[key] = v; }
            else st[key] = el.value;
            if (key === 'helperSource') fillProfiles();
            if (key === 'loreScope') { loreCache.clear(); renderBookList(); }
            if (key === 'enabled' && !st.enabled) clearPrompt();
            if (key === 'injectMode' || key === 'position') document.getElementById('spiderwalk_depth_row')?.classList.toggle('displayNone', Number(st.position) !== 1);
            save();
        });
    }
    document.getElementById('spiderwalk_depth_row')?.classList.toggle('displayNone', Number(s.position) !== 1);
    fillProfiles();
    renderBookList();
    $('#spiderwalk_settings .inline-drawer-toggle').on('click', () => setTimeout(renderBookList, 0));
    $('#spiderwalk_open').on('click', () => openViewer());
    $('#spiderwalk_build').on('click', () => buildWeb({ force: true, full: true }));
    $('#spiderwalk_preview').on('click', () => previewWalk());
    $('#spiderwalk_clear').on('click', () => clearWeb());
}

/* ---------------------------------------------------------------- UI: viewer popup */

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const SRC_LABEL = { self: 'card', card: 'card', memory: 'memory', manual: 'pinned', lore: 'lore', co: 'seen together' };

/** Radial picture of the last walk: what's in view in the middle, each hop on a ring further out. */
function walkSvg(walk) {
    if (!walk || !walk.reached?.length) return '<div class="spiderwalk-empty">No walk yet. Send a message, or press <b>Preview walk</b>.</div>';
    const onPath = new Set((walk.picks || []).flatMap(p => p.path));
    const finals = new Set((walk.picks || []).map(p => p.id));
    const pathEdges = new Set();
    for (const p of walk.picks || []) for (let i = 1; i < p.path.length; i++) pathEdges.add([p.path[i - 1], p.path[i]].sort().join('|'));
    const rings = {};
    for (const n of walk.reached) (rings[n.hop] = rings[n.hop] || []).push(n);
    // ring radius grows with how many knots sit on it, so labels don't pile up
    const pos = {}; let prev = 0;
    for (const h of Object.keys(rings).map(Number).sort((a, b) => a - b)) {
        const list = rings[h];
        const r = h === 0 && list.length === 1 ? 0 : Math.max(prev + 95, (list.length * 105) / (2 * Math.PI));
        list.forEach((n, i) => {
            const a = (2 * Math.PI * i) / list.length - Math.PI / 2 + h * 0.5;
            pos[n.id] = [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))];
        });
        prev = r;
    }
    const xs = Object.values(pos).map(p => p[0]); const ys = Object.values(pos).map(p => p[1]);
    const minX = Math.min(...xs) - 75; const maxX = Math.max(...xs) + 75;
    const minY = Math.min(...ys) - 30; const maxY = Math.max(...ys) + 40;
    let edges = ''; let dots = '';
    for (const [a, b] of walk.links || []) {
        if (!pos[a] || !pos[b]) continue;
        const on = pathEdges.has([a, b].sort().join('|'));
        edges += `<line x1="${pos[a][0]}" y1="${pos[a][1]}" x2="${pos[b][0]}" y2="${pos[b][1]}" class="sw-edge${on ? ' sw-edge-on' : ''}"/>`;
    }
    if (!walk.links) { // older snapshots: draw the parent links only
        for (const n of walk.reached) if (n.parent && pos[n.parent]) {
            const on = pathEdges.has([n.id, n.parent].sort().join('|'));
            edges += `<line x1="${pos[n.parent][0]}" y1="${pos[n.parent][1]}" x2="${pos[n.id][0]}" y2="${pos[n.id][1]}" class="sw-edge${on ? ' sw-edge-on' : ''}"/>`;
        }
    }
    for (const n of walk.reached) {
        const [x, y] = pos[n.id];
        const cls = n.seed ? 'sw-seed' : finals.has(n.id) ? 'sw-pick' : onPath.has(n.id) ? 'sw-path' : 'sw-node';
        const label = n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name;
        dots += `<g class="${cls}"><circle cx="${x}" cy="${y}" r="${n.seed || finals.has(n.id) ? 10 : 7}"><title>${esc(n.name)} · ${esc(n.kind)} · ${esc(SRC_LABEL[n.source] || n.source)} · pull ${n.act}</title></circle>`
            + `<text x="${x}" y="${y + 26}" text-anchor="middle">${esc(label)}</text></g>`;
    }
    const found = (walk.picks || []).map(p => p.path.map(id => esc(walk.reached.find(n => n.id === id)?.name || id)).join(' <span class="spiderwalk-muted">then</span> ')).map(t => `<li>${t}</li>`).join('');
    return `<svg class="spiderwalk-svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" role="img" aria-label="Last spider walk">${edges}${dots}</svg>
        <div class="spiderwalk-legend"><span class="lg sw-seed">in view</span><span class="lg sw-path">on the path</span><span class="lg sw-pick">found</span><span class="lg sw-node">reached</span></div>
        ${found ? `<div class="spiderwalk-paths"><b>Paths walked</b><ol>${found}</ol></div>` : '<div class="spiderwalk-empty">Nothing new found beyond what is already in view.</div>'}`;
}

function knotRow(k, degree) {
    return `<div class="spiderwalk-card" data-id="${esc(k.id)}">
        <div class="spiderwalk-card-head">
            <b>${esc(k.name)}</b>
            <span class="spiderwalk-badge">${esc(k.kind)}</span>
            <span class="spiderwalk-badge sw-src-${esc(k.source)}">${esc(SRC_LABEL[k.source] || k.source)}</span>
            <span class="spiderwalk-muted">${degree || 0} strands</span>
        </div>
        ${k.aliases?.length ? `<div class="spiderwalk-muted">aka ${esc(k.aliases.join(', '))}</div>` : ''}
        ${k.note ? `<div class="spiderwalk-note">${esc(k.note)}</div>` : ''}
        ${k.source === 'self' ? '' : `<div class="spiderwalk-actions">
            <div class="menu_button sw-edit" title="Edit"><i class="fa-solid fa-pen"></i></div>
            <div class="menu_button sw-pin" title="${k.pinned ? 'Unpin' : 'Pin (never pruned)'}"><i class="fa-solid fa-thumbtack${k.pinned ? '' : ' sw-dim'}"></i></div>
            <div class="menu_button sw-del" title="Delete"><i class="fa-solid fa-trash"></i></div>
        </div>`}
    </div>`;
}

function strandRow(key, s, web) {
    const a = web.knots[s.a]?.name || s.a; const b = web.knots[s.b]?.name || s.b;
    return `<div class="spiderwalk-card spiderwalk-strand" data-key="${esc(key)}">
        <div class="spiderwalk-card-head"><b>${esc(a)}</b><span class="spiderwalk-muted">and</span><b>${esc(b)}</b>
            <span class="spiderwalk-badge sw-src-${esc(s.source)}">${esc(SRC_LABEL[s.source] || s.source)} · ${Math.round(s.w * 100) / 100}</span></div>
        ${s.why ? `<div class="spiderwalk-note">${esc(s.why)}</div>` : ''}
        <div class="spiderwalk-actions"><div class="menu_button sw-sdel" title="Delete strand"><i class="fa-solid fa-trash"></i></div></div>
    </div>`;
}

async function openViewer(tab = 'walk') {
    if (!hasChat()) { toast('info', 'Open a chat first.'); return; }
    const c = ctx();
    const root = document.createElement('div');
    root.className = 'spiderwalk-viewer';
    const render = (active) => {
        const web = getWeb();
        const degree = {};
        for (const s of Object.values(web.strands)) { degree[s.a] = (degree[s.a] || 0) + 1; degree[s.b] = (degree[s.b] || 0) + 1; }
        const knots = Object.values(web.knots).sort((x, y) => (x.source === 'self' ? -1 : 0) - (y.source === 'self' ? -1 : 0) || (y.lastSeen ?? -1) - (x.lastSeen ?? -1));
        const strands = Object.entries(web.strands).sort((x, y) => y[1].w - x[1].w);
        root.innerHTML = `
            <h3 class="spiderwalk-title">🕸️ Spider Walk Web</h3>
            <div class="spiderwalk-muted">${esc(statusText())}</div>
            ${web.lastBuild ? `<div class="spiderwalk-build ${web.lastBuild.ok ? 'ok' : 'bad'}">${web.lastBuild.ok ? 'Last build' : '⚠ Last build failed'}: ${esc(web.lastBuild.msg)}</div>` : ''}
            <div class="spiderwalk-muted">Walking: ${esc(walkBooks().map(b => b.name).join(', ') || 'no lorebooks')}${settings().useMemory ? ' + story memory' : ''}</div>
            <div class="spiderwalk-tabs" role="tablist">
                <div class="menu_button sw-tab${active === 'walk' ? ' active' : ''}" data-tab="walk">Last walk</div>
                <div class="menu_button sw-tab${active === 'knots' ? ' active' : ''}" data-tab="knots">Knots (${knots.length})</div>
                <div class="menu_button sw-tab${active === 'strands' ? ' active' : ''}" data-tab="strands">Strands (${strands.length})</div>
                <div class="menu_button sw-tab${active === 'inject' ? ' active' : ''}" data-tab="inject">Injected text</div>
            </div>
            <div class="spiderwalk-body">
            ${active === 'walk' ? walkSvg(web.lastWalk) : ''}
            ${active === 'knots' ? `<div class="spiderwalk-toolbar"><input class="text_pole sw-search" type="search" placeholder="Search knots…">
                <div class="menu_button sw-add"><i class="fa-solid fa-plus"></i> Add knot</div></div>
                <div class="sw-list">${knots.map(k => knotRow(k, degree[k.id])).join('') || '<div class="spiderwalk-empty">No knots yet.</div>'}</div>` : ''}
            ${active === 'strands' ? `<div class="spiderwalk-toolbar"><div class="menu_button sw-addstrand"><i class="fa-solid fa-plus"></i> Add strand</div></div>
                <div class="sw-list">${strands.map(([key, s]) => strandRow(key, s, web)).join('') || '<div class="spiderwalk-empty">No strands yet.</div>'}</div>` : ''}
            ${active === 'inject' ? `<pre class="spiderwalk-pre">${esc(lastInjection || '(nothing injected on the last generation)')}</pre>` : ''}
            </div>`;
        root.querySelectorAll('.sw-tab').forEach(el => el.addEventListener('click', () => render(el.dataset.tab)));
        root.querySelector('.sw-search')?.addEventListener('input', (ev) => {
            const q = norm(ev.target.value);
            root.querySelectorAll('.sw-list .spiderwalk-card').forEach(card => {
                card.classList.toggle('displayNone', !!q && !norm(card.textContent).includes(q));
            });
        });
        root.querySelectorAll('.sw-del').forEach(el => el.addEventListener('click', async () => {
            const id = el.closest('.spiderwalk-card').dataset.id;
            if (await c.Popup.show.confirm('Delete knot?', esc(web.knots[id]?.name))) { removeKnot(web, id); saveWeb(); render('knots'); }
        }));
        root.querySelectorAll('.sw-pin').forEach(el => el.addEventListener('click', () => {
            const k = web.knots[el.closest('.spiderwalk-card').dataset.id];
            if (k) { k.pinned = !k.pinned; if (k.pinned && k.source === 'memory') k.source = 'manual'; saveWeb(); render('knots'); }
        }));
        root.querySelectorAll('.sw-edit').forEach(el => el.addEventListener('click', async () => {
            const k = web.knots[el.closest('.spiderwalk-card').dataset.id];
            if (!k) return;
            const note = await c.Popup.show.input(`Edit "${esc(k.name)}"`, 'What matters about it now (one sentence):', k.note || '', { rows: 3 });
            if (note === null || note === undefined) return;
            k.note = String(note).trim().slice(0, 280);
            const aliases = await c.Popup.show.input('Other names', 'Comma-separated aliases:', (k.aliases || []).join(', '));
            if (aliases !== null && aliases !== undefined) k.aliases = String(aliases).split(',').map(x => x.trim()).filter(Boolean).slice(0, 6);
            saveWeb(); render('knots');
        }));
        root.querySelector('.sw-add')?.addEventListener('click', async () => {
            const name = await c.Popup.show.input('Add knot', 'Name (a person, place, thing, secret, promise…):', '');
            if (!name) return;
            const kind = await c.Popup.show.input('Kind', `One of: ${KINDS.filter(k => k !== 'self' && k !== 'lore').join(', ')}`, 'thing');
            const note = await c.Popup.show.input('Note', 'What matters about it now:', '', { rows: 3 });
            upsertKnot(web, { name, kind: kind || 'thing', note: note || '', source: 'manual', pinned: true }, c.chat.length - 1);
            saveWeb(); render('knots');
        });
        root.querySelectorAll('.sw-sdel').forEach(el => el.addEventListener('click', () => {
            const key = el.closest('.spiderwalk-card').dataset.key;
            delete web.strands[key]; delete web.co[key]; saveWeb(); render('strands');
        }));
        root.querySelector('.sw-addstrand')?.addEventListener('click', async () => {
            const a = await c.Popup.show.input('Add strand', 'First knot name:', '');
            if (!a) return;
            const b = await c.Popup.show.input('Add strand', 'Second knot name:', '');
            if (!b) return;
            const why = await c.Popup.show.input('Add strand', 'Why are they connected?', '');
            if (!findKnot(web, a)) upsertKnot(web, { name: a, source: 'manual' }, c.chat.length - 1);
            if (!findKnot(web, b)) upsertKnot(web, { name: b, source: 'manual' }, c.chat.length - 1);
            upsertStrand(web, a, b, why || '', 3, 'manual', c.chat.length - 1);
            saveWeb(); render('strands');
        });
    };
    render(tab);
    const popup = new c.Popup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' });
    await popup.show();
}

async function previewWalk() {
    if (!hasChat()) { toast('info', 'Open a chat first.'); return ''; }
    await loadCoreModules();
    const { text, result } = await runWalk(ctx().chat);
    saveWeb();
    lastInjection = text;
    updateStatus();
    if (!result.picks.length) toast('info', result.seeds.length ? 'The spider found nothing new beyond what is already in view.' : 'Nothing in the newest messages matches a knot yet. Build the web first.');
    openViewer('walk'); // not awaited: the command returns the text while the viewer stays open
    return text;
}

async function clearWeb() {
    if (!hasChat()) return;
    const c = ctx();
    if (!await c.Popup.show.confirm('Clear the web for this chat?', 'Story memory, strands and the last walk will be deleted. Lorebooks and the card are not touched.')) return;
    c.chatMetadata[META_KEY] = emptyWeb();
    saveWeb();
    lastInjection = '';
    clearPrompt();
    updateStatus();
    toast('success', 'Web cleared.');
}

/* ---------------------------------------------------------------- slash commands, macro, wand menu */

function registerCommands() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand } = c;
    if (!SlashCommandParser || !SlashCommand) return;
    const add = (name, helpString, callback) => SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name, callback, helpString, returns: 'string' }));
    add('spider-web', 'Open the Spider Walk web viewer.', async () => { await openViewer(); return ''; });
    add('spider-walk', 'Run the spider on the current chat now, show the walk, and return the text it would inject.', async () => previewWalk());
    add('spider-build', 'Grow the web now with the helper model (re-reads the card and recent messages).', async () => { const r = await buildWeb({ force: true, full: true }); return r ? JSON.stringify(r) : ''; });
    add('spider-clear', 'Clear the Spider Walk web for this chat.', async () => { await clearWeb(); return ''; });
}

function registerMacro() {
    const c = ctx();
    const handler = () => lastInjection || '';
    try {
        if (c.macros?.register && c.powerUserSettings?.experimental_macro_engine) {
            c.macros.register('spiderWeb', { handler, category: c.macros.category?.MISC, description: 'Threads found by the Spider Walk on the last generation.', returns: 'Injected spider web text', exampleUsage: '{{spiderWeb}}' });
        } else if (typeof c.registerMacro === 'function') {
            c.registerMacro('spiderWeb', handler, 'Threads found by the Spider Walk on the last generation.');
        }
    } catch (e) {
        console.warn(LOG, 'macro registration failed', e);
    }
}

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('spiderwalk_wand')) return;
    const btn = document.createElement('div');
    btn.id = 'spiderwalk_wand';
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.tabIndex = 0;
    btn.innerHTML = '<div class="fa-solid fa-diagram-project extensionsMenuExtensionButton"></div><span>Spider Web</span>';
    btn.addEventListener('click', () => openViewer());
    menu.appendChild(btn);
}

/* ---------------------------------------------------------------- init */

async function init() {
    const c = ctx();
    settings();
    const html = await c.renderExtensionTemplateAsync(FOLDER, 'settings');
    $('#extensions_settings2').append(html);
    bindSettings();
    addWandButton();
    registerCommands();
    registerMacro();
    loadCoreModules();

    const ev = c.eventTypes || c.event_types;
    c.eventSource.on(ev.CHAT_CHANGED, () => { generating = false; onChatChanged(); });
    c.eventSource.on(ev.MESSAGE_RECEIVED, (id, type) => { if (type !== 'quiet') generating = false; onReply(id, type); });
    c.eventSource.on(ev.MESSAGE_SENT, onMessage);
    c.eventSource.on(ev.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) generating = true; });
    c.eventSource.on(ev.GENERATION_ENDED, () => { generating = false; });
    c.eventSource.on(ev.GENERATION_STOPPED, () => { generating = false; });
    c.eventSource.on(ev.WORLDINFO_UPDATED, (name) => { if (name) loreCache.delete(name); else loreCache.clear(); });
    c.eventSource.on(ev.WORLDINFO_SETTINGS_UPDATED, () => { loreCache.clear(); renderBookList(); });
    if (ev.CONNECTION_PROFILE_LOADED) c.eventSource.on(ev.CONNECTION_PROFILE_LOADED, fillProfiles);
    updateStatus();
    console.log(LOG, 'ready', FOLDER);
}

// Expose a tiny API for power users, Quick Replies and tests.
globalThis.SpiderWalkWeb = { getWeb, buildWeb, previewWalk, openViewer, runWalk: () => runWalk(ctx().chat), settings, debug, get lastInjection() { return lastInjection; } };

jQuery(async () => {
    try { await init(); } catch (e) { console.error(LOG, 'init failed', e); }
});
