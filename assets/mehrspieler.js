/* ============================================================
   mehrspieler.js · Räume mit Code, Spielzüge direkt per WebRTC
   ------------------------------------------------------------
   Der Spiele-Server (/ws/vermittlung) reicht nur Angebot, Antwort
   und ICE zwischen Host (Platz 0) und Gästen weiter und speichert
   nichts. Danach laufen alle Nachrichten über einen RTCDataChannel
   direkt von Browser zu Browser (Mitspieler sehen dabei die
   IP-Adresse, siehe Datenschutz § Mehrspieler). Kein TURN-Relay:
   In sehr strengen Netzen klappt keine Direktverbindung → Meldung.

   const raum = await raumEroeffnen("blackjack", {
     gast(platz), gastWeg(platz), nachricht(platz, daten), status(text, art) });
   raum.code · raum.senden(platz, daten) · raum.allen(daten) · raum.schliessen()

   const tisch = await raumBeitreten("blackjack", "AB3D", {
     verbunden(), nachricht(daten), status(text, art), ende(grund) });
   tisch.platz · tisch.senden(daten) · tisch.verlassen()
   ============================================================ */

const STUN = [{ urls: "stun:stun.cloudflare.com:3478" }];
const DIREKT_FRIST_MS = 15000; // so lange darf der Verbindungsaufbau dauern
const LEBENSZEICHEN_MS = 30000;
export const CODE_MUSTER = /^[A-HJ-NP-Z2-9]{4}$/;

function vermittlungsAdresse() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/vermittlung`;
}

const merkSchluessel = (spiel) => `ba:mehr:${spiel}`;
function gemerkt(spiel) {
  try {
    return JSON.parse(sessionStorage.getItem(merkSchluessel(spiel)) || "null");
  } catch {
    return null;
  }
}
function merken(spiel, wert) {
  try {
    if (wert) sessionStorage.setItem(merkSchluessel(spiel), JSON.stringify(wert));
    else sessionStorage.removeItem(merkSchluessel(spiel));
  } catch {
    /* privates Fenster: dann eben ohne Wiederverbinden */
  }
}

/** WebSocket zur Vermittlung mit automatischem Neuaufbau. */
function leitung(beimOeffnen, beiNachricht, beiAbbruch) {
  let ws = null;
  let aus = false;
  let versuche = 0;
  let ping = null;
  function auf() {
    if (aus) return;
    ws = new WebSocket(vermittlungsAdresse());
    ws.onopen = () => {
      versuche = 0;
      clearInterval(ping);
      ping = setInterval(() => senden({ t: "ping" }), LEBENSZEICHEN_MS);
      beimOeffnen();
    };
    ws.onmessage = (e) => {
      let d;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      if (d.t !== "pong") beiNachricht(d);
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (aus) return;
      versuche++;
      if (versuche > 6) return beiAbbruch();
      setTimeout(auf, Math.min(1000 * 2 ** versuche, 15000));
    };
  }
  function senden(d) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(d));
  }
  auf();
  return {
    senden,
    zu() {
      aus = true;
      clearInterval(ping);
      ws?.close();
    },
  };
}

/** Eine Peer-Verbindung; Signale gehen über `signal(daten)` hinaus. */
function peer(signal, istHost) {
  const pc = new RTCPeerConnection({ iceServers: STUN });
  pc.onicecandidate = (e) => {
    if (e.candidate) signal({ ice: e.candidate.toJSON() });
  };
  return {
    pc,
    async signalRein(d) {
      if (d.sdp) {
        await pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          signal({ sdp: pc.localDescription.toJSON() });
        }
      } else if (d.ice) {
        try {
          await pc.addIceCandidate(d.ice);
        } catch {
          /* veraltete Kandidaten ignorieren */
        }
      }
    },
    async anbieten() {
      if (!istHost) return;
      await pc.setLocalDescription(await pc.createOffer());
      signal({ sdp: pc.localDescription.toJSON() });
    },
    zu() {
      try {
        pc.close();
      } catch {
        /* schon zu */
      }
    },
  };
}

function kanalSenden(kanal, daten) {
  if (kanal && kanal.readyState === "open") {
    kanal.send(JSON.stringify(daten));
    return true;
  }
  return false;
}

function kanalLesen(e) {
  try {
    return JSON.parse(e.data);
  } catch {
    return null;
  }
}

/* ---------- Host ---------- */
export function raumEroeffnen(spiel, rueck = {}) {
  const gaeste = new Map(); // platz -> { p, kanal, frist }
  const alt = gemerkt(spiel);
  let code = null;
  let schluessel = null;

  return new Promise((fertig, fehler) => {
    let erstesMal = true;
    const l = leitung(
      () => {
        // Neuaufbau der Leitung: mit Schlüssel denselben Raum zurückholen
        if (code && schluessel) l.senden({ t: "beitreten", spiel, code, schluessel });
        else if (alt?.rolle === "host")
          l.senden({ t: "beitreten", spiel, code: alt.code, schluessel: alt.schluessel });
        else l.senden({ t: "eroeffnen", spiel });
      },
      async (d) => {
        if (d.t === "raum" || (d.t === "drin" && d.platz === 0)) {
          code = d.code;
          schluessel = d.schluessel;
          merken(spiel, { rolle: "host", code, schluessel });
          if (erstesMal) {
            erstesMal = false;
            fertig(api);
          }
        } else if (d.t === "fehler") {
          if (!code && alt) {
            // gemerkter Raum ist weg → neu eröffnen
            merken(spiel, null);
            l.senden({ t: "eroeffnen", spiel });
            return;
          }
          if (erstesMal) {
            erstesMal = false;
            l.zu();
            fehler(new Error(d.text));
          } else rueck.status?.(d.text, "fehler");
        } else if (d.t === "neu") {
          gastVerbinden(d.platz);
        } else if (d.t === "signal") {
          await gaeste.get(d.von)?.p.signalRein(d.daten);
        } else if (d.t === "weg") {
          gastEntfernen(d.platz);
        } else if (d.t === "ende") {
          merken(spiel, null);
          rueck.status?.(d.grund, "fehler");
        }
      },
      () => rueck.status?.("Keine Verbindung zum Spiele-Server.", "fehler"),
    );

    function gastEntfernen(platz) {
      const g = gaeste.get(platz);
      if (!g) return;
      clearTimeout(g.frist);
      g.p.zu();
      gaeste.delete(platz);
      rueck.gastWeg?.(platz);
    }

    function gastVerbinden(platz) {
      const vorher = gaeste.get(platz);
      if (vorher) {
        clearTimeout(vorher.frist);
        vorher.p.zu();
      }
      const p = peer((daten) => l.senden({ t: "signal", an: platz, daten }), true);
      const kanal = p.pc.createDataChannel("spiel", { ordered: true });
      const g = { p, kanal, frist: null };
      gaeste.set(platz, g);
      g.frist = setTimeout(() => {
        if (kanal.readyState !== "open") {
          rueck.status?.(
            `Platz ${platz + 1}: keine Direktverbindung möglich (strenges Netz).`,
            "fehler",
          );
          gastEntfernen(platz);
        }
      }, DIREKT_FRIST_MS);
      kanal.onopen = () => {
        clearTimeout(g.frist);
        rueck.gast?.(platz);
      };
      kanal.onmessage = (e) => {
        const daten = kanalLesen(e);
        if (daten) rueck.nachricht?.(platz, daten);
      };
      kanal.onclose = () => {
        if (gaeste.get(platz)?.kanal === kanal) {
          gaeste.delete(platz);
          rueck.gastWeg?.(platz);
        }
      };
      p.anbieten();
    }

    const api = {
      get code() {
        return code;
      },
      senden: (platz, daten) => kanalSenden(gaeste.get(platz)?.kanal, daten),
      allen(daten) {
        for (const g of gaeste.values()) kanalSenden(g.kanal, daten);
      },
      plaetze: () =>
        [...gaeste.entries()].filter(([, g]) => g.kanal.readyState === "open").map(([p]) => p),
      schliessen() {
        l.senden({ t: "verlassen" });
        merken(spiel, null);
        for (const g of gaeste.values()) g.p.zu();
        gaeste.clear();
        setTimeout(() => l.zu(), 200);
      },
    };
  });
}

/* ---------- Gast ---------- */
export function raumBeitreten(spiel, codeRoh, rueck = {}) {
  const code = String(codeRoh || "")
    .toUpperCase()
    .trim();
  if (!CODE_MUSTER.test(code))
    return Promise.reject(new Error("Der Code hat 4 Zeichen (A–Z, 2–9)."));
  const alt = gemerkt(spiel);
  let schluessel = alt?.rolle === "gast" && alt.code === code ? alt.schluessel : null;
  let platz = null;
  let p = null;
  let kanal = null;
  let frist = null;
  let beendet = false;

  return new Promise((fertig, fehler) => {
    let erstesMal = true;
    const l = leitung(
      () => l.senden({ t: "beitreten", spiel, code, schluessel }),
      async (d) => {
        if (d.t === "drin") {
          platz = d.platz;
          schluessel = d.schluessel;
          merken(spiel, { rolle: "gast", code, schluessel });
          neuerPeer();
          if (erstesMal) {
            erstesMal = false;
            fertig(api);
          }
          if (!d.host_da) rueck.status?.("Warte auf den Host …", "neutral");
        } else if (d.t === "fehler") {
          if (erstesMal) {
            erstesMal = false;
            l.zu();
            fehler(new Error(d.text));
          } else rueck.status?.(d.text, "fehler");
        } else if (d.t === "signal") {
          await p?.signalRein(d.daten);
        } else if (d.t === "host-getrennt") {
          rueck.status?.("Der Host ist kurz weg – warte …", "neutral");
        } else if (d.t === "host-zurueck") {
          rueck.status?.("Der Host ist zurück.", "neutral");
        } else if (d.t === "ende") {
          ende(d.grund);
        }
      },
      () => ende("Keine Verbindung zum Spiele-Server."),
    );

    function ende(grund) {
      if (beendet) return;
      beendet = true;
      merken(spiel, null);
      clearTimeout(frist);
      p?.zu();
      l.zu();
      rueck.ende?.(grund);
    }

    function neuerPeer() {
      p?.zu();
      clearTimeout(frist);
      p = peer((daten) => l.senden({ t: "signal", an: 0, daten }), false);
      frist = setTimeout(() => {
        if (!kanal || kanal.readyState !== "open")
          rueck.status?.(
            "Keine Direktverbindung möglich – vermutlich ein sehr strenges Netz (z. B. Mobilfunk). Versuch es im WLAN.",
            "fehler",
          );
      }, DIREKT_FRIST_MS);
      p.pc.ondatachannel = (e) => {
        kanal = e.channel;
        kanal.onopen = () => {
          clearTimeout(frist);
          rueck.verbunden?.();
        };
        kanal.onmessage = (ev) => {
          const daten = kanalLesen(ev);
          if (daten) rueck.nachricht?.(daten);
        };
        kanal.onclose = () => {
          if (beendet) return;
          rueck.status?.("Verbindung zum Host unterbrochen – verbinde neu …", "neutral");
          // erneut beitreten → Host bekommt "neu" und baut die Verbindung wieder auf
          setTimeout(() => !beendet && l.senden({ t: "nochmal" }), 1500);
        };
      };
    }

    const api = {
      get platz() {
        return platz;
      },
      code,
      senden: (daten) => kanalSenden(kanal, daten),
      verlassen() {
        l.senden({ t: "verlassen" });
        beendet = true;
        merken(spiel, null);
        p?.zu();
        setTimeout(() => l.zu(), 200);
      },
    };
  });
}
