/**
 * Spider Walk Web — core engine (no SillyTavern imports, so it can be unit-tested in Node).
 *
 * The story is a web:
 *   knot   = a person, place, thing, secret, promise, plan, event, relationship or trait
 *            (from the character card, the lorebook, or story memory built from the chat)
 *   strand = a reason two knots affect each other (from the helper model, lorebook links,
 *            or "seen together" co-mentions that strengthen over time)
 *
 * Each turn the spider lands on the knots named in the newest messages and hops along strands
 * (spreading activation with decay). It brings back the few knots that pull hardest but are
 * NOT already in view, plus the path it walked to reach them.
 */

export const WEB_VERSION = 1;

export const KINDS = ['person', 'place', 'thing', 'secret', 'promise', 'plan', 'event', 'relationship', 'trait', 'lore', 'self'];
const KIND_BOOST = { secret: 1.15, promise: 1.15, plan: 1.1, relationship: 1.05 };

/* ------------------------------------------------------------------ text helpers */

/** Lowercase, Unicode-normalise, drop punctuation, collapse spaces. */
export function norm(s) {
    return String(s ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function slug(s) {
    return norm(s).replace(/[\s'-]+/g, '_').slice(0, 60) || 'x';
}

/**
 * Remove things the spider should not read: Eclipse Forge ledgers, <details> blocks, HTML tags,
 * HTML comments, code fences. Keeps the visible prose and speech.
 */
export function cleanText(s, { stripLedger = true } = {}) {
    let t = String(s ?? '');
    if (stripLedger) {
        t = t.replace(/<!--\s*EF_STATE_START\s*-->[\s\S]*?<!--\s*EF_STATE_END\s*-->/g, ' ');
        t = t.replace(/<internal_states>[\s\S]*?<\/internal_states>/gi, ' ');
        // nested <details>: remove innermost first, repeat
        for (let i = 0; i < 6 && /<details[\s>]/i.test(t); i++) {
            t = t.replace(/<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi, ' ');
        }
    }
    t = t.replace(/<!--[\s\S]*?-->/g, ' ');
    t = t.replace(/```[\s\S]*?```/g, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\s'-]+$/u;
const matcherCache = new Map();

/** Build a matcher for one term: word-boundary regex for Latin script, substring for CJK/others. */
export function termMatcher(term) {
    const n = norm(term);
    if (matcherCache.has(n)) return matcherCache.get(n);
    let fn;
    if (!n || n.length < 2 || (LATIN_ONLY.test(n) && n.length < 3)) {
        fn = () => false;
    } else if (LATIN_ONLY.test(n)) {
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
        fn = (normText) => re.test(normText);
    } else {
        fn = (normText) => normText.includes(n);
    }
    if (matcherCache.size > 5000) matcherCache.clear();
    matcherCache.set(n, fn);
    return fn;
}

/** True if any of the knot's names appears in already-normalised text. */
export function mentions(normText, knot) {
    for (const term of [knot.name, ...(knot.aliases || [])]) {
        if (termMatcher(term)(normText)) return true;
    }
    return false;
}

/* ------------------------------------------------------------------ web structure */

export function emptyWeb() {
    return { v: WEB_VERSION, knots: {}, strands: {}, co: {}, builtUpTo: -1, seededFor: '', lastWalk: null, updated: 0 };
}

/** Make sure an object loaded from chat metadata has every field (older/partial saves). */
export function ensureWeb(w) {
    const base = emptyWeb();
    if (!w || typeof w !== 'object') return base;
    for (const k of Object.keys(base)) if (w[k] === undefined) w[k] = base[k];
    return w;
}

export function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Find a knot by name or alias (normalised). */
export function findKnot(web, name) {
    const n = norm(name);
    if (!n) return null;
    for (const k of Object.values(web.knots)) {
        if (norm(k.name) === n) return k;
    }
    for (const k of Object.values(web.knots)) {
        if ((k.aliases || []).some(a => norm(a) === n)) return k;
    }
    return null;
}

function cleanKind(kind) {
    const k = norm(kind);
    return KINDS.includes(k) ? k : 'thing';
}

function cleanAliases(list, name) {
    const out = [];
    const seen = new Set([norm(name)]);
    for (const a of Array.isArray(list) ? list : []) {
        const n = norm(a);
        if (!n || seen.has(n) || n.length > 40) continue;
        seen.add(n); out.push(String(a).trim());
        if (out.length >= 6) break;
    }
    return out;
}

/**
 * Insert or update a knot. Returns the knot.
 * source: 'card' | 'memory' | 'self' | 'manual'
 */
export function upsertKnot(web, { name, kind = 'thing', aliases = [], note = '', source = 'memory', pinned = false }, msgIndex = -1) {
    name = String(name ?? '').trim().slice(0, 60);
    if (!name) return null;
    let k = findKnot(web, name);
    if (!k) {
        let id = 'k_' + slug(name);
        while (web.knots[id]) id += '_';
        k = web.knots[id] = { id, name, kind: cleanKind(kind), aliases: [], note: '', source, pinned: !!pinned, firstSeen: msgIndex, lastSeen: msgIndex, hits: 0 };
    }
    if (kind && k.source !== 'self') k.kind = cleanKind(kind);
    k.aliases = cleanAliases([...(k.aliases || []), ...(aliases || [])], k.name);
    note = String(note ?? '').trim();
    if (note) k.note = note.slice(0, 280);
    // a card/manual/self knot keeps its stronger source label
    const rank = { self: 4, manual: 3, card: 2, memory: 1 };
    if ((rank[source] || 0) > (rank[k.source] || 0)) k.source = source;
    if (pinned) k.pinned = true;
    if (msgIndex > (k.lastSeen ?? -1)) k.lastSeen = msgIndex;
    return k;
}

/** Insert or update a strand between two knot names. strength 1..3. */
export function upsertStrand(web, aName, bName, why = '', strength = 2, source = 'memory', msgIndex = -1) {
    const a = typeof aName === 'object' ? aName : findKnot(web, aName);
    const b = typeof bName === 'object' ? bName : findKnot(web, bName);
    if (!a || !b || a.id === b.id) return null;
    const key = pairKey(a.id, b.id);
    const w = Math.max(0.3, Math.min(1, (Number(strength) || 2) / 3));
    const s = web.strands[key] || (web.strands[key] = { a: a.id, b: b.id, why: '', w: 0, source, lastSeen: msgIndex });
    if (why) s.why = String(why).trim().slice(0, 160);
    s.w = Math.max(s.w, w);
    if (source !== 'co' || s.source === 'co') s.source = source;
    if (msgIndex > (s.lastSeen ?? -1)) s.lastSeen = msgIndex;
    return s;
}

export function removeKnot(web, id) {
    delete web.knots[id];
    for (const [key, s] of Object.entries(web.strands)) if (s.a === id || s.b === id) delete web.strands[key];
    for (const key of Object.keys(web.co)) if (key.split('|').includes(id)) delete web.co[key];
}

/**
 * "Fire together, wire together": knots named in the same message get a weak strand that grows
 * each time they appear together (max 0.6, so helper/lore strands stay stronger).
 */
export function hebbian(web, normText, msgIndex) {
    const hit = Object.values(web.knots).filter(k => k.source !== 'self' && mentions(normText, k));
    for (const k of hit) { k.hits = (k.hits || 0) + 1; if (msgIndex > (k.lastSeen ?? -1)) k.lastSeen = msgIndex; }
    for (let i = 0; i < hit.length; i++) {
        for (let j = i + 1; j < hit.length; j++) {
            const key = pairKey(hit[i].id, hit[j].id);
            const c = web.co[key] = (web.co[key] || 0) + 1;
            const w = Math.min(0.6, 0.2 + 0.1 * c);
            const s = web.strands[key];
            if (!s) web.strands[key] = { a: hit[i].id, b: hit[j].id, why: 'often come up together', w, source: 'co', lastSeen: msgIndex };
            else if (s.source === 'co') { s.w = Math.max(s.w, w); s.lastSeen = msgIndex; }
        }
    }
    return hit.map(k => k.id);
}

/** Keep the web from growing forever: drop the least-connected, longest-unseen memory knots. */
export function prune(web, maxKnots = 150, maxStrands = 400) {
    const knots = Object.values(web.knots);
    if (knots.length > maxKnots) {
        const degree = {};
        for (const s of Object.values(web.strands)) { degree[s.a] = (degree[s.a] || 0) + 1; degree[s.b] = (degree[s.b] || 0) + 1; }
        const removable = knots.filter(k => !k.pinned && k.source === 'memory')
            .sort((x, y) => ((x.lastSeen ?? -1) + 3 * (degree[x.id] || 0)) - ((y.lastSeen ?? -1) + 3 * (degree[y.id] || 0)));
        for (const k of removable.slice(0, knots.length - maxKnots)) removeKnot(web, k.id);
    }
    const strands = Object.entries(web.strands);
    if (strands.length > maxStrands) {
        strands.sort((x, y) => (x[1].w + (x[1].lastSeen ?? 0) / 1e4) - (y[1].w + (y[1].lastSeen ?? 0) / 1e4));
        for (const [key] of strands.slice(0, strands.length - maxStrands)) delete web.strands[key];
    }
}

/* ------------------------------------------------------------------ lorebook knots */

/**
 * Turn lorebook entries into virtual knots (not saved in the chat web; rebuilt from the books).
 * books: [{ name, entries: { uid: { uid, key:[], keysecondary:[], comment, content, disable, constant } } }]
 * Lore-to-lore strands: an entry whose text names another entry's key (like SillyTavern recursion).
 */
export function buildLoreKnots(books, { maxEntries = 400, subst = (x) => x } = {}) {
    const knots = [];
    const seen = new Set(); // the same entry in two books (e.g. two versions of one lorebook) counts once
    for (const book of books || []) {
        const entries = Object.values(book?.entries || {});
        for (const e of entries) {
            if (!e || e.disable) continue;
            const keys = (Array.isArray(e.key) ? e.key : String(e.key || '').split(','))
                .map(x => String(x).trim()).filter(x => x && !/^\/.*\/[a-z]*$/i.test(x)); // skip regex keys
            const name = subst(String(e.comment || keys[0] || '').trim());
            if (!name) continue;
            const content = subst(String(e.content || ''));
            const sig = norm(name) + '|' + norm(content).slice(0, 120);
            if (seen.has(sig)) continue;
            seen.add(sig);
            knots.push({
                id: `lore:${book.name}:${e.uid}`, name: name.slice(0, 60), kind: 'lore', aliases: keys.slice(0, 8).map(k => subst(k)),
                note: '', content, constant: !!e.constant, source: 'lore', book: book.name, uid: e.uid,
            });
            if (knots.length >= maxEntries) break;
        }
    }
    const strands = [];
    for (const a of knots) {
        const text = norm(a.content);
        if (!text) continue;
        for (const b of knots) {
            if (a === b) continue;
            if (mentions(text, b)) strands.push({ a: a.id, b: b.id, why: '', w: 0.8, source: 'lore' }); // the path already says how it was reached
        }
    }
    return { knots, strands };
}

/** Strands between lore knots and web knots: either side's text names the other. */
export function linkLoreToWeb(loreKnots, webKnots) {
    const strands = [];
    for (const l of loreKnots) {
        const lt = norm(`${l.name} ${l.content}`);
        for (const k of webKnots) {
            const kt = norm(`${k.note}`);
            if (mentions(lt, k) || (kt && mentions(kt, l))) {
                strands.push({ a: l.id, b: k.id, why: '', w: 0.7, source: 'lore' });
            }
        }
    }
    return strands;
}

/* ------------------------------------------------------------------ the walk */

/**
 * Spreading-activation crawl.
 * windows: [{ text (already cleaned), weight }], newest first.
 * Returns { seeds, picks, act, parent, hop, inView, nodes }.
 */
export function crawl({ web, lore = { knots: [], strands: [] }, windows = [], hops = 3, decay = 0.6, topK = 3,
    currentIndex = 0, dormantAfter = 20, minScore = 0.08, excludeKinds = ['self'] }) {
    const nodes = new Map();
    for (const k of Object.values(web.knots)) nodes.set(k.id, k);
    for (const k of lore.knots || []) nodes.set(k.id, k);

    const adj = new Map();
    const addEdge = (a, b, w, why) => {
        if (!nodes.has(a) || !nodes.has(b) || a === b) return;
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a).push({ to: b, w, why });
        adj.get(b).push({ to: a, w, why });
    };
    for (const s of Object.values(web.strands)) addEdge(s.a, s.b, s.w, s.why);
    for (const s of lore.strands || []) addEdge(s.a, s.b, s.w, s.why);

    // seeds: knots named in the newest messages
    const act = new Map(); const parent = new Map(); const hop = new Map(); const via = new Map();
    const inView = new Set();
    for (const win of windows) {
        const t = norm(win.text);
        if (!t) continue;
        for (const k of nodes.values()) {
            if (mentions(t, k)) {
                inView.add(k.id);
                if ((act.get(k.id) || 0) < win.weight) { act.set(k.id, win.weight); hop.set(k.id, 0); }
            }
        }
    }
    const seeds = [...act.entries()].map(([id, a]) => ({ id, act: a })).sort((x, y) => y.act - x.act);

    // hop outward
    let frontier = seeds.map(s => s.id);
    for (let h = 1; h <= hops && frontier.length; h++) {
        const next = new Set();
        for (const id of frontier) {
            const a = act.get(id) || 0;
            for (const e of adj.get(id) || []) {
                const na = a * decay * e.w;
                if (na < minScore / 2) continue;
                if (na > (act.get(e.to) || 0) + 1e-9) {
                    act.set(e.to, na); parent.set(e.to, id); hop.set(e.to, h); via.set(e.to, e.why);
                    next.add(e.to);
                }
            }
        }
        frontier = [...next];
    }

    // score what the spider reached but the scene isn't already showing
    const cands = [];
    for (const [id, a] of act) {
        if (inView.has(id) || (hop.get(id) || 0) < 1) continue;
        const k = nodes.get(id);
        if (!k || excludeKinds.includes(k.kind)) continue;
        if (k.source === 'lore' && k.constant) continue; // always-on entries are already in the prompt
        let score = a * (KIND_BOOST[k.kind] || 1);
        const dormant = k.lastSeen !== undefined && k.lastSeen >= 0 && currentIndex - k.lastSeen >= dormantAfter;
        if (dormant) score *= 1.2; // bring back what the story has been forgetting
        if (score >= minScore) cands.push({ id, score, hop: hop.get(id), dormant });
    }
    cands.sort((x, y) => y.score - x.score);
    const picks = cands.slice(0, topK).map(c => {
        const path = [c.id];
        let cur = c.id; let guard = 0;
        while (parent.has(cur) && guard++ < 10) { cur = parent.get(cur); path.unshift(cur); }
        return { ...c, path, why: via.get(c.id) || '' };
    });
    return { seeds, picks, act, parent, hop, inView, nodes, adj, candidates: cands.length };
}

/* ------------------------------------------------------------------ output */

function excerpt(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

const SOURCE_LABEL = { card: 'card', memory: 'story memory', lore: 'lorebook', manual: 'pinned', self: 'card' };

/**
 * Plain-language block for the main model. No arrows or engineering words on purpose
 * (they make some models reason like an auditor).
 */
export function formatInjection(result, { maxChars = 1400, loreChars = 350, seedNotes = 2, header = true } = {}) {
    const { picks, seeds, nodes } = result;
    if (!picks.length) return '';
    const name = id => nodes.get(id)?.name || id;
    const lines = [];
    if (header) {
        lines.push('<spider_web>');
        lines.push('Threads the spider found by following connections from this turn (character card, lorebook and story memory). Background for you, not text to copy. Use at most one, and only if it really pulls on this moment; show it through what someone does or says, never by explaining the chain. Characters only act on what they know.');
    }
    const seedLines = [];
    for (const s of seeds.slice(0, 6)) {
        const k = nodes.get(s.id);
        if (!k || !k.note || k.kind === 'self' || k.source === 'lore') continue;
        seedLines.push(`${k.name}: ${excerpt(k.note, 140)}`);
        if (seedLines.length >= seedNotes) break;
    }
    if (seedLines.length) lines.push('In view now. ' + seedLines.join(' | '));
    for (const p of picks) {
        const k = nodes.get(p.id);
        const label = `${k.kind === 'lore' ? 'lore' : k.kind}, ${SOURCE_LABEL[k.source] || k.source}${p.dormant ? ', not mentioned for a while' : ''}`;
        const path = p.path.length > 1 ? ` Reached from ${p.path.slice(0, -1).map(name).join(', then ')}.` : '';
        let body = k.source === 'lore' ? excerpt(k.content, loreChars) : excerpt(k.note, 220);
        if (p.why && !/often come up together/.test(p.why)) body += (body ? ' ' : '') + `Link: ${excerpt(p.why, 120)}.`;
        lines.push(`- ${k.name} (${label}).${path} ${body}`.trim());
    }
    if (header) lines.push('</spider_web>');
    let out = lines.join('\n');
    if (out.length > maxChars) {
        // drop picks from the end until it fits, keep the header and closing tag
        while (out.length > maxChars && lines.length > (header ? 4 : 1)) {
            lines.splice(lines.length - (header ? 2 : 1), 1);
            out = lines.join('\n');
        }
        if (out.length > maxChars) out = out.slice(0, maxChars - 20) + (header ? '…\n</spider_web>' : '…');
    }
    return out;
}

/** Snapshot for the viewer (ids and names only, small enough to save in chat metadata). */
export function walkSnapshot(result, limit = 24) {
    const reached = [...result.act.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, a]) => ({
        id, name: result.nodes.get(id)?.name || id, kind: result.nodes.get(id)?.kind || 'thing',
        source: result.nodes.get(id)?.source || '', act: Math.round(a * 100) / 100, hop: result.hop.get(id) || 0,
        parent: result.parent.get(id) || null, seed: result.inView.has(id),
    }));
    // every strand between two reached knots, so the viewer can draw the local web, not just the path
    const ids = new Set(reached.map(n => n.id));
    const seen = new Set(); const links = [];
    for (const id of ids) {
        for (const e of result.adj?.get(id) || []) {
            if (!ids.has(e.to)) continue;
            const key = id < e.to ? `${id}|${e.to}` : `${e.to}|${id}`;
            if (seen.has(key)) continue;
            seen.add(key); links.push([id, e.to, Math.round(e.w * 100) / 100]);
            if (links.length >= 80) break;
        }
    }
    return { at: Date.now(), reached, links, picks: result.picks.map(p => ({ id: p.id, path: p.path, score: Math.round(p.score * 100) / 100 })) };
}

/* ------------------------------------------------------------------ helper model I/O */

/**
 * Pull the {"knots":..., "strands":...} object out of a model reply that may contain
 * reasoning, code fences or chatter. Returns null if nothing usable.
 */
export function parseHelperJSON(text) {
    let t = String(text ?? '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ');
    const tryParse = (s) => {
        try { return JSON.parse(s); } catch { /* fall through */ }
        try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
    };
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { const o = tryParse(fence[1].trim()); if (o && (o.knots || o.strands)) return o; }
    // balanced-brace scan from each '{' that precedes a "knots" or "strands" key
    for (let start = t.indexOf('{'); start !== -1; start = t.indexOf('{', start + 1)) {
        let depth = 0; let inStr = false; let esc = false;
        for (let i = start; i < t.length; i++) {
            const c = t[i];
            if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
            if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    const o = tryParse(t.slice(start, i + 1));
                    if (o && (Array.isArray(o.knots) || Array.isArray(o.strands))) return o;
                    break;
                }
            }
        }
    }
    return null;
}

/** Merge a helper result into the web. Returns counts. */
export function applyHelperResult(web, obj, msgIndex, source = 'memory') {
    const res = { added: 0, updated: 0, strands: 0 };
    if (!obj) return res;
    for (const k of (Array.isArray(obj.knots) ? obj.knots : []).slice(0, 40)) {
        if (!k || !k.name) continue;
        const existed = !!findKnot(web, k.name);
        const kk = upsertKnot(web, { name: k.name, kind: k.kind, aliases: k.aliases, note: k.note, source }, msgIndex);
        if (kk) existed ? res.updated++ : res.added++;
    }
    for (const s of (Array.isArray(obj.strands) ? obj.strands : []).slice(0, 60)) {
        if (!s || !s.a || !s.b) continue;
        // a strand may name a knot the model forgot to list: create it as a plain thing
        if (!findKnot(web, s.a)) upsertKnot(web, { name: s.a, source }, msgIndex);
        if (!findKnot(web, s.b)) upsertKnot(web, { name: s.b, source }, msgIndex);
        if (upsertStrand(web, s.a, s.b, s.why, s.strength, source, msgIndex)) res.strands++;
    }
    web.updated = Date.now();
    return res;
}
