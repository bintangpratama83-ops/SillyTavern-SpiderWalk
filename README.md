# 🕸️ Spider Walk Web — SillyTavern extension

A memory web for roleplay. Spider Walk connects your **character card**, your **lorebooks** and the **story so far** into one web. Before every reply, a spider walks that web to find the threads that matter right now.

- **Knots:** people, places, things, secrets, promises, plans, events and relationships.
- **Strands:** the reasons two knots affect each other ("she hides the sessions from him", "the key opens the cellar").

Each turn, the spider lands on whatever the newest messages mention. It hops along the strands, losing a little pull at each hop, like activation spreading through neurons. Then it brings back the 2–3 threads that pull hardest but are **not already in view**: a forgotten promise, an off-screen person, a lorebook entry that no keyword would have triggered. The AI gets them as a short background note and decides whether one belongs in the reply.

```
"the letter"  ──►  The farm  ──►  Promise to Lena  ──►  Lena
  (in view)        (hop 1)          (hop 2)             (hop 3, found: hasn't come up in 30 messages)
```

Works on desktop and mobile. It uses SillyTavern's own theme colors, so it matches any theme.

## Install

1. In SillyTavern, open **Extensions** (the stacked-blocks icon), then **Install extension**.
2. Paste this repository's URL, e.g. `https://github.com/YOUR_GITHUB_NAME/SillyTavern-SpiderWalk`, and install.
3. Reload the page. **🕸️ Spider Walk Web** appears in the extension settings, and **Spider Web** appears in the wand menu.

Requires a recent SillyTavern (1.13+) with the built-in **Connection Manager** extension enabled if you want a separate helper model.

## How it works

| Part | What it does | API cost |
|---|---|---|
| **The walk** | Runs before every generation, inside SillyTavern's prompt builder. Pure JavaScript. | none |
| **Lorebook layer** | Every enabled entry in the active lorebooks (character, extra character books, chat, global, persona) becomes a knot. Entries that mention each other's keys are linked. Constant entries are skipped because they're always in the prompt anyway. | none |
| **"Seen together" links** | Knots mentioned in the same message get a weak strand that grows each time ("fire together, wire together"). These links stay weaker than real ones. | none |
| **Memory builder** | Every few AI replies, a helper model reads the new messages (and the card, the first time) and adds knots and strands. | one small request |

The web is saved per chat, in the chat's metadata. Lorebooks and the card are read but never changed.

## Choosing the helper model

Under **Memory builder → Helper model**:

- **Current connection:** uses whatever API you're chatting with. Easiest, but a big thinking model (e.g. GLM thinking) is slow and costly for this job.
- **Connection profile…:** recommended. Create a profile in SillyTavern's **Connection Manager** with a small, fast model on **OpenRouter, NanoGPT** or any other provider you already use, then pick it here. Your API key stays in SillyTavern's secret store; this extension never sees or saves it.
- **Off:** no helper at all. The spider then walks only lorebooks and "seen together" links, and anything you add by hand.

Good helper models are small instruction models that follow JSON well. The helper only maps the story; it never writes story text.

## Settings

**The walk**
- **Hops:** how far the spider may travel from what's in view (default 3).
- **Pull kept per hop:** 0.3 stays close; 0.9 wanders far (default 0.6).
- **Threads brought back:** how many it reports each turn (default 3).
- **Messages to land on:** how many of the newest messages it starts from (default 3; the newest counts most).
- **In-view reminders:** short notes about things already in the scene, so stale facts get refreshed (default 2).
- **Bring back after:** a knot not mentioned for this many messages gets a boost, so forgotten threads return (default 20).
- **Ignore ledgers and HTML blocks:** skips Eclipse Forge state ledgers, `<details>` blocks and HTML when reading messages.

**What the AI sees**
- **Inject automatically:** in chat at depth 1 as a system message (default), or after or before the story string.
- **Only through `{{spiderWeb}}`:** nothing is inserted on its own. Put the macro anywhere in your preset, Author's Note or a lorebook entry.
- **Max characters / Lore text per entry:** keep the note small (default 1400 / 350).

The note looks like this:

```
<spider_web>
Threads the spider found by following connections from this turn (character card, lorebook and story memory). Background for you, not text to copy. Use at most one, and only if it really pulls on this moment; show it through what someone does or says, never by explaining the chain. Characters only act on what they know.
In view now. Lena: Mira's sister; arrives tomorrow and does not know the farm is sold.
- Promise to Lena (promise, story memory, not mentioned for a while). Reached from The letter, then The farm. Mira swore she would never sell the farm. Link: selling it breaks the promise.
- The old mill (lore, lorebook). Reached from Lena. Abandoned mill by the river. Lena still keeps the deed there.
</spider_web>
```

## The web viewer

Open it from the wand menu (**Spider Web**), the **Open web** button, or `/spider-web`. It has four tabs:

- **Last walk:** a map of where the spider went. In-view knots are in the middle and each hop sits on a ring further out. The paths it walked are highlighted and listed.
- **Knots:** search, edit notes and aliases, **pin** (pinned knots are never pruned), delete, or add your own.
- **Strands:** see why things are connected, delete wrong links, or add your own.
- **Injected text:** exactly what the AI received on the last generation.

## Commands and macro

| | |
|---|---|
| `/spider-web` | open the viewer |
| `/spider-walk` | run the spider now; shows the walk and returns the text it would inject |
| `/spider-build` | grow the web now with the helper model (re-reads the card and recent messages) |
| `/spider-clear` | clear this chat's web |
| `{{spiderWeb}}` | the text found on the last generation |

`window.SpiderWalkWeb` is also exposed for Quick Replies and STscript power users (`getWeb()`, `buildWeb()`, `previewWalk()`, `openViewer()`).

## Using it with Eclipse Forge

Eclipse Forge R6.17 has a 🕷️ Spider Walk reasoning toggle: the model's own "think in a web" step. The extension supplies the web itself. They work together:

- Turn on **🕷️ Spider Walk** in the preset; the model then thinks along strands.
- Leave the extension on **in chat, depth 1, system**. Eclipse Forge's Human Response Kernel stays the last thing at depth 0, so the extension's note never pushes it out of last place.
- Keep **Ignore ledgers and HTML blocks** on, so ledgers never get read as story.

## Privacy and limits

- Everything is stored in your SillyTavern data (chat metadata and extension settings). Nothing is sent anywhere except to the helper model you choose.
- The walk only knows what's in the web. A brand-new chat starts with lorebook knots and the card. Story memory grows as you play, or press **Build now**.
- Word matching is whole-word for Latin scripts and substring for CJK and other scripts. Very short names (under 3 letters) are ignored to avoid false hits; add a longer alias if needed.

## Development

- `src/web.js`: the engine (knots, strands, crawl, formatting, helper JSON parsing). It has no SillyTavern imports, so it can be tested in Node: `node --test test/`
- `src/prompts.js`: the helper-model prompt.
- `index.js`: SillyTavern glue (settings, interceptor, viewer, commands).

## License

MIT. See `LICENSE`.
