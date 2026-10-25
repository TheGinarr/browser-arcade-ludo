/* ============================================================
   LUDO · engine.js (rein, ohne DOM – in Node testbar)
   ------------------------------------------------------------
   Farben 0 Rot, 1 Blau, 2 Grün, 3 Gelb (im Uhrzeigersinn).
   Position einer Figur relativ zur eigenen Farbe:
     -1      = Haus (Startbereich)
     0..39   = Laufbahn (0 = eigenes Startfeld)
     40..43  = Ziel
   Absolutes Bahnfeld = (rel + 10 * farbe) % 40.
   Regeln:
   - Mit einer 6 kommt eine Figur aus dem Haus (Pflicht, wenn möglich).
   - Das eigene Startfeld muss geräumt werden, solange noch Figuren
     im Haus warten (wenn die Figur dort ziehen kann).
   - Nach einer 6 darf man nochmal würfeln.
   - Kann keine Figur auf der Bahn ziehen: bis zu 3 Würfe für die 6.
   - Ins Ziel nur genau, eigene Figuren im Ziel werden nicht übersprungen.
   - Wer auf einer fremden Figur landet, schickt sie ins Haus.
   - Wer zuerst alle 4 Figuren im Ziel hat, gewinnt.
   ============================================================ */

export const FARBEN = ["Rot", "Blau", "Grün", "Gelb"];

/** Brett 11×11: [x, y] je Bahnfeld, ab dem Startfeld von Rot im Uhrzeigersinn. */
export const BAHN = [
  [0, 4],
  [1, 4],
  [2, 4],
  [3, 4],
  [4, 4],
  [4, 3],
  [4, 2],
  [4, 1],
  [4, 0],
  [5, 0],
  [6, 0],
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [7, 4],
  [8, 4],
  [9, 4],
  [10, 4],
  [10, 5],
  [10, 6],
  [9, 6],
  [8, 6],
  [7, 6],
  [6, 6],
  [6, 7],
  [6, 8],
  [6, 9],
  [6, 10],
  [5, 10],
  [4, 10],
  [4, 9],
  [4, 8],
  [4, 7],
  [4, 6],
  [3, 6],
  [2, 6],
  [1, 6],
  [0, 6],
  [0, 5],
];
export const ZIEL = [
  [
    [1, 5],
    [2, 5],
    [3, 5],
    [4, 5],
  ],
  [
    [5, 1],
    [5, 2],
    [5, 3],
    [5, 4],
  ],
  [
    [9, 5],
    [8, 5],
    [7, 5],
    [6, 5],
  ],
  [
    [5, 9],
    [5, 8],
    [5, 7],
    [5, 6],
  ],
];
export const HAUS = [
  [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  [
    [9, 0],
    [10, 0],
    [9, 1],
    [10, 1],
  ],
  [
    [9, 9],
    [10, 9],
    [9, 10],
    [10, 10],
  ],
  [
    [0, 9],
    [1, 9],
    [0, 10],
    [1, 10],
  ],
];

/** Sitzordnung je Spielerzahl: gegenüber bei zwei. */
export const SITZE = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

export const absFeld = (farbe, rel) => (rel + 10 * farbe) % 40;

/** Brettkoordinate [x, y] einer Figur (f = Figur 0..3). */
export function koord(farbe, f, rel) {
  if (rel < 0) return HAUS[farbe][f];
  if (rel >= 40) return ZIEL[farbe][rel - 40];
  return BAHN[absFeld(farbe, rel)];
}

export function neuesSpiel(farben = [0, 1, 2, 3], beginner = farben[0]) {
  const st = {
    farben: [...farben],
    pos: [0, 1, 2, 3].map(() => [-1, -1, -1, -1]),
    dran: beginner,
    phase: "wurf", // wurf | zug | aus
    wurf: 0,
    versuche: 3,
    sieger: null,
    zugNr: 0,
    letzt: null, // {farbe, f, von, nach, schlag:[farbe,f]|null}
  };
  st.versuche = versucheFuer(st, beginner);
  return st;
}

export const kopie = (st) => JSON.parse(JSON.stringify(st));

/** Wer steht auf Bahnfeld a? → [farbe, figur] oder null */
function belegt(st, a) {
  for (const fa of st.farben)
    for (let f = 0; f < 4; f++) {
      const r = st.pos[fa][f];
      if (r >= 0 && r < 40 && absFeld(fa, r) === a) return [fa, f];
    }
  return null;
}

/** Ein Zug für Figur f mit Wurf w, oder null wenn nicht erlaubt. */
function zugFuer(st, fa, f, w) {
  const p = st.pos[fa];
  const von = p[f];
  if (von >= 40 + 3 && w) return null;
  let nach;
  if (von < 0) {
    if (w !== 6) return null;
    nach = 0;
  } else nach = von + w;
  if (nach > 43) return null;
  if (nach >= 40) {
    // im Ziel: Platz frei, nichts Eigenes überspringen
    for (let r = Math.max(40, von + 1); r <= nach; r++) if (p.includes(r)) return null;
    return { f, von, nach, schlag: null };
  }
  const wer = belegt(st, absFeld(fa, nach));
  if (wer && wer[0] === fa) return null;
  return { f, von, nach, schlag: wer };
}

/** Alle erlaubten Züge des aktuellen Spielers mit dem aktuellen Wurf. */
export function zuege(st, w = st.wurf) {
  const fa = st.dran;
  const p = st.pos[fa];
  const alle = [];
  for (let f = 0; f < 4; f++) {
    const z = zugFuer(st, fa, f, w);
    if (z) alle.push(z);
  }
  const imHaus = p.some((r) => r < 0);
  // 1. Pflicht: mit 6 raus
  if (w === 6 && imHaus) {
    const raus = alle.filter((z) => z.von < 0);
    if (raus.length) return raus.slice(0, 1);
  }
  // 2. Pflicht: Startfeld räumen
  if (imHaus) {
    const f0 = p.indexOf(0);
    if (f0 >= 0) {
      const weg = alle.filter((z) => z.f === f0);
      if (weg.length) return weg;
    }
  }
  return alle;
}

/** 3 Versuche, wenn keine Figur mit 1–5 ziehen könnte, sonst 1. */
function versucheFuer(st, fa) {
  const alt = st.dran;
  st.dran = fa;
  let geht = false;
  for (let w = 1; w <= 5 && !geht; w++) if (zuege(st, w).length) geht = true;
  st.dran = alt;
  return geht ? 1 : 3;
}

function naechster(st) {
  const i = st.farben.indexOf(st.dran);
  st.dran = st.farben[(i + 1) % st.farben.length];
  st.phase = "wurf";
  st.wurf = 0;
  st.versuche = versucheFuer(st, st.dran);
}

/** Würfeln (w = 1..6). Liefert neuen Stand. */
export function wuerfeln(alt, w) {
  if (alt.phase !== "wurf") return alt;
  const st = kopie(alt);
  st.wurf = w;
  if (zuege(st, w).length) {
    st.phase = "zug";
    return st;
  }
  // kein Zug möglich
  st.letzt = null;
  if (w === 6) {
    st.phase = "wurf";
    st.versuche = versucheFuer(st, st.dran);
    return st;
  }
  st.versuche--;
  if (st.versuche > 0) st.phase = "wurf";
  else naechster(st);
  st.wurf = w; // fürs Anzeigen
  return st;
}

/** Zug ausführen (z aus zuege()). */
export function ziehen(alt, z) {
  if (alt.phase !== "zug") return alt;
  const st = kopie(alt);
  const fa = st.dran;
  const echt = zuege(st).find((y) => y.f === z.f);
  if (!echt) return alt;
  st.pos[fa][echt.f] = echt.nach;
  if (echt.schlag) st.pos[echt.schlag[0]][echt.schlag[1]] = -1;
  st.zugNr++;
  st.letzt = { farbe: fa, ...echt };
  if (st.pos[fa].every((r) => r >= 40)) {
    st.sieger = fa;
    st.phase = "aus";
    return st;
  }
  const w = st.wurf;
  if (w === 6) {
    st.phase = "wurf";
    st.wurf = 0;
    st.versuche = 1;
  } else naechster(st);
  return st;
}

/** Felder 1..6 hinter Bahnfeld a, auf denen Gegner stehen (Gefahr). */
function gefahr(st, fa, a, ohne) {
  let g = 0;
  for (const o of st.farben) {
    if (o === fa) continue;
    for (let f = 0; f < 4; f++) {
      const r = ohne && ohne[0] === o && ohne[1] === f ? -2 : st.pos[o][f];
      if (r >= 0 && r < 40) {
        const d = (a - absFeld(o, r) + 40) % 40;
        // nur wenn der Gegner das Feld noch auf seiner Bahn erreicht
        if (d >= 1 && d <= 6 && r + d <= 39) g += d === 6 ? 0.8 : 1;
      } else if (r === -1 && a === absFeld(o, 0)) g += 1.2; // Startfeld mit wartenden Figuren
    }
  }
  return g;
}

/** Computerzug: "gemuetlich" = zufällig, "clever" = Abwägung. */
export function computerZug(st, stufe = "clever", zufall = Math.random) {
  const liste = zuege(st);
  if (!liste.length) return null;
  if (liste.length === 1) return liste[0];
  if (stufe === "gemuetlich") return liste[Math.floor(zufall() * liste.length)];
  const fa = st.dran;
  let best = null,
    bw = -Infinity;
  for (const z of liste) {
    let w = zufall() * 0.5;
    if (z.schlag) {
      const opfer = st.pos[z.schlag[0]][z.schlag[1]];
      w += 60 + opfer; // weit gelaufene Figuren schlagen lohnt mehr
    }
    if (z.von < 0) w += 45;
    if (z.nach >= 40 && z.von < 40) w += 40;
    if (z.nach >= 40) w += (z.nach - 40) * 2; // tief ins Ziel
    if (z.von >= 0 && z.von < 40) {
      const g0 = gefahr(st, fa, absFeld(fa, z.von));
      w += g0 * 18 * (1 + z.von / 40); // aus der Gefahr ziehen
    }
    if (z.nach < 40) {
      const g1 = gefahr(st, fa, absFeld(fa, z.nach), z.schlag);
      w -= g1 * 22 * (1 + z.nach / 40);
      w += z.nach * 0.3;
    }
    if (w > bw) {
      bw = w;
      best = z;
    }
  }
  return best;
}

/** Wurf mit kryptografischem Zufall (Browser + Node 20). */
export function zufallsWurf() {
  try {
    const a = new Uint8Array(1);
    do crypto.getRandomValues(a);
    while (a[0] >= 252);
    return (a[0] % 6) + 1;
  } catch {
    return 1 + Math.floor(Math.random() * 6);
  }
}
