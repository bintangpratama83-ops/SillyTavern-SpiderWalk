// node --test test/web.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    norm, cleanText, termMatcher, emptyWeb, upsertKnot, upsertStrand, findKnot, hebbian, crawl, formatInjection,
    parseHelperJSON, applyHelperResult, buildLoreKnots, linkLoreToWeb, prune, walkSnapshot, ensureWeb,
} from '../src/web.js';

function sampleWeb() {
    const w = emptyWeb();
    upsertKnot(w, { name: 'Mira', kind: 'self', source: 'self' }, 0);
    upsertKnot(w, { name: 'The letter', kind: 'thing', note: 'Arin found it in her drawer.' }, 2);
    upsertKnot(w, { name: 'Mira\'s guilt', kind: 'trait', note: 'She broke a promise to her sister.' }, 3);
    upsertKnot(w, { name: 'Promise to Lena', kind: 'promise', aliases: ['the promise'], note: 'Mira swore to keep the farm.' }, 1);
    upsertKnot(w, { name: 'Lena', kind: 'person', aliases: ['her sister'], note: 'Arrives tomorrow; does not know the farm is sold.' }, 1);
    upsertStrand(w, 'The letter', "Mira's guilt", 'the letter is the sale contract', 3);
    upsertStrand(w, "Mira's guilt", 'Promise to Lena', 'she broke it', 3);
    upsertStrand(w, 'Promise to Lena', 'Lena', 'Lena trusts the promise', 3);
    return w;
}

test('norm and cleanText', () => {
    assert.equal(norm('  Héllo,  WORLD!! '), 'héllo world');
    const msg = 'Hi *she waves*<!-- EF_STATE_START --><internal_states><details><summary>x</summary><details>y</details></details></internal_states><!-- EF_STATE_END -->\n<font color="#fff">"Yo"</font>';
    const c = cleanText(msg);
    assert.ok(!c.includes('internal_states') && !c.includes('summary') && c.includes('"Yo"'));
});

test('termMatcher: word boundaries for Latin, substring for CJK, short terms ignored', () => {
    assert.equal(termMatcher('Lena')(norm('lena came home')), true);
    assert.equal(termMatcher('Lena')(norm('helena came home')), false);
    assert.equal(termMatcher('写真')(norm('彼は写真を持っている')), true);
    assert.equal(termMatcher('Al')(norm('al is here')), false);
});

test('crawl hops from the named thing to the hidden pull, and skips what is already in view', () => {
    const w = sampleWeb();
    const r = crawl({ web: w, windows: [{ text: 'Arin holds up the letter and stares at her.', weight: 1 }], hops: 3, decay: 0.7, topK: 2, currentIndex: 30 });
    assert.deepEqual(r.seeds.map(s => w.knots[s.id].name), ['The letter']);
    const names = r.picks.map(p => r.nodes.get(p.id).name);
    assert.ok(names.includes("Mira's guilt"));
    assert.ok(names.includes('Promise to Lena'));
    const deep = crawl({ web: w, windows: [{ text: 'the letter', weight: 1 }], hops: 3, decay: 0.9, topK: 5, currentIndex: 30 });
    const lena = deep.picks.find(p => deep.nodes.get(p.id).name === 'Lena');
    assert.ok(lena, 'Lena reached in 3 hops');
    assert.equal(lena.path.length, 4);
    assert.ok(lena.dormant, 'last seen long ago, marked dormant');
});

test('hops limit is respected', () => {
    const w = sampleWeb();
    const r = crawl({ web: w, windows: [{ text: 'the letter', weight: 1 }], hops: 1, decay: 0.9, topK: 5 });
    assert.deepEqual(r.picks.map(p => r.nodes.get(p.id).name), ["Mira's guilt"]);
});

test('self knots are never picked; no seeds means no picks', () => {
    const w = sampleWeb();
    upsertStrand(w, 'Mira', 'The letter', 'hers', 3);
    const r = crawl({ web: w, windows: [{ text: 'the letter', weight: 1 }], hops: 2, decay: 0.9, topK: 5 });
    assert.ok(!r.picks.some(p => r.nodes.get(p.id).kind === 'self'));
    const none = crawl({ web: w, windows: [{ text: 'nothing relevant here', weight: 1 }] });
    assert.equal(none.picks.length, 0);
    assert.equal(formatInjection(none), '');
});

test('formatInjection: plain words, no arrows, fits the budget', () => {
    const w = sampleWeb();
    const r = crawl({ web: w, windows: [{ text: 'the letter', weight: 1 }], hops: 3, decay: 0.9, topK: 3, currentIndex: 30 });
    const out = formatInjection(r, { maxChars: 1400 });
    assert.ok(out.startsWith('<spider_web>') && out.endsWith('</spider_web>'));
    assert.ok(!/[→⇒≠]|->|=>/.test(out));
    assert.ok(out.includes('Reached from The letter'));
    const small = formatInjection(r, { maxChars: 420 });
    assert.ok(small.length <= 420, small.length);
    assert.ok(small.endsWith('</spider_web>'));
});

test('hebbian co-mention strands grow but stay weaker than real strands', () => {
    const w = emptyWeb();
    upsertKnot(w, { name: 'Koyori' }); upsertKnot(w, { name: 'Itsuki' });
    for (let i = 0; i < 10; i++) hebbian(w, norm('Koyori told Itsuki everything'), i);
    const s = Object.values(w.strands)[0];
    assert.equal(s.source, 'co');
    assert.ok(s.w <= 0.6 && s.w >= 0.59);
    upsertStrand(w, 'Koyori', 'Itsuki', 'she covers for Uka with him', 3, 'memory');
    assert.equal(Object.values(w.strands)[0].w, 1);
    assert.equal(Object.values(w.strands)[0].source, 'memory');
});

test('parseHelperJSON survives reasoning, fences, chatter and trailing commas', () => {
    const a = parseHelperJSON('<think>{"x":1}</think>Sure! ```json\n{"knots":[{"name":"A","kind":"person"}],"strands":[],}\n```');
    assert.equal(a.knots[0].name, 'A');
    const b = parseHelperJSON('Here: {"note":"{weird}"} then {"knots":[{"name":"B \\"q\\"","kind":"thing"}],"strands":[{"a":"B","b":"C","why":"x","strength":3}]} done');
    assert.equal(b.knots[0].name, 'B "q"');
    assert.equal(parseHelperJSON('no json at all'), null);
});

test('applyHelperResult merges by name and alias, creates missing strand ends', () => {
    const w = sampleWeb();
    const res = applyHelperResult(w, {
        knots: [{ name: 'her sister', kind: 'person', note: 'Now suspicious.' }, { name: 'The farm', kind: 'place', aliases: ['farm'] }],
        strands: [{ a: 'The farm', b: 'Lena', why: 'she grew up there', strength: 2 }, { a: 'Ghost knot', b: 'Lena', why: 'x', strength: 1 }],
    }, 10);
    assert.equal(findKnot(w, 'Lena').note, 'Now suspicious.');
    assert.equal(res.added, 1);
    assert.equal(res.updated, 1);
    assert.ok(findKnot(w, 'Ghost knot'));
    assert.equal(res.strands, 2);
});

test('lorebook knots link by key mentions and to web knots', () => {
    const books = [{ name: 'World', entries: {
        1: { uid: 1, key: ['Old Mill'], comment: 'The old mill', content: 'Where Lena hid the deed. Near the river crossing.' },
        2: { uid: 2, key: ['river crossing', 'ford'], comment: '', content: 'Flooded every spring.' },
        3: { uid: 3, key: ['/regex/i'], comment: 'Regex only', content: 'x' },
        4: { uid: 4, key: ['Disabled'], comment: 'Off', content: 'x', disable: true },
    } }];
    const lore = buildLoreKnots(books);
    assert.equal(lore.knots.length, 3);
    assert.ok(lore.strands.some(s => s.a === 'lore:World:1' && s.b === 'lore:World:2'));
    const w = sampleWeb();
    lore.strands.push(...linkLoreToWeb(lore.knots, Object.values(w.knots)));
    const r = crawl({ web: w, lore, windows: [{ text: 'Lena looks toward the window', weight: 1 }], hops: 2, decay: 0.9, topK: 3 });
    assert.ok(r.picks.some(p => p.id === 'lore:World:1'), 'reaches the mill through Lena');
    const out = formatInjection(r, { loreChars: 30 });
    assert.ok(out.includes('lorebook'));
});

test('prune keeps pinned/card knots and caps size; ensureWeb repairs partial saves', () => {
    const w = emptyWeb();
    upsertKnot(w, { name: 'Pinned one', source: 'manual', pinned: true }, 0);
    upsertKnot(w, { name: 'Card one', source: 'card' }, 0);
    for (let i = 0; i < 50; i++) upsertKnot(w, { name: `Memory ${i}` }, i);
    prune(w, 20, 10);
    assert.equal(Object.keys(w.knots).length, 20);
    assert.ok(findKnot(w, 'Pinned one') && findKnot(w, 'Card one') && findKnot(w, 'Memory 49'));
    const fixed = ensureWeb({ knots: {} });
    assert.deepEqual(fixed.strands, {});
    assert.equal(fixed.builtUpTo, -1);
});

test('walkSnapshot is small and serialisable', () => {
    const w = sampleWeb();
    const r = crawl({ web: w, windows: [{ text: 'the letter', weight: 1 }], hops: 3, decay: 0.9 });
    const snap = walkSnapshot(r);
    assert.ok(JSON.stringify(snap).length < 4000);
    assert.ok(snap.reached.some(n => n.seed));
});

test('lore: macros resolved, duplicate entries across two books counted once', () => {
    const entry = { uid: 1, key: ['mill'], comment: 'The day {{user}} found the mill', content: 'Where {{user}} hid.' };
    const lore = buildLoreKnots([{ name: 'Book v1', entries: { 1: entry } }, { name: 'Book v2', entries: { 1: { ...entry } } }],
        { subst: s => s.replaceAll('{{user}}', 'Arin') });
    assert.equal(lore.knots.length, 1);
    assert.equal(lore.knots[0].name, 'The day Arin found the mill');
    assert.ok(!lore.knots[0].content.includes('{{user}}'));
});
