// Human play UI for the pokerogue-rl sim server. Plain JS, no build step.
// Every click goes through the same legal-action API the agents use (POST /api {cmd: "step", index}).
"use strict";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KEYS = "1234567890qwertyuiopasdfghjklzxcvbnm".split("");
const TYPE_COLORS = {
  NORMAL: "#9fa19f", FIGHTING: "#ff8000", FLYING: "#81b9ef", POISON: "#9141cb", GROUND: "#915121", ROCK: "#afa981",
  BUG: "#91a119", GHOST: "#704170", STEEL: "#60a1b8", FIRE: "#e62829", WATER: "#2980ef", GRASS: "#3fa129",
  ELECTRIC: "#fac000", PSYCHIC: "#ef4179", ICE: "#3dcef3", DRAGON: "#5060e1", DARK: "#624d4e", FAIRY: "#ef70ef",
  STELLAR: "#40b5a5", UNKNOWN: "#68a090",
};
const TIERS = ["Common", "Great", "Ultra", "Rogue", "Master", "Luxury"];
const TIER_COLORS = ["#d8d8d8", "#5aa0ff", "#f2c14e", "#ef5b5b", "#c77dff", "#40e0d0"];
const STAT = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
const STAGE = ["Atk", "Def", "SpA", "SpD", "Spe", "Acc", "Eva"];
const CAT = ["Phys", "Spec", "Status"];
const BALLS = ["Poké Ball", "Great Ball", "Ultra Ball", "Rogue Ball", "Master Ball", "Luxury Ball"];

let state = null; // last server response
let busy = false;
let shownAt = 0;
let starters = null;
let cap = 15;
let picked = [];
let msgHistory = [];

async function api(cmd, args = {}) {
  const res = await fetch("/api", { method: "POST", body: JSON.stringify({ cmd, ...args }) });
  const out = await res.json();
  if (!out.ok) {
    throw new Error(out.error || "request failed");
  }
  return out;
}

function setBusy(b) {
  busy = b;
  $("#busy").classList.toggle("hidden", !b);
}

async function act(cmd, args) {
  if (busy) {
    return;
  }
  setBusy(true);
  try {
    const out = await api(cmd, args);
    apply(out);
    return out;
  } catch (e) {
    footer(`<span class="err">${esc(e.message)}</span>`);
  } finally {
    setBusy(false);
  }
}

function footer(html) {
  $("#footer").innerHTML = html;
}

// ------------------------------------------------------------------ rendering

const typePill = t => `<span class="type" style="background:${TYPE_COLORS[t] || "#666"}">${esc(t)}</span>`;
const hpColor = f => (f > 0.5 ? "var(--good)" : f > 0.2 ? "var(--warn)" : "var(--bad)");
const hpBar = f => `<div class="hpbar"><div style="width:${Math.max(0, Math.min(1, f)) * 100}%;background:${hpColor(f)}"></div></div>`;
const stages = arr => {
  const parts = (arr || []).map((v, i) => (v ? `${STAGE[i]} ${v > 0 ? "+" : ""}${v}` : "")).filter(Boolean);
  return parts.length ? `<div class="stages">${parts.join(" · ")}</div>` : "";
};

function apply(out) {
  state = out;
  if (out.messages?.length) {
    msgHistory = msgHistory.map(m => ({ ...m, fresh: false })).concat(out.messages.map(t => ({ t, fresh: true }))).slice(-60);
  } else {
    msgHistory = msgHistory.map(m => ({ ...m, fresh: false }));
  }
  render();
}

function render() {
  const d = state?.decision;
  const obs = d?.obs;
  // header
  if (obs) {
    const wx = [obs.weatherName, obs.terrainName].filter(Boolean).map(esc).join(" · ");
    $("#status").innerHTML =
      `<span>Wave <b>${obs.wave}</b></span><span>Biome <b>${esc(obs.biome)}</b></span>` +
      `<span>Money <b>₽${obs.money.toLocaleString()}</b></span><span>Turn <b>${obs.turn}</b></span>` +
      `<span>${obs.double ? "Double" : "Single"} · ${esc(obs.battleType)}</span>${wx ? `<span>${wx}</span>` : ""}` +
      `<span>Seed <b>${esc(state.seed)}</b></span>`;
  } else if (state?.end) {
    $("#status").innerHTML = `<span>Run over · wave <b>${state.end.wave}</b></span><span>Seed <b>${esc(state.seed)}</b></span>`;
  }
  if (obs) {
    renderEnemies(obs);
    renderParty(obs);
  }
  renderMessages();
  renderDecision();
  if (state?.runId) {
    footer(`run <b>${esc(state.runId)}</b> · logging to ${esc(state.logFile ?? "(not logged)")} · step ${d?.step ?? state.end?.decisions ?? ""}${state.simMs != null ? ` · sim ${state.simMs} ms` : ""}`);
  }
}

function renderEnemies(obs) {
  const ballLine = Object.entries(obs.balls || {}).filter(([, n]) => n > 0).map(([k, n]) => `${esc(BALLS[k] ?? k)} ×${n}`).join(" · ");
  $("#enemies").innerHTML =
    (obs.enemies || [])
      .map(
        e => `<div class="mon">
      <div class="top"><span class="name">${esc(e.name)}${e.shiny ? " ✨" : ""}</span><span class="lvl">Lv ${e.level}</span></div>
      ${hpBar(e.hpFrac)}
      <div class="row">${(e.types || []).map(typePill).join("")}
        ${e.status ? `<span class="status-pill">${esc(e.status)}</span>` : ""}
        ${e.boss ? `<span class="boss">BOSS ${e.bossSegments > 1 ? `${e.bossSegments - e.bossSegmentIndex}/${e.bossSegments} bars` : ""}</span>` : ""}
        <span class="small">${Math.round(e.hpFrac * 100)}%</span></div>
      ${stages(e.statStages)}
    </div>`,
      )
      .join("") + (ballLine ? `<div class="small">Balls: ${ballLine}</div>` : "");
}

function renderParty(obs) {
  const items = (obs.items || []).map(i => `${esc(i.name)}${i.count > 1 ? ` ×${i.count}` : ""}`).join(", ");
  $("#items").textContent = items ? `· ${items}` : "";
  $("#party").innerHTML = (obs.party || [])
    .map(p => {
      const f = p.maxHp ? p.hp / p.maxHp : 0;
      const moves = (p.moves || [])
        .map(m => `<div title="${esc(`${m.type} · ${CAT[m.category] || ""} · pow ${m.power > 0 ? m.power : "—"} · acc ${m.accuracy > 0 ? m.accuracy : "—"}`)}"><span style="color:${TYPE_COLORS[m.type] || "#aaa"}">●</span> ${esc(m.name)}<span class="pp">${m.pp}/${m.ppMax}</span></div>`)
        .join("");
      const held = (p.items || []).map(i => `${esc(i.name)}${i.count > 1 ? ` ×${i.count}` : ""}`).join(", ");
      return `<div class="mon ${p.onField ? "active" : ""} ${p.fainted ? "fainted" : ""}">
        <div class="top"><span class="name">${p.slot + 1}. ${esc(p.name)}</span><span class="lvl">Lv ${p.level} · ${p.hp}/${p.maxHp}</span></div>
        ${hpBar(f)}
        <div class="row">${(p.types || []).map(typePill).join("")}${p.status ? `<span class="status-pill">${esc(p.status)}</span>` : ""}<span class="small">${esc(p.ability)}</span></div>
        <div class="moves">${moves}</div>
        <div class="stats">${(p.stats || []).map((s, i) => `${STAT[i]} ${s}`).join(" · ")}</div>
        ${stages(p.statStages)}
        ${held ? `<div class="small">Held: ${held}</div>` : ""}
      </div>`;
    })
    .join("");
}

function renderMessages() {
  $("#messages").innerHTML = msgHistory
    .slice()
    .reverse()
    .map(m => `<div class="${m.fresh ? "new" : "old"}">${esc(m.t)}</div>`)
    .join("");
}

function actionDetail(d, a) {
  const obs = d.obs;
  const kind = a.id.split(/[:/]/)[0];
  let sub = "";
  if (d.kind === "command" && kind === "move") {
    const mon = obs?.party?.[d.context?.slot ?? 0];
    const m = mon?.moves?.find(x => x.id === a.data?.moveId);
    if (m) {
      sub = `${typePill(m.type)} ${CAT[m.category] || ""} · pow ${m.power > 0 ? m.power : "—"} · acc ${m.accuracy > 0 ? m.accuracy : "—"} · PP ${m.pp}/${m.ppMax}`;
    }
  } else if ((d.kind === "command" && kind === "switch") || (d.kind === "party" && a.data?.slot != null)) {
    const p = obs?.party?.[a.data.slot];
    if (p) {
      sub = `Lv ${p.level} · HP ${p.hp}/${p.maxHp}${p.status ? ` · ${esc(p.status)}` : ""} · ${(p.types || []).map(typePill).join(" ")}`;
    }
  } else if (kind === "ball") {
    sub = `${a.data?.count ?? "?"} left`;
  } else if (kind === "reward" || kind === "shop") {
    const tier = a.data?.tier;
    sub = `${tier != null ? `<b style="color:${TIER_COLORS[tier] || "#ccc"}">${TIERS[tier] || tier}</b> · ` : ""}${a.data?.cost != null ? `₽${a.data.cost} · ` : ""}${esc(a.data?.desc || "")}`;
  } else if (kind === "reroll") {
    sub = `₽${a.data?.cost}`;
  } else if (kind === "target") {
    const e = obs?.enemies?.find(x => x.name === a.label);
    if (e) {
      sub = `${Math.round(e.hpFrac * 100)}% HP`;
    }
  }
  return { kind, sub };
}

function renderDecision() {
  const box = $("#decision");
  if (state?.end) {
    const e = state.end;
    box.innerHTML = `<div class="end"><div class="big">${e.cause === "wipe" ? "Party wiped" : esc(e.cause)}</div>
      <div>Reached wave <b>${e.wave}</b> · cleared ${e.wavesCleared} · ${e.decisions} decisions</div>
      <p><button class="primary" id="btnAgain">New run <kbd>N</kbd></button></p></div>`;
    $("#btnAgain").onclick = openNew;
    return;
  }
  const d = state?.decision;
  if (!d) {
    box.innerHTML = `<div class="empty">Start a run with <b>New run</b> (or press <kbd>N</kbd>), or resume one from <b>Runs</b>.</div>`;
    return;
  }
  const ctx = d.context || {};
  let ctxLine = "";
  if (d.kind === "command") {
    ctxLine = `What will <b>${esc(ctx.mon)}</b> do?`;
  } else if (d.kind === "target") {
    ctxLine = `Target for <b>${esc(ctx.move)}</b>`;
  } else if (d.kind === "learn_move") {
    ctxLine = `${esc(ctx.move)} · ${esc(ctx.type ?? "")} · pow ${ctx.power > 0 ? ctx.power : "—"} · acc ${ctx.accuracy > 0 ? ctx.accuracy : "—"}`;
  } else if (d.kind === "catch_full") {
    ctxLine = `Caught <b>${esc(ctx.caught)}</b> (Lv ${ctx.level}) but the party is full.`;
  } else if (d.kind === "reward") {
    ctxLine = `Money ₽${(ctx.money ?? 0).toLocaleString()}`;
  }
  const kindLabel = d.sub ? `${d.kind} · ${d.sub}` : d.kind;
  box.innerHTML = `<span class="kind">${esc(kindLabel)}</span>
    ${d.prompt ? `<div class="prompt">${esc(d.prompt)}</div>` : ""}
    <div class="ctx">${ctxLine}</div>
    <div class="actions">${d.actions
      .map((a, i) => {
        const { kind, sub } = actionDetail(d, a);
        return `<button class="act k-${esc(kind)}" data-i="${i}">
          <span class="key">${KEYS[i] ? `<kbd>${KEYS[i]}</kbd>` : ""}</span>
          <span class="lbl">${esc(a.label)}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</button>`;
      })
      .join("")}</div>`;
  box.querySelectorAll(".act").forEach(b => {
    b.onclick = () => choose(Number(b.dataset.i));
  });
  shownAt = performance.now();
}

function choose(i) {
  const d = state?.decision;
  if (!d || busy || i >= d.actions.length) {
    return;
  }
  act("step", { index: i, expect: d.actions[i].id, thinkMs: Math.round(performance.now() - shownAt) });
}

// ------------------------------------------------------------------ new run

async function loadStarters() {
  if (!starters) {
    const out = await api("starters");
    starters = out.starters;
    cap = out.cap;
  }
}

async function openNew() {
  await loadStarters();
  picked = [];
  $("#seed").value = "";
  $("#preview").textContent = "";
  renderPicked();
  $("#dlgNew").showModal();
  $("#seed").focus();
}

function teamMode() {
  return document.querySelector("input[name=teamMode]:checked").value;
}

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
  const seed = $("#seed").value.trim() || undefined;
  const args = { policy: "human", seed };
  if (teamMode() === "choose") {
    if (!picked.length) {
      ev.preventDefault();
      return;
    }
    args.team = picked.map(p => p.id);
  }
  msgHistory = [];
  footer("booting run…");
  await act("reset", args);
});

// ------------------------------------------------------------------ runs / resume / review

async function openRuns() {
  const out = await api("runs");
  $("#runList").innerHTML = out.runs.length
    ? `<table><tr><th>Started</th><th>Seed</th><th>Team</th><th>Wave</th><th>Decisions</th><th>Status</th><th></th></tr>${out.runs
        .map(
          r => `<tr><td>${esc(new Date(r.time).toLocaleString())}</td><td>${esc(r.seed)}</td><td>${esc(r.team.join(", "))}</td><td>${r.wave}</td><td>${r.decisions}</td>
        <td>${r.ended ? esc(r.ended) : r.active ? "playing" : "paused"}</td>
        <td>${!r.ended && !r.active ? `<button data-resume="${esc(r.runId)}">Resume</button> ` : ""}<button data-review="${esc(r.runId)}">Review</button></td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No human runs yet.</p>`;
  $("#runList").querySelectorAll("[data-resume]").forEach(b => {
    b.onclick = async () => {
      $("#dlgRuns").close();
      msgHistory = [];
      footer("replaying run to where it stopped…");
      const out = await act("resume", { runId: b.dataset.resume });
      if (out) {
        msgHistory = [{ t: `Resumed: replayed ${out.replayed} decisions in ${out.replayMs} ms.`, fresh: true }];
        renderMessages();
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
        return `<tr><td>${r.step}</td><td>${r.wave}</td><td>${esc(r.sub ? `${r.kind}/${r.sub}` : r.kind)}</td><td><b>${esc(r.label)}</b></td><td class="small">${esc((r.options || []).join(" | "))}</td><td class="small">${r.thinkMs != null ? `${(r.thinkMs / 1000).toFixed(1)}s` : ""}</td></tr>`;
      }
      if (r.t === "wave") {
        return `<tr><td></td><td colspan="5" class="small">→ wave ${r.wave} (party HP ${Math.round((r.partyHpFrac ?? 0) * 100)}%, ${r.alive} alive)</td></tr>`;
      }
      if (r.t === "end" || r.t === "resume" || r.t === "rej") {
        return `<tr><td></td><td colspan="5" class="small">${esc(r.t)} ${esc(r.cause ?? r.action ?? r.session ?? "")}</td></tr>`;
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

// ------------------------------------------------------------------ keyboard

document.addEventListener("keydown", ev => {
  if (document.querySelector("dialog[open]") || ev.ctrlKey || ev.metaKey || ev.altKey) {
    return;
  }
  if (ev.target instanceof HTMLInputElement) {
    return;
  }
  const k = ev.key.toLowerCase();
  if (k === "n" && !state?.decision?.actions?.length) {
    openNew();
    return;
  }
  if (k === "r" && !state?.decision?.actions?.some((_, i) => KEYS[i] === "r")) {
    openRuns();
    return;
  }
  if (k === "n" && !state?.decision?.actions?.some((_, i) => KEYS[i] === "n")) {
    openNew();
    return;
  }
  const i = KEYS.indexOf(k);
  if (i >= 0) {
    ev.preventDefault();
    choose(i);
  }
});

// Pick up an in-progress run if the page is reloaded.
api("state").then(apply).catch(() => {});
