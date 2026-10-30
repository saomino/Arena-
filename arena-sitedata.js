// ============================================================
// ARENA — données publiques du site (animaux, événements, trios…)
// ============================================================
// Au démarrage, le bot calcule la liste des animaux, les événements, les
// bonus de type et les meilleurs trios monotype (par simulation), puis les
// envoie à Supabase (table site_data). Le site les lit à chaque ouverture :
// plus besoin de régénérer index.html quand le jeu change.
// Les images et illustrations restent dans index.html (le site les garde
// par identifiant d'animal ; un nouvel animal s'affiche avec son emoji
// tant qu'on ne lui a pas ajouté d'image).
//
// Ne fait rien si Supabase n'est pas configuré, et ne fait jamais planter
// le bot.
import {
  ANIMAL_LIST,
  EVENT_THEMES,
  TRIO_BONUS,
  JURASSIK_TRIO,
  JURASSIK_MONO_EXTRA,
  DISCORD_ATTACK_MULT,
  TYPES,
  TYPE_BEATS,
  STAR_MAX,
  LEGENDARY_ITEMS,
  skillRateAtLevel,
  skillPowerAtLevel,
  allSkillsForAnimal
} from "./arena-data.js";
import { MYTHICS, MYTHIC_MIN_EVENT_ANIMALS, MYTHIC_TOWER_FLOOR } from "./arena-mythics.js";
import { simulateCombat, simulatePvP } from "./arena-combat.js";
import { floorBoss } from "./arena-tower.js";
import { supabaseEnabled, sbRequest } from "./arena-supabase.js";
import { arenaDataDir } from "./arena-players.js";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

// Empreinte des fichiers de règles : le site la compare à celle du moteur
// de simulation qu'il contient, pour prévenir quand le jeu a changé.
function engineHash() {
  try {
    const h = crypto.createHash("sha1");
    for (const f of ["arena-data.js", "arena-combat.js", "arena-tower.js", "arena-balance.js", "arena-balance-data.js"]) {
      h.update(fs.readFileSync(new URL(`./${f}`, import.meta.url)));
    }
    return h.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

const CATS = ["defense", "soutien", "attaque"];
const TYPE_IDS = ["terre", "air", "eau"];

// Valeur d'un animal dans un rôle (compétences niveau 10, bonus de rôle).
function roleValue(a, role) {
  let dmg = 0, sh = 0, he = 0;
  for (const s of a.skills) {
    let r = skillRateAtLevel(s, 10);
    let p = skillPowerAtLevel(s, 10);
    if (s.category === role) {
      r = Math.min(90, r + 15);
      p = Math.round(p * 1.25);
    }
    const fx = s.effect || {};
    const q = r / 100;
    if (s.category === "attaque") {
      let m = 1;
      if (fx.doubleChance) m *= 1 + fx.doubleChance / 100;
      if (fx.critChance) m *= 1 + 0.5 * fx.critChance / 100;
      if (fx.rage) m *= 1 + fx.rage * 0.35;
      dmg += q * p * m;
    } else if (s.category === "defense") {
      sh += q * p * (fx.fortify ? 1 + fx.fortify / 100 : 1);
    } else {
      he += q * p * 0.5 * (fx.teamWide ? 2 : 1);
    }
  }
  return { attaque: dmg, defense: sh, soutien: he }[role];
}

function roleOnlyScore(a, cat) {
  let t = 0;
  for (const s of a.skills) {
    if (s.category !== cat) continue;
    const r = Math.min(90, skillRateAtLevel(s, 10) + 15);
    const p = Math.round(skillPowerAtLevel(s, 10) * 1.25);
    const fx = s.effect || {};
    let m = 1;
    if (cat === "attaque") {
      if (fx.doubleChance) m *= 1 + fx.doubleChance / 100;
      if (fx.critChance) m *= 1 + 0.5 * fx.critChance / 100;
      if (fx.rage) m *= 1 + fx.rage * 0.35;
    } else if (cat === "defense") {
      if (fx.fortify) m *= 1 + fx.fortify / 100;
    } else if (fx.teamWide) m *= 2;
    t += (r / 100) * p * m;
  }
  return t;
}

function makePlayer(x, y, z) {
  const p = {
    formation: { defenseur: x.id, soutien: y.id, attaquant: z.id },
    animaux: {}, etoiles: {}, items: [], equipped: {}, victoires: 0
  };
  for (const a of [x, y, z]) {
    p.etoiles[a.id] = 5;
    p.animaux[a.id] = { competences: {} };
    for (const s of allSkillsForAnimal(a)) p.animaux[a.id].competences[s.id] = 10;
  }
  return p;
}

// Meilleurs trios monotype par type (simulation : tour + duels).
export function computeIdeas() {
  // Étape 1 : TOUS les trios monotype ordonnés (défenseur/soutien/attaquant), criblés sur la tour.
  // Étape 2 : les meilleurs finalistes de chaque type sont re-testés sur la tour puis en tournoi de duels.
  const sFloors = [33, 38], sN = 4;
  const fFloors = [30, 33, 36, 38, 40], fN = 10;
  const run = (p, floors, n) => {
    let dealt = 0, w = 0;
    for (const f of floors) {
      const b = floorBoss(f);
      for (let i = 0; i < n; i++) {
        const r = simulateCombat(p, { boss: b });
        dealt += Math.min(1, r.totalDamage / b.maxHp);
        if (r.victory) w++;
      }
    }
    return { pve: dealt / (floors.length * n), win: w / (floors.length * n) };
  };
  const cand = [];
  for (const t of TYPE_IDS) {
    const pool = ANIMAL_LIST.filter(a => a.type === t);
    const all = [];
    for (const x of pool) for (const y of pool) for (const z of pool) {
      if (x === y || y === z || x === z) continue;
      const p = makePlayer(x, y, z);
      all.push({ t, d: x, s: y, a: z, p, pre: run(p, sFloors, sN).pve });
    }
    all.sort((a, b) => b.pre - a.pre);
    // Cribles duel : chaque trio affronte 8 équipes de référence (les meilleures sur la tour + un échantillon régulier).
    const refs = [...all.slice(0, 4), ...all.filter((_, i) => i % 611 === 305)].slice(0, 8);
    for (const q of all) {
      let w = 0;
      for (const r of refs) for (let k = 0; k < 2; k++) {
        const res = k ? simulatePvP(r.p, q.p) : simulatePvP(q.p, r.p);
        if (res.winner === "draw") w += 0.5; else if ((res.winner === "A") === (k === 0)) w++;
      }
      q.pre2 = w;
    }
    const fin = new Set(all.slice(0, 20));
    [...all].sort((a, b) => b.pre2 - a.pre2).slice(0, 24).forEach(q => fin.add(q));
    for (const q of fin) {
      const r = run(q.p, fFloors, fN);
      q.pve = r.pve; q.win = r.win;
      cand.push(q);
    }
  }
  const N2 = 16;
  const wins = cand.map(() => 0), games = cand.map(() => 0);
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      for (let k = 0; k < N2; k++) {
        const r = k % 2 ? simulatePvP(cand[j].p, cand[i].p) : simulatePvP(cand[i].p, cand[j].p);
        const iA = k % 2 === 0;
        games[i]++; games[j]++;
        if (r.winner === "draw") { wins[i] += 0.5; wins[j] += 0.5; }
        else if ((r.winner === "A") === iA) wins[i]++;
        else wins[j]++;
      }
    }
  }
  const rows = cand.map((q, i) => ({
    t: q.t, d: q.d.id, s: q.s.id, a: q.a.id,
    pvp: Math.round((wins[i] / games[i]) * 100),
    tower: Math.round(q.pve * 100),
    win: Math.round(q.win * 100)
  }));
  const out = {};
  for (const t of TYPE_IDS) {
    out[t] = rows.filter(r => r.t === t).sort((a, b) => (b.pvp + b.tower) - (a.pvp + a.tower)).slice(0, 8);
  }
  return out;
}

export function buildSiteData({ withIdeas = true } = {}) {
  const best = {};
  for (const c of CATS) best[c] = Math.max(...ANIMAL_LIST.map(a => roleOnlyScore(a, c)));
  const sk = s => ({
    id: s.id, n: s.name, c: s.category,
    r1: skillRateAtLevel(s, 1), r10: skillRateAtLevel(s, 10),
    p1: skillPowerAtLevel(s, 1), p10: skillPowerAtLevel(s, 10),
    fx: s.effect || null
  });
  const sc = {};
  const animals = ANIMAL_LIST.map(a => {
    const row = {};
    let top = null, tv = -1;
    for (const c of CATS) {
      row[c] = roleOnlyScore(a, c) / best[c];
      if (row[c] > tv) { tv = row[c]; top = c; }
    }
    sc[a.id] = {
      attaque: +roleValue(a, "attaque").toFixed(3),
      defense: +roleValue(a, "defense").toFixed(3),
      soutien: +roleValue(a, "soutien").toFixed(3)
    };
    const roles = [top, ...CATS.filter(c => c !== top && row[c] >= 0.85 * row[top])];
    const L = LEGENDARY_ITEMS[a.id];
    return {
      id: a.id, name: a.name, emoji: a.emoji, type: a.type || null, hp: a.baseHp, roles,
      event: a.event || null, start: a.eventStart || null, end: a.eventEnd || null,
      mythic: !!a.mythic && !a.season, season: a.season || null, excl: a.passMonth ? "pass" : a.contestPrize ? "contest" : null, desc: a.description,
      skills: a.skills.map(sk), img: false,
      weapon: L ? { name: L.name, emoji: L.emoji, cat: L.category, skill: sk(L.skill), img: false } : null
    };
  });
  // Les scores par rôle : normalisés sur le meilleur animal (0 à 1).
  const bestSc = {};
  for (const c of ["attaque", "defense", "soutien"]) bestSc[c] = Math.max(...Object.values(sc).map(v => v[c]));
  for (const id of Object.keys(sc)) {
    for (const c of ["attaque", "defense", "soutien"]) sc[id][c] = +(sc[id][c] / bestSc[c]).toFixed(3);
  }
  return {
    animals,
    events: EVENT_THEMES,
    trio: TRIO_BONUS,
    jurassik: { trio: JURASSIK_TRIO, monoExtra: JURASSIK_MONO_EXTRA },
    discord: DISCORD_ATTACK_MULT,
    types: TYPES,
    beats: TYPE_BEATS,
    stars: STAR_MAX,
    mythics: MYTHICS.map(m => m.id),
    mythicMin: MYTHIC_MIN_EVENT_ANIMALS,
    mythicTower: MYTHIC_TOWER_FLOOR,
    sc,
    ideas: withIdeas ? computeIdeas() : undefined,
    engine: engineHash(),
    generatedAt: new Date().toISOString()
  };
}

// Les meilleurs trios coûtent très cher à calculer (plusieurs dizaines de
// secondes, bien plus sur un petit processeur). Ils ne changent que si les
// animaux ou le moteur changent : on les garde en cache dans un fichier, et
// quand il faut les recalculer, c'est dans un fil séparé (le bot reste réactif).
function computeIdeasInWorker() {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./arena-ideas-worker.js", import.meta.url));
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", code => { if (code) reject(new Error("calcul des trios arrêté (code " + code + ")")); });
  });
}

export async function cachedIdeas(base) {
  const { generatedAt, ...stable } = base;
  const key = createHash("sha1").update(JSON.stringify(stable)).digest("hex");
  const dir = arenaDataDir();
  const file = dir ? path.join(dir, "site_ideas_cache.json") : null;
  if (file) {
    try {
      const c = JSON.parse(await fsp.readFile(file, "utf8"));
      if (c && c.key === key && c.ideas) return c.ideas;
    } catch { /* pas de cache */ }
  }
  const ideas = await computeIdeasInWorker();
  if (file) await fsp.writeFile(file, JSON.stringify({ key, ideas }), "utf8").catch(() => {});
  return ideas;
}

// Envoie les données à Supabase. Renvoie { ok, message }.
export async function syncSiteData() {
  if (!supabaseEnabled()) return { ok: false, message: "Supabase non configuré" };
  try {
    const data = buildSiteData({ withIdeas: false });
    data.ideas = await cachedIdeas(data);
    await sbRequest("site_data?on_conflict=id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [{ id: "main", data, updated_at: new Date().toISOString() }]
    });
    return { ok: true, message: `${data.animals.length} animaux et les meilleurs trios envoyés au site` };
  } catch (err) {
    const msg = String(err?.message || err);
    const hint = /site_data/.test(msg) && /(404|relation|schema)/i.test(msg)
      ? " — lance supabase-site-data.sql dans Supabase (SQL Editor)"
      : "";
    return { ok: false, message: msg.slice(0, 200) + hint };
  }
}
