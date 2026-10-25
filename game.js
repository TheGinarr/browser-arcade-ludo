/* ============================================================
   LUDO · game.js
   ------------------------------------------------------------
   1. Regeln + Computer in engine.js (rein, Node-testbar).
   2. Modi: gegen Computer (1–3 Computer, Gemütlich/Clever), am Gerät
      (2–4 Personen), online bis 4 (mehrspieler.js). Online würfelt
      nur der Host und prüft jeden Zug; Gäste schicken {t:"wurf"} bzw.
      {t:"zug", f}. Wer 30 s nichts tut oder geht, für den zieht der
      Computer.
   3. Topliste "ludo" = Punkte gegen den Computer
      (Sieg = Anzahl Computer, auf „Clever“ doppelt).
   ============================================================ */

import * as E from "./engine.js?v=20261024";
import { lade, speichere, spielZuruecksetzen } from "./assets/storage.js";
import { stillEintragen, toplisteAnzeigen, bewegungReduziert } from "./assets/ui.js";
import * as FS from "./assets/fortschritt.js";
import { raumEroeffnen, raumBeitreten, CODE_MUSTER } from "./assets/mehrspieler.js";

const SPIEL = "ludo";
const $ = (id) => document.getElementById(id);
const el = {
  modi: $("modi"),
  anzahl: $("anzahl"),
  stufen: $("stufen"),
  online: $("online"),
  beitritt: $("beitritt"),
  code: $("code"),
  raumkopf: $("raumkopf"),
  raumcode: $("raumcode"),
  starten: $("starten"),
  status: $("status"),
  brett: $("brett"),
  spieler: $("spieler"),
  wuerfel: $("wuerfel"),
  hinweis: $("hinweis"),
  ende: $("ende"),
  nochmal: $("nochmal"),
  neu: $("neu"),
  punkte: $("punkte"),
  topliste: $("topliste"),
  l1: $("hud-l1"),
  w1: $("hud-1"),
  l2: $("hud-l2"),
  w2: $("hud-2"),
};
const CODEFARBE = ["#d7263d", "#1e5bd8", "#1f9d55", "#f2c200"];
const ZUG_ZEIT = 30000;

/* ---------- Zustand ---------- */
let modus = "computer";
let anzahl = Number(lade(SPIEL, "anzahl", 4)) || 4;
if (![2, 3, 4].includes(anzahl)) anzahl = 4;
let stufe = lade(SPIEL, "stufe", "clever") === "gemuetlich" ? "gemuetlich" : "clever";
let stat = lade(SPIEL, "stat", null) || { punkte: 0, siege: 0 };
let st = E.neuesSpiel(E.SITZE[anzahl]);
let sitze = []; // je Farbe {art: "ich"|"mensch"|"bot"|"gast", platz?}
let lauf = 0; // erhöht bei Neustart → alte Timer/Animationen verfallen
let beschaeftigt = false;
let timer = 0;
let ereignis = "";
let partien = 0,
  letzterSieg = "–";
// online
let netz = null; // {rolle, raum, code}
let gestartet = false;
let gaeste = new Set(); // Host: anwesende Plätze
let meine = 0; // eigene Farbe (Gast: vom Host)
let nachher = null; // Host: Gast-Eingabe während Animation
let kette = Promise.resolve(); // Gast: Stände der Reihe nach zeigen
let artVon = []; // Gast: Art je Farbe (mensch/bot) zur Anzeige

/* ---------- Brett aufbauen ---------- */
const pct = (v) => `${(v * 100) / 11}%`;
const feldEl = new Map(); // "x,y" -> div
function feld(x, y, cls) {
  const d = document.createElement("div");
  d.className = `lu-feld ${cls}`;
  d.style.left = pct(x);
  d.style.top = pct(y);
  el.brett.append(d);
  feldEl.set(`${x},${y}`, d);
}
const ecken = [0, 1, 2, 3].map((fa) => {
  const e = document.createElement("div");
  e.className = `lu-ecke e${fa} f${fa}`;
  el.brett.append(e);
  return e;
});
el.brett.insertAdjacentHTML("beforeend", '<div class="lu-mitte"></div>');
E.BAHN.forEach(([x, y], i) => feld(x, y, i % 10 === 0 ? `start f${i / 10}` : "bahn"));
E.ZIEL.forEach((r, fa) => r.forEach(([x, y]) => feld(x, y, `ziel f${fa}`)));
E.HAUS.forEach((r, fa) => r.forEach(([x, y]) => feld(x, y, `haus f${fa}`)));

const FIGUR_SVG = (n) =>
  `<svg viewBox="0 0 60 60" aria-hidden="true"><path class="koerper" d="M30 4a11 11 0 0 1 7 19.5c-2 1.6-1.6 3 0 3.6 3 1.2 4 3.2 2.4 4.4 4.6 7 8 13 9.6 19.5H11c1.6-6.5 5-12.5 9.6-19.5-1.6-1.2-.6-3.2 2.4-4.4 1.6-.6 2-2-0-3.6A11 11 0 0 1 30 4z"/><path class="licht" d="M24 10a7 7 0 0 1 5-2.5M21 47c1-4.5 3-9 6-14"/><text class="nr" x="30" y="44" text-anchor="middle">${n}</text></svg>`;
const figurEl = [0, 1, 2, 3].map((fa) =>
  [0, 1, 2, 3].map((f) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `lu-figur f${fa}`;
    b.innerHTML = FIGUR_SVG(f + 1);
    b.tabIndex = -1;
    b.addEventListener("click", () => figurKlick(fa, f));
    el.brett.append(b);
    return b;
  }),
);
function setzen(fa, f, rel) {
  const [x, y] = E.koord(fa, f, rel);
  figurEl[fa][f].style.left = pct(x);
  figurEl[fa][f].style.top = pct(y);
}

/* ---------- Anzeige ---------- */
const istGast = () => modus === "online" && netz?.rolle === "gast";
function artVonFarbe(fa) {
  if (istGast()) return fa === meine ? "ich" : artVon[fa] || "mensch";
  return sitze[fa]?.art || "bot";
}
function nameVon(fa) {
  const a = artVonFarbe(fa);
  if (modus === "zweit") return E.FARBEN[fa];
  if (a === "ich") return `Du (${E.FARBEN[fa]})`;
  if (a === "bot") return `${E.FARBEN[fa]} · Computer`;
  return `${E.FARBEN[fa]} · Gegenüber`;
}

function ichDarf() {
  if (beschaeftigt || st.phase === "aus") return false;
  if (modus === "online") {
    if (!netz || !gestartet) return false;
    return istGast() ? st.dran === meine : sitze[st.dran]?.art === "ich";
  }
  const a = sitze[st.dran]?.art;
  return a === "ich" || a === "mensch";
}

function zeichnen() {
  const aktiv = new Set(st.farben);
  const darf = ichDarf();
  const moegl = darf && st.phase === "zug" ? E.zuege(st) : [];
  for (const k of feldEl.values()) k.classList.remove("zielmarke", "letzt");
  for (let fa = 0; fa < 4; fa++) {
    ecken[fa].classList.toggle("aus", !aktiv.has(fa));
    for (let f = 0; f < 4; f++) {
      const b = figurEl[fa][f];
      b.hidden = !aktiv.has(fa);
      if (!beschaeftigt) setzen(fa, f, st.pos[fa][f]);
      const z = fa === st.dran ? moegl.find((y) => y.f === f) : null;
      b.classList.toggle("geht", !!z);
      b.tabIndex = z ? 0 : -1;
      const rel = st.pos[fa][f];
      const wo = rel < 0 ? "im Haus" : rel >= 40 ? "im Ziel" : `${rel + 1} Felder gelaufen`;
      b.setAttribute("aria-label", `${E.FARBEN[fa]} Figur ${f + 1}, ${wo}${z ? " – ziehen" : ""}`);
      if (z) feldEl.get(E.koord(fa, f, z.nach).join())?.classList.add("zielmarke");
    }
  }
  const l = st.letzt;
  if (l && !beschaeftigt) feldEl.get(E.koord(l.farbe, l.f, l.nach).join())?.classList.add("letzt");
  // Spielerleiste
  el.spieler.innerHTML = st.farben
    .map((fa) => {
      const imZiel = st.pos[fa].filter((r) => r >= 40).length;
      const dran = st.phase !== "aus" && fa === st.dran && (modus !== "online" || gestartet);
      return `<li class="f${fa}${dran ? " dran" : ""}"><span class="punkt" aria-hidden="true"></span><span>${artVonFarbe(fa) === "ich" && modus !== "zweit" ? "Du" : E.FARBEN[fa]}${artVonFarbe(fa) === "bot" ? " · PC" : ""}</span><span class="zahl" title="im Ziel">${imZiel}/4</span></li>`;
    })
    .join("");
  // Würfel
  el.wuerfel.className = `lu-wuerfel f${st.dran}${darf && st.phase === "wurf" ? " bereit" : ""}`;
  el.wuerfel.disabled = !(darf && st.phase === "wurf");
  if (!beschaeftigt && st.wurf) el.wuerfel.dataset.augen = st.wurf;
  el.wuerfel.setAttribute(
    "aria-label",
    darf && st.phase === "wurf" ? "Würfeln" : `Würfel zeigt ${el.wuerfel.dataset.augen}`,
  );
  el.hinweis.textContent = ereignis;
  statusSetzen();
  hud();
  el.ende.hidden = st.phase !== "aus" || (modus === "online" && (!netz || istGast()));
  el.neu.hidden = modus === "online";
  el.starten.hidden = !(netz?.rolle === "host" && (!gestartet || st.phase === "aus"));
  el.starten.disabled = gaeste.size < 1;
}

function statusSetzen(text, art) {
  el.status.dataset.art = art || "";
  if (text) return void (el.status.textContent = text);
  let t;
  if (modus === "online" && !netz) t = "Eröffne ein Spiel oder tritt mit Code bei.";
  else if (modus === "online" && !gestartet) {
    t =
      netz.rolle === "host"
        ? gaeste.size
          ? `${gaeste.size + 1} am Tisch – tippe auf „Starten“.`
          : "Warte auf Mitspieler …"
        : "Warte, bis der Gastgeber startet …";
  } else if (st.phase === "aus") {
    const a = artVonFarbe(st.sieger);
    t =
      modus === "zweit"
        ? `${E.FARBEN[st.sieger]} gewinnt!`
        : a === "ich"
          ? "Du gewinnst!"
          : `${nameVon(st.sieger)} gewinnt.`;
  } else {
    const a = artVonFarbe(st.dran);
    const was = st.phase === "wurf" ? "würfeln" : "Figur wählen";
    if (a === "ich") t = `Du bist dran – ${was}`;
    else if (modus === "zweit") t = `${E.FARBEN[st.dran]} ist dran – ${was}`;
    else if (a === "bot") t = `${nameVon(st.dran)} ist dran …`;
    else t = `${nameVon(st.dran)} ist dran …`;
  }
  el.status.innerHTML = "";
  if (modus !== "online" || gestartet) {
    const m = document.createElement("span");
    m.className = "mini";
    m.style.setProperty("--fa", CODEFARBE[st.phase === "aus" ? st.sieger : st.dran]);
    m.setAttribute("aria-hidden", "true");
    el.status.append(m);
  }
  el.status.append(t);
}

function hud() {
  if (modus === "computer") {
    el.l1.textContent = "Punkte";
    el.w1.textContent = String(stat.punkte);
    el.l2.textContent = "Siege";
    el.w2.textContent = String(stat.siege);
    const p = (anzahl - 1) * (stufe === "clever" ? 2 : 1);
    el.punkte.textContent = `Sieg +${p} ${p === 1 ? "Punkt" : "Punkte"} · ${anzahl - 1} ${anzahl === 2 ? "Computer" : "Computer"} (${stufe === "clever" ? "Clever" : "Gemütlich"})`;
  } else {
    el.l1.textContent = "Partien";
    el.w1.textContent = String(partien);
    el.l2.textContent = "Letzter Sieg";
    el.w2.textContent = letzterSieg;
    el.punkte.textContent =
      modus === "online" && netz && gestartet && meine >= 0 ? `Du spielst ${E.FARBEN[meine]}.` : "";
  }
}

/* ---------- Animation ---------- */
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function wuerfelAnim(w, t) {
  const ruhig = bewegungReduziert();
  if (!ruhig) {
    el.wuerfel.classList.remove("rollt");
    void el.wuerfel.offsetWidth;
    el.wuerfel.classList.add("rollt");
    for (let i = 0; i < 5 && t === lauf; i++) {
      el.wuerfel.dataset.augen = 1 + ((w + i * 2) % 6);
      await warte(80);
    }
  }
  el.wuerfel.dataset.augen = w;
  if (!ruhig) await warte(260);
}
async function zugAnim(alt, neu, t) {
  const l = neu.letzt;
  if (!l) return;
  const b = figurEl[l.farbe][l.f];
  const ruhig = bewegungReduziert();
  const weg = [];
  if (l.von < 0) weg.push(0);
  else for (let r = l.von + 1; r <= l.nach; r++) weg.push(r);
  for (const r of ruhig ? [l.nach] : weg) {
    if (t !== lauf) return;
    setzen(l.farbe, l.f, r);
    b.classList.remove("hops");
    void b.offsetWidth;
    b.classList.add("hops");
    if (!ruhig) await warte(150);
  }
  b.classList.remove("hops");
  if (l.schlag) {
    if (!ruhig) await warte(120);
    setzen(l.schlag[0], l.schlag[1], -1);
    if (!ruhig) await warte(220);
  }
}

function ereignisText(alt, neu, art) {
  const wer =
    artVonFarbe(alt.dran) === "ich"
      ? "Du"
      : modus === "zweit"
        ? E.FARBEN[alt.dran]
        : nameVon(alt.dran);
  if (art === "wurf") {
    if (neu.phase === "zug")
      return E.zuege(neu).length > 1 || artVonFarbe(neu.dran) !== "ich"
        ? `Eine ${neu.wurf}.`
        : `Eine ${neu.wurf} – es geht nur ein Zug.`;
    if (neu.wurf === 6) return "Eine 6 – nochmal würfeln!";
    if (neu.dran === alt.dran)
      return `Eine ${neu.wurf} – nichts geht. Noch ${neu.versuche} ${neu.versuche === 1 ? "Versuch" : "Versuche"}.`;
    return `Eine ${neu.wurf} – ${wer === "Du" ? "du kannst" : `${wer} kann`} nicht ziehen.`;
  }
  const l = neu.letzt;
  if (!l) return "";
  if (neu.phase === "aus") return "Alle Figuren im Ziel!";
  let s = "";
  if (l.schlag) s = `Geschlagen! ${E.FARBEN[l.schlag[0]]} muss zurück ins Haus. `;
  else if (l.von < 0) s = "Raus aufs Startfeld. ";
  else if (l.nach >= 40 && l.von < 40) s = "Figur im Ziel! ";
  if (alt.wurf === 6) s += "Nochmal würfeln!";
  return s.trim();
}

/** Neuen Stand übernehmen (lokal oder Host), mit Animation, dann weiter. */
async function anwenden(neu, art) {
  const t = lauf;
  const alt = st;
  clearTimeout(timer);
  ereignis = ereignisText(alt, neu, art);
  st = neu;
  if (modus === "online" && netz?.rolle === "host") hostSenden(art);
  beschaeftigt = true;
  zeichnen();
  if (art === "wurf") await wuerfelAnim(neu.wurf, t);
  else await zugAnim(alt, neu, t);
  if (t !== lauf) return;
  beschaeftigt = false;
  zeichnen();
  sichern();
  if (st.phase === "aus") return spielEnde();
  if (nachher) {
    const n = nachher;
    nachher = null;
    if (n()) return;
  }
  schritt();
}

function wurfMachen() {
  const n = E.wuerfeln(st, E.zufallsWurf());
  n.wn = (st.wn || 0) + 1;
  return anwenden(n, "wurf");
}
function zugMachen(f) {
  const z = E.zuege(st).find((y) => y.f === f);
  if (z) return anwenden(E.ziehen(st, z), "zug");
}

/** Wer ist dran? Computer ziehen lassen, einzigen Zug automatisch machen, Zeitlimit online. */
function schritt() {
  clearTimeout(timer);
  if (st.phase === "aus" || istGast() || (modus === "online" && !gestartet)) return;
  const s = sitze[st.dran];
  const t = lauf;
  const spaeter = (ms, fn) => (timer = setTimeout(() => t === lauf && !beschaeftigt && fn(), ms));
  if (!s || s.art === "bot") {
    const k = s?.stufe || "clever";
    return spaeter(st.phase === "wurf" ? 650 : 450, () =>
      st.phase === "wurf" ? wurfMachen() : zugMachen(E.computerZug(st, k).f),
    );
  }
  if (st.phase === "zug") {
    const z = E.zuege(st);
    if (z.length === 1) return spaeter(700, () => zugMachen(z[0].f));
  }
  if (modus === "online")
    spaeter(ZUG_ZEIT, () =>
      st.phase === "wurf" ? wurfMachen() : zugMachen(E.computerZug(st, "clever").f),
    );
}

/* ---------- Bedienung ---------- */
function wuerfelKlick() {
  if (!ichDarf() || st.phase !== "wurf") return;
  if (istGast()) {
    beschaeftigt = true; // bis der Host antwortet
    zeichnen();
    return netz.raum.senden({ t: "wurf" });
  }
  wurfMachen();
}
function figurKlick(fa, f) {
  if (!ichDarf() || st.phase !== "zug" || fa !== st.dran) return;
  if (!E.zuege(st).some((z) => z.f === f)) return;
  if (istGast()) {
    beschaeftigt = true;
    zeichnen();
    return netz.raum.senden({ t: "zug", f });
  }
  zugMachen(f);
}
el.wuerfel.addEventListener("click", wuerfelKlick);
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select") || e.altKey || e.ctrlKey || e.metaKey) return;
  if ((e.key === " " || e.key === "Enter") && !e.target.closest?.("button, a, summary")) {
    if (ichDarf() && st.phase === "wurf") {
      e.preventDefault();
      wuerfelKlick();
    }
  } else if (/^[1-4]$/.test(e.key) && ichDarf() && st.phase === "zug") {
    figurKlick(st.dran, Number(e.key) - 1);
  }
});

/* ---------- Spiel starten / Ende ---------- */
function sitzeLokal() {
  sitze = [];
  for (const fa of E.SITZE[anzahl]) {
    if (modus === "zweit") sitze[fa] = { art: "mensch" };
    else sitze[fa] = fa === 0 ? { art: "ich" } : { art: "bot", stufe };
  }
}
function neuesSpiel() {
  lauf++;
  clearTimeout(timer);
  beschaeftigt = false;
  sitzeLokal();
  const farben = E.SITZE[anzahl];
  st = E.neuesSpiel(farben, farben[E.zufallsWurf() % farben.length]);
  ereignis = modus === "zweit" ? "Reicht das Gerät weiter, wer dran ist." : "";
  zeichnen();
  sichern();
  schritt();
}
function sichern() {
  if (modus === "online") return;
  speichere(SPIEL, `partie-${modus}`, st.phase === "aus" ? null : { st, anzahl, stufe });
}
function laden() {
  const p = lade(SPIEL, `partie-${modus}`, null);
  if (!p?.st?.pos || p.anzahl !== anzahl || (modus === "computer" && p.stufe !== stufe))
    return false;
  if (p.st.farben.join() !== E.SITZE[anzahl].join()) return false;
  lauf++;
  beschaeftigt = false;
  sitzeLokal();
  st = p.st;
  if (st.phase === "zug" && !E.zuege(st).length) return false;
  ereignis = "";
  zeichnen();
  schritt();
  return true;
}

function spielEnde() {
  partien++;
  letzterSieg = E.FARBEN[st.sieger];
  if (modus === "computer") {
    if (st.sieger === 0) {
      const plus = (anzahl - 1) * (stufe === "clever" ? 2 : 1);
      stat.punkte += plus;
      stat.siege++;
      speichere(SPIEL, "stat", stat);
      try {
        FS.runde(SPIEL, { punkte: stat.punkte });
      } catch {
        /* Zugabe */
      }
      stillEintragen(SPIEL, stat.punkte, "hoch");
      toplisteAnzeigen(el.topliste, SPIEL, punkteText);
      hud();
      el.punkte.textContent = `+${plus} ${plus === 1 ? "Punkt" : "Punkte"} · gesamt ${stat.punkte}`;
    } else epRunde(false);
  } else {
    epRunde(modus === "online" && st.sieger === meine);
    hud();
  }
  zeichnen();
  if (modus === "computer" && st.sieger === 0)
    el.punkte.textContent = `+${(anzahl - 1) * (stufe === "clever" ? 2 : 1)} Punkte · gesamt ${stat.punkte}`;
}
function epRunde(sieg) {
  const pb = Number(lade("konto", `pb:${SPIEL}`, 0)) || 0;
  try {
    FS.runde(SPIEL, { punkte: sieg && pb >= 1 ? 1 : 0 });
  } catch {
    /* Zugabe */
  }
}
const punkteText = (p) => `${p} ${p === 1 ? "Punkt" : "Punkte"}`;

function knopfWahl(gruppe, attr, wert) {
  for (const k of gruppe.querySelectorAll("button"))
    k.setAttribute("aria-pressed", String(k.dataset[attr] === String(wert)));
}
function laeuft() {
  return st.phase !== "aus" && st.zugNr > 0;
}
function modusSetzen(m) {
  if (netz) return;
  modus = m;
  knopfWahl(el.modi, "modus", m);
  el.stufen.hidden = m !== "computer";
  el.anzahl.hidden = m === "online";
  el.online.hidden = m !== "online";
  partien = 0;
  letzterSieg = "–";
  if (m === "online") {
    lauf++;
    clearTimeout(timer);
    st = E.neuesSpiel([0, 1, 2, 3]);
    gestartet = false;
    ereignis = "";
    return zeichnen();
  }
  if (!laden()) neuesSpiel();
}
el.modi.addEventListener("click", (e) => {
  const k = e.target.closest("button[data-modus]");
  if (k && k.dataset.modus !== modus) modusSetzen(k.dataset.modus);
});
el.anzahl.addEventListener("click", (e) => {
  const k = e.target.closest("button[data-anzahl]");
  if (!k || Number(k.dataset.anzahl) === anzahl) return;
  if (laeuft() && !confirm("Laufendes Spiel beenden und neu starten?")) return;
  anzahl = Number(k.dataset.anzahl);
  speichere(SPIEL, "anzahl", anzahl);
  knopfWahl(el.anzahl, "anzahl", anzahl);
  neuesSpiel();
});
el.stufen.addEventListener("click", (e) => {
  const k = e.target.closest("button[data-stufe]");
  if (!k || k.dataset.stufe === stufe) return;
  if (laeuft() && !confirm("Laufendes Spiel beenden und neu starten?")) return;
  stufe = k.dataset.stufe;
  speichere(SPIEL, "stufe", stufe);
  knopfWahl(el.stufen, "stufe", stufe);
  neuesSpiel();
});
el.neu.addEventListener("click", () => {
  if (laeuft() && !confirm("Laufendes Spiel beenden und neu starten?")) return;
  neuesSpiel();
});
el.nochmal.addEventListener("click", () =>
  modus === "online" ? netz?.rolle === "host" && hostStarten() : neuesSpiel(),
);
$("reset").addEventListener("click", () => {
  spielZuruecksetzen(SPIEL);
  stat = { punkte: 0, siege: 0 };
  hud();
  toplisteAnzeigen(el.topliste, SPIEL, punkteText);
});

/* ---------- Online ---------- */
function onlineStart(n) {
  netz = n;
  el.modi.classList.add("gesperrt");
  el.online.hidden = true;
  el.raumkopf.hidden = false;
  el.raumcode.textContent = n.code;
  gestartet = false;
  partien = 0;
}
function onlineEnde(text) {
  try {
    netz?.rolle === "host" ? netz.raum.schliessen() : netz?.raum.verlassen();
  } catch {
    /* schon zu */
  }
  netz = null;
  lauf++;
  clearTimeout(timer);
  beschaeftigt = false;
  gestartet = false;
  gaeste = new Set();
  meine = 0;
  el.modi.classList.remove("gesperrt");
  el.raumkopf.hidden = true;
  el.online.hidden = modus !== "online";
  st = E.neuesSpiel([0, 1, 2, 3]);
  ereignis = "";
  zeichnen();
  if (text) statusSetzen(text, "fehler");
}

// Host: Platz 0 = Host (Rot), Gäste 1..3 bekommen die übrigen Farben.
const farbeVonPlatz = (p) => sitze.findIndex((s) => s && s.platz === p);
function hostSenden(art = "neu") {
  if (!netz || netz.rolle !== "host") return;
  const arten = [0, 1, 2, 3].map((fa) => (sitze[fa]?.art === "bot" ? "bot" : "mensch"));
  for (const p of gaeste) {
    netz.raum.senden(p, {
      t: "stand",
      st,
      art,
      gestartet,
      deine: gestartet ? farbeVonPlatz(p) : -1,
      arten,
      partien,
      letzterSieg,
      ereignis,
    });
  }
}
function hostStarten() {
  if (!gaeste.size) return;
  const plaetze = [...gaeste].sort((a, b) => a - b).slice(0, 3);
  const n = plaetze.length + 1;
  const farben = E.SITZE[n];
  sitze = [];
  sitze[farben[0]] = { art: "ich", platz: 0 };
  plaetze.forEach((p, i) => (sitze[farben[i + 1]] = { art: "gast", platz: p }));
  lauf++;
  beschaeftigt = false;
  gestartet = true;
  meine = 0;
  st = E.neuesSpiel(farben, farben[E.zufallsWurf() % farben.length]);
  ereignis = "";
  zeichnen();
  hostSenden("neu");
  schritt();
}
function gastEingabe(platz, d) {
  const fa = farbeVonPlatz(platz);
  if (!gestartet || fa < 0 || st.dran !== fa || sitze[fa].art !== "gast") return hostSenden("neu");
  const tun = () => {
    if (st.dran !== fa) return false;
    if (d.t === "wurf" && st.phase === "wurf") return (wurfMachen(), true);
    if (d.t === "zug" && st.phase === "zug" && E.zuege(st).some((z) => z.f === d.f))
      return (zugMachen(d.f), true);
    hostSenden("neu");
    return false;
  };
  if (beschaeftigt) nachher = tun;
  else tun();
}

$("eroeffnen").addEventListener("click", async () => {
  statusSetzen("Eröffne Spiel …");
  try {
    const raum = await raumEroeffnen(SPIEL, {
      gast(platz) {
        gaeste.add(platz);
        const fa = farbeVonPlatz(platz);
        if (gestartet && fa >= 0) {
          if (sitze[fa].art === "bot") ereignis = `${E.FARBEN[fa]} ist wieder da.`;
          sitze[fa].art = "gast"; // zurück an den eigenen Platz
          schritt();
        }
        zeichnen();
        hostSenden("neu");
      },
      gastWeg(platz) {
        gaeste.delete(platz);
        const fa = farbeVonPlatz(platz);
        if (gestartet && fa >= 0 && st.phase !== "aus") {
          sitze[fa].art = "bot";
          sitze[fa].stufe = "clever";
          ereignis = `${E.FARBEN[fa]} ist weg – der Computer übernimmt.`;
          if (!beschaeftigt) schritt();
        }
        zeichnen();
        hostSenden("neu");
      },
      nachricht(platz, d) {
        if (!d) return;
        if (d.t === "wurf" || d.t === "zug") gastEingabe(platz, d);
      },
      status(text, art) {
        statusSetzen(text, art);
      },
    });
    gaeste = new Set();
    sitze = [{ art: "ich", platz: 0 }];
    onlineStart({ rolle: "host", raum, code: raum.code });
    zeichnen();
  } catch (err) {
    statusSetzen(err.message || "Eröffnen hat nicht geklappt.", "fehler");
  }
});
el.starten.addEventListener("click", () => netz?.rolle === "host" && hostStarten());

/** Gast: Stand vom Host zeigen (der Reihe nach, mit Animation). */
async function gastStand(d) {
  const t = lauf;
  const alt = st;
  const neu = d.st;
  if (!neu?.pos) return;
  const warGestartet = gestartet;
  gestartet = !!d.gestartet;
  meine = d.deine;
  artVon = d.arten || [];
  partien = d.partien || 0;
  letzterSieg = d.letzterSieg || "–";
  ereignis = d.ereignis || "";
  const neueRunde = !warGestartet || neu.zugNr < alt.zugNr || (neu.zugNr === 0 && !neu.wn);
  st = neu;
  if (!neueRunde && d.art === "wurf" && neu.wn !== alt.wn) {
    beschaeftigt = true;
    zeichnen();
    await wuerfelAnim(neu.wurf, t);
  } else if (!neueRunde && d.art === "zug" && neu.zugNr === alt.zugNr + 1) {
    beschaeftigt = true;
    zeichnen();
    await zugAnim(alt, neu, t);
  }
  if (t !== lauf) return;
  beschaeftigt = false;
  zeichnen();
  if (neu.phase === "aus" && alt.phase !== "aus") epRunde(neu.sieger === meine);
}

el.beitritt.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = el.code.value.toUpperCase().trim();
  if (!CODE_MUSTER.test(code)) return statusSetzen("Der Code hat 4 Zeichen (A–Z, 2–9).", "fehler");
  statusSetzen("Verbinde …");
  try {
    const raum = await raumBeitreten(SPIEL, code, {
      verbunden() {
        statusSetzen("Verbunden – warte auf den Start.");
      },
      nachricht(d) {
        if (d?.t === "stand") kette = kette.then(() => gastStand(d)).catch(() => {});
      },
      status(text, art) {
        statusSetzen(text, art);
      },
      ende(grund) {
        onlineEnde(grund || "Das Spiel ist beendet.");
      },
    });
    onlineStart({ rolle: "gast", raum, code });
    statusSetzen("Verbinde direkt …");
  } catch (err) {
    statusSetzen(err.message || "Beitreten hat nicht geklappt.", "fehler");
  }
});

$("aufstehen").addEventListener("click", () => onlineEnde("Du hast das Spiel verlassen."));
$("teilen").addEventListener("click", async () => {
  const code = netz?.code;
  if (!code) return;
  const url = `${location.origin}${location.pathname}?tisch=${code}`;
  try {
    if (navigator.share)
      await navigator.share({ title: "Ludo", text: `Spiel Ludo mit mir: ${code}`, url });
    else {
      await navigator.clipboard.writeText(url);
      statusSetzen("Link kopiert.");
    }
  } catch {
    statusSetzen(`Code: ${code}`);
  }
});
window.addEventListener("pagehide", () => {
  if (netz?.rolle === "host") netz.raum.schliessen();
});

/* ---------- Start ---------- */
knopfWahl(el.anzahl, "anzahl", anzahl);
knopfWahl(el.stufen, "stufe", stufe);
toplisteAnzeigen(el.topliste, SPIEL, punkteText);
const eingeladen = new URLSearchParams(location.search).get("tisch");
if (eingeladen) {
  modusSetzen("online");
  el.code.value = eingeladen.toUpperCase().slice(0, 4);
} else modusSetzen("computer");
