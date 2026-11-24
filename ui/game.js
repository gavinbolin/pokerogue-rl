// PokéRogue-style play UI for the pokerogue-rl sim server. Plain JS, no build step.
// Every choice on screen maps 1:1 to one legal action from the server (POST /api {cmd:"step", index}),
// so human runs are logged exactly like agent runs. Art comes from the pinned pokerogue-assets checkout.
"use strict";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const A = p => `/assets/images/${p}`;
const W = 320;
const H = 180;
const TIER_COLORS = ["#f8f8f8", "#4998f8", "#f8d038", "#f85858", "#e070f8", "#40e0d0"];
const BALL_NAMES = ["Poké Ball", "Great Ball", "Ultra Ball", "Rogue Ball", "Master Ball", "Luxury Ball"];
const STAGE = ["Atk", "Def", "SpA", "SpD", "Spe", "Acc", "Eva"];
const CAT = ["physical", "special", "status"];

// ------------------------------------------------------------------ state

let resp = null; // last server response (decision or end)
let shown = null; // {obs, visual} currently drawn on the field (lags behind resp while text plays)
let screenStack = []; // menu screens (top = active)
let msgQueue = [];
let msgActive = null; // {text, shownAt}
let pendingApply = null; // response to apply once text is done
let busy = false;
let decisionShownAt = 0;
let autoTimer = null;
const opts = { auto: localStorage.getItem("prl.auto") === "1", speed: Number(localStorage.getItem("prl.speed") || 450) };

// ------------------------------------------------------------------ assets

const atlasCache = new Map();
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
/** TexturePacker atlas -> {img, frames: Map(name -> {x,y,w,h, ox,oy, sw,sh}), names[]} */
function loadAtlas(base) {
  if (!atlasCache.has(base)) {
    atlasCache.set(
      base,
      (async () => {
        const [json, img] = await Promise.all([fetch(`${base}.json`).then(r => (r.ok ? r.json() : Promise.reject(new Error(base)))), loadImage(`${base}.png`)]);
        const frames = new Map();
        const list = json.textures ? json.textures[0].frames : Object.entries(json.frames).map(([filename, f]) => ({ filename, ...f }));
        for (const f of list) {
          frames.set(f.filename, { x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h, ox: f.spriteSourceSize?.x ?? 0, oy: f.spriteSourceSize?.y ?? 0, sw: f.sourceSize?.w ?? f.frame.w, sh: f.sourceSize?.h ?? f.frame.h });
        }
        return { img, frames, names: [...frames.keys()].sort() };
      })(),
    );
  }
  return atlasCache.get(base);
}
const frameCss = {}; // small static atlases: css background positions
async function cssAtlas(name) {
  if (!frameCss[name]) {
    const a = await loadAtlas(A(name));
    frameCss[name] = a.frames;
  }
  return frameCss[name];
}
const typeCss = t => {
  const f = frameCss.types?.get(String(t).toLowerCase());
  return f ? `background-position:-${f.x}px -${f.y}px` : "display:none";
};
const statusCss = s => {
  const f = s && frameCss.statuses?.get(String(s).toLowerCase() === "toxic" ? "poison" : String(s).toLowerCase());
  return f ? `background-position:-${f.x}px -${f.y}px;width:${f.w}px` : "display:none";
};
const catCss = c => {
  const f = frameCss.categories?.get(CAT[c] ?? "status");
  return f ? `background-position:-${f.x}px -${f.y}px` : "display:none";
};
const itemImg = (icon, cls = "itemico") => (icon ? `<img class="${cls}" src="${A(`items/${icon}.png`)}" onerror="this.style.display='none'" alt="">` : "");

/** Animated battle sprite drawn into a canvas (bottom-centre anchored at x,y). */
class MonSprite {
  constructor(key) {
    this.key = key;
    this.el = document.createElement("canvas");
    this.el.className = "mon";
    this.ctx = this.el.getContext("2d");
    this.atlas = null;
    this.i = 0;
    this.x = 0;
    this.y = 0;
  }
  async load(sprite, fallback) {
    if (this.sprite === sprite) {
      return;
    }
    this.sprite = sprite;
    let atlas = null;
    for (const p of [sprite, fallback]) {
      try {
        atlas = await loadAtlas(A(`pokemon/${p}`));
        break;
      } catch {
        /* try next */
      }
    }
    if (this.sprite !== sprite) {
      return;
    }
    this.atlas = atlas;
    this.i = 0;
    if (atlas) {
      let w = 0;
      let h = 0;
      for (const f of atlas.frames.values()) {
        w = Math.max(w, f.sw);
        h = Math.max(h, f.sh);
      }
      this.el.width = w;
      this.el.height = h;
      this.place(this.x, this.y);
      this.draw();
    }
  }
  place(x, y) {
    this.x = x;
    this.y = y;
    this.el.style.left = `${Math.round(x - this.el.width / 2)}px`;
    this.el.style.top = `${Math.round(y - this.el.height)}px`;
  }
  draw() {
    const a = this.atlas;
    if (!a) {
      return;
    }
    const f = a.frames.get(a.names[this.i % a.names.length]);
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
    const dx = Math.floor((this.el.width - f.sw) / 2) + f.ox;
    const dy = this.el.height - f.sh + f.oy;
    this.ctx.drawImage(a.img, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
  }
  tick() {
    if (this.atlas && this.atlas.names.length > 1) {
      this.i = (this.i + 1) % this.atlas.names.length;
      this.draw();
    }
  }
}
const sprites = new Map(); // "p0", "p1", "e0", "e1"
setInterval(() => sprites.forEach(s => s.tick()), 1000 / 12);

async function iconCanvas(icon, scale = 1) {
  const c = document.createElement("canvas");
  c.width = 40;
  c.height = 30;
  c.style.width = `${40 * scale}px`;
  c.style.height = `${30 * scale}px`;
  try {
    const a = await loadAtlas(A(icon.atlas));
    const f = a.frames.get(icon.frame) || a.frames.get(icon.frame.replace(/-.*$/, ""));
    if (f) {
      c.getContext("2d").drawImage(a.img, f.x, f.y, f.w, f.h, f.ox, f.oy, f.w, f.h);
    }
  } catch {
    /* no icon */
  }
  return c;
}

// ------------------------------------------------------------------ api

async function api(cmd, args = {}) {
  const res = await fetch("/api", { method: "POST", body: JSON.stringify({ cmd, ...args }) });
  const out = await res.json();
  if (!out.ok) {
    throw new Error(out.error || "request failed");
  }
  return out;
}
function status(html) {
  $("#status").innerHTML = html;
}
async function send(cmd, args) {
  if (busy) {
    return null;
  }
  busy = true;
  status("…");
  try {
    const out = await api(cmd, args);
    receive(out);
    return out;
  } catch (e) {
    status(`<span class="err">${esc(e.message)}</span>`);
    return null;
  } finally {
    busy = false;
  }
}

function choose(index) {
  const d = resp?.decision;
  if (!d || busy || index == null || index < 0 || index >= d.actions.length) {
    return;
  }
  screenStack = [];
  renderUi();
  send("step", { index, expect: d.actions[index].id, thinkMs: Math.round(performance.now() - decisionShownAt) });
}

// ------------------------------------------------------------------ message playback

function receive(out) {
  resp = out;
  $("#title").classList.add("hidden");
  $("#runinfo").textContent = out.runId ? `${out.runId} · seed ${out.seed} · ${out.logFile ?? "not logged"}` : "";
  const msgs = (out.messages || []).filter(Boolean);
  if (!shown || !msgs.length) {
    msgQueue = [];
    msgActive = null;
    applyState(out);
    showDecision();
    return;
  }
  pendingApply = out;
  msgQueue = msgs.slice();
  nextMessage();
}

function nextMessage() {
  clearTimeout(autoTimer);
  if (!msgQueue.length) {
    msgActive = null;
    if (pendingApply) {
      applyState(pendingApply);
      pendingApply = null;
    }
    showDecision();
    return;
  }
  const text = msgQueue.shift();
  msgActive = { text, at: performance.now() };
  reactToMessage(text);
  screenStack = [];
  renderUi();
  if (opts.auto) {
    autoTimer = setTimeout(nextMessage, Math.max(opts.speed, text.length * (opts.speed / 40)));
  }
}

/** Light animation cues from battle text: attacker lunges, target flashes, fainted mon drops. */
function reactToMessage(text) {
  const obs = shown?.obs;
  if (!obs) {
    return;
  }
  const findKey = name => {
    if (!name) {
      return null;
    }
    const enemyFirst = /^(Wild|Foe|The opposing)\s/i.test(text);
    const clean = name.replace(/^(Wild|Foe|The opposing)\s+/i, "").trim();
    const e = obs.enemies.find(x => x.name === clean);
    const p = obs.party.find(x => x.name === clean && x.onField);
    if (enemyFirst && e) {
      return `e${e.fieldIndex}`;
    }
    if (p) {
      return `p${obs.party.indexOf(p)}`;
    }
    return e ? `e${e.fieldIndex}` : null;
  };
  const flash = (key, cls) => {
    const s = sprites.get(key);
    if (s) {
      s.el.classList.remove(cls);
      void s.el.offsetWidth;
      s.el.classList.add(cls);
    }
  };
  let m = text.match(/^(.+?) used (.+?)!/);
  if (m) {
    const key = findKey(m[1]);
    if (key) {
      flash(key, key.startsWith("p") ? "bump-l" : "bump-r");
      // after the attack line, show the new HP values (bars drain like the game)
      const target = pendingApply;
      setTimeout(() => target && target === pendingApply && applyHp(target), 250);
    }
    return;
  }
  m = text.match(/^(.+?) fainted!/);
  if (m) {
    const key = findKey(m[1]);
    if (key) {
      sprites.get(key)?.el.classList.add("faint");
      if (pendingApply) {
        applyHp(pendingApply);
      }
    }
  }
}

// ------------------------------------------------------------------ field (battle scene)

function applyState(out) {
  const obs = out.decision?.obs ?? shown?.obs ?? null;
  const visual = out.visual ?? shown?.visual ?? null;
  if (!obs) {
    return;
  }
  shown = { obs, visual };
  drawField();
}

/** Update only HP bars of mons that stay on the field (mid-text), keeping sprites as they are. */
function applyHp(out) {
  const obs = out.decision?.obs;
  if (!obs || !shown) {
    return;
  }
  for (const e of obs.enemies) {
    const bar = document.querySelector(`#info-e${e.fieldIndex} .bar`);
    const old = shown.obs.enemies.find(x => x.fieldIndex === e.fieldIndex);
    if (bar && old && old.name === e.name) {
      setBar(bar, e.hpFrac);
    }
  }
  obs.party.forEach((p, i) => {
    const old = shown.obs.party[i];
    const box = document.querySelector(`#info-p${i}`);
    if (box && old && old.id === p.id) {
      setBar(box.querySelector(".bar"), p.maxHp ? p.hp / p.maxHp : 0);
      const num = box.querySelector(".hpnum");
      if (num) {
        num.textContent = `${p.hp}/${p.maxHp}`;
      }
    }
  });
}

function setBar(bar, frac, width = 48) {
  if (!bar) {
    return;
  }
  const f = Math.max(0, Math.min(1, frac));
  bar.style.width = `${Math.ceil(f * width)}px`;
  bar.style.backgroundPositionY = f > 0.5 ? "0px" : f > 0.25 ? "-2px" : "-4px";
}

const POS = {
  player: { single: [[106, 148]], double: [[74, 140], [138, 148]] },
  enemy: { single: [[236, 84]], double: [[204, 76], [268, 84]] },
};

function drawField() {
  const { obs, visual } = shown;
  const arena = visual?.arena || String(obs.biome || "plains").toLowerCase();
  const setSrc = (el, src) => {
    if (el.dataset.src !== src) {
      el.dataset.src = src;
      el.src = src;
      el.onerror = () => {
        el.onerror = null;
        el.src = A(`arenas/plains${src.match(/_(bg|a|b)\.png$/)?.[0] ?? "_bg.png"}`);
      };
    }
  };
  setSrc($("#arenaBg"), A(`arenas/${arena}_bg.png`));
  setSrc($("#arenaA"), A(`arenas/${arena}_a.png`));
  setSrc($("#arenaB"), A(`arenas/${arena}_b.png`));

  const layout = obs.double ? "double" : "single";
  const want = new Map();
  const field = obs.party.map((p, i) => ({ p, i })).filter(x => x.p.onField && !x.p.fainted);
  field.forEach(({ p, i }, k) => want.set(`p${i}`, { mon: p, vis: visual?.party?.[i], pos: POS.player[layout][Math.min(k, POS.player[layout].length - 1)], player: true }));
  obs.enemies.forEach((e, k) => {
    if (e.hpFrac > 0) {
      const vis = visual?.enemies?.find(v => v.fieldIndex === e.fieldIndex) ?? visual?.enemies?.[k];
      want.set(`e${e.fieldIndex}`, { mon: e, vis, pos: POS.enemy[layout][Math.min(e.fieldIndex, POS.enemy[layout].length - 1)], player: false });
    }
  });
  for (const [key, s] of sprites) {
    const w = want.get(key);
    if (!w || (w.vis && w.vis.sprite !== s.sprite && s.sprite)) {
      if (!w || s.monId !== (w.mon.id ?? w.mon.name)) {
        s.el.remove();
        sprites.delete(key);
      }
    }
  }
  for (const [key, w] of want) {
    let s = sprites.get(key);
    if (!s) {
      s = new MonSprite(key);
      sprites.set(key, s);
      // enemies sit behind the player's sprites
      const holder = $("#sprites");
      if (w.player) {
        holder.appendChild(s.el);
      } else {
        holder.insertBefore(s.el, holder.firstChild);
      }
    }
    s.monId = w.mon.id ?? w.mon.name;
    s.el.classList.remove("faint", "target");
    s.place(w.pos[0], w.pos[1]);
    const sprite = w.vis?.sprite ?? (w.player ? `back/${w.mon.species}` : String(w.mon.species));
    s.load(sprite, w.vis?.fallback ?? sprite);
  }
  drawInfos(want, layout);
  const wx = [obs.weatherName, obs.terrainName].filter(Boolean).map(x => x.replace(/_/g, " ").toLowerCase()).join(" · ");
  $("#hud").innerHTML = `<div>${esc(titleCase(obs.biome))} - Wave ${obs.wave}</div><div>₽${obs.money.toLocaleString()}</div>${wx ? `<div class="smalltxt">${esc(wx)}</div>` : ""}`;
}

const titleCase = s => String(s ?? "").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function drawInfos(want, layout) {
  const parts = [];
  const enemies = [...want.entries()].filter(([k]) => k.startsWith("e"));
  const players = [...want.entries()].filter(([k]) => k.startsWith("p"));
  enemies.forEach(([key, w], k) => {
    const e = w.mon;
    const boss = e.boss;
    const top = layout === "double" ? 6 + k * 30 : 24;
    const left = 10;
    const width = boss ? 178 : 130;
    const segs = boss && e.bossSegments > 1 ? Array.from({ length: e.bossSegments - 1 }, (_, i) => `<div style="left:${16 + ((i + 1) * 48) / e.bossSegments}px;top:-1px;width:1px;height:4px;background:#404040"></div>`).join("") : "";
    parts.push(`<div class="info" id="info-${key}" style="left:${left}px;top:${top}px;width:${width}px;height:31px">
      <img class="px" src="${A(`ui/${boss ? "pbinfo_enemy_boss" : "pbinfo_enemy_mini"}.png`)}" style="left:0;top:0">
      <div class="txt dark" style="left:6px;top:3px">${esc(e.name)}${w.vis?.shiny || e.shiny ? ' <span style="color:#f8d030!important">★</span>' : ""}</div>
      <div class="txt dark smalltxt" style="left:88px;top:11px">Lv${e.level}</div>
      <div class="status" style="left:6px;top:15px;${statusCss(e.status)}"></div>
      <div style="left:59px;top:20px;width:48px;height:2px"><div class="bar" style="left:0;top:0"></div>${segs}</div>
      ${e.types.map((t, i) => `<div class="typeico" style="left:${width + 2}px;top:${i * 15}px;transform:scale(.5);transform-origin:0 0;${typeCss(t)}"></div>`).join("")}
      ${stageText(e.statStages, width + 20, 2)}
    </div>`);
  });
  players.forEach(([key, w], k) => {
    const p = w.mon;
    const vis = w.vis;
    const mini = layout === "double";
    const top = mini ? 68 + k * 30 : 87;
    parts.push(`<div class="info" id="info-${key}" style="left:180px;top:${top}px;width:130px;height:42px">
      <img class="px" src="${A(`ui/${mini ? "pbinfo_player_mini" : "pbinfo_player"}.png`)}" style="left:0;top:0">
      <div class="txt dark" style="left:15px;top:5px">${esc(p.name)}${vis?.shiny ? ' <span style="color:#f8d030!important">★</span>' : ""}</div>
      <div class="txt dark smalltxt" style="left:93px;top:12px">Lv${p.level}</div>
      <div class="status" style="left:15px;top:16px;${statusCss(p.status)}"></div>
      <div style="left:69px;top:20px;width:48px;height:2px"><div class="bar" style="left:0;top:0"></div></div>
      ${mini ? "" : `<div class="txt dark hpnum" style="right:13px;top:24px">${p.hp}/${p.maxHp}</div>`}
      ${mini ? "" : `<div style="left:32px;top:37px;width:85px;height:2px"><div class="exp" style="left:0;top:0;width:${Math.round((vis?.expFrac ?? 0) * 85)}px"></div></div>`}
      ${p.types.map((t, i) => `<div class="typeico" style="left:-18px;top:${i * 8 + 4}px;transform:scale(.5);transform-origin:0 0;${typeCss(t)}"></div>`).join("")}
      ${stageText(p.statStages, -2, 22, true)}
    </div>`);
  });
  // keep old bars so the width transition animates
  const old = new Map([...document.querySelectorAll("#infos .info")].map(el => [el.id, el.querySelector(".bar")?.style.width]));
  $("#infos").innerHTML = parts.join("");
  for (const [key, w] of [...enemies, ...players]) {
    const bar = document.querySelector(`#info-${key} .bar`);
    const frac = key.startsWith("e") ? w.mon.hpFrac : w.mon.maxHp ? w.mon.hp / w.mon.maxHp : 0;
    if (old.has(`info-${key}`)) {
      bar.style.width = old.get(`info-${key}`);
      void bar.offsetWidth;
    }
    setBar(bar, frac);
  }
}

function stageText(stages, left, top, alignRight = false) {
  const parts = (stages || []).map((v, i) => (v ? `${STAGE[i]}${v > 0 ? "+" : ""}${v}` : "")).filter(Boolean);
  if (!parts.length) {
    return "";
  }
  return `<div class="txt smalltxt stages" style="${alignRight ? `right:${130 - left}px` : `left:${left}px`};top:${top}px">${parts.join(" ")}</div>`;
}

// ------------------------------------------------------------------ menus

/** Index of the legal action with this id (or matching predicate), or -1. */
const findAction = (d, pred) => d.actions.findIndex(typeof pred === "function" ? pred : a => a.id === pred);
const actionSlot = a => {
  if (a.data && Number.isInteger(a.data.slot)) {
    return a.data.slot;
  }
  if (a.data && Number.isInteger(a.data.from)) {
    return a.data.from;
  }
  const m = a.id.match(/^(?:slot|release|switch):(\d+)/);
  return m ? Number(m[1]) : null;
};

function msgBox(text, width = 296) {
  return `<div class="msgbox"></div><div class="txt msgtext" style="width:${width}px">${esc(text)}</div>`;
}
function cursorAt(x, y) {
  return `<div class="cursor" style="left:${x}px;top:${y}px"></div>`;
}
function win(x, y, w, h, inner = "") {
  return `<div class="win" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>${inner}`;
}

/** Base screen: items [{label, enabled, act}] with grid navigation. */
class Screen {
  constructor() {
    this.cursor = 0;
    this.cols = 1;
    this.items = [];
    this.back = null;
  }
  enabledIdx() {
    return this.items.map((it, i) => (it.enabled === false ? -1 : i)).filter(i => i >= 0);
  }
  fixCursor() {
    const en = this.enabledIdx();
    if (en.length && !en.includes(this.cursor)) {
      this.cursor = en[0];
    }
  }
  nav(dx, dy) {
    const n = this.items.length;
    if (!n) {
      return;
    }
    let c = this.cursor;
    for (let k = 0; k < n; k++) {
      if (this.cols > 1) {
        c = dx ? c + dx : c + dy * this.cols;
        if (c < 0 || c >= n) {
          return;
        }
      } else {
        c = (c + (dy || dx) + n) % n;
      }
      if (this.items[c]?.enabled !== false) {
        this.cursor = c;
        return;
      }
      if (this.cols > 1) {
        return;
      }
    }
  }
  activate(i = this.cursor) {
    const it = this.items[i];
    if (it && it.enabled !== false) {
      this.cursor = i;
      it.act();
    }
  }
  pick(n) {
    const en = this.enabledIdx();
    if (n - 1 < en.length) {
      this.activate(en[n - 1]);
    }
  }
}

function push(screen) {
  screen.fixCursor();
  screenStack.push(screen);
  renderUi();
}
function pop() {
  if (screenStack.length > 1) {
    screenStack.pop();
    renderUi();
  }
}
const topScreen = () => screenStack[screenStack.length - 1];

// ---- command (Fight / Ball / Pokémon / Run)

class CommandScreen extends Screen {
  constructor(d) {
    super();
    this.d = d;
    this.cols = 2;
    const has = pre => d.actions.some(a => a.id === pre || a.id.startsWith(`${pre}:`));
    const run = findAction(d, "run");
    const known = /^(move|struggle|ball|switch|run|tera)(:|$)/;
    const other = d.actions.map((a, i) => ({ a, i })).filter(x => !known.test(x.a.id));
    this.items = [
      { label: "Fight", enabled: has("move") || has("struggle"), act: () => (has("move") ? push(new FightScreen(d)) : choose(findAction(d, "struggle"))) },
      { label: "Ball", enabled: has("ball"), act: () => push(new BallScreen(d)) },
      { label: "Pokémon", enabled: has("switch"), act: () => push(new PartyScreen(d, { filter: a => a.id.startsWith("switch:"), back: true, prompt: "Choose a Pokémon to switch in." })) },
      { label: "Run", enabled: run >= 0, act: () => choose(run) },
    ];
    if (other.length) {
      this.items.push({ label: "Other", enabled: true, act: () => push(new ListScreen(d, other.map(x => x.i), "Other actions", true)) });
    }
    // Tera button (live: left of the command window once you hold a Tera Orb; it opens the fight menu in Tera mode)
    this.teraIdx = -1;
    if (has("tera")) {
      this.teraIdx = this.items.length;
      const only = d.actions.every(a => !a.id.startsWith("tera:") || a.id === "tera:struggle");
      this.items.push({ label: "Tera", tera: true, enabled: true, act: () => (only ? choose(findAction(d, "tera:struggle")) : push(new FightScreen(d, true))) });
    }
  }
  nav(dx, dy) {
    // as in CommandUiHandler: LEFT from Fight / Pokémon goes to Tera, RIGHT from Tera back to Fight
    if (this.teraIdx >= 0 && dx < 0 && (this.cursor === 0 || this.cursor === 2)) {
      this.cursor = this.teraIdx;
      return;
    }
    if (this.cursor === this.teraIdx) {
      if (dx > 0) {
        this.cursor = 0;
      }
      return;
    }
    super.nav(dx, dy);
  }
  render() {
    const pos = [
      [228, 141],
      [276, 141],
      [228, 157],
      [276, 157],
      [228, 125],
    ];
    const mon = this.d.context?.mon ?? "it";
    const tt = this.d.context?.teraType;
    return (
      msgBox(`What will ${mon} do?`, this.teraIdx >= 0 ? 170 : 196) +
      win(214, 132, 106, 48) +
      this.items
        .map((it, i) =>
          it.tera
            ? `<div class="tera-btn item ${this.cursor === i ? "sel" : ""}" data-i="${i}" style="left:186px;top:142px" title="Terastallize (${esc(titleCase(tt ?? ""))})"><span class="typeico" style="position:absolute;left:-2px;top:6px;${typeCss(tt ?? "")}"></span></div>`
            : `<div class="txt item ${it.enabled === false ? "disabled" : ""}" data-i="${i}" style="left:${pos[i][0]}px;top:${pos[i][1]}px">${esc(it.label)}</div>`,
        )
        .join("") +
      (this.cursor === this.teraIdx ? cursorAt(178, 149) : cursorAt(pos[this.cursor][0] - 8, pos[this.cursor][1] + 1))
    );
  }
}

const effColor = e => (e == null ? null : e === 0 ? "#888888" : e < 1 ? "#f89058" : e > 1 ? "#88f048" : null);
const effText = e => (e == null ? "" : e === 0 ? "No effect" : `x${e}`);

class FightScreen extends Screen {
  /** tera: the fight menu opened from the Tera button (moves send tera:i) */
  constructor(d, tera = false) {
    super();
    this.d = d;
    this.tera = tera;
    this.cols = 2;
    this.back = true;
    const slot = d.context?.slot ?? 0;
    this.mon = shown?.obs?.party?.[slot] ?? d.obs?.party?.[slot];
    const moves = this.mon?.moves ?? [];
    const pre = tera ? "tera" : "move";
    this.items = [0, 1, 2, 3].map(i => {
      const idx = findAction(d, `${pre}:${i}`);
      return { label: moves[i]?.name ?? "-", move: moves[i], actionId: `move:${i}`, enabled: idx >= 0, act: () => this.pickMove(idx) };
    });
  }
  pickMove(idx) {
    choose(idx);
  }
  render() {
    const pos = [
      [18, 141],
      [122, 141],
      [18, 157],
      [122, 157],
    ];
    const eff = resp?.visual?.effectiveness ?? {};
    const cur = this.items[this.cursor];
    const m = cur?.move;
    const effs = (eff[cur?.actionId] ?? []).filter(x => x != null);
    const best = effs.length ? Math.max(...effs) : null;
    let info = "";
    if (m) {
      info = `<div class="typeico" style="left:236px;top:140px;${typeCss(m.type)}"></div>
        <div class="catico" style="left:276px;top:141px;${catCss(m.category)}"></div>
        <div class="txt" style="left:234px;top:154px">PP ${m.pp}/${m.ppMax}</div>
        <div class="txt smalltxt" style="left:234px;top:167px">Pow ${m.power > 0 ? m.power : "-"} Acc ${m.accuracy > 0 ? m.accuracy : "-"}</div>
        ${best != null ? `<div class="txt smalltxt" style="right:8px;top:157px;color:${effColor(best) ?? "#f8f8f8"}!important">${effText(best)}</div>` : ""}`;
    }
    return (
      `<div class="msgbox"></div>` +
      (this.tera ? `<div class="txt smalltxt" style="left:10px;top:132px;color:#f8a8f8!important">Terastallize → ${esc(titleCase(this.d.context?.teraType ?? ""))}</div>` : "") +
      win(226, 132, 94, 48) +
      this.items
        .map((it, i) => {
          const es = (eff[it.actionId] ?? []).filter(x => x != null);
          const c = es.length ? effColor(Math.max(...es)) : null;
          return `<div class="txt item ${it.enabled ? "" : "disabled"}" data-i="${i}" style="left:${pos[i][0]}px;top:${pos[i][1]}px;${c ? `color:${c}!important` : ""}">${esc(it.label)}</div>`;
        })
        .join("") +
      cursorAt(pos[this.cursor][0] - 8, pos[this.cursor][1] + 1) +
      info
    );
  }
}

class BallScreen extends Screen {
  constructor(d) {
    super();
    this.d = d;
    this.back = true;
    this.items = d.actions
      .map((a, i) => ({ a, i }))
      .filter(x => x.a.id.startsWith("ball:"))
      .map(x => ({ label: BALL_NAMES[Number(x.a.id.slice(5))] ?? x.a.label, count: x.a.data?.count, icon: resp?.visual?.actionIcons?.[x.a.id], act: () => choose(x.i) }));
    this.items.push({ label: "Cancel", act: () => pop() });
  }
  render() {
    const h = this.items.length * 16 + 12;
    const y = 132 - h;
    return (
      msgBox("Throw which ball?", 196) +
      win(196, y, 124, h) +
      this.items
        .map((it, i) => `${it.icon ? `<img class="px" src="${A(`items/${it.icon}.png`)}" style="left:204px;top:${y + 4 + i * 16 - 10}px;width:24px;height:24px" onerror="this.remove()">` : ""}<div class="txt item" data-i="${i}" style="left:226px;top:${y + 8 + i * 16}px">${esc(it.label)}${it.count != null ? ` x${it.count}` : ""}</div>`)
        .join("") +
      cursorAt(218, y + 9 + this.cursor * 16)
    );
  }
}

class TargetScreen extends Screen {
  constructor(d) {
    super();
    this.d = d;
    this.cols = 4;
    this.items = d.actions.map((a, i) => ({ label: a.label, a, act: () => choose(i) }));
  }
  keyFor(a) {
    const bi = a?.data?.battlerIndex;
    if (bi == null) {
      return null;
    }
    return bi >= 2 ? `e${bi - 2}` : `p${bi}`;
  }
  render() {
    sprites.forEach(s => s.el.classList.remove("target"));
    const cur = this.items[this.cursor]?.a;
    const key = this.keyFor(cur);
    if (key) {
      sprites.get(key)?.el.classList.add("target");
    } else if (cur?.id === "target:all") {
      sprites.forEach(s => s.el.classList.add("target"));
    }
    const move = this.d.context?.move ?? "the move";
    return (
      `<div class="msgbox"></div><div class="txt" style="left:12px;top:139px">Target for ${esc(move)}:</div>` +
      this.items.map((it, i) => `<div class="txt item" data-i="${i}" style="left:${22 + i * 74}px;top:157px">${esc(it.label)}</div>`).join("") +
      cursorAt(14 + this.cursor * 74, 158)
    );
  }
}

// ---- party screen (switch, faint switch, item / TM targets, release, ...)

const PARTY_PROMPTS = {
  FAINT_SWITCH: "Choose a Pokémon to send out.",
  POST_BATTLE_SWITCH: "Choose a Pokémon to send out.",
  MODIFIER: "Give the item to which Pokémon?",
  TM_MODIFIER: "Teach the TM to which Pokémon?",
  MOVE_MODIFIER: "Use it on which Pokémon's move?",
  REMEMBER_MOVE_MODIFIER: "Which Pokémon should remember a move?",
  RELEASE: "Release which Pokémon?",
  REVIVAL_BLESSING: "Revive which Pokémon?",
  SPLICE: "Splice which Pokémon?",
  MODIFIER_TRANSFER: "Choose a Pokémon. (Transfer)",
  DISCARD: "Choose a Pokémon. (Discard)",
};

class PartyScreen extends Screen {
  /** opts: filter(action) -> bool, back: true (pop) | action id (cancel action), prompt, cancelLabel */
  constructor(d, o = {}) {
    super();
    this.d = d;
    this.o = o;
    const party = (shown?.obs ?? d.obs)?.party ?? [];
    this.party = party;
    const filter = o.filter ?? (() => true);
    this.bySlot = party.map(() => []);
    const leftovers = [];
    d.actions.forEach((a, i) => {
      if (!filter(a)) {
        return;
      }
      const s = actionSlot(a);
      if (s != null && this.bySlot[s]) {
        this.bySlot[s].push(i);
      } else if (a.id !== o.cancelId) {
        leftovers.push(i);
      }
    });
    this.items = party.map((p, s) => ({
      label: p.name,
      enabled: this.bySlot[s].length > 0,
      act: () => {
        const acts = this.bySlot[s];
        if (acts.length === 1) {
          choose(acts[0]);
        } else {
          push(new ListScreen(d, acts, `${p.name}:`, true, a => a.label.replace(`${p.name}: `, "")));
        }
      },
    }));
    const cancelIdx = o.cancelId ? findAction(d, o.cancelId) : -1;
    if (leftovers.length) {
      this.items.push({ label: "More…", act: () => push(new ListScreen(d, leftovers, "Other choices", true)) });
    }
    if (o.toggle && o.toggle.idx >= 0) {
      this.items.push({ label: o.toggle.label, toggle: true, act: () => choose(o.toggle.idx) });
    }
    this.cancelItem = this.items.length;
    this.items.push({ label: o.cancelLabel ?? "Cancel", enabled: cancelIdx >= 0 || o.back === true, act: () => (cancelIdx >= 0 ? choose(cancelIdx) : pop()) });
    this.back = this.items[this.cancelItem].enabled ? () => this.items[this.cancelItem].act() : null;
  }
  nav(dx, dy) {
    // left column = slot 0, right column = slots 1..5, cancel at the bottom
    const n = this.items.length;
    const order = [...Array(n).keys()];
    let c = this.cursor;
    if (dx < 0 && c > 0 && c < this.party.length) {
      c = 0;
    } else if (dx > 0 && c === 0 && this.party.length > 1) {
      c = 1;
    } else if (dy) {
      let k = order.indexOf(c);
      for (let t = 0; t < n; t++) {
        k = (k + dy + n) % n;
        if (this.items[order[k]].enabled !== false) {
          break;
        }
      }
      c = order[k];
    }
    if (this.items[c]?.enabled !== false) {
      this.cursor = c;
    }
  }
  render() {
    const html = [`<div class="overlay party"></div>`];
    const icons = [];
    this.party.forEach((p, s) => {
      const sel = this.cursor === s;
      const fnt = p.fainted || p.hp <= 0;
      const main = s === 0;
      const [x, y] = main ? [9, 31] : [143, 12 + 28 * (s - 1)];
      const frame = (main ? 49 : 24) * ((fnt ? 2 : 0) + (sel ? 1 : 0));
      const it = this.items[s];
      const frac = p.maxHp ? p.hp / p.maxHp : 0;
      const hpFrame = frac > 0.5 ? 0 : frac > 0.25 ? -3 : -6;
      const vis = resp?.visual?.party?.[s] ?? shown?.visual?.party?.[s];
      const held = (vis?.items ?? []).slice(0, 4).map((h, k) => `<img class="px" src="${A(`items/${h.icon}.png`)}" style="left:${main ? 92 - k * 9 : 120 - k * 9}px;top:${main ? 2 : 2}px;width:12px;height:12px" onerror="this.remove()" title="${esc(h.name)}">`).join("");
      if (main) {
        html.push(`<div class="pslot-main item ${it.enabled ? "" : "disabled"}" data-i="${s}" style="left:${x}px;top:${y}px;background-position:0 -${frame}px">
          <div id="picon-${s}" style="left:2px;top:4px"></div>
          <div class="txt" style="left:34px;top:8px">${esc(p.name)}</div>
          <div class="txt smalltxt" style="left:34px;top:21px">Lv${p.level}${p.status ? ` ${esc(p.status)}` : ""}</div>
          <div class="php" style="left:6px;top:33px"><div class="fill" style="width:${Math.ceil(frac * 80)}px;background-position-y:${hpFrame}px"></div></div>
          <div class="txt smalltxt" style="right:8px;top:41px">${p.hp}/${p.maxHp}</div>${held}</div>`);
      } else {
        html.push(`<div class="pslot item ${it.enabled ? "" : "disabled"}" data-i="${s}" style="left:${x}px;top:${y}px;background-position:0 -${frame}px">
          <div id="picon-${s}" style="left:4px;top:-4px"></div>
          <div class="txt" style="left:44px;top:1px">${esc(p.name)}</div>
          <div class="txt smalltxt" style="left:44px;top:14px">Lv${p.level}${p.status ? ` ${esc(p.status)}` : ""}</div>
          <div class="php" style="left:68px;top:15px"><div class="fill" style="width:${Math.ceil(frac * 80)}px;background-position-y:${hpFrame}px"></div></div>
          <div class="txt smalltxt" style="right:14px;top:4px">${p.hp}/${p.maxHp}</div>${held}</div>`);
      }
      if (vis?.icon) {
        icons.push([s, vis.icon]);
      }
    });
    // Cancel / More
    for (let i = this.party.length; i < this.items.length; i++) {
      const it = this.items[i];
      const isCancel = i === this.cancelItem;
      const sel = this.cursor === i;
      if (it.toggle) {
        html.push(`<div class="pcancel item" data-i="${i}" style="left:204px;top:158px;width:56px;background-position:0 -${sel ? 16 : 0}px"><div class="txt" style="left:8px;top:3px">${esc(it.label)}</div></div>`);
      } else if (isCancel) {
        const label = it.label.length > 8 ? it.label.slice(0, 18) : it.label;
        const wide = label.length > 8;
        html.push(`<div class="pcancel item ${it.enabled === false ? "disabled" : ""}" data-i="${i}" style="left:${wide ? 226 : 262}px;top:158px;width:${wide ? 88 : 52}px;background-position:0 -${sel ? 16 : 0}px;background-size:${wide ? "88px 32px" : "auto"}"><div class="txt" style="left:16px;top:3px">${esc(label)}</div></div>`);
      } else {
        html.push(`<div class="txt item" data-i="${i}" style="left:150px;top:161px">${sel ? "▶ " : ""}${esc(it.label)}</div>`);
      }
    }
    // details of the highlighted mon (a convenience the real party screen does not have)
    const p = this.party[this.cursor];
    if (p) {
      const moves = (p.moves || []).map(m => `${esc(m.name)} ${m.pp}/${m.ppMax}`);
      html.push(`<div class="txt smalltxt" style="left:10px;top:86px;line-height:10px!important">
        ${p.types.map((t, i) => `<span class="typeico" style="position:absolute;left:${i * 34}px;top:0;${typeCss(t)}"></span>`).join("")}
        <div style="left:0;top:17px">${esc(p.ability)}</div>
        <div style="left:0;top:28px">${moves.slice(0, 2).join(" · ")}</div>
        <div style="left:0;top:38px">${moves.slice(2, 4).join(" · ")}</div>
        <div style="left:0;top:50px">${(p.stats || []).map((v, i) => `${["HP", "At", "Df", "SA", "SD", "Sp"][i]}${v}`).join(" ")}</div></div>`);
    }
    const prompt = this.o.prompt ?? PARTY_PROMPTS[this.d.sub] ?? this.d.prompt ?? "Choose a Pokémon.";
    // long prompts ("Are you sure you want to discard these items?") wrap onto two lines like the game's text box
    const long = prompt.length > 30;
    html.push(`<div class="txt${long ? " smalltxt" : ""}" style="left:8px;top:${long ? 155 : 161}px;width:190px;overflow:hidden;white-space:normal;${long ? "line-height:10px!important" : ""}">${esc(prompt)}</div>`);
    queueMicrotask(async () => {
      for (const [s, icon] of icons) {
        const holder = document.getElementById(`picon-${s}`);
        if (holder && !holder.firstChild) {
          holder.appendChild(await iconCanvas(icon));
        }
      }
    });
    return html.join("");
  }
}

// ---- generic option window (learn move, biome, yes/no, sub-choices, "all actions")

class ListScreen extends Screen {
  constructor(d, actionIdxs, title, back = false, labelFn = a => a.label, header = "") {
    super();
    this.d = d;
    this.title = title;
    this.header = header;
    this.back = back ? true : null;
    this.items = actionIdxs.map(i => ({ label: labelFn(d.actions[i]), a: d.actions[i], act: () => choose(i) }));
    if (back) {
      this.items.push({ label: "Cancel", act: () => pop() });
    }
  }
  render() {
    const rows = this.items.length;
    const maxRows = 9;
    const start = Math.max(0, Math.min(this.cursor - maxRows + 1, rows - maxRows));
    const vis = this.items.slice(start, start + maxRows);
    const width = Math.min(300, Math.max(110, ...this.items.map(it => it.label.length * 6 + 40)));
    const h = vis.length * 13 + 14 + (this.header ? 14 : 0);
    const x = 320 - width;
    const y = Math.max(0, 132 - h);
    const hy = this.header ? 14 : 0;
    return (
      (this.noMsg ? "" : msgBox(this.title, Math.min(296, x - 16 > 120 ? x - 16 : 296))) +
      win(x, y, width, h) +
      (this.header ? `<div class="txt smalltxt" style="left:${x + 10}px;top:${y + 8}px">${this.header}</div>` : "") +
      vis
        .map((it, k) => {
          const i = start + k;
          const move = it.a?.data?.moveId != null ? null : null;
          return `<div class="txt item" data-i="${i}" style="left:${x + 18}px;top:${y + 8 + hy + k * 13}px">${esc(it.label)}${move ?? ""}</div>`;
        })
        .join("") +
      cursorAt(x + 9, y + 9 + hy + (this.cursor - start) * 13) +
      (rows > maxRows ? `<div class="txt smalltxt" style="left:${x + width - 30}px;top:${y + h - 10}px">${this.cursor + 1}/${rows}</div>` : "")
    );
  }
}

/** A list of hand-made entries [{label, act}] (not 1:1 with actions); `back` runs on X / Esc. */
function menuScreen(d, title, entries, back = null, header = "") {
  const s = new ListScreen(d, [], title, false, a => a.label, header);
  s.items = entries;
  s.back = back;
  return s;
}

/**
 * Learning a 5th move, the way the game asks it:
 *   "Should a move be forgotten and replaced with X?"  Yes -> pick the move to forget (X/Cancel = don't learn)
 *                                                      No  -> don't learn
 *   then (live setting, on by default) "Stop trying to teach X?"  Yes -> give up, No -> ask again.
 */
function learnMoveScreen(d) {
  const c = d.context || {};
  const header = c.move ? `New: ${esc(c.move)} · ${esc(c.type != null ? titleCase(typeName(c.type)) : "")} · Pow ${c.power > 0 ? c.power : "-"} · Acc ${c.accuracy > 0 ? c.accuracy : "-"}` : "";
  const mon = (shown?.obs ?? d.obs)?.party?.[c.slot];
  const label = a => {
    const m = a.id.match(/^forget:(\d+)/);
    const mv = m && mon?.moves?.[Number(m[1])];
    return mv ? `${a.label.replace(/^Forget /, "")}  (${titleCase(mv.type)} ${mv.power > 0 ? mv.power : "-"})` : a.label;
  };
  const keep = findAction(d, "keep");
  const forgets = d.actions.map((a, i) => (a.id.startsWith("forget:") ? i : -1)).filter(i => i >= 0);
  if (d.sub === "stop_teaching") {
    const stop = findAction(d, "stop");
    const retry = findAction(d, "retry");
    return menuScreen(d, d.prompt ?? "Stop trying to teach it?", [
      { label: "Yes", act: () => choose(stop) },
      { label: "No", act: () => choose(retry) },
    ], () => choose(retry));
  }
  const moveList = () => {
    const s = new ListScreen(d, forgets, "Which move should be forgotten?", false, label, header);
    if (keep >= 0) {
      s.items.push({ label: `Don't learn ${c.move ?? ""}`.trim(), act: () => choose(keep) });
      s.back = () => choose(keep);
    }
    return s;
  };
  if (d.kind === "forget_move" || keep < 0) {
    return moveList();
  }
  return menuScreen(d, `Should a move be forgotten and replaced with ${c.move ?? "it"}?`, [
    { label: "Yes", act: () => push(moveList()) },
    { label: "No", act: () => choose(keep) },
  ], () => choose(keep));
}

/** Transfer screen stages after the source mon: item list / quantity over the party screen. */
class TransferListScreen extends ListScreen {
  constructor(d, idxs, title, labelFn = a => a.label) {
    super(d, idxs, title, false, labelFn, "");
    this.noMsg = true;
    this.party = new PartyScreen(d, { filter: () => false, prompt: title, back: true, cancelLabel: "Back" });
    this.party.cursor = d.context?.from ?? 0;
    const backIdx = findAction(d, "back");
    if (backIdx >= 0) {
      this.items.push({ label: "Back", act: () => choose(backIdx) });
      this.back = () => choose(backIdx);
    }
  }
  render() {
    return this.party.render() + super.render();
  }
}

function transferScreen(d) {
  const stage = d.context?.stage;
  const ids = pre => d.actions.map((a, i) => (a.id.startsWith(pre) ? i : -1)).filter(i => i >= 0);
  if (stage === "from") {
    return new PartyScreen(d, { filter: a => a.id.startsWith("xfer_from:"), cancelId: "cancel", cancelLabel: "Done", prompt: d.prompt, toggle: { label: "Discard", idx: findAction(d, "xfer_mode") } });
  }
  if (stage === "item") {
    return new TransferListScreen(d, ids("xfer_item:"), d.prompt);
  }
  if (stage === "qty") {
    return new TransferListScreen(d, ids("xfer_qty:"), d.prompt);
  }
  const items = d.context?.items ?? [];
  const it = d.context?.item === "all" ? "all items" : items[d.context?.item]?.name ?? "the item";
  const qty = d.context?.qty ? ` x${d.context.qty}` : "";
  const s = new PartyScreen(d, { filter: a => a.id.startsWith("xfer_to:"), cancelId: "back", cancelLabel: "Back", prompt: `Give ${it}${qty} to?` });
  return s;
}
/** Manage Items in Discard mode: mon -> item / All -> quantity -> "Are you sure?" Yes / No. */
function discardScreen(d) {
  const stage = d.context?.stage;
  const ids = pre => d.actions.map((a, i) => (a.id.startsWith(pre) ? i : -1)).filter(i => i >= 0);
  if (stage === "from") {
    return new PartyScreen(d, { filter: a => a.id.startsWith("discard_from:"), cancelId: "cancel", cancelLabel: "Done", prompt: d.prompt, toggle: { label: "Transfer", idx: findAction(d, "xfer_mode") } });
  }
  if (stage === "item") {
    return new TransferListScreen(d, ids("discard_item:"), d.prompt);
  }
  if (stage === "qty") {
    return new TransferListScreen(d, ids("discard_qty:"), d.prompt);
  }
  const s = new TransferListScreen(d, [findAction(d, "discard_yes"), findAction(d, "discard_no")].filter(i => i >= 0), d.prompt);
  const no = findAction(d, "discard_no");
  s.back = () => choose(no);
  return s;
}
const TYPES = ["NORMAL", "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST", "STEEL", "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON", "DARK", "FAIRY", "STELLAR"];
const typeName = t => (typeof t === "number" ? (TYPES[t] ?? "UNKNOWN") : String(t));

// ---- reward screen

class RewardScreen extends Screen {
  constructor(d) {
    super();
    this.d = d;
    const icons = resp?.visual?.actionIcons ?? {};
    const mk = i => {
      const a = d.actions[i];
      return { label: a.label.replace(/^Buy /, ""), a, icon: icons[a.id], act: () => choose(i) };
    };
    const idx = pre => d.actions.map((a, i) => (a.id.startsWith(pre) ? i : -1)).filter(i => i >= 0);
    this.rows = [idx("reward:").map(mk), idx("shop:").map(mk), d.actions.map((a, i) => (/^(reward|shop):/.test(a.id) ? -1 : i)).filter(i => i >= 0).map(mk)];
    this.items = this.rows.flat();
    this.row = this.rows.findIndex(r => r.length);
    this.col = 0;
    this.sync();
  }
  sync() {
    this.cursor = this.items.indexOf(this.rows[this.row]?.[this.col]);
  }
  nav(dx, dy) {
    // the bottom-right window (Reroll / Skip / Manage Items / Lock Rarities) is a vertical list
    if (dy && this.row === 2 && this.col + dy >= 0 && this.col + dy < this.rows[2].length) {
      this.col += dy;
      this.sync();
      return;
    }
    if (dy) {
      let r = this.row;
      for (let k = 0; k < 3; k++) {
        r = (r + dy + 3) % 3;
        if (this.rows[r].length) {
          break;
        }
      }
      this.col = r === 2 ? (dy > 0 ? 0 : this.rows[2].length - 1) : Math.min(this.row === 2 ? 0 : this.col, this.rows[r].length - 1);
      this.row = r;
    } else if (dx) {
      const n = this.rows[this.row].length;
      this.col = (this.col + dx + n) % n;
    }
    this.sync();
  }
  activate(i = this.cursor) {
    const it = this.items[i];
    if (it) {
      it.act();
    }
  }
  render() {
    const html = [`<div class="overlay" style="background:#0007"></div>`, win(4, 4, 312, 126)];
    const cardRow = (row, y, showCost) => {
      const n = row.length;
      const gap = Math.min(52, 300 / Math.max(1, n));
      const x0 = 160 - (gap * n) / 2 + (gap - 50) / 2;
      row.forEach((it, k) => {
        const i = this.items.indexOf(it);
        const sel = i === this.cursor;
        const tier = it.a.data?.tier;
        const color = TIER_COLORS[tier] ?? "#c8c8c8";
        html.push(`<div class="reward-card item ${sel ? "sel" : ""}" data-i="${i}" style="left:${Math.round(x0 + k * gap)}px;top:${y}px">
          <div class="ball" style="background:radial-gradient(circle, ${color}55 0%, ${color}22 60%, transparent 70%)"></div>
          ${it.icon ? `<img class="px" src="${A(`items/${it.icon}.png`)}" style="left:9px;top:2px;width:32px;height:32px" onerror="this.remove()">` : ""}
          <div class="txt nm" style="color:${showCost ? "#f8f8f8" : color}!important">${esc(it.label)}</div>
          ${showCost && it.a.data?.cost != null ? `<div class="txt smalltxt" style="left:0;top:45px;width:50px;text-align:center;color:#f8d030!important">₽${it.a.data.cost}</div>` : ""}
        </div>`);
      });
    };
    if (this.rows[0].length) {
      cardRow(this.rows[0], 12, false);
    } else {
      html.push(`<div class="txt" style="left:16px;top:28px">No reward fits your party.</div>`);
    }
    if (this.rows[1].length) {
      html.push(`<div class="txt smalltxt" style="left:14px;top:66px">Shop</div>`);
      cardRow(this.rows[1], 70, true);
    }
    // bottom: description + reroll / skip window
    const cur = this.items[this.cursor];
    const desc = cur?.a?.data?.desc ?? (cur?.a?.id === "reroll" ? "Roll new rewards." : cur?.a?.id === "skip" ? "Take nothing this wave." : cur?.a?.id === "transfer" ? "Manage Pokémon held items (Transfer/Discard)." : "");
    html.push(`<div class="msgbox"></div><div class="txt msgtext smalltxt" style="width:186px;line-height:10px!important;top:140px">${esc(desc)}</div>`);
    // Reroll / Skip / Manage Items / Lock Rarities (the window grows with the buttons the game shows)
    const n = this.rows[2].length;
    const step = n > 3 ? 11 : 14;
    const wy = Math.min(132, 180 - (n * step + 9));
    const ty = n > 3 ? 5 : 8;
    html.push(win(206, wy, 114, 180 - wy));
    const locked = resp?.decision?.context?.lockRarities;
    this.rows[2].forEach((it, k) => {
      const i = this.items.indexOf(it);
      const sel = i === this.cursor;
      const label = it.a.id === "reroll" ? `Reroll ₽${it.a.data?.cost ?? ""}${locked ? " (lock)" : ""}` : it.label;
      html.push(`<div class="txt item" data-i="${i}" style="left:222px;top:${wy + ty + k * step}px">${esc(label)}</div>`);
      if (sel) {
        html.push(cursorAt(213, wy + ty + 1 + k * step));
      }
    });
    if (resp?.decision?.obs) {
      html.push(`<div class="txt" style="right:14px;top:12px;color:#f8d030!important">₽${resp.decision.obs.money.toLocaleString()}</div>`);
    }
    return html.join("");
  }
}

// ---- end of run

class EndScreen extends Screen {
  constructor(end) {
    super();
    this.end = end;
    this.items = [{ label: "New run", act: () => openNew() }];
  }
  render() {
    const e = this.end;
    return `<div class="overlay center"><div class="title-box txt">
      <div class="big">${e.cause === "wipe" ? "Game Over" : esc(e.cause)}</div>
      <div>Reached wave ${e.wave} · cleared ${e.wavesCleared}</div>
      <div>${e.decisions} decisions</div>
      <div class="item" data-i="0">▶ New run (Z)</div></div></div>`;
  }
}

// ------------------------------------------------------------------ decision -> screen

function rootScreen(d) {
  const all = d.actions.map((_, i) => i);
  switch (d.kind) {
    case "command":
      return new CommandScreen(d);
    case "target":
      return new TargetScreen(d);
    case "party":
      if (d.sub === "DISCARD" && d.context?.stage) {
        return discardScreen(d);
      }
      if (d.sub === "MODIFIER_TRANSFER" && d.context?.stage) {
        return transferScreen(d);
      }
      return new PartyScreen(d, { cancelId: "cancel" });
    case "catch_full":
      return new PartyScreen(d, {
        filter: a => a.id.startsWith("release:"),
        cancelId: "keep_party",
        cancelLabel: "Don't keep",
        prompt: `Release one to keep ${d.context?.caught ?? "the new Pokémon"}?`,
      });
    case "reward":
      return new RewardScreen(d);
    case "learn_move":
    case "forget_move":
      return learnMoveScreen(d);
    default:
      return new ListScreen(d, all, d.prompt ?? titleCase(d.sub ?? d.kind));
  }
}

function showDecision() {
  clearTimeout(autoTimer);
  if (resp?.end) {
    screenStack = [new EndScreen(resp.end)];
    renderUi();
    status(`run over · ${esc(resp.end.cause)}`);
    return;
  }
  const d = resp?.decision;
  if (!d) {
    screenStack = [];
    renderUi();
    return;
  }
  const root = rootScreen(d);
  root.fixCursor();
  screenStack = [root];
  decisionShownAt = performance.now();
  renderUi();
  status(`step ${d.step} · ${esc(d.kind)}${d.sub ? `/${esc(d.sub)}` : ""} · ${d.actions.length} legal${resp.simMs != null ? ` · sim ${resp.simMs} ms` : ""}`);
}

function renderUi() {
  const ui = $("#ui");
  if (msgActive) {
    sprites.forEach(s => s.el.classList.remove("target"));
    ui.innerHTML = `${msgBox(msgActive.text)}${opts.auto ? "" : '<div class="advance" style="left:auto"></div>'}`;
    return;
  }
  const s = topScreen();
  if (!s) {
    ui.innerHTML = resp?.decision ? "" : "";
    return;
  }
  if (!(s instanceof TargetScreen)) {
    sprites.forEach(x => x.el.classList.remove("target"));
  }
  ui.innerHTML = s.render();
}

function openAllActions() {
  const d = resp?.decision;
  if (!d || msgActive) {
    return;
  }
  if (topScreen() instanceof ListScreen && topScreen().title === "All legal actions") {
    pop();
    return;
  }
  push(new ListScreen(d, d.actions.map((_, i) => i), "All legal actions", true, a => a.label));
}

// ------------------------------------------------------------------ input

document.addEventListener("keydown", ev => {
  if (document.querySelector("dialog[open]") || ev.ctrlKey || ev.metaKey || ev.altKey || ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) {
    return;
  }
  const k = ev.key;
  const lower = k.toLowerCase();
  if (lower === "a" && !ev.repeat) {
    setAuto(!opts.auto);
    return;
  }
  if (lower === "n" && (!resp?.decision || resp?.end)) {
    openNew();
    return;
  }
  if (lower === "r" && !ev.repeat) {
    openRuns();
    return;
  }
  if (msgActive) {
    if (["z", "x", "enter", " ", "escape", "backspace"].includes(lower)) {
      ev.preventDefault();
      nextMessage();
    }
    return;
  }
  const s = topScreen();
  if (k === "Tab") {
    ev.preventDefault();
    openAllActions();
    return;
  }
  if (!s || busy) {
    if (lower === "n") {
      openNew();
    }
    return;
  }
  const map = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  if (map[lower]) {
    ev.preventDefault();
    s.nav(...map[lower]);
    renderUi();
  } else if (lower === "z" || lower === "enter" || lower === " ") {
    ev.preventDefault();
    s.activate();
  } else if (lower === "x" || lower === "escape" || lower === "backspace") {
    ev.preventDefault();
    if (typeof s.back === "function") {
      s.back();
    } else if (s.back) {
      pop();
    }
  } else if (/^[1-9]$/.test(k)) {
    s.pick(Number(k));
  }
});

$("#screen").addEventListener("click", ev => {
  if (document.querySelector("dialog[open]")) {
    return;
  }
  if (msgActive) {
    nextMessage();
    return;
  }
  const el = ev.target.closest("[data-i]");
  const s = topScreen();
  if (el && s) {
    const i = Number(el.dataset.i);
    if (s instanceof RewardScreen) {
      const it = s.items[i];
      s.row = s.rows.findIndex(r => r.includes(it));
      s.col = s.rows[s.row].indexOf(it);
      s.sync();
      if (ev.detail === 1 && s.cursor !== i) {
        renderUi();
        return;
      }
    }
    s.activate(i);
  }
});
$("#screen").addEventListener("contextmenu", ev => {
  ev.preventDefault();
  const s = topScreen();
  if (s && !msgActive) {
    if (typeof s.back === "function") {
      s.back();
    } else if (s.back) {
      pop();
    }
  }
});

function setAuto(on) {
  opts.auto = on;
  localStorage.setItem("prl.auto", on ? "1" : "0");
  $("#optAuto").checked = on;
  if (on && msgActive) {
    autoTimer = setTimeout(nextMessage, opts.speed);
  }
  renderUi();
}
$("#optAuto").checked = opts.auto;
$("#optAuto").onchange = () => setAuto($("#optAuto").checked);
$("#optSpeed").value = String(opts.speed);
$("#optSpeed").onchange = () => {
  opts.speed = Number($("#optSpeed").value);
  localStorage.setItem("prl.speed", String(opts.speed));
};

// ------------------------------------------------------------------ scaling

function fit() {
  const stage = $("#stage");
  const k = Math.max(1, Math.min(stage.clientWidth / W, stage.clientHeight / H));
  $("#screen").style.transform = `translate(-50%, -50%) scale(${k})`;
}
window.addEventListener("resize", fit);

// ------------------------------------------------------------------ new run / runs / review dialogs

let starters = null;
let cap = 15;
let picked = [];

async function loadStarters() {
  if (!starters) {
    const out = await api("starters");
    starters = out.starters;
    cap = out.cap;
  }
}
async function openNew() {
  if (document.querySelector("dialog[open]")) {
    return;
  }
  await loadStarters();
  picked = [];
  $("#seed").value = "";
  $("#preview").textContent = "";
  renderPicked();
  $("#dlgNew").showModal();
  $("#seed").focus();
}
const teamMode = () => document.querySelector("input[name=teamMode]:checked").value;
function renderPicked() {
  const pts = picked.reduce((s, p) => s + p.cost, 0);
  $("#picked").innerHTML = picked.length ? picked.map((p, i) => `<span class="chip" data-i="${i}" title="remove">${esc(p.name)} (${p.cost}) ✕</span>`).join("") : `<span class="muted">Pick up to 6 starters</span>`;
  $("#points").textContent = `${pts}/${cap} pts`;
  $("#picked").querySelectorAll(".chip").forEach(c => {
    c.onclick = () => {
      picked.splice(Number(c.dataset.i), 1);
      renderPicked();
    };
  });
  const left = cap - pts;
  const q = $("#search").value.trim().toLowerCase();
  const list = (starters || []).filter(s => s.cost <= left && !picked.some(p => p.id === s.id) && (!q || s.name.toLowerCase().includes(q))).slice(0, 400);
  $("#starterList").innerHTML = picked.length >= 6 ? `<span class="muted">Party full</span>` : list.map(s => `<button type="button" data-id="${s.id}"><span>${esc(s.name)}</span><span class="muted">${s.cost}</span></button>`).join("");
  $("#starterList").querySelectorAll("button").forEach(b => {
    b.onclick = () => {
      const s = starters.find(x => x.id === Number(b.dataset.id));
      if (s && picked.length < 6) {
        picked.push(s);
        renderPicked();
      }
    };
  });
}
document.querySelectorAll("input[name=teamMode]").forEach(r => {
  r.onchange = () => {
    $("#randomBox").classList.toggle("hidden", teamMode() !== "random");
    $("#chooseBox").classList.toggle("hidden", teamMode() !== "choose");
  };
});
$("#search").oninput = renderPicked;
$("#btnPreview").onclick = async () => {
  const seed = $("#seed").value.trim();
  if (!seed) {
    $("#preview").textContent = "Enter a seed to preview its team (blank = random seed, team revealed on start).";
    return;
  }
  try {
    const out = await api("preview", { seed });
    $("#preview").textContent = `${out.team.names.map((n, i) => `${n} (${out.team.costs[i]})`).join(", ")} · ${out.team.points}/${out.team.cap} pts`;
  } catch (e) {
    $("#preview").textContent = e.message;
  }
};
$("#formNew").addEventListener("submit", async ev => {
  if (ev.submitter?.value !== "start") {
    return;
  }
  const args = { policy: "human", seed: $("#seed").value.trim() || undefined };
  if (teamMode() === "choose") {
    if (!picked.length) {
      ev.preventDefault();
      return;
    }
    args.team = picked.map(p => p.id);
  }
  resetView();
  status("booting run…");
  await send("reset", args);
});

function resetView() {
  shown = null;
  msgQueue = [];
  msgActive = null;
  pendingApply = null;
  screenStack = [];
  sprites.forEach(s => s.el.remove());
  sprites.clear();
  $("#infos").innerHTML = "";
}

async function openRuns() {
  if (document.querySelector("dialog[open]")) {
    return;
  }
  const out = await api("runs");
  $("#runList").innerHTML = out.runs.length
    ? `<table><tr><th>Started</th><th>Seed</th><th>Team</th><th>Wave</th><th>Decisions</th><th>Status</th><th></th></tr>${out.runs
        .map(
          r => `<tr><td>${esc(new Date(r.time).toLocaleString())}</td><td>${esc(r.seed)}</td><td>${esc(r.team.join(", "))}</td><td>${r.wave}</td><td>${r.decisions}</td>
        <td>${r.ended ? esc(r.ended) : r.active ? "playing" : r.sameGame === false ? `old game ${esc(String(r.gamePin ?? "?").slice(0, 7))}` : "paused"}</td>
        <td>${!r.ended && !r.active && r.sameGame !== false ? `<button data-resume="${esc(r.runId)}">Resume</button> ` : ""}<button data-review="${esc(r.runId)}">Review</button></td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No human runs yet.</p>`;
  $("#runList").querySelectorAll("[data-resume]").forEach(b => {
    b.onclick = async () => {
      $("#dlgRuns").close();
      resetView();
      status("replaying run to where it stopped…");
      const r = await send("resume", { runId: b.dataset.resume });
      if (r) {
        status(`resumed: replayed ${r.replayed} decisions in ${r.replayMs} ms`);
      }
    };
  });
  $("#runList").querySelectorAll("[data-review]").forEach(b => {
    b.onclick = () => review(b.dataset.review);
  });
  $("#dlgRuns").showModal();
}

async function review(runId) {
  const out = await api("review", { runId });
  $("#reviewTitle").textContent = `Review · ${runId}`;
  $("#reviewBody").innerHTML = `<table><tr><th>Step</th><th>Wave</th><th>Kind</th><th>Chosen</th><th>Options</th><th>Think</th></tr>${out.records
    .map(r => {
      if (r.t === "d") {
        return `<tr><td>${r.step}</td><td>${r.wave}</td><td>${esc(r.sub ? `${r.kind}/${r.sub}` : r.kind)}</td><td><b>${esc(r.label)}</b></td><td class="muted">${esc((r.options || []).join(" | "))}</td><td class="muted">${r.thinkMs != null ? `${(r.thinkMs / 1000).toFixed(1)}s` : ""}</td></tr>`;
      }
      if (r.t === "wave") {
        return `<tr><td></td><td colspan="5" class="muted">→ wave ${r.wave} (party HP ${Math.round((r.partyHpFrac ?? 0) * 100)}%, ${r.alive} alive)</td></tr>`;
      }
      if (r.t === "end" || r.t === "resume" || r.t === "rej") {
        return `<tr><td></td><td colspan="5" class="muted">${esc(r.t)} ${esc(r.cause ?? r.action ?? r.session ?? "")}</td></tr>`;
      }
      return "";
    })
    .join("")}</table>`;
  $("#dlgReview").showModal();
}

$("#btnNew").onclick = openNew;
$("#btnRuns").onclick = openRuns;
$("#btnRunsClose").onclick = () => $("#dlgRuns").close();
$("#btnReviewClose").onclick = () => $("#dlgReview").close();

// ------------------------------------------------------------------ boot

(async () => {
  fit();
  await Promise.all(["types", "statuses", "categories"].map(n => cssAtlas(n).catch(() => null)));
  try {
    const out = await api("state");
    if (out.decision || out.end) {
      receive({ ...out, messages: [] });
    }
  } catch {
    /* server not up */
  }
})();
