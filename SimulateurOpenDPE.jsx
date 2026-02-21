import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ═══════════════════════════════════════════════════════
//  MOTEUR DE CALCUL 3CL-DPE 2021 (méthode Cerema v3)
// ═══════════════════════════════════════════════════════

const DJU = { H1a:3500, H1b:3200, H1c:2900, H2a:2400, H2b:2300, H2c:2000, H2d:2700, H3:1500 };
const FEP = { gaz:1.0, fioul:1.0, bois:1.0, elec:2.3, reseau:0.6, aucun:1.0 };
const FCO2 = { gaz:0.227, fioul:0.324, bois:0.030, elec:0.064, reseau:0.040, aucun:0.1 };
const PRIX = { gaz:0.112, fioul:0.110, elec:0.206, bois:0.060, reseau:0.080, aucun:0.15 };
// Qvarepconv m³/(h·m²) — source §4 arrêté 31/03/2021, tableau ventilation
// Clé: type_vent (+ periode si VMC datée)
const QVAR_TABLE = {
  // ── Ventilation naturelle/passive ──────────────────────────────────────────
  fenetres:           1.20, // Ouverture des fenêtres (§4)
  hautes_basses:      2.23, // Entrées d'air hautes et basses (§4)
  naturelle_conduit:  2.23, // Ventilation naturelle par conduit
  naturelle_hygro:    1.24, // Naturelle par conduit avec entrées d'air hygro
  // ── VMC Simple Flux Auto-réglable ─────────────────────────────────────────
  vmc_sf_auto_av1982: 1.97,
  vmc_sf_auto_1982:   1.65, // 1982–2000
  vmc_sf_auto_2001:   1.50, // 2001–2012
  vmc_sf_auto_ap2012: 1.32,
  // ── VMC SF Hygroréglable A ─────────────────────────────────────────────────
  vmc_sf_hygroA_av2001: 1.50,
  vmc_sf_hygroA_2001:   1.44, // 2001–2012
  vmc_sf_hygroA_ap2012: 1.16,
  // ── VMC SF Hygroréglable B ─────────────────────────────────────────────────
  vmc_sf_hygroB_av2001: 1.36,
  vmc_sf_hygroB_2001:   1.24, // 2001–2012
  vmc_sf_hygroB_ap2012: 1.09,
  // ── VMC SF Gaz ─────────────────────────────────────────────────────────────
  vmc_sf_gaz_av2001:  1.59,
  vmc_sf_gaz_2001:    1.53, // 2001–2012
  vmc_sf_gaz_ap2012:  1.22,
  // ── VMC Basse pression ─────────────────────────────────────────────────────
  vmc_bp_auto:        1.97,
  vmc_bp_hygroA:      1.30,
  vmc_bp_hygroB:      1.24,
  // ── VMC Double Flux ────────────────────────────────────────────────────────
  vmc_df_indiv_av2012: 0.60, // individuelle avec échangeur ≤2012
  vmc_df_indiv_ap2012: 0.26, // individuelle avec échangeur >2012
  vmc_df_coll_av2012:  0.75, // collective avec échangeur ≤2012
  vmc_df_coll_ap2012:  0.46, // collective avec échangeur >2012
  vmc_df_sans_av2012:  1.65, // sans échangeur ≤2012
  vmc_df_sans_ap2012:  1.32, // sans échangeur >2012
  // ── Ventilation hybride ─────────────────────────────────────────────────────
  hybride_av2001:     1.52,
  hybride_2001:       1.33, // 2001–2012
  hybride_ap2012:     1.17,
  hybride_hygro_av2001: 1.52,
  hybride_hygro_2001:   1.33, // 2001–2012
  hybride_hygro_ap2012: 1.17,
  // ── VMC sur conduit existant ─────────────────────────────────────────────
  vmc_conduit_av2012: 2.24,
  vmc_conduit_ap2012: 1.97,
  // ── Puits climatique ─────────────────────────────────────────────────────
  puits_sans_av2012:  1.65,
  puits_sans_ap2012:  1.32,
  puits_avec_av2012:  0.60,
  puits_avec_ap2012:  0.26,
};
// Rétrocompatibilité : alias simples
const QVAR = {
  fenetres:"fenetres", naturelle:"naturelle_conduit", vmc_auto:"vmc_sf_auto_2001",
  vmc_hygro:"vmc_sf_hygroB_2001", vmc_double:"vmc_df_indiv_ap2012", hybride:"hybride_2001",
  hautes_basses:"hautes_basses",
};
function getQvar(type) { return QVAR_TABLE[type] ?? (QVAR_TABLE[QVAR[type]] ?? 1.2); }

const U_MUR = {
  pierre:        { non:2.5, iti:0.36, ite:0.28, reparti:0.45 },
  brique_pleine: { non:1.8, iti:0.35, ite:0.27, reparti:0.40 },
  brique_creuse: { non:1.2, iti:0.35, ite:0.27, reparti:0.35 },
  beton_plein:   { non:2.2, iti:0.35, ite:0.27, reparti:0.35 },
  parpaing:      { non:1.5, iti:0.35, ite:0.27, reparti:0.35 },
  ossature_bois: { non:0.7, iti:0.27, ite:0.25, reparti:0.25 },
  ancien:        { non:2.0, iti:0.40, ite:0.35, reparti:0.50 },
};
// ─── Plancher bas ─────────────────────────────────────────────────────────────
// Types avec Upb0 (transmission non isolé) et indication structure lourde/légère
// Structure légère (bois) → ponts thermiques nuls (§3.4.1 : matériaux lourds uniquement)
const PB_TYPES_3CL = [
  { v:"beton_plein",    l:"🏢 Dalle béton plein",           d:"Béton massif ou banché — structure lourde",     upb0:2.0,  lourd:true  },
  { v:"hourdis_beton",  l:"📐 Hourdis béton / corps creux", d:"Corps creux béton + table compression — lourd", upb0:1.6,  lourd:true  },
  { v:"hourdis_bois",   l:"🪵 Hourdis bois-béton",          d:"Poutrelles bois + hourdis béton — lourd",       upb0:1.1,  lourd:true  },
  { v:"entrevous_poly", l:"🔷 Entrevous polystyrène",        d:"Plancher isolant intégré (traité ITE en 3CL)",  upb0:0.45, lourd:false },
  { v:"bois_solives",   l:"🪵 Solivage bois + parquet",      d:"Structure bois — ponts thermiques négligés",    upb0:0.8,  lourd:false },
  { v:"autre",          l:"❓ Autre / inconnu",              d:"Upb0 = 2,0 W/m²K par défaut 3CL",               upb0:2.0,  lourd:true  },
];

// Situations d'exposition du plancher bas
const PB_SITUATIONS = [
  { v:"vide_sanitaire", l:"🕳️ Vide sanitaire non chauffé",     d:"Espace aéré sous le plancher — ventilé",          ue:true  },
  { v:"sous_sol",       l:"🏚️ Sous-sol / cave non chauffée",    d:"Espace clos non chauffé en dessous",               ue:true  },
  { v:"terre_plein",    l:"🏠 Dalle sur terre-plein",           d:"Béton en contact direct avec la terre",             ue:true  },
  { v:"exterieur",      l:"💨 Pilotis / extérieur direct",      d:"Air extérieur directement sous le plancher",        ue:false },
  { v:"local_nc",       l:"🚪 Local non chauffé (autre)",       d:"Garage, remise, autre local non chauffé",          ue:false },
];

// Types d'isolation plancher bas — ITI = sous-chape, ITE = sous-face (§3.4.1)
const PB_ISO_TYPES = [
  { v:"non",      l:"Non isolé",              d:"Aucune isolation",                           psi_key:"non"     },
  { v:"iti",      l:"ITI — Sous chape",       d:"Polystyrène / laine posé sous la chape",     psi_key:"iti"     },
  { v:"ite",      l:"ITE — Sous-face",        d:"Isolant fixé en sous-face du plancher",      psi_key:"ite"     },
  { v:"iti_ite",  l:"ITI + ITE (combiné)",    d:"Isolation en sous-chape et en sous-face",    psi_key:"iti_ite" },
  { v:"inconnue", l:"Inconnu",                d:"3CL : ITE appliquée par défaut",             psi_key:"ite"     },
];

// Upb_tab par époque d'isolation et zone (valeur «Autres» = non-effet joule)
// Source : Tableau §3.2.2, méthode 3CL-DPE 2021 arrêté 31/03/2021
const UPB_TAB = [
  { max:74,  H1:2.0,  H2:2.0,  H3:2.0  },
  { max:77,  H1:0.9,  H2:0.95, H3:1.0  },
  { max:82,  H1:0.9,  H2:0.95, H3:1.0  },
  { max:88,  H1:0.8,  H2:0.74, H3:0.89 },
  { max:2000,H1:0.5,  H2:0.63, H3:0.56 },
  { max:2005,H1:0.3,  H2:0.3,  H3:0.47 },
  { max:2012,H1:0.27, H2:0.27, H3:0.40 },
  { max:9999,H1:0.23, H2:0.23, H3:0.25 },
];

function getUpbTab(anneeStr, zone) {
  const a = parseInt(anneeStr)||0;
  const yr = a < 100 ? (a >= 75 ? 1900+a : 2000+a) : a;
  const row = UPB_TAB.find(r => yr <= r.max) || UPB_TAB[UPB_TAB.length-1];
  return row[zone] || row.H1;
}

// Calcul Upb effectif selon 3CL
function computeUpb(p, zone="H1") {
  const typeDef = PB_TYPES_3CL.find(t=>t.v===p.type) || { upb0:2.0 };
  const upb0 = typeDef.upb0;
  const iso = p.iso_type || "non";
  if (iso === "non") return upb0;
  const e = parseFloat(p.epaisseurIso);
  if (e > 0) return Math.round(100 / (100/upb0 + e/0.042)) / 100;
  const annee = p.anneeIso;
  if (annee) return Math.min(upb0, getUpbTab(annee, zone));
  return Math.min(upb0, getUpbTab("old", zone));
}

// Ue simplifié pour vide sanitaire / sous-sol / terre-plein
// 2S/P ≈ 5 m (valeur médiane) — approximation 3CL
function computeUe(upb, situation) {
  // Interpolation table 2S/P=5 pour vide sanitaire/sous-sol
  if (situation === "terre_plein") {
    // Tableau terre-plein 2S/P=5 (avant 2001 si upb>1 sinon après)
    if (upb >= 2.0) return 0.60; if (upb >= 1.5) return 0.46;
    if (upb >= 0.85) return 0.38; if (upb >= 0.6) return 0.32; return 0.27;
  }
  // Vide sanitaire / sous-sol, 2S/P=5
  if (upb >= 3.0) return 0.39; if (upb >= 1.4) return 0.36;
  if (upb >= 0.8) return 0.34; if (upb >= 0.45) return 0.32; return 0.30;
}

// ─── Plancher haut ────────────────────────────────────────────────────────────
// Types avec Uph0 (§3.2.3.2 méthode 3CL)
const PH_TYPES_3CL = [
  { v:"combles_perdus",  l:"🏠 Combles perdus",               d:"Grenier non aménagé — isoler au plancher",       uph0:2.5,  lourd:true,  tbl:"combles"  },
  { v:"combles_amenages",l:"🔺 Combles aménagés / rampants",  d:"Pièces habitables sous les pentes du toit",      uph0:2.5,  lourd:false, tbl:"combles"  },
  { v:"terrasse",        l:"🏢 Toiture terrasse",              d:"Toit plat (<5°) — plancher haut lourd",          uph0:2.5,  lourd:true,  tbl:"terrasse" },
  { v:"bac_acier",       l:"🏗️ Bac acier",                    d:"Toiture métallique — traité comme combles",       uph0:2.5,  lourd:false, tbl:"combles"  },
  { v:"placo",           l:"📋 Plafond plaque de plâtre",      d:"Faux-plafond — Uph0 = 2,5 W/m²K",               uph0:2.5,  lourd:false, tbl:"terrasse" },
  { v:"chaume",          l:"🌾 Toiture en chaume",             d:"Uph0 = 0,24 W/m²K — valeur spécifique 3CL",      uph0:0.24, lourd:false, tbl:"combles"  },
  { v:"autre",           l:"❓ Autre / inconnu",               d:"Uph0 = 2,5 W/m²K par défaut",                   uph0:2.5,  lourd:true,  tbl:"combles"  },
];

// Types d'isolation plancher haut — ITI = sous plafond, ITE = sur plancher haut (§3.4.3)
const PH_ISO_TYPES = [
  { v:"non",      l:"Non isolé",                    d:"Aucune isolation",                                   psi_key:"non"     },
  { v:"iti",      l:"ITI — Sous plafond (intérieur)",d:"Laine posée côté intérieur (sous le plancher haut)",psi_key:"iti"     },
  { v:"ite",      l:"ITE — Sur plancher (extérieur)",d:"Isolation posée sur le plancher haut, côté toiture",psi_key:"ite"     },
  { v:"iti_ite",  l:"ITI + ITE (combiné)",           d:"Double isolation : dessus et dessous",               psi_key:"iti_ite" },
  { v:"inconnue", l:"Inconnu",                       d:"3CL : ITE appliquée par défaut",                    psi_key:"ite"     },
];

// Uph_tab par époque (valeur «Autres» non-effet joule)
// Source : Tableau §3.2.3, arrêté 31/03/2021
const UPH_TAB = {
  combles: [
    { max:74,  H1:2.5,  H2:2.5,  H3:2.5  },
    { max:77,  H1:0.5,  H2:0.53, H3:0.56 },
    { max:82,  H1:0.5,  H2:0.53, H3:0.56 },
    { max:88,  H1:0.3,  H2:0.32, H3:0.33 },
    { max:2000,H1:0.25, H2:0.26, H3:0.3  },
    { max:2005,H1:0.23, H2:0.23, H3:0.3  },
    { max:2012,H1:0.2,  H2:0.2,  H3:0.25 },
    { max:9999,H1:0.14, H2:0.14, H3:0.14 },
  ],
  terrasse: [
    { max:74,  H1:2.5,  H2:2.5,  H3:2.5  },
    { max:77,  H1:0.75, H2:0.79, H3:0.83 },
    { max:82,  H1:0.75, H2:0.79, H3:0.83 },
    { max:88,  H1:0.55, H2:0.58, H3:0.61 },
    { max:2000,H1:0.40, H2:0.42, H3:0.44 },
    { max:2005,H1:0.30, H2:0.30, H3:0.30 },
    { max:2012,H1:0.27, H2:0.27, H3:0.27 },
    { max:9999,H1:0.14, H2:0.14, H3:0.14 },
  ],
};

function getUphTab(anneeStr, zone, tbl="combles") {
  const a = parseInt(anneeStr)||0;
  const yr = a < 100 ? (a >= 75 ? 1900+a : 2000+a) : a;
  const rows = UPH_TAB[tbl] || UPH_TAB.combles;
  const row = rows.find(r=>yr<=r.max) || rows[rows.length-1];
  return row[zone] || row.H1;
}

function computeUph(t, zone="H1") {
  const typeDef = PH_TYPES_3CL.find(tt=>tt.v===t.type) || { uph0:2.5 };
  const uph0 = typeDef.uph0;
  const tbl = typeDef.tbl || "combles";
  const iso = t.iso_type || "non";
  if (iso === "non") return uph0;
  const e = parseFloat(t.epaisseurIso);
  if (e > 0) return Math.round(100 / (100/uph0 + e/0.040)) / 100;
  const annee = t.anneeIso;
  if (annee) return Math.min(uph0, getUphTab(annee, zone, tbl));
  return Math.min(uph0, getUphTab("old", zone, tbl));
}


// ─── Facteurs d'ensoleillement 3CL-DPE 2021 §6.2.2 ─────────────────────────

// Fe1 masques proches (§6.2.2.1) — fond/sous balcon, loggia, paroi latérale
// Clés: orientation façade N/S/E/O ; valeur: coefficient réduction apports
const FE1 = {
  aucun:     { N:1,    S:1,    E:1,    O:1    },
  inf1m:     { N:0.40, S:0.50, E:0.45, O:0.45 }, // balcon fond < 1 m
  "1_2m":    { N:0.30, S:0.40, E:0.35, O:0.35 }, // balcon fond 1–2 m
  "2_3m":    { N:0.20, S:0.30, E:0.25, O:0.25 }, // balcon fond 2–3 m
  sup3m:     { N:0.10, S:0.20, E:0.15, O:0.15 }, // balcon fond ≥ 3 m
  loggia:    { N:0.40, S:0.50, E:0.45, O:0.45 }, // loggia fermée ≈ balcon < 1m
  paroi_lat: { N:0.70, S:0.50, E:0.70, O:0.70 }, // retour latéral obstacle Sud
};

// Fe2 masques lointains homogènes (§6.2.2.2.1) — hauteur angulaire α
// Angles : < 15° (aucun), 15–30°, 30–60°, 60–90°
const FE2 = {
  aucun:   { N:1,    S:1,    E:1,    O:1    },
  "0_15":  { N:1,    S:1,    E:1,    O:1    },
  "15_30": { N:0.82, S:0.80, E:0.77, O:0.77 },
  "30_60": { N:0.50, S:0.30, E:0.40, O:0.40 },
  "60_90": { N:0.30, S:0.10, E:0.20, O:0.20 },
};

// C1 coefficient orientation annuel (approximation saison chauffe)
const C1_ORIENT = { N:0.30, S:1.00, E:0.60, O:0.60 };

// sw facteur solaire par vitrage (proportion énergie solaire transmise)
const SW_VITRAGE = { simple:0.85, double_old:0.67, double_rec:0.55, triple:0.40 };

// Situations plancher haut — local au-dessus (§3.1 + §3.2.3)
// btr=0 : local chauffé → pas de déperdition
// forceTbl : si "terrasse", forcer Uph_tab terrasse même pour combles (§3.2.3)
const PH_SITUATIONS = [
  { v:"exterieur",     l:"☁️ Toiture / extérieur",        d:"Toiture donnant sur l'air extérieur",              btr:1.0, forceTbl:null   },
  { v:"combles_nc",    l:"🏠 Combles non chauffés",        d:"Grenier, combles perdus non chauffés",             btr:0.9, forceTbl:null   },
  { v:"local_nc",      l:"🚪 Local non chauffé au-dessus", d:"Appartement vide, dépendance non chauffée — Uph_tab terrasse (§3.2.3)", btr:0.8, forceTbl:"terrasse" },
  { v:"local_chauffe", l:"🔥 Local chauffé au-dessus",     d:"Logement chauffé — b=0, aucune déperdition",       btr:0.0, forceTbl:null   },
];

// ─── Matrices ponts thermiques 3CL-DPE 2021 ──────────────────────────────────
// Source : §3.4 Arrêté du 31/03/2021, Annexe 1 méthode 3CL-DPE 2021
// Structure légère → PT = 0 (§3.4.1 : « matériaux lourds uniquement »)

// kpb[iso_plancher_bas][iso_mur] W/(m.K) — Plancher bas / Mur
const KPB = {
  non:     { non:0.39, iti:0.31, ite:0.49, iti_ite:0.31 },
  iti:     { non:0.47, iti:0.08, ite:0.48, iti_ite:0.08 },
  ite:     { non:0.80, iti:0.71, ite:0.64, iti_ite:0.45 },
  iti_ite: { non:0.47, iti:0.08, ite:0.48, iti_ite:0.08 },
};

// kph[iso_plancher_haut][iso_mur] W/(m.K) — Plancher haut lourd (terrasse, combles perdus) / Mur
const KPH = {
  non:     { non:0.30, iti:0.27, ite:0.55, iti_ite:0.27 },
  iti:     { non:0.83, iti:0.07, ite:0.76, iti_ite:0.07 },
  ite:     { non:0.40, iti:0.75, ite:0.58, iti_ite:0.58 },
  iti_ite: { non:0.40, iti:0.07, ite:0.58, iti_ite:0.07 },
};

// kpi[iso_mur] W/(m.K) — Plancher intermédiaire / Mur (structure lourde uniquement)
const KPI = { non:0.86, iti:0.92, ite:0.13, iti_ite:0.13 };

// krf[iso_mur] W/(m.K) — Refend / Mur (structure lourde uniquement)
const KRF = { non:0.73, iti:0.82, ite:0.13, iti_ite:0.13 };

// kmen[iso_mur] W/(m.K) — Menuiserie / Mur (§3.4.5 valeurs forfaitaires)
const KMEN = { non:0.45, iti:0.35, ite:0.10, iti_ite:0.10 };

// Helper: résoudre la clé iso_mur 3CL depuis le champ isolation du mur
function isoMurKey(murIso) {
  if (murIso === "ite") return "ite";
  if (murIso === "iti") return "iti";
  if (murIso === "iti_ite" || murIso === "iti+ite") return "iti_ite";
  return "non";
}

const U_VITRAGE = { simple:5.8, double_old:2.9, double_rec:1.4, triple:0.8 };

// ─── Générateurs de chauffage 3CL-DPE 2021 ─────────────────────────────────
// eff = Rg × Re × Rd × Rr (rendements §12–§13 arrêté 31/03/2021)
// Rg : §13.2.2 — Re : §12.1 — Rr : §12.3 — Rd ≈ 0.91 (réseau individuel isolé)
// groupe : utilisé pour regrouper l'affichage Step8
const CHAUFFAGES = {
  // ── GAZ ────────────────────────────────────────────────────────────────────
  gaz_classique: { label:"Chaudière gaz classique (avant 1991)",  eff:0.74, ep:"gaz",   ico:"🔵", groupe:"gaz",
    d:"Rpn ~84 % — vieilles chaudières à tirage naturel, veilleuse permanente" },
  gaz_std:       { label:"Chaudière gaz standard",                 eff:0.80, ep:"gaz",   ico:"🔵", groupe:"gaz",
    d:"Rpn ~88 % — standard depuis 1991, température fixe ≥65°C" },
  gaz_basse_t:   { label:"Chaudière gaz basse température",       eff:0.88, ep:"gaz",   ico:"🔵", groupe:"gaz",
    d:"Rpn ~91 % — température variable 45–70°C, faibles pertes à l'arrêt" },
  gaz_cond:      { label:"Chaudière gaz condensation",            eff:0.97, ep:"gaz",   ico:"💙", groupe:"gaz",
    d:"Rpn 103+ % PCI — récupération chaleur latente vapeur d'eau (§13.2.2)" },
  // ── FIOUL ──────────────────────────────────────────────────────────────────
  fioul_classique:{ label:"Chaudière fioul classique (avant 1991)",eff:0.72, ep:"fioul", ico:"🛢️", groupe:"fioul",
    d:"Rpn ~84 % PCI — avant 1970 à 1990" },
  fioul_std:     { label:"Chaudière fioul standard",              eff:0.78, ep:"fioul", ico:"🛢️", groupe:"fioul",
    d:"Rpn ~87,5 % — depuis 1991, brûleur à air pulsé" },
  fioul_basse_t: { label:"Chaudière fioul basse température",     eff:0.87, ep:"fioul", ico:"🛢️", groupe:"fioul",
    d:"Rpn ~91 % — température modulante, gains significatifs vs standard" },
  fioul_cond:    { label:"Chaudière fioul condensation",          eff:0.94, ep:"fioul", ico:"🛢️", groupe:"fioul",
    d:"Rpn ~98 % PCI — condensation partiellement limitée par teneur en soufre" },
  // ── GPL / PROPANE ──────────────────────────────────────────────────────────
  gpl_std:       { label:"Chaudière GPL / propane standard",      eff:0.79, ep:"gaz",   ico:"🟡", groupe:"gpl",
    d:"Rendement similaire gaz standard — énergie plus coûteuse (réseau absent)" },
  gpl_cond:      { label:"Chaudière GPL condensation",            eff:0.96, ep:"gaz",   ico:"🟡", groupe:"gpl",
    d:"Condensation fiable (pas de soufre) — performances proches du gaz naturel" },
  // ── ÉLECTRIQUE DIRECT (effet joule) ────────────────────────────────────────
  // Re §12.1 : convecteur NFC=0.95 / panneau rayonnant NFC=0.97 / autres=0.95
  // Rr §12.3 : convecteur NFC=0.99 / panneau rayonnant NFC=0.99 / accumulation=0.95
  // Rg §12.4.1 : générateur effet joule direct = 1.0
  elec_conv:     { label:"Convecteur électrique (NFC ou NF**)",   eff:0.940, ep:"elec", ico:"⚡", groupe:"elec",
    d:"Re=0,95 × Rr=0,99 — convecteur à soufflerie, chauffe vite, inertie nulle (§12.1/12.3)" },
  elec_rayon:    { label:"Panneau rayonnant électrique (NF**)",   eff:0.960, ep:"elec", ico:"⚡", groupe:"elec",
    d:"Re=0,97 × Rr=0,99 — chaleur douce rayonnante, meilleur confort hygrométrique" },
  elec_inertiel: { label:"Radiateur à inertie (fonte / céramique)",eff:0.899,ep:"elec", ico:"⚡", groupe:"elec",
    d:"Re=0,95 × Rr=0,95 (accumulation) — inertie forte, chauffe lentement, refroidit lentement" },
  elec_seche_serv:{ label:"Sèche-serviettes électrique",          eff:0.912,ep:"elec", ico:"⚡", groupe:"elec",
    d:"Re=0,95 × Rr=0,96 — même calcul que panneau rayonnant NFC en SdB" },
  elec_autres:   { label:"Autres émetteurs effet joule",          eff:0.912,ep:"elec", ico:"⚡", groupe:"elec",
    d:"Re=0,95 × Rr=0,96 — résistances nues, convecteurs non NF, soufflants" },
  elec_plancher: { label:"Plancher chauffant électrique",         eff:0.969,ep:"elec", ico:"⚡", groupe:"elec",
    d:"Re=1,00 × Rr=0,98 (avec régulation) — inertie très forte, confort optimal" },
  // ── POMPES À CHALEUR ───────────────────────────────────────────────────────
  pac_aireau_h1: { label:"PAC air/eau — zone H1",                  eff:2.20, ep:"elec", ico:"🌡️", groupe:"pac",
    d:"SCOP estimé H1 — émetteurs radiateurs ou plancher basse T. (§12.4.2)" },
  pac_aireau_h2: { label:"PAC air/eau — zone H2",                  eff:2.60, ep:"elec", ico:"🌡️", groupe:"pac",
    d:"SCOP estimé H2 — conditions plus douces, performances supérieures" },
  pac_aireau_h3: { label:"PAC air/eau — zone H3",                  eff:3.00, ep:"elec", ico:"🌡️", groupe:"pac",
    d:"SCOP estimé H3 (Sud) — performances maximales, très peu de jours froids" },
  pac_split:     { label:"PAC air/air (split / multi-split)",      eff:2.50, ep:"elec", ico:"❄️",  groupe:"pac",
    d:"SCOP moyen — système divisé, pas de réseau hydraulique, efficace en H2-H3" },
  pac_geo:       { label:"PAC géothermique (sol/eau ou eau/eau)",  eff:3.50, ep:"elec", ico:"🌍", groupe:"pac",
    d:"SCOP ~3,5 — source froide stable, très performant en H1 (§12.4.2)" },
  // ── BOIS / BIOMASSE ────────────────────────────────────────────────────────
  bois_buche:    { label:"Poêle / insert bois bûche",              eff:0.65, ep:"bois", ico:"🪵", groupe:"bois",
    d:"Rg ~0,65 — rendement variable selon combustion, traité comme radiateur/convecteur (§8)" },
  bois_gra:      { label:"Poêle à granulés (pellets)",             eff:0.85, ep:"bois", ico:"⬛", groupe:"bois",
    d:"Rg ~0,85 — régulation automatique, alimentation continue, très performant" },
  chaud_bois:    { label:"Chaudière bois bûche / plaquettes",      eff:0.75, ep:"bois", ico:"🌿", groupe:"bois",
    d:"Rg ~0,75 — chaudière à accumulation ou à gazéification" },
  chaud_gra:     { label:"Chaudière à granulés",                   eff:0.88, ep:"bois", ico:"🌿", groupe:"bois",
    d:"Rg ~0,88 — alimentation automatique, rendement proche chaudière gaz standard" },
  // ── RÉSEAU DE CHALEUR ──────────────────────────────────────────────────────
  reseau:        { label:"Réseau de chaleur urbain",               eff:0.97, ep:"reseau",ico:"🏭",groupe:"reseau",
    d:"Rg=0,97 (§12.4.1) — énergie comptabilisée selon mix réseau (primaire variable)" },
};
// Groupes pour affichage Step8
const CHAUFFAGE_GROUPES = [
  { key:"gaz",    ico:"🔵", label:"Gaz naturel",       },
  { key:"fioul",  ico:"🛢️", label:"Fioul domestique",  },
  { key:"gpl",    ico:"🟡", label:"GPL / Propane",     },
  { key:"elec",   ico:"⚡", label:"Électrique direct", },
  { key:"pac",    ico:"🌡️", label:"Pompe à chaleur",   },
  { key:"bois",   ico:"🪵", label:"Bois / Biomasse",   },
  { key:"reseau", ico:"🏭", label:"Réseau de chaleur", },
];
const ECS_SYS = {
  elec_bal:  { label:"Ballon électrique",             eff:0.85, ep:"elec",  ico:"🛁" },
  thermo:    { label:"Chauffe-eau thermodynamique",   eff:2.80, ep:"elec",  ico:"🌡️" },
  gaz_inst:  { label:"Chauffe-eau gaz instantané",   eff:0.85, ep:"gaz",   ico:"🔵" },
  chaud_mix: { label:"Couplé à la chaudière",         eff:null, ep:null,    ico:"🔗" },
  solaire:   { label:"Chauffe-eau solaire",           eff:3.00, ep:"elec",  ico:"☀️" },
};

// Ventilation — types complets 3CL-DPE 2021 (§4 arrêté)
// structure : { v: clé QVAR_TABLE, l: label, d: description, cat: groupe, qvarRef: valeur médiane }
const VENT_GROUPES = [
  {
    key:"passive", ico:"🌬️", label:"Ventilation naturelle / passive",
    items:[
      { v:"fenetres",         l:"🪟 Ouverture des fenêtres",                  d:"Aucun système dédié — renouvellement par ouverture manuelle uniquement (le plus défavorable)",         qvarRef:1.20 },
      { v:"hautes_basses",    l:"🔳 Entrées d'air hautes et basses",           d:"Grilles basses dans pièces de vie + évacuation haute en cuisine/SdB — pas de moteur (§4 : Qva=2,23)", qvarRef:2.23 },
      { v:"naturelle_conduit",l:"🏠 Ventilation naturelle par conduit",        d:"Conduits verticaux shunt ou tirage naturel — efficacité variable selon vent et saison",               qvarRef:2.23 },
      { v:"naturelle_hygro",  l:"💧 Naturelle par conduit + entrées hygro",    d:"Conduits naturels + entrées d'air hygroréglables — réduction des déperditions par humidité",          qvarRef:1.24 },
    ]
  },
  {
    key:"vmc_sf", ico:"⚙️", label:"VMC Simple Flux",
    periodeLabel:"Date d'installation du caisson VMC",
    periodes:[
      {v:"av_1982",l:"Avant 1982"},
      {v:"1982",   l:"1982 – 2000"},
      {v:"2001",   l:"2001 – 2012"},
      {v:"ap2012", l:"Après 2012"},
    ],
    items:[
      { v:"vmc_sf_auto",   l:"⚙️ VMC SF Auto-réglable",     d:"Débit constant, bouches débit fixe, entrées d'air calibrées — système le plus répandu",                    periodeMap:{av_1982:"vmc_sf_auto_av1982",1982:"vmc_sf_auto_1982",2001:"vmc_sf_auto_2001",ap2012:"vmc_sf_auto_ap2012"} },
      { v:"vmc_sf_hygroA", l:"💧 VMC SF Hygro A",            d:"Bouches auto-réglables + entrées d'air hygro — réduction modérée des déperditions",                       periodeMap:{av_1982:"vmc_sf_hygroA_av2001",1982:"vmc_sf_hygroA_av2001",2001:"vmc_sf_hygroA_2001",ap2012:"vmc_sf_hygroA_ap2012"} },
      { v:"vmc_sf_hygroB", l:"💧 VMC SF Hygro B",            d:"Bouches ET entrées d'air hygro — meilleure adaptation au taux d'humidité (NF 068)",                       periodeMap:{av_1982:"vmc_sf_hygroB_av2001",1982:"vmc_sf_hygroB_av2001",2001:"vmc_sf_hygroB_2001",ap2012:"vmc_sf_hygroB_ap2012"} },
      { v:"vmc_sf_gaz",    l:"🔵 VMC SF Gaz",                d:"Extracteur gaz dans la cuisine — extraction couplée à l'évacuation des produits de combustion",           periodeMap:{av_1982:"vmc_sf_gaz_av2001",1982:"vmc_sf_gaz_av2001",2001:"vmc_sf_gaz_2001",ap2012:"vmc_sf_gaz_ap2012"} },
      { v:"vmc_bp_auto",   l:"⚙️ VMC Basse pression Auto",  d:"Basse pression, moteur très silencieux, débit auto-réglable — souvent dans petits collectifs",             periodeMap:{av_1982:"vmc_bp_auto",1982:"vmc_bp_auto",2001:"vmc_bp_auto",ap2012:"vmc_bp_auto"} },
      { v:"vmc_bp_hygroA", l:"💧 VMC Basse pression Hygro A",d:"Basse pression + bouches hygro A",                                                                         periodeMap:{av_1982:"vmc_bp_hygroA",1982:"vmc_bp_hygroA",2001:"vmc_bp_hygroA",ap2012:"vmc_bp_hygroA"} },
      { v:"vmc_bp_hygroB", l:"💧 VMC Basse pression Hygro B",d:"Basse pression + bouches ET entrées hygro B",                                                              periodeMap:{av_1982:"vmc_bp_hygroB",1982:"vmc_bp_hygroB",2001:"vmc_bp_hygroB",ap2012:"vmc_bp_hygroB"} },
      { v:"vmc_conduit",   l:"🏗️ VMC sur conduit existant",  d:"Extracteur mécanique sur conduit naturel reconverti — adapté rénovation immeuble collectif",              periodeMap:{av_1982:"vmc_conduit_av2012",1982:"vmc_conduit_av2012",2001:"vmc_conduit_av2012",ap2012:"vmc_conduit_ap2012"} },
    ]
  },
  {
    key:"vmc_df", ico:"↔️", label:"VMC Double Flux",
    periodeLabel:"Date d'installation",
    periodes:[
      {v:"av2012",l:"≤ 2012"},
      {v:"ap2012",l:"Après 2012"},
    ],
    items:[
      { v:"vmc_df_indiv",  l:"↔️ VMC DF individuelle avec échangeur", d:"Échangeur thermique sur chaque logement — préchauffage de l'air entrant, gain important",      periodeMap:{av2012:"vmc_df_indiv_av2012",ap2012:"vmc_df_indiv_ap2012"} },
      { v:"vmc_df_coll",   l:"↔️ VMC DF collective avec échangeur",   d:"Échangeur commun à l'immeuble — économies mutualisées, adaptation résidentiel collectif",     periodeMap:{av2012:"vmc_df_coll_av2012",ap2012:"vmc_df_coll_ap2012"} },
      { v:"vmc_df_sans",   l:"↔️ VMC DF sans échangeur",              d:"Double flux sans récupération thermique — amélioration qualité d'air, peu d'économies énergie",periodeMap:{av2012:"vmc_df_sans_av2012",ap2012:"vmc_df_sans_ap2012"} },
      { v:"puits_sans",    l:"🌡️ Puits climatique sans échangeur",     d:"Air pré-tempéré par le sol (puits provençal) — sans récupérateur thermique supplémentaire",   periodeMap:{av2012:"puits_sans_av2012",ap2012:"puits_sans_ap2012"} },
      { v:"puits_avec",    l:"🌡️ Puits climatique avec échangeur",     d:"Puits canadien / provençal + échangeur air/air — préchauffage maximal de l'air entrant",      periodeMap:{av2012:"puits_avec_av2012",ap2012:"puits_avec_ap2012"} },
    ]
  },
  {
    key:"hybride", ico:"🔄", label:"Ventilation hybride",
    periodeLabel:"Date d'installation",
    periodes:[
      {v:"av_2001",l:"Avant 2001"},
      {v:"2001",   l:"2001 – 2012"},
      {v:"ap2012", l:"Après 2012"},
    ],
    items:[
      { v:"hybride_auto",  l:"🔄 Hybride auto-réglable",     d:"Naturelle + extracteur basse pression déclenché automatiquement — bonne adaptation été/hiver",    periodeMap:{av_2001:"hybride_av2001",2001:"hybride_2001",ap2012:"hybride_ap2012"} },
      { v:"hybride_hygro", l:"🔄 Hybride avec entrées hygro", d:"Hybride + entrées d'air hygroréglables — version améliorée, réduction déperditions hivernales",   periodeMap:{av_2001:"hybride_hygro_av2001",2001:"hybride_hygro_2001",ap2012:"hybride_hygro_ap2012"} },
    ]
  },
];
// Aplatir pour recherche par clé
const VENTS_FLAT = VENT_GROUPES.flatMap(g=>g.items);
// Obtenir la clé QVAR_TABLE à partir du type et période sélectionnée
function ventQvarKey(type, periode) {
  const item = VENTS_FLAT.find(i=>i.v===type);
  if (!item) return type; // déjà une clé directe
  if (!item.periodeMap) return type;
  return item.periodeMap[periode] || Object.values(item.periodeMap)[0];
}

function computeDPE(data) {
  const { identification: id, pieces, murs, planchers, toiture, menuiseries, ventilation, chauffage, ecs } = data;
  const sRef = pieces.reduce((s, p) => s + (parseFloat(p.surface) || 0), 0);
  if (sRef < 5) return null;

  let Henv = 0;

  // Murs avec coefficient b_tr par local adjacent
  murs.forEach(m => {
    const s = (parseFloat(m.longueur) || 0) * (parseFloat(m.hauteur) || 2.5);
    const u = (U_MUR[m.materiau] || U_MUR.parpaing)[m.isolation || "non"] || 1.5;
    // b_tr selon local adjacent
    const la = LOCAL_ADJACENT.find(l => l.v === (m.local_adjacent || "exterieur"));
    let btr = la?.btr ?? 1.0;
    // Cas local non chauffé avec Aiu/Aue connus
    if (m.local_adjacent === "local_nc_calc" && m.aiu && m.aue) {
      const Aiu = parseFloat(m.aiu) || 1;
      const Aue = parseFloat(m.aue) || 1;
      btr = Aue / (Aiu + Aue); // simplification 3CL
    }
    Henv += u * s * btr;
  });

  const zone3clH = id.zone || "H1";
  planchers.forEach(p => {
    const s = parseFloat(p.surface) || sRef;
    const upb = computeUpb(p, zone3clH);
    const sit = p.situation || "vide_sanitaire";
    const u = (sit==="vide_sanitaire"||sit==="sous_sol"||sit==="terre_plein") ? computeUe(upb,sit) : upb;
    Henv += u * s;
  });
  toiture.forEach(t => {
    const s = parseFloat(t.surface) || sRef;
    Henv += computeUph(t, zone3clH) * s;
  });

  let sVit = 0;
  menuiseries.forEach(m => {
    const s = (parseFloat(m.largeur) || 1.2) * (parseFloat(m.hauteur) || 1.2) * (parseInt(m.nb) || 1);
    // Pour les portes, appliquer b_tr du local adjacent
    const isPorte = m.type_ouv==="porte_opa" || m.type_ouv==="porte_vit";
    const la = isPorte ? (LOCAL_ADJACENT.find(l=>l.v===(m.local_adjacent||"exterieur"))) : null;
    let btr_m = 1.0;
    if (isPorte && la) {
      btr_m = la.btr ?? 1.0;
      if (m.local_adjacent==="local_nc_calc" && m.aiu && m.aue) {
        btr_m = parseFloat(m.aue)/(parseFloat(m.aiu)+parseFloat(m.aue));
      }
    }
    const uw = computeUw(m);
    if (!isPorte) sVit += s; // seules les vitrages contribuent aux apports solaires
    Henv += uw * s * btr_m;
  });

  // Ponts thermiques : calcul réel si murs renseignés, sinon forfait +10%
  const niveaux = data.niveaux ? parseInt(data.niveaux) : 1;
  let HenvPT;
  if (murs.length > 0) {
    const { totalPT } = autoPontsThermiques(murs, menuiseries, planchers, toiture, niveaux);
    HenvPT = Henv + totalPT;
  } else {
    HenvPT = Henv * 1.10;
  }

  const ventTypeKey = ventQvarKey(ventilation.type || "fenetres", ventilation.periode || "");
  const qva = getQvar(ventTypeKey);
  const Hvent = 0.34 * qva * sRef;
  const Htot = HenvPT + Hvent;

  const dju = DJU[id.zone] || 2500;
  const altF = (parseFloat(id.altitude) || 0) > 800 ? 1.30 : (parseFloat(id.altitude) || 0) > 400 ? 1.12 : 1.0;
  const Asol = sVit * 50 * 0.55 * 0.7;
  // Facteur d'intermittence I0 §8 arrêté — maison individuelle, inertie légère/moyenne
  // Radiateur/convecteur, chauffage divisé, 5 niveaux régulation
  const I0_MAP = {
    aucune:        0.84, // Absent
    central_min:   0.83, // Central sans minimum de température
    thermostat:    0.81, // Central avec minimum de température
    zonale:        0.77, // Pièce par pièce avec minimum de température
    detection:     0.75, // Par pièce avec min de température + détection de présence
    smart:         0.77, // = zonale (fil pilote/thermostat connecté → pièce par pièce)
    horloge:       0.83, // = central sans min
  };
  const reg = chauffage.regulation || "aucune";
  const INT = I0_MAP[reg] ?? 0.84;
  const Bch = Math.max(Htot * dju * 24 / 1000 * altF * INT - (Asol + sRef * 8) * 0.75, 0);

  // NSP fallback : fioul standard (hypothèse défavorable)
  const chType = chauffage.nsp ? "fioul_std" : (chauffage.type || "fioul_std");
  const ch = CHAUFFAGES[chType] || CHAUFFAGES.elec_joul;
  const conCh = Bch / ch.eff;

  const nbOcc = Math.max(1, Math.round(sRef / 25));
  const Becs = nbOcc * 365 * 0.056 * 4.186 * 40 / 3.6;
  // NSP ECS fallback : ballon électrique standard
  const ecsType = ecs.nsp ? "elec_bal" : (ecs.type || "elec_bal");
  let ecsSys = ECS_SYS[ecsType] || ECS_SYS.elec_bal;
  const ecEff = ecsType === "chaud_mix" ? ch.eff : (ecsSys.eff || 0.85);
  const ecEp  = ecsType === "chaud_mix" ? ch.ep  : (ecsSys.ep  || "elec");
  const conEcs = Becs / ecEff;

  const conAux = sRef * 2.5;

  const epCh  = conCh  * (FEP[ch.ep]  || 1);
  const epEcs = conEcs * (FEP[ecEp]   || 1);
  const epAux = conAux * FEP.elec;
  const cep   = (epCh + epEcs + epAux) / sRef;

  const co2Ch  = conCh  * (FCO2[ch.ep]  || 0.2);
  const co2Ecs = conEcs * (FCO2[ecEp]   || 0.2);
  const co2Aux = conAux * FCO2.elec;
  const eges   = (co2Ch + co2Ecs + co2Aux) / sRef;

  const LETTR = ["A","B","C","o","E","F","G"];
  const cepC = (v) => v<70?"A":v<110?"B":v<180?"C":v<250?"o":v<330?"E":v<420?"F":"G";
  const gesC = (v) => v<6?"A":v<11?"B":v<30?"C":v<50?"o":v<70?"E":v<100?"F":"G";
  const cc = cepC(cep), cg = gesC(eges);
  const classe = LETTR[Math.max(LETTR.indexOf(cc), LETTR.indexOf(cg))];

  const cout = conCh * (PRIX[ch.ep]||0.15) + conEcs*(PRIX[ecEp]||0.15) + conAux*PRIX.elec;

  // Déperditions détaillées avec b_tr et ponts thermiques réels
  const dMursBruts = murs.reduce((s,m)=>{
    const surf = (parseFloat(m.longueur)||0)*(parseFloat(m.hauteur)||2.5);
    const u = (U_MUR[m.materiau]||U_MUR.parpaing)[m.isolation||"non"]||1.5;
    const la = LOCAL_ADJACENT.find(l=>l.v===(m.local_adjacent||"exterieur"));
    const btr = la?.btr ?? 1.0;
    return s + u * surf * btr;
  }, 0);
  const { totalPT: dPT } = autoPontsThermiques(murs, menuiseries, planchers, toiture, niveaux);
  const dMurs = murs.length > 0 ? dMursBruts + dPT : dMursBruts * 1.1;
  const dPb = planchers.reduce((s,p)=>{
    const upb = computeUpb(p, zone3clH);
    const sit = p.situation || "vide_sanitaire";
    const u = (sit==="vide_sanitaire"||sit==="sous_sol"||sit==="terre_plein") ? computeUe(upb, sit) : upb;
    return s + u * (parseFloat(p.surface)||sRef);
  },0);
  const dToit = toiture.reduce((s,t)=>s+computeUph(t,zone3clH)*(parseFloat(t.surface)||sRef),0);
  const dVit  = menuiseries.reduce((s,m)=>s+computeUw(m)*(parseFloat(m.largeur)||1.2)*(parseFloat(m.hauteur)||1.2)*(parseInt(m.nb)||1), 0);
  const dVent = Hvent * dju * 24 / 1000 * altF;
  const dTot  = dMurs+dPb+dToit+dVit+dVent||1;

  return {
    sRef, classe, cep:Math.round(cep), eges:Math.round(eges*10)/10,
    coutMin:Math.round(cout*0.85), coutMax:Math.round(cout*1.15),
    nbOcc, conCh:Math.round(conCh), conEcs:Math.round(conEcs), conAux:Math.round(conAux),
    cc, cg,
    ptDetail: autoPontsThermiques(murs, menuiseries, planchers, toiture, niveaux),
    depertitons: {
      murs:  Math.round(dMurs/dTot*100),
      pb:    Math.round(dPb/dTot*100),
      toit:  Math.round(dToit/dTot*100),
      vit:   Math.round(dVit/dTot*100),
      vent:  Math.round(dVent/dTot*100),
    }
  };
}

// ═══════════════════════════════════════════════════════
//  DESIGN SYSTEM
// ═══════════════════════════════════════════════════════

const STEPS = [
  { id:1, icon:"🏡", label:"Bien" },
  { id:2, icon:"📐", label:"Pièces" },
  { id:3, icon:"🧱", label:"Murs" },
  { id:4, icon:"⬛", label:"Plancher" },
  { id:5, icon:"🏗️", label:"Toiture" },
  { id:6, icon:"🪟", label:"Vitrages" },
  { id:7, icon:"💨", label:"Ventil." },
  { id:8, icon:"🔥", label:"Chauffage" },
  { id:9, icon:"💧", label:"ECS" },
  { id:10,icon:"🎯", label:"Résultat" },
];

const CLASS_COL = {
  A:{bg:"#00843D",txt:"#fff",bar:25},
  B:{bg:"#39A84E",txt:"#fff",bar:36},
  C:{bg:"#92C342",txt:"#fff",bar:49},
  D:{bg:"#F5D020",txt:"#222",bar:62},
  E:{bg:"#F0A030",txt:"#fff",bar:74},
  F:{bg:"#E0551E",txt:"#fff",bar:87},
  G:{bg:"#C0001A",txt:"#fff",bar:100},
};

const INIT = {
  identification:{ type:"", periode:"", zone:"", altitude:"100", materiau_ancien:false, adresse:"", lat:"", lng:"", rnb_id:"", rnb_status:"" },
  pieces:[{ id:1, nom:"Salon", surface:"", hauteur:"2.50" }],
  niveaux: "1",
  murs:[],
  planchers:[],
  toiture:[],
  menuiseries:[],
  ventilation:{ type:"", annee:"", periode:"" },
  chauffage:{ type:"", annee:"", regulation:"", distribution:"", isolation_reseau:"", nsp:false, type_installation:"" },
  ecs:{ type:"", isolation_ballon:"", nsp:false, type_installation:"" },
  photovoltaique:{ present:false, surface:"", orientation:"S" },
};

// ─── Shared primitives ───────────────────────────────

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      style={active ? { background:"#0f2d5e", color:"#fff", borderColor:"#0f2d5e" } : {}}
      className="px-4 py-2.5 rounded-2xl text-sm font-bold border-2 border-gray-200
        text-gray-600 hover:border-gray-400 transition-all duration-200 text-left">
      {children}
    </button>
  );
}

function BigCard({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      style={active ? { borderColor:"#0f2d5e", background:"#f0f4fb" } : {}}
      className="w-full p-5 rounded-3xl border-2 border-gray-200 text-left hover:border-gray-300
        transition-all duration-200 group">
      {children}
    </button>
  );
}

function Input({ value, onChange, placeholder, type="text", min, max, step, className="" }) {
  return (
    <input type={type} value={value} onChange={e=>onChange(e.target.value)}
      placeholder={placeholder} min={min} max={max} step={step}
      className={`w-full rounded-2xl border-2 border-gray-200 px-4 py-3 text-sm font-semibold
        text-gray-800 placeholder-gray-300 focus:border-blue-500 focus:outline-none
        focus:ring-4 focus:ring-blue-50 transition-all ${className}`} />
  );
}

function Select({ value, onChange, opts, placeholder }) {
  return (
    <select value={value} onChange={e=>onChange(e.target.value)}
      className="w-full rounded-2xl border-2 border-gray-200 px-4 py-3 text-sm font-semibold
        text-gray-800 bg-white focus:border-blue-500 focus:outline-none transition-all appearance-none">
      {placeholder && <option value="">{placeholder}</option>}
      {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

function InfoBox({ icon="💡", color="blue", children }) {
  const colors = {
    blue: "bg-blue-50 border-blue-200 text-blue-800",
    amber: "bg-amber-50 border-amber-200 text-amber-800",
    green: "bg-emerald-50 border-emerald-200 text-emerald-800",
    red: "bg-red-50 border-red-200 text-red-800",
  };
  return (
    <div className={`flex gap-3 p-4 rounded-2xl border ${colors[color]} text-xs leading-relaxed`}>
      <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

function Label({ children, sub }) {
  return (
    <div className="mb-2">
      <p className="text-sm font-bold text-gray-800">{children}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-6">
      <p className="text-xs font-black uppercase tracking-widest text-gray-400 mb-3">{title}</p>
      {children}
    </div>
  );
}

function NavButtons({ onPrev, onNext, nextLabel="Suivant →", canNext=true }) {
  return (
    <div className="flex gap-3 mt-8 pt-6 border-t border-gray-100">
      {onPrev && (
        <button onClick={onPrev}
          className="px-6 py-3.5 rounded-2xl bg-gray-100 text-gray-600 font-bold text-sm
            hover:bg-gray-200 transition-all flex items-center gap-2">
          ← Retour
        </button>
      )}
      <button onClick={onNext} disabled={!canNext}
        style={canNext ? { background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)" } : {}}
        className={`flex-1 py-3.5 rounded-2xl font-black text-sm transition-all
          ${canNext ? "text-white shadow-lg shadow-blue-900/20 hover:opacity-90" : "bg-gray-100 text-gray-300 cursor-not-allowed"}`}>
        {nextLabel}
      </button>
    </div>
  );
}

// ─── SVG Illustrations ───────────────────────────────

function IlluRoom() {
  return (
    <svg viewBox="0 0 220 150" className="w-full h-full">
      <rect x="20" y="20" width="160" height="100" rx="4" fill="#EEF2F7" stroke="#94A3B8" strokeWidth="2"/>
      {[40,60,80,100,120,140,160].map(x=><line key={x} x1={x} y1="20" x2={x} y2="120" stroke="#CBD5E0" strokeWidth=".8"/>)}
      {[40,60,80,100].map(y=><line key={y} x1="20" y1={y} x2="180" y2={y} stroke="#CBD5E0" strokeWidth=".8"/>)}
      {/* door */}
      <rect x="145" y="80" width="30" height="40" fill="none" stroke="#64748B" strokeWidth="1.5"/>
      <path d="M145,80 Q145,100 160,100" fill="none" stroke="#64748B" strokeWidth="1" strokeDasharray="3,2"/>
      {/* window */}
      <rect x="30" y="28" width="40" height="28" fill="#BFDBFE" stroke="#64748B" strokeWidth="1.5"/>
      <line x1="50" y1="28" x2="50" y2="56" stroke="#64748B" strokeWidth="1"/>
      {/* arrows */}
      <defs>
        <marker id="r1" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6Z" fill="#E0602A"/>
        </marker>
        <marker id="r2" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6Z" fill="#1E8A6E"/>
        </marker>
      </defs>
      <line x1="20" y1="136" x2="180" y2="136" stroke="#E0602A" strokeWidth="1.8" markerEnd="url(#r1)"/>
      <text x="100" y="148" textAnchor="middle" fill="#E0602A" fontSize="10" fontWeight="bold">Longueur L</text>
      <line x1="8" y1="120" x2="8" y2="20" stroke="#1E8A6E" strokeWidth="1.8" markerEnd="url(#r2)"/>
      <text x="4" y="72" textAnchor="middle" fill="#1E8A6E" fontSize="10" fontWeight="bold" transform="rotate(-90,4,72)">Largeur l</text>
      <text x="100" y="75" textAnchor="middle" fill="#1B3560" fontSize="13" fontWeight="bold">S = L × l</text>
      <text x="100" y="90" textAnchor="middle" fill="#64748B" fontSize="9">Mesurer à l'intérieur, de mur à mur</text>
    </svg>
  );
}

function IlluWall({ mat, iso }) {
  const matColors = { pierre:"#A0AEC0", brique_pleine:"#E07050", brique_creuse:"#D4927A",
    beton_plein:"#9DADC4", parpaing:"#8AA2B5", ossature_bois:"#B5854A", ancien:"#9B8060" };
  const bg = matColors[mat] || "#A0AEC0";
  const hasIso = iso && iso !== "non";
  return (
    <svg viewBox="0 0 180 130" className="w-full h-full">
      {/* structure */}
      <rect x={hasIso ? 80 : 50} y="15" width={hasIso ? 60 : 80} height="100" fill={bg} stroke="#475569" strokeWidth="1.5"/>
      {/* brick pattern */}
      {[25,45,65,85,105].map((y,i)=>
        <rect key={y} x={hasIso?82:52} y={y} width={hasIso?14:18} height="8" rx="1" fill="rgba(0,0,0,.15)" style={{transform:`translateX(${i%2===0?0:hasIso?15:20}px)`}}/>
      )}
      {/* insulation */}
      {hasIso && <>
        <rect x="38" y="15" width="40" height="100" fill="#FEF3C7" stroke="#D69E2E" strokeWidth="1" strokeDasharray="3,2"/>
        {[25,38,51,64,77,90,103].map(y=>(
          <line key={y} x1="38" y1={y} x2="78" y2={y} stroke="#F59E0B" strokeWidth=".8"/>
        ))}
        <text x="58" y="70" textAnchor="middle" fill="#92400E" fontSize="7" fontWeight="bold" transform="rotate(-90,58,70)">ISOLANT</text>
      </>}
      {/* labels */}
      <line x1="38" y1="8" x2="140" y2="8" stroke="#0f2d5e" strokeWidth="1.2"/>
      <text x="90" y="6" textAnchor="middle" fill="#0f2d5e" fontSize="9" fontWeight="bold">Épaisseur totale</text>
      <line x1="152" y1="15" x2="152" y2="115" stroke="#1E8A6E" strokeWidth="1.2"/>
      <text x="167" y="68" textAnchor="middle" fill="#1E8A6E" fontSize="9" fontWeight="bold" transform="rotate(90,167,68)">Hauteur</text>
    </svg>
  );
}

function IlluWindow({ vitrage }) {
  const frameW = vitrage === "triple" ? 4 : vitrage === "simple" ? 1.5 : 2.5;
  return (
    <svg viewBox="0 0 160 150" className="w-full h-full">
      <rect x="20" y="15" width="120" height="100" rx="3" fill={vitrage==="simple"?"#F0F9FF":"#DBEAFE"} stroke="#1B3560" strokeWidth={frameW}/>
      <line x1="80" y1="15" x2="80" y2="115" stroke="#1B3560" strokeWidth={frameW}/>
      <line x1="20" y1="65" x2="140" y2="65" stroke="#1B3560" strokeWidth={frameW}/>
      {vitrage==="triple" && <>
        <rect x="25" y="20" width="50" height="40" rx="1" fill="rgba(147,197,253,.3)"/>
        <rect x="85" y="20" width="50" height="40" rx="1" fill="rgba(147,197,253,.3)"/>
      </>}
      <line x1="30" y1="25" x2="42" y2="37" stroke="white" strokeWidth="2" opacity=".8"/>
      <line x1="88" y1="25" x2="100" y2="37" stroke="white" strokeWidth="2" opacity=".8"/>
      <line x1="20" y1="128" x2="140" y2="128" stroke="#E0602A" strokeWidth="1.5"/>
      <text x="80" y="142" textAnchor="middle" fill="#E0602A" fontSize="10" fontWeight="bold">Largeur (m)</text>
      <line x1="7" y1="15" x2="7" y2="115" stroke="#1E8A6E" strokeWidth="1.5"/>
      <text x="3" y="66" textAnchor="middle" fill="#1E8A6E" fontSize="10" fontWeight="bold" transform="rotate(-90,3,66)">Hauteur</text>
      <text x="80" y="10" textAnchor="middle" fill="#1B3560" fontSize="8" fontWeight="bold">
        {vitrage==="simple"?"Simple vitrage — 1 reflet":vitrage==="triple"?"Triple vitrage — 3 reflets":"Double vitrage — 2 reflets"}
      </text>
    </svg>
  );
}

function IlluCompass({ orientation="S" }) {
  const dirs = { N:0, NE:45, E:90, SE:135, S:180, SO:225, O:270, NO:315 };
  const ang = (dirs[orientation]||180) * Math.PI / 180;
  const cx=35, cy=35, r=26;
  return (
    <svg viewBox="0 0 70 70" className="w-12 h-12 flex-shrink-0">
      <circle cx={cx} cy={cy} r={r} fill="#F1F5F9" stroke="#CBD5E0" strokeWidth="1.5"/>
      {["N","E","S","O"].map((d,i)=>{
        const a=i*Math.PI/2;
        return <text key={d} x={cx+r*.7*Math.sin(a)} y={cy-r*.7*Math.cos(a)+3}
          textAnchor="middle" fill={d==="S"?"#DC2626":"#475569"} fontSize="9" fontWeight="bold">{d}</text>
      })}
      <line x1={cx} y1={cy} x2={cx+r*.85*Math.sin(ang)} y2={cy-r*.85*Math.cos(ang)}
        stroke="#E0602A" strokeWidth="2.5" strokeLinecap="round"/>
      <circle cx={cx} cy={cy} r="2.5" fill="#1B3560"/>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════
//  STEP COMPONENTS
// ═══════════════════════════════════════════════════════

// ─── Step 1 : Identification ─────────────────────────

// ─── Mapping département → zone climatique 3CL-DPE 2021 (ADEME officiel) ────────
const DEPT_ZONE = {
  "01":"H1c","02":"H1a","03":"H1c","04":"H2d","05":"H2d","06":"H3",
  "07":"H1c","08":"H1a","09":"H2c","10":"H1a","11":"H2c","12":"H2c",
  "13":"H3", "14":"H2a","15":"H1c","16":"H2b","17":"H2b","18":"H2b",
  "19":"H2c","20":"H3", "21":"H1c","22":"H2a","23":"H2c","24":"H2c",
  "25":"H1b","26":"H1c","27":"H2a","28":"H2b","29":"H2a","30":"H3",
  "31":"H2c","32":"H2c","33":"H2c","34":"H3", "35":"H2a","36":"H2b",
  "37":"H2b","38":"H1c","39":"H1c","40":"H2c","41":"H2b","42":"H1c",
  "43":"H1c","44":"H2a","45":"H2b","46":"H2c","47":"H2c","48":"H1c",
  "49":"H2b","50":"H2a","51":"H1a","52":"H1b","53":"H2a","54":"H1b",
  "55":"H1b","56":"H2a","57":"H1b","58":"H1c","59":"H1a","60":"H1a",
  "61":"H2a","62":"H1a","63":"H1c","64":"H2c","65":"H2c","66":"H3",
  "67":"H1b","68":"H1b","69":"H1c","70":"H1b","71":"H1c","72":"H2a",
  "73":"H2d","74":"H2d","75":"H1a","76":"H2a","77":"H1a","78":"H1a",
  "79":"H2b","80":"H1a","81":"H2c","82":"H2c","83":"H3", "84":"H3",
  "85":"H2b","86":"H2b","87":"H2c","88":"H1b","89":"H1c","90":"H1b",
  "91":"H1a","92":"H1a","93":"H1a","94":"H1a","95":"H1a",
  "2A":"H3", "2B":"H3",
};
function inferZoneFromDept(citycode="") {
  let dept;
  const cc = String(citycode).toUpperCase();
  if (cc.startsWith("2A") || cc.startsWith("2B")) dept = cc.slice(0,2);
  else if (cc.startsWith("97"))                    dept = cc.slice(0,3);
  else                                             dept = cc.slice(0,2).padStart(2,"0");
  return DEPT_ZONE[dept] || "";
}

// ─── Sélecteur RNB — OSM tile map + SVG overlay (no external deps) ─────────────
// Inspiré de: https://codepen.io/ReferentielNationalDesBatiments/pen/ogNoOdb
// Tile math: WebMercator (EPSG:3857) → OSM z/x/y

function lngToTileX(lng, zoom) {
  return Math.floor(Math.pow(2, zoom) * (lng + 180) / 360);
}
function latToTileY(lat, zoom) {
  const r = lat * Math.PI / 180;
  return Math.floor(Math.pow(2, zoom) * (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2);
}
function lngToFracX(lng, zoom) { return Math.pow(2, zoom) * (lng + 180) / 360; }
function latToFracY(lat, zoom) {
  const r = lat * Math.PI / 180;
  return Math.pow(2, zoom) * (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}
function latLngToPixel(lat, lng, zoom, fracX0, fracY0, tileSize) {
  return {
    px: (lngToFracX(lng, zoom) - fracX0) * tileSize,
    py: (latToFracY(lat, zoom) - fracY0) * tileSize,
  };
}

// Projeter une géométrie GeoJSON → points SVG (coordonnées [lng, lat])
function geomToSVGPoints(geom, zoom, fracX0, fracY0, TILE) {
  if (!geom) return null;
  const project = ([lng, lat]) => {
    const { px, py } = latLngToPixel(lat, lng, zoom, fracX0, fracY0, TILE);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  };
  if (geom.type === 'Point') {
    const { px, py } = latLngToPixel(geom.coordinates[1], geom.coordinates[0], zoom, fracX0, fracY0, TILE);
    return { type: 'circle', cx: px, cy: py };
  }
  if (geom.type === 'Polygon') {
    return { type: 'polygon', points: geom.coordinates[0].map(project).join(' ') };
  }
  if (geom.type === 'MultiPolygon') {
    return { type: 'multipolygon', parts: geom.coordinates.map(poly => poly[0].map(project).join(' ')) };
  }
  return null;
}

function RNBMapSelector({ lat, lng, currentRnbId, onSelect, onClose }) {
  const TILE  = 256;
  const ZOOM  = 18;
  const COLS  = 5;   // grille 5×5 tiles
  const ROWS  = 5;
  const W     = COLS * TILE;   // 1280px
  const H     = ROWS * TILE;   // 1280px

  const [buildings, setBuildings] = useState([]);
  const [selected,  setSelected]  = useState(currentRnbId || null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [hovered,   setHovered]   = useState(null);

  // Tuile centrale
  const cX = lngToTileX(parseFloat(lng), ZOOM);
  const cY = latToTileY(parseFloat(lat), ZOOM);
  // Coin supérieur gauche du canvas (en fraction de tuile)
  const fracX0 = cX - Math.floor(COLS / 2);
  const fracY0 = cY - Math.floor(ROWS / 2);

  // Position de l'adresse en pixels
  const addrPx = latLngToPixel(parseFloat(lat), parseFloat(lng), ZOOM, fracX0, fracY0, TILE);

  // Fetch bâtiments RNB (bbox ±250m)
  useEffect(() => {
    setLoading(true); setError(null);
    const d = 0.0022;
    const swLat = (parseFloat(lat) - d).toFixed(6);
    const swLng = (parseFloat(lng) - d).toFixed(6);
    const neLat = (parseFloat(lat) + d).toFixed(6);
    const neLng = (parseFloat(lng) + d).toFixed(6);
    fetch(`https://rnb-api.beta.gouv.fr/api/alpha/buildings/?bb=${swLat},${swLng},${neLat},${neLng}&limit=50&status=constructed`)
      .then(r => { if (!r.ok) throw new Error(`RNB HTTP ${r.status}`); return r.json(); })
      .then(json => { setBuildings(json.results || []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [lat, lng]);

  const selBuilding = buildings.find(b => b.rnb_id === selected);

  return (
    <div style={{position:'fixed',inset:0,zIndex:9999,background:'rgba(10,20,50,0.75)',display:'flex',
      flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'12px'}}>
      <div style={{background:'white',borderRadius:'22px',width:'100%',maxWidth:'620px',
        maxHeight:'92vh',display:'flex',flexDirection:'column',overflow:'hidden',
        boxShadow:'0 24px 64px rgba(0,0,0,.45)'}}>

        {/* Header */}
        <div style={{padding:'13px 18px',borderBottom:'2px solid #e8f0fe',display:'flex',
          alignItems:'center',gap:'10px',flexShrink:0,background:'#f8faff'}}>
          <span style={{fontSize:'22px'}}>🏢</span>
          <div style={{flex:1}}>
            <p style={{margin:0,fontWeight:900,fontSize:'14px',color:'#1e2d5e'}}>Sélecteur de bâtiment — RNB</p>
            <p style={{margin:0,fontSize:'11px',color:'#888',fontWeight:600}}>
              Cliquez sur votre bâtiment pour obtenir son ID-RNB · rnb.beta.gouv.fr
            </p>
          </div>
          <button onClick={onClose} style={{width:'30px',height:'30px',borderRadius:'50%',
            border:'2px solid #dde4f5',background:'white',cursor:'pointer',fontSize:'15px',
            display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>✕</button>
        </div>

        {/* Légende */}
        <div style={{padding:'7px 14px',background:'#f0f4ff',borderBottom:'1px solid #dde8ff',
          display:'flex',gap:'16px',flexShrink:0,flexWrap:'wrap',alignItems:'center'}}>
          {[
            {bg:'#3b82f6',bd:'#1d4ed8',label:'Bâtiment RNB'},
            {bg:'#f97316',bd:'#c2410c',label:'Sélectionné'},
          ].map(s=>(
            <div key={s.label} style={{display:'flex',alignItems:'center',gap:'5px'}}>
              <div style={{width:'13px',height:'9px',background:s.bg,border:`2px solid ${s.bd}`,borderRadius:'2px'}}/>
              <span style={{fontSize:'11px',color:'#444',fontWeight:700}}>{s.label}</span>
            </div>
          ))}
          <div style={{display:'flex',alignItems:'center',gap:'5px'}}>
            <div style={{width:'10px',height:'10px',background:'#ef4444',borderRadius:'50%',
              border:'2px solid white',boxShadow:'0 1px 3px rgba(0,0,0,.3)'}}/>
            <span style={{fontSize:'11px',color:'#444',fontWeight:700}}>Adresse</span>
          </div>
          {buildings.length > 0 && (
            <span style={{marginLeft:'auto',fontSize:'11px',color:'#1d4ed8',fontWeight:800}}>
              {buildings.length} bâtiment{buildings.length>1?'s':''} chargé{buildings.length>1?'s':''}
            </span>
          )}
        </div>

        {/* Carte OSM tile + SVG overlay */}
        <div style={{flex:1,position:'relative',overflow:'hidden',minHeight:'300px',maxHeight:'380px',
          background:'#e8e8e8',cursor:'crosshair'}}>

          {/* Loading overlay */}
          {loading && (
            <div style={{position:'absolute',inset:0,zIndex:10,display:'flex',flexDirection:'column',
              alignItems:'center',justifyContent:'center',background:'rgba(255,255,255,.88)',gap:'8px'}}>
              <div style={{fontSize:'28px',animation:'spin 1s linear infinite'}}>⏳</div>
              <p style={{margin:0,fontWeight:800,fontSize:'13px',color:'#1d4ed8'}}>
                Chargement des bâtiments RNB…
              </p>
              <p style={{margin:0,fontSize:'11px',color:'#666',fontWeight:600}}>
                API RNB — rnb-api.beta.gouv.fr
              </p>
            </div>
          )}

          {/* Error overlay */}
          {error && !loading && (
            <div style={{position:'absolute',inset:0,zIndex:10,display:'flex',flexDirection:'column',
              alignItems:'center',justifyContent:'center',background:'rgba(255,255,255,.92)',gap:'6px',padding:'16px'}}>
              <span style={{fontSize:'26px'}}>⚠️</span>
              <p style={{margin:0,fontWeight:800,fontSize:'13px',color:'#b91c1c',textAlign:'center'}}>
                Erreur : {error}
              </p>
              <p style={{margin:0,fontSize:'11px',color:'#666',textAlign:'center'}}>
                Saisissez l'ID-RNB manuellement ci-dessous.
              </p>
            </div>
          )}

          {/* Conteneur scrollable de la carte */}
          <div style={{width:'100%',height:'100%',overflowX:'auto',overflowY:'auto',position:'relative'}}>
            <div style={{position:'relative',width:`${W}px`,height:`${H}px`}}>

              {/* Tiles OSM */}
              {Array.from({length:COLS},(_, cx)=>
                Array.from({length:ROWS},(_,cy)=>{
                  const tx = fracX0 + cx;
                  const ty = fracY0 + cy;
                  const maxT = Math.pow(2, ZOOM);
                  if (tx < 0 || ty < 0 || tx >= maxT || ty >= maxT) return null;
                  return (
                    <img key={`${cx}-${cy}`}
                      src={`https://tile.openstreetmap.org/${ZOOM}/${tx}/${ty}.png`}
                      alt=""
                      crossOrigin="anonymous"
                      style={{position:'absolute',left:`${cx*TILE}px`,top:`${cy*TILE}px`,
                        width:`${TILE}px`,height:`${TILE}px`,display:'block',userSelect:'none'}}
                    />
                  );
                })
              )}

              {/* SVG overlay — bâtiments RNB */}
              <svg style={{position:'absolute',left:0,top:0,width:`${W}px`,height:`${H}px`,
                overflow:'visible',pointerEvents:'none'}}>
                <defs>
                  <filter id="shadow">
                    <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.3"/>
                  </filter>
                </defs>

                {buildings.map(b => {
                  const geom = b.shape || b.point;
                  if (!geom) return null;
                  const proj = geomToSVGPoints(geom, ZOOM, fracX0, fracY0, TILE);
                  if (!proj) return null;
                  const isSelected = b.rnb_id === selected;
                  const isHovered  = b.rnb_id === hovered;
                  const fill   = isSelected ? '#f97316' : isHovered ? '#60a5fa' : '#3b82f6';
                  const stroke = isSelected ? '#c2410c' : isHovered ? '#1d4ed8' : '#1d4ed8';
                  const opacity = isSelected ? 0.75 : isHovered ? 0.65 : 0.45;
                  const sw = isSelected || isHovered ? 2.5 : 1.5;

                  const handleClick = () => setSelected(isSelected ? null : b.rnb_id);
                  const handleEnter = () => setHovered(b.rnb_id);
                  const handleLeave = () => setHovered(null);

                  if (proj.type === 'circle') {
                    return (
                      <circle key={b.rnb_id}
                        cx={proj.cx} cy={proj.cy} r={isSelected?12:isHovered?10:8}
                        fill={fill} stroke={stroke} strokeWidth={sw} fillOpacity={opacity}
                        style={{cursor:'pointer',pointerEvents:'all',filter:'url(#shadow)'}}
                        onClick={handleClick} onMouseEnter={handleEnter} onMouseLeave={handleLeave}/>
                    );
                  }
                  if (proj.type === 'polygon') {
                    return (
                      <polygon key={b.rnb_id} points={proj.points}
                        fill={fill} stroke={stroke} strokeWidth={sw} fillOpacity={opacity}
                        style={{cursor:'pointer',pointerEvents:'all',filter:'url(#shadow)'}}
                        onClick={handleClick} onMouseEnter={handleEnter} onMouseLeave={handleLeave}/>
                    );
                  }
                  if (proj.type === 'multipolygon') {
                    return (
                      <g key={b.rnb_id} style={{cursor:'pointer',pointerEvents:'all'}}
                        onClick={handleClick} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
                        {proj.parts.map((pts, i) => (
                          <polygon key={i} points={pts}
                            fill={fill} stroke={stroke} strokeWidth={sw} fillOpacity={opacity}
                            style={{filter:'url(#shadow)'}}/>
                        ))}
                      </g>
                    );
                  }
                  return null;
                })}

                {/* Tooltip label au survol */}
                {hovered && (() => {
                  const b = buildings.find(b=>b.rnb_id===hovered);
                  if (!b) return null;
                  const geom = b.shape || b.point;
                  if (!geom) return null;
                  const proj = geomToSVGPoints(geom, ZOOM, fracX0, fracY0, TILE);
                  if (!proj) return null;
                  const cx = proj.type === 'circle' ? proj.cx : (() => {
                    const pts = proj.points || proj.parts?.[0] || '';
                    const coords = pts.split(' ').map(p=>p.split(',').map(Number));
                    if (!coords.length) return addrPx.px;
                    return coords.reduce((s,p)=>s+p[0],0)/coords.length;
                  })();
                  const cy = proj.type === 'circle' ? proj.cy - 18 : (() => {
                    const pts = proj.points || proj.parts?.[0] || '';
                    const coords = pts.split(' ').map(p=>p.split(',').map(Number));
                    if (!coords.length) return addrPx.py;
                    return coords.reduce((s,p)=>s+p[1],0)/coords.length - 18;
                  })();
                  return (
                    <g key="tooltip">
                      <rect x={cx-42} y={cy-12} width={84} height={18} rx={5}
                        fill="rgba(15,30,80,0.85)"/>
                      <text x={cx} y={cy+2} textAnchor="middle" fontSize="10"
                        fill="white" fontWeight="bold" fontFamily="monospace">
                        {hovered}
                      </text>
                    </g>
                  );
                })()}

                {/* Marqueur adresse */}
                <g>
                  <circle cx={addrPx.px} cy={addrPx.py} r={9}
                    fill="#ef4444" stroke="white" strokeWidth={2.5}
                    style={{filter:'url(#shadow)'}}/>
                  <circle cx={addrPx.px} cy={addrPx.py} r={3} fill="white"/>
                </g>
              </svg>

              {/* Empty state */}
              {!loading && !error && buildings.length === 0 && (
                <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
                  background:'rgba(255,255,255,.9)',borderRadius:'14px',padding:'16px 20px',
                  textAlign:'center',pointerEvents:'none'}}>
                  <p style={{margin:0,fontWeight:800,fontSize:'13px',color:'#555'}}>🔍 Aucun bâtiment trouvé à 250 m</p>
                  <p style={{margin:'4px 0 0',fontSize:'11px',color:'#888'}}>Saisir l'ID-RNB manuellement</p>
                </div>
              )}
            </div>
          </div>

          {/* Attribution */}
          <div style={{position:'absolute',bottom:'4px',right:'6px',
            background:'rgba(255,255,255,.75)',borderRadius:'4px',padding:'2px 5px',
            fontSize:'9px',color:'#555',pointerEvents:'none'}}>
            © OpenStreetMap · RNB beta.gouv.fr
          </div>
        </div>

        {/* Footer */}
        <div style={{padding:'12px 16px',borderTop:'2px solid #e8f0fe',flexShrink:0}}>
          {selBuilding ? (
            <div style={{background:'#fff8f0',border:'2px solid #f97316',borderRadius:'14px',
              padding:'10px 14px',marginBottom:'10px',display:'flex',alignItems:'center',gap:'10px'}}>
              <span style={{fontSize:'18px'}}>🟠</span>
              <div style={{flex:1}}>
                <p style={{margin:0,fontWeight:900,fontSize:'12px',color:'#7c3000'}}>Bâtiment sélectionné</p>
                <p style={{margin:0,fontWeight:900,fontSize:'17px',color:'#ea580c',fontFamily:'monospace'}}>
                  {selBuilding.rnb_id}
                </p>
                <p style={{margin:0,fontSize:'11px',color:'#9a3412',fontWeight:600}}>
                  Statut : {selBuilding.status || 'construit'} · Référentiel National des Bâtiments
                </p>
              </div>
              <button onClick={()=>setSelected(null)}
                style={{background:'white',border:'2px solid #fed7aa',borderRadius:'8px',
                  padding:'4px 8px',fontSize:'11px',fontWeight:800,color:'#ea580c',cursor:'pointer'}}>
                ✕ Désélect.
              </button>
            </div>
          ) : (
            <div style={{background:'#f0f4ff',borderRadius:'14px',padding:'10px 14px',marginBottom:'10px'}}>
              <p style={{margin:0,fontSize:'12px',color:'#666',fontWeight:600,textAlign:'center'}}>
                👆 Cliquez sur un bâtiment (polygone bleu) pour le sélectionner
              </p>
            </div>
          )}

          <div style={{display:'flex',gap:'8px'}}>
            <button onClick={onClose}
              style={{flex:1,padding:'10px',borderRadius:'12px',border:'2px solid #e0e7ff',
                background:'white',fontSize:'13px',fontWeight:800,color:'#555',cursor:'pointer'}}>
              Annuler
            </button>
            <button
              disabled={!selected}
              onClick={()=>{ if(selBuilding) onSelect(selBuilding); onClose(); }}
              style={{flex:2,padding:'10px',borderRadius:'12px',border:'none',
                background:selected?'#1d4ed8':'#c0cce0',color:'white',
                fontSize:'13px',fontWeight:900,cursor:selected?'pointer':'not-allowed'}}>
              {selected ? `✅ Confirmer  ${selected}` : 'Sélectionner un bâtiment'}
            </button>
          </div>
          <p style={{margin:'7px 0 0',fontSize:'10px',color:'#aaa',textAlign:'center'}}>
            Données : Référentiel National des Bâtiments (RNB) — Géocommun · rnb.beta.gouv.fr
          </p>
        </div>
      </div>
    </div>
  );
}


function Step1({ d, upd, onNext, onPrev }) {
  const { identification: id } = d;
  const set     = (k,v)  => upd("identification", { ...id, [k]:v });
  const setMany = (obj)  => upd("identification", { ...id, ...obj });
  const ok = id.type && id.periode && id.zone;

  const [addrInput,   setAddrInput]   = useState(id.adresse || "");
  const [suggestions, setSuggestions] = useState([]);
  const [addrLoading, setAddrLoading] = useState(false);
  // enrichStatus : null | "loading" | "ok" | "partial"
  const [enrichStatus, setEnrichStatus] = useState(id.adresse ? "ok" : null);
  const [enrichLog,    setEnrichLog]    = useState([]);
  const addrTimer = useRef(null);
  // RNB sélecteur carte
  const [showRNBMap, setShowRNBMap] = useState(false);

  // ── Autocomplete BAN debounced ──────────────────────────────────────────────
  const onAddrChange = (val) => {
    setAddrInput(val);
    set("adresse", val);
    setSuggestions([]);
    setEnrichStatus(null);
    setEnrichLog([]);
    clearTimeout(addrTimer.current);
    if (val.length < 5) return;
    setAddrLoading(true);
    addrTimer.current = setTimeout(async () => {
      try {
        const r    = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(val)}&limit=6&type=housenumber`);
        const json = await r.json();
        setSuggestions(json.features || []);
      } catch { setSuggestions([]); }
      setAddrLoading(false);
    }, 350);
  };

  // ── Pipeline d'enrichissement sur sélection ─────────────────────────────────
  const onSelectAddr = async (feat) => {
    const label    = feat.properties.label || "";
    const [lng, lat] = feat.geometry.coordinates;
    const citycode = feat.properties.citycode || "";
    const zone     = inferZoneFromDept(citycode);

    setAddrInput(label);
    setSuggestions([]);
    setEnrichStatus("loading");
    setEnrichLog([]);

    // Mise à jour synchrone immédiate
    const updates = { adresse: label, lat: String(lat), lng: String(lng) };
    if (zone) updates.zone = zone;

    const log = [];
    if (zone) log.push({ ico:"🗺️", src:"BAN / ADEME",
      txt: `Zone ${zone} — dept ${citycode.slice(0,2).toUpperCase()}` });

    // ── Requêtes parallèles : RNB (identification) + IGN (altitude) ────────────
    // NB : RNB /closest/ ne fournit PAS d'altitude (point 2D uniquement).
    //      L'altitude vient exclusivement de l'IGN RGE Alti 1m.
    const [rnbRes, ignRes] = await Promise.allSettled([

      // 1) RNB : param point=lat,lng  — réponse paginée → results[0]
      fetch(`https://rnb-api.beta.gouv.fr/api/alpha/buildings/closest/?point=${lat},${lng}`)
        .then(r => { if (!r.ok) throw new Error(`RNB HTTP ${r.status}`); return r.json(); })
        .then(json => {
          const b = json.results?.[0];
          if (!b) throw new Error("RNB aucun bâtiment");
          return { rnb_id: b.rnb_id, status: b.status };
        }),

      // 2) IGN RGE Alti 1m — seule source d'altitude, précision ≈1 m
      //    zonly=true → réponse : { elevations: [ valeur_numérique ] }
      fetch(`https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${lng}&lat=${lat}&zonly=true`)
        .then(r => { if (!r.ok) throw new Error(`IGN HTTP ${r.status}`); return r.json(); })
        .then(json => {
          // zonly=true retourne un tableau de scalaires ou d'objets {z}
          const raw = json.elevations?.[0];
          const z   = (typeof raw === "object") ? raw?.z : raw;
          if (z == null || z < -100) throw new Error("IGN z invalide");
          return Math.round(z);
        }),
    ]);

    // Altitude : IGN uniquement (RNB n'a pas ce champ)
    let altFinal = null;
    if (ignRes.status === "fulfilled") {
      altFinal = ignRes.value;
      log.push({ ico:"⛰️", src:"IGN RGE Alti 1m — data.geopf.fr", txt:`Altitude : ${altFinal} m` });
    } else {
      log.push({ ico:"⚠️", src:"", txt:`Altitude non récupérée (${ignRes.reason?.message || "IGN KO"}) — saisir manuellement` });
    }
    if (altFinal != null) updates.altitude = String(altFinal);

    // RNB : identification pré-remplie (sélecteur carte disponible ensuite)
    if (rnbRes.status === "fulfilled") {
      const r = rnbRes.value;
      updates.rnb_id     = r.rnb_id;
      updates.rnb_status = r.status || "constructed";
      log.push({ ico:"🏢", src:"RNB — rnb-api.beta.gouv.fr",
        txt:`Bâtiment RNB auto-détecté : ${r.rnb_id}${r.status ? ` · ${r.status}` : ""}` });
    } else {
      log.push({ ico:"ℹ️", src:"", txt:`RNB auto-détection : ${rnbRes.reason?.message || "non trouvé"} — utilisez le sélecteur carte` });
    }

    setMany(updates);
    setEnrichLog(log);
    setEnrichStatus(altFinal != null && zone ? "ok" : "partial");
  };

  const PERIODES = [
    { v:"av_1948",   l:"Avant 1948 — Pierre, bois, torchis" },
    { v:"1948_1974", l:"1948–1974 — Aucune isolation thermique" },
    { v:"1975_1977", l:"1975–1977 — 1ère RT (RT74)" },
    { v:"1978_1982", l:"1978–1982 — RT78" },
    { v:"1983_1988", l:"1983–1988 — RT82" },
    { v:"1989_2000", l:"1989–2000 — RT88" },
    { v:"2001_2005", l:"2001–2005 — RT2000" },
    { v:"2006_2012", l:"2006–2012 — RT2005" },
    { v:"ap_2013",   l:"Après 2013 — RT2012 / RE2020" },
  ];
  const ZONES = [
    { v:"H1a", l:"H1a — Paris, Île-de-France, Nord" },
    { v:"H1b", l:"H1b — Alsace, Lorraine, Bourgogne-Est" },
    { v:"H1c", l:"H1c — Centre, Auvergne, Rhône-Alpes plaine" },
    { v:"H2a", l:"H2a — Bretagne, Normandie" },
    { v:"H2b", l:"H2b — Pays de la Loire, Poitou-Charentes" },
    { v:"H2c", l:"H2c — Aquitaine, Languedoc, Occitanie" },
    { v:"H2d", l:"H2d — Alpes, Pyrénées hautes, Savoie" },
    { v:"H3",  l:"H3 — Méditerranée, Côte d'Azur, Corse" },
  ];

  const altVal = parseFloat(id.altitude) || 0;

  return (
    <div>
      {/* ── Adresse avec enrichissement automatique ── */}
      <Section title="Adresse du bien">
        <div className="relative">
          <div className="relative">
            <input type="text" value={addrInput} onChange={e=>onAddrChange(e.target.value)}
              placeholder="Ex : 12 rue de la Paix, 75001 Paris"
              className="w-full px-4 py-3 pr-9 rounded-2xl border-2 border-gray-200 bg-gray-50
                text-sm font-medium outline-none focus:border-blue-400 focus:bg-white transition-all"
            />
            {addrLoading && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm animate-spin">⏳</span>
            )}
          </div>

          {/* Suggestions dropdown BAN */}
          {suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-30 mt-1 bg-white rounded-2xl
              border-2 border-blue-100 shadow-xl overflow-hidden">
              {suggestions.map((f,i)=>(
                <button key={i} onClick={()=>onSelectAddr(f)}
                  className="w-full text-left px-4 py-3 hover:bg-blue-50 transition-colors
                    border-b border-gray-100 last:border-0 flex items-center gap-3">
                  <span className="flex-shrink-0">📍</span>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-gray-800 truncate">{f.properties.label}</p>
                    <p className="text-[11px] text-gray-400">{f.properties.context}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* État enrichissement */}
        {enrichStatus === "loading" && (
          <div className="mt-3 rounded-2xl border-2 border-blue-100 bg-blue-50 px-4 py-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="animate-spin text-sm">⏳</span>
              <p className="text-xs font-black text-blue-700">Enrichissement en cours…</p>
            </div>
            {["🗺️ Zone climatique 3CL — dept ADEME","⛰️ Altitude — IGN RGE Alti 1m","🏢 Bâtiment — RNB"].map((t,i)=>(
              <p key={i} className="text-[11px] text-blue-500 pl-6 animate-pulse">{t}</p>
            ))}
          </div>
        )}

        {(enrichStatus === "ok" || enrichStatus === "partial") && enrichLog.length > 0 && (
          <div className={`mt-3 rounded-2xl border-2 px-4 py-3 space-y-2
            ${enrichStatus==="ok" ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
            <p className={`text-xs font-black ${enrichStatus==="ok" ? "text-green-700" : "text-amber-700"}`}>
              {enrichStatus==="ok" ? "✅ Zone et altitude détectées" : "⚠️ Enrichissement partiel"}
            </p>
            {enrichLog.map((l,i)=>(
              <div key={i} className="flex items-start gap-2">
                <span className="text-sm flex-shrink-0 leading-none mt-0.5">{l.ico}</span>
                <div>
                  <p className={`text-xs font-bold leading-tight ${enrichStatus==="ok" ? "text-green-800" : "text-amber-800"}`}>
                    {l.txt}
                  </p>
                  {l.src && <p className="text-[10px] text-gray-400 font-mono">{l.src}</p>}
                </div>
              </div>
            ))}
            <p className="text-[10px] text-gray-400 pt-1 border-t border-gray-200">
              Valeurs pré-remplies ci-dessous — vérifiables et modifiables manuellement.
            </p>
          </div>
        )}

        {/* ── Sélecteur RNB carte — disponible dès qu'on a une adresse géocodée ── */}
        {id.lat && id.lng && (
          <div className="mt-3">
            <div className={`rounded-2xl border-2 p-3 flex items-center gap-3 ${
              id.rnb_id
                ? "border-orange-300 bg-orange-50"
                : "border-blue-200 bg-blue-50"
            }`}>
              <div className="flex-1 min-w-0">
                {id.rnb_id ? (
                  <>
                    <p className="text-xs font-black text-orange-700">🏢 Bâtiment RNB identifié</p>
                    <p className="text-sm font-black text-orange-900 font-mono">{id.rnb_id}</p>
                    <p className="text-[10px] text-orange-600 font-semibold">
                      {id.rnb_status || "construit"} · Référentiel National des Bâtiments
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-black text-blue-700">🏢 Identifier le bâtiment exact</p>
                    <p className="text-[10px] text-blue-600 font-semibold">
                      Sélectionnez votre bâtiment sur la carte pour obtenir son ID-RNB
                    </p>
                  </>
                )}
              </div>
              <button
                onClick={()=>setShowRNBMap(true)}
                className="flex-shrink-0 px-3 py-2 rounded-xl text-xs font-black transition-all"
                style={{
                  background: id.rnb_id ? '#FF8B00' : '#0052cc',
                  color: 'white',
                  border: 'none',
                  cursor: 'pointer'
                }}>
                {id.rnb_id ? '🗺️ Modifier' : '🗺️ Ouvrir la carte'}
              </button>
            </div>

            {/* Saisie manuelle ID-RNB */}
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={id.rnb_id || ""}
                onChange={e=>setMany({rnb_id: e.target.value.toUpperCase()})}
                placeholder="Ou saisir l'ID-RNB manuellement (ex: AB12-CD34)"
                className="flex-1 px-3 py-2 rounded-xl border-2 border-gray-200 text-xs font-mono
                  font-bold outline-none focus:border-blue-400 transition-all bg-gray-50"
              />
              {id.rnb_id && (
                <button onClick={()=>setMany({rnb_id:'', rnb_status:''})}
                  className="text-gray-400 hover:text-red-500 text-xs px-2 font-bold transition-colors">
                  ✕
                </button>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ── Modal sélecteur RNB ── */}
      {showRNBMap && id.lat && id.lng && (
        <RNBMapSelector
          lat={id.lat}
          lng={id.lng}
          currentRnbId={id.rnb_id}
          onSelect={(building) => {
            if (building) setMany({ rnb_id: building.rnb_id, rnb_status: building.status || 'constructed' });
          }}
          onClose={()=>setShowRNBMap(false)}
        />
      )}

      {/* ── Type de logement ── */}
      <Section title="Type de logement">
        <div className="grid grid-cols-2 gap-3">
          {[["maison","🏠 Maison individuelle"],["appartement","🏢 Appartement"]].map(([v,l])=>(
            <BigCard key={v} active={id.type===v} onClick={()=>set("type",v)}>
              <span className="text-2xl block mb-1.5">{l.split(" ")[0]}</span>
              <span className="text-sm font-bold text-gray-700">{l.split(" ").slice(1).join(" ")}</span>
            </BigCard>
          ))}
        </div>
      </Section>

      <Section title="Période de construction">
        <Select value={id.periode} onChange={v=>set("periode",v)}
          opts={PERIODES} placeholder="— Sélectionnez la période —"/>
        {(id.periode==="av_1948"||id.periode==="1948_1974") && (
          <div className="mt-2">
            <InfoBox icon="🏛️" color="amber">
              <strong>Bâtiment ancien :</strong> matériaux perméables à la vapeur (pierre, brique, pisé).
              Toute isolation doit préserver la respirabilité des parois.
            </InfoBox>
          </div>
        )}
      </Section>

      {/* Zone climatique — pré-remplie automatiquement */}
      <Section title={
        <span className="flex items-center gap-2">
          Zone climatique
          {enrichStatus === "ok" && id.zone && (
            <span className="text-[10px] font-black text-green-600 bg-green-100 px-2 py-0.5 rounded-xl normal-case tracking-normal">
              📡 auto
            </span>
          )}
        </span>
      }>
        <Select value={id.zone} onChange={v=>set("zone",v)}
          opts={ZONES} placeholder="— Sélectionnez votre région —"/>
        <p className="text-[11px] text-gray-400 mt-1.5">
          Déduite automatiquement du département (BAN + ADEME). Vérifiez pour les zones de montagne et frontières H1c/H2d.
        </p>
      </Section>

      {/* Altitude — remplie depuis IGN RGE Alti */}
      <Section title={
        <span className="flex items-center gap-2">
          Altitude (mètres)
          {enrichStatus === "ok" && id.altitude && (
            <span className="text-[10px] font-black text-blue-600 bg-blue-100 px-2 py-0.5 rounded-xl normal-case tracking-normal">
              📡 IGN RGE Alti
            </span>
          )}
          {enrichStatus === "partial" && id.altitude && (
            <span className="text-[10px] font-black text-amber-600 bg-amber-100 px-2 py-0.5 rounded-xl normal-case tracking-normal">
              📡 RNB
            </span>
          )}
        </span>
      }>
        <Input value={id.altitude} onChange={v=>set("altitude",v)} type="number"
          placeholder="Ex: 150" min="0" max="3000"/>
        {altVal > 800 && (
          <InfoBox icon="⛰️" color="blue">
            <strong>Altitude &gt; 800 m</strong> — Coefficient ×1,30 sur besoin de chauffage. Seuils DPE spécifiques H1b, H1c, H2d.
          </InfoBox>
        )}
        {altVal > 400 && altVal <= 800 && (
          <p className="text-[11px] text-amber-600 font-bold mt-1.5">
            ⚠️ Altitude 400–800 m — coefficient ×1,12 appliqué.
          </p>
        )}
        <p className="text-[11px] text-gray-400 mt-1.5">
          Source : IGN RGE Alti 1m (≈1 m précision) via data.geopf.fr. Modifiable manuellement.
        </p>
      </Section>

      <Section title="Matériaux d'origine ancienne ?">
        <div className="flex gap-3">
          {[[true,"✅ Oui — pierre, pisé, pan de bois..."],[false,"❌ Non — béton, brique moderne..."]].map(([v,l])=>(
            <button key={String(v)} onClick={()=>set("materiau_ancien",v)}
              style={id.materiau_ancien===v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
              className="flex-1 p-3.5 rounded-2xl border-2 border-gray-200 text-xs font-bold text-left hover:border-gray-300 transition-all">
              {l}
            </button>
          ))}
        </div>
      </Section>

      <NavButtons onPrev={null} onNext={onNext} nextLabel="Surfaces et pièces →" canNext={!!ok}/>
    </div>
  );
}

// ─── Step 2 : Pièces ─────────────────────────────────

function Step2({ d, upd, onNext, onPrev }) {
  const add = () => {
    const id = Date.now();
    upd("pieces", [...d.pieces, { id, nom:"", surface:"", hauteur:"2.50" }]);
  };
  const del = (id) => upd("pieces", d.pieces.filter(p=>p.id!==id));
  const set = (id,k,v) => upd("pieces", d.pieces.map(p=>p.id===id?{...p,[k]:v}:p));
  const sRef = d.pieces.reduce((s,p)=>s+(parseFloat(p.surface)||0),0);
  const ok = d.pieces.length>0 && d.pieces.every(p=>parseFloat(p.surface)>0);

  const RAPIDES = ["Salon","Chambre 1","Chambre 2","Cuisine","SdB","WC","Bureau","Couloir","Salle à manger"];

  return (
    <div>
      <div className="bg-gray-50 rounded-3xl overflow-hidden mb-6 aspect-video">
        <IlluRoom/>
      </div>

      <InfoBox icon="📏" color="blue">
        <strong>Comment mesurer ?</strong> Mesurez de finition à finition (sans inclure les murs).
        S = Longueur × Largeur. Hauteur sous plafond (HSP) = du sol au plafond.
        <br/><strong>Ne pas compter :</strong> garage, cave, combles &lt; 1,80 m HSP, balcons, terrasses, surfaces des murs.
      </InfoBox>

      <div className="flex items-center justify-between mt-5 mb-3 bg-blue-950 text-white rounded-2xl px-5 py-3.5">
        <span className="text-sm font-bold opacity-70">Surface de référence</span>
        <span className="text-2xl font-black">{sRef.toFixed(1)} m²</span>
      </div>

      <div className="space-y-3 mb-4">
        {d.pieces.map((p,i)=>(
          <div key={p.id} className="bg-gray-50 border-2 border-gray-100 rounded-3xl p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-black text-gray-400 uppercase tracking-widest">Pièce {i+1}</span>
              <button onClick={()=>del(p.id)} className="text-red-400 text-xs font-bold hover:text-red-600">✕ Suppr.</button>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <div className="col-span-1">
                <p className="text-xs text-gray-400 font-bold mb-1.5">Nom</p>
                <Input value={p.nom} onChange={v=>set(p.id,"nom",v)} placeholder="Salon..."/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Surface (m²)</p>
                <Input type="number" value={p.surface} onChange={v=>set(p.id,"surface",v)} placeholder="25" min="1" step="0.5"/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">HSP (m)</p>
                <Input type="number" value={p.hauteur} onChange={v=>set(p.id,"hauteur",v)} placeholder="2.50" min="1.8" max="6" step="0.05"/>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button onClick={add}
        className="w-full py-3.5 rounded-2xl border-2 border-dashed border-blue-300 text-blue-600
          font-bold text-sm hover:bg-blue-50 transition-all mb-3">
        + Ajouter une pièce
      </button>

      <div className="flex flex-wrap gap-2 mb-1">
        <span className="text-xs text-gray-400 self-center font-bold">Ajout rapide :</span>
        {RAPIDES.map(n=>(
          <button key={n} onClick={()=>add(n)}
            className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-xl hover:bg-blue-50
              hover:text-blue-700 border border-gray-200 font-semibold transition-all">
            + {n}
          </button>
        ))}
      </div>

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Décrire les murs →" canNext={ok}/>
    </div>
  );
}

// ─── Step 3 : Murs ───────────────────────────────────

const MATS = [
  { v:"parpaing",      l:"Parpaings (béton creux)" },
  { v:"brique_creuse", l:"Briques creuses" },
  { v:"brique_pleine", l:"Briques pleines" },
  { v:"beton_plein",   l:"Béton plein banché" },
  { v:"pierre",        l:"Pierre (moellons)" },
  { v:"ossature_bois", l:"Ossature bois" },
  { v:"ancien",        l:"Matériau ancien (pisé, torchis, bois)" },
];
const ISOS = [
  { v:"non",    l:"Non isolé (mur d'origine)" },
  { v:"iti",    l:"Isolation par l'intérieur (ITI)" },
  { v:"ite",    l:"Isolation par l'extérieur (ITE)" },
  { v:"reparti",l:"Isolation répartie dans la masse" },
];
const ORIS = [
  { v:"N",l:"Nord" },{ v:"NE",l:"Nord-Est" },{ v:"E",l:"Est" },{ v:"SE",l:"Sud-Est" },
  { v:"S",l:"Sud" },{ v:"SO",l:"Sud-Ouest" },{ v:"O",l:"Ouest" },{ v:"NO",l:"Nord-Ouest" },
];

// ─── Coefficients b_tr par type de local adjacent (3CL-DPE 2021) ────
// b_tr = fraction des déperditions effective (0 = logement chauffé contigu, 1 = extérieur plein)
const LOCAL_ADJACENT = [
  { v:"exterieur",      l:"🌬️ Extérieur / air extérieur",                      btr: 1.00, d:"Mur en contact direct avec l'air extérieur" },
  { v:"circ_ouverte",   l:"🚪 Circulation avec ouverture directe sur extérieur", btr: 1.00, d:"Couloir ou palier avec porte(s) donnant sur l'extérieur" },
  { v:"combles_nc",     l:"🏠 Combles non chauffés",                             btr: 0.90, d:"Grenier ou combles perdus non chauffés" },
  { v:"cave_nc",        l:"🪨 Sous-sol / cave non chauffé",                      btr: 0.80, d:"Cave ou sous-sol fermé sans ouverture directe" },
  { v:"garage_nc",      l:"🚗 Garage non chauffé",                               btr: 0.75, d:"Garage attenant non chauffé (mur ou plafond)" },
  { v:"circ_fermee",    l:"🏢 Circulation sans ouverture directe",               btr: 0.60, d:"Couloir ou palier fermé sans air extérieur direct" },
  { v:"tampon_solar",   l:"🌿 Espace tampon solarisé (véranda...)",              btr: 0.60, d:"Véranda, loggia vitrée non chauffée, serre" },
  { v:"vide_sanitaire", l:"🕳️ Vide sanitaire / plancher ventilé",               btr: 0.50, d:"Mur du vide sanitaire (entourant l'espace ventilé)" },
  { v:"local_nc_calc",  l:"❓ Local non chauffé (Aiu/Aue connus)",               btr: null, d:"Calcul précis possible si surfaces connues" },
  { v:"mitoyen",        l:"🏘️ Logement chauffé contigu / mitoyen",              btr: 0.00, d:"Paroi entre deux logements chauffés — pas de déperdition" },
];

// ─── Valeurs Ψ ponts thermiques forfaitaires 3CL (W/m.K) ───────────
// Source: Guide Cerema 2021 + Arrêté 31/03/2021 méthode 3CL
// Colonnes: [non_isole, iti, ite, reparti]
// ─── Tableau d'affichage simplifié PSI ───────────────────────────────────────
const PSI_DISPLAY = {
  "pb_mur":     { lbl:"Plancher bas / Mur",            ico:"⬛" },
  "ph_mur":     { lbl:"Plancher haut / Mur",           ico:"🏠" },
  "pi_mur":     { lbl:"Plancher intermédiaire / Mur",  ico:"📐" },
  "refend_mur": { lbl:"Refend / Mur extérieur",        ico:"🧱" },
  "menu_mur":   { lbl:"Menuiserie / Mur (périmètre)",  ico:"🪟" },
};

// ─── Calcul auto ponts thermiques — matrices 3CL-DPE 2021 ────────────────────
function autoPontsThermiques(murs, menuiseries, planchers, toiture, niveaux=1) {
  const mursDep = murs.filter(m => {
    const la = LOCAL_ADJACENT.find(l=>l.v===(m.local_adjacent||"exterieur"));
    return la && (la.btr === null || la.btr > 0);
  });
  const longueurTotale = mursDep.reduce((s,m)=>s+(parseFloat(m.longueur)||0), 0);

  // Clé iso mur dominante
  const isoCount = {};
  mursDep.forEach(m=>{ const k = isoMurKey(m.isolation||"non"); isoCount[k]=(isoCount[k]||0)+1; });
  const isoDomMur = Object.entries(isoCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || "non";

  // Plancher bas lourd dominant
  const pbLourd = planchers.find(p => { const td=PB_TYPES_3CL.find(t=>t.v===p.type); return td?.lourd!==false; });
  const isoPbKey = pbLourd ? (PB_ISO_TYPES.find(i=>i.v===(pbLourd.iso_type||"non"))?.psi_key || "non") : null;

  // Plancher haut lourd dominant
  const phLourd = toiture.find(t => { const td=PH_TYPES_3CL.find(tt=>tt.v===t.type); return td?.lourd===true; });
  const isoPh = phLourd ? (PH_ISO_TYPES.find(i=>i.v===(phLourd.iso_type||"non"))?.psi_key || "non") : null;

  const longueurMenu = menuiseries.reduce((s,m)=>{
    const L=parseFloat(m.largeur)||1.2, H=parseFloat(m.hauteur)||1.2, nb=parseInt(m.nb)||1;
    const peri = m.type_ouv==="porte_opa"||m.type_ouv==="pf" ? (2*H+L) : 2*(L+H);
    return s+peri*nb;
  }, 0);

  const pts = [];

  if (longueurTotale > 0 && isoPbKey !== null) {
    const psi = (KPB[isoPbKey]||KPB.non)[isoDomMur] || 0.39;
    const L = Math.round(longueurTotale*10)/10;
    pts.push({ type:"pb_mur", longueur:L, psi, pt:Math.round(L*psi*10)/10 });
  }
  if (longueurTotale > 0 && isoPh !== null) {
    const psi = (KPH[isoPh]||KPH.non)[isoDomMur] || 0.30;
    const L = Math.round(longueurTotale*10)/10;
    pts.push({ type:"ph_mur", longueur:L, psi, pt:Math.round(L*psi*10)/10 });
  }
  if (niveaux > 1 && longueurTotale > 0) {
    const psi = KPI[isoDomMur] || 0.86;
    const lpi = Math.round(longueurTotale*(niveaux-1)*10)/10;
    pts.push({ type:"pi_mur", longueur:lpi, psi, pt:Math.round(lpi*psi*10)/10 });
  }
  if (longueurTotale > 0) {
    const psi = KRF[isoDomMur] || 0.73;
    const lref = Math.round(longueurTotale*0.25*10)/10;
    pts.push({ type:"refend_mur", longueur:lref, psi, pt:Math.round(lref*psi*10)/10 });
  }
  if (longueurMenu > 0) {
    const psi = KMEN[isoDomMur] || 0.45;
    const L = Math.round(longueurMenu*10)/10;
    pts.push({ type:"menu_mur", longueur:L, psi, pt:Math.round(L*psi*10)/10 });
  }

  const totalPT = Math.round(pts.reduce((s,p)=>s+p.pt,0)*10)/10;
  return { pts, totalPT, isoDomMur, isoPbKey, isoPh, longueurTotale };
}

function Step3({ d, upd, onNext, onPrev }) {
  const add = () => upd("murs", [...d.murs, {
    id:Date.now(), nom:"", orientation:"S", longueur:"", hauteur:"2.50",
    materiau:"parpaing", isolation:"non", epaisseurIso:"", epaisseurMur:"",
    local_adjacent:"exterieur", aiu:"", aue:""
  }]);
  const del = id => upd("murs", d.murs.filter(m=>m.id!==id));
  const set = (id,k,v) => upd("murs", d.murs.map(m=>m.id===id?{...m,[k]:v}:m));
  const [previewIdx, setPreviewIdx] = useState(0);
  const [showPT, setShowPT] = useState(false);
  const preview = d.murs[previewIdx];
  const niveaux = parseInt(d.niveaux)||1;

  const uVal = m => {
    const row = U_MUR[m.materiau]||U_MUR.parpaing;
    return (row[m.isolation||"non"]||"?");
  };

  const ptData = d.murs.length > 0
    ? autoPontsThermiques(d.murs, d.menuiseries, d.planchers, d.toiture, niveaux)
    : null;

  return (
    <div>
      <InfoBox icon="🧱" color="blue">
        <strong>Identifier la composition :</strong> observez l'épaisseur dans l'embrasure d'une fenêtre.
        Cherchez une trappe, un percement ou une zone non enduite.
        Un mur de pierre sonne "creux", un béton est lourd et lisse.
        En l'absence de justificatif sur un bâtiment d'<strong>avant 1975</strong>, les murs sont présumés non isolés.
      </InfoBox>

      {/* Nombre de niveaux — nécessaire pour les PT planchers intermédiaires */}
      <div className="mt-4 mb-3">
        <Label sub="Nécessaire pour le calcul des ponts thermiques planchers intermédiaires">
          Nombre de niveaux chauffés
        </Label>
        <div className="flex gap-2 mt-2">
          {["1","2","3","4+"].map(n=>(
            <button key={n} onClick={()=>upd("niveaux", n==="4+"?"4":n)}
              style={(d.niveaux||"1")===n||(n==="4+"&&(d.niveaux||"1")==="4")?{background:"#0f2d5e",color:"#fff",borderColor:"#0f2d5e"}:{}}
              className="flex-1 py-2.5 rounded-2xl text-sm font-black border-2 border-gray-200 hover:border-gray-400 transition-all">
              {n}
            </button>
          ))}
        </div>
      </div>

      {d.murs.length > 0 && (
        <div className="bg-gray-50 rounded-3xl p-4 mb-4 mt-4">
          <div className="flex gap-2 mb-3 flex-wrap">
            {d.murs.map((m,i)=>(
              <button key={m.id} onClick={()=>setPreviewIdx(i)}
                style={previewIdx===i?{background:"#0f2d5e",color:"#fff",borderColor:"#0f2d5e"}:{}}
                className="text-xs px-3 py-1.5 rounded-xl border-2 border-gray-200 font-bold transition-all">
                {m.nom||`Mur ${i+1}`}
              </button>
            ))}
          </div>
          {preview && (
            <div className="aspect-video rounded-2xl overflow-hidden bg-white border border-gray-200">
              <IlluWall mat={preview.materiau} iso={preview.isolation}/>
            </div>
          )}
          {preview && (
            <p className="text-center mt-2 text-xs font-bold text-blue-900">
              U estimé = <span className="text-orange-600">{uVal(preview)} W/m²K</span>
              {uVal(preview) <= 0.4 && " ✅ Bien isolé"}
              {uVal(preview) > 1.0 && " ⚠️ Très déperditif"}
            </p>
          )}
        </div>
      )}

      <div className="space-y-4 mb-4">
        {d.murs.map((m,i)=>{
          const la = LOCAL_ADJACENT.find(l=>l.v===(m.local_adjacent||"exterieur"));
          const btr = la?.btr ?? 1.0;
          const uEff = uVal(m) * (btr??1);
          const surf = (parseFloat(m.longueur)||0)*(parseFloat(m.hauteur)||2.5);
          const deperd = Math.round(uEff * surf * 10)/10;

          return (
          <div key={m.id} className="bg-gray-50 border-2 border-gray-100 rounded-3xl p-4">
            <div className="flex justify-between items-center mb-3">
              <span className="text-xs font-black text-gray-400 uppercase tracking-widest">
                Mur {i+1} — {m.nom||"sans nom"}
              </span>
              <button onClick={()=>del(m.id)} className="text-red-400 text-xs font-bold hover:text-red-600">✕</button>
            </div>

            {/* Nom + Orientation */}
            <div className="grid grid-cols-2 gap-2.5 mb-2.5">
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Nom / repère</p>
                <Input value={m.nom} onChange={v=>set(m.id,"nom",v)} placeholder="Façade Sud..."/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Orientation</p>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Select value={m.orientation} onChange={v=>set(m.id,"orientation",v)} opts={ORIS}/>
                  </div>
                  <IlluCompass orientation={m.orientation}/>
                </div>
              </div>
            </div>

            {/* Dimensions */}
            <div className="grid grid-cols-4 gap-2 mb-2.5">
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Long. (m)</p>
                <Input type="number" value={m.longueur} onChange={v=>set(m.id,"longueur",v)} placeholder="8.0" min="0.5" step="0.1"/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Haut. (m)</p>
                <Input type="number" value={m.hauteur} onChange={v=>set(m.id,"hauteur",v)} placeholder="2.50" min="1" step="0.05"/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Ép. mur (cm)</p>
                <Input type="number" value={m.epaisseurMur||""} onChange={v=>set(m.id,"epaisseurMur",v)} placeholder="20" min="5" max="100" step="1"/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Surf. brute</p>
                <div className="w-full rounded-2xl border-2 border-blue-100 bg-blue-50 px-2 py-3
                  text-sm font-black text-blue-900 text-center">
                  {surf.toFixed(1)} m²
                </div>
              </div>
            </div>

            {/* Matériau + Isolation */}
            <div className="grid grid-cols-2 gap-2.5 mb-2.5">
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Matériau</p>
                <Select value={m.materiau} onChange={v=>set(m.id,"materiau",v)} opts={MATS}/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Isolation</p>
                <Select value={m.isolation} onChange={v=>set(m.id,"isolation",v)} opts={ISOS}/>
              </div>
            </div>
            {m.isolation && m.isolation !== "non" && (
              <div className="grid grid-cols-2 gap-2.5 mb-2.5">
                <div>
                  <p className="text-xs text-gray-400 font-bold mb-1.5">Épaisseur isolant (cm)</p>
                  <Input type="number" value={m.epaisseurIso} onChange={v=>set(m.id,"epaisseurIso",v)} placeholder="10" min="1" max="50"/>
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-bold mb-1.5">Année d'isolation</p>
                  <Input type="number" value={m.anneeIso||""} onChange={v=>set(m.id,"anneeIso",v)} placeholder="2010" min="1970" max="2025"/>
                </div>
              </div>
            )}

            {/* Local adjacent */}
            <div className="mb-2.5">
              <p className="text-xs text-gray-400 font-bold mb-1.5">Ce mur donne sur…</p>
              <div className="grid grid-cols-1 gap-1.5">
                {LOCAL_ADJACENT.map(opt=>(
                  <button key={opt.v} onClick={()=>set(m.id,"local_adjacent",opt.v)}
                    style={(m.local_adjacent||"exterieur")===opt.v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
                    className="w-full p-2.5 rounded-2xl border-2 border-gray-200 text-left hover:border-gray-300 transition-all">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1">
                        <p className="text-xs font-black text-gray-800">{opt.l}</p>
                        <p className="text-[10px] text-gray-400 leading-snug">{opt.d}</p>
                      </div>
                      {opt.btr !== null ? (
                        <span className={`text-[10px] font-black px-2 py-1 rounded-xl flex-shrink-0 whitespace-nowrap
                          ${opt.btr===1?"bg-red-100 text-red-700":opt.btr===0?"bg-green-100 text-green-700":"bg-orange-100 text-orange-700"}`}>
                          b = {opt.btr}
                        </span>
                      ) : (
                        <span className="text-[10px] font-black px-2 py-1 rounded-xl bg-purple-100 text-purple-700 flex-shrink-0">
                          b calculé
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Champs Aiu/Aue si local_nc_calc */}
            {m.local_adjacent==="local_nc_calc" && (
              <div className="grid grid-cols-2 gap-2.5 mb-2.5 bg-purple-50 border border-purple-200 rounded-2xl p-3">
                <div>
                  <p className="text-xs text-purple-700 font-bold mb-1.5">Aiu — surf. parois vers logement (m²)</p>
                  <Input type="number" value={m.aiu||""} onChange={v=>set(m.id,"aiu",v)} placeholder="Ex: 15"/>
                </div>
                <div>
                  <p className="text-xs text-purple-700 font-bold mb-1.5">Aue — surf. parois vers extérieur (m²)</p>
                  <Input type="number" value={m.aue||""} onChange={v=>set(m.id,"aue",v)} placeholder="Ex: 25"/>
                </div>
                {m.aiu && m.aue && (
                  <div className="col-span-2 text-center">
                    <p className="text-xs font-black text-purple-700">
                      b_tr calculé = {Math.round(parseFloat(m.aue)/(parseFloat(m.aiu)+parseFloat(m.aue))*100)/100}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Récapitulatif déperditions du mur */}
            {surf > 0 && (
              <div className={`rounded-2xl p-2.5 mt-1 flex items-center justify-between
                ${btr===0?"bg-green-50 border border-green-200":"bg-blue-50 border border-blue-100"}`}>
                <div>
                  <p className="text-[10px] text-gray-400 font-bold">U = {uVal(m)} W/m²K · b = {btr===null?"calc.":btr} · S = {surf.toFixed(1)} m²</p>
                  {btr===0
                    ? <p className="text-xs font-black text-green-700">✅ Paroi non déperditrice (b = 0)</p>
                    : <p className="text-xs font-black text-blue-900">Dép. = {deperd} W/K</p>
                  }
                </div>
                {uVal(m) <= 0.4 && <span className="text-green-600 text-lg">✅</span>}
                {uVal(m) > 1.2 && <span className="text-red-500 text-lg">⚠️</span>}
              </div>
            )}
          </div>
          );
        })}
      </div>

      <button onClick={add}
        className="w-full py-3.5 rounded-2xl border-2 border-dashed border-blue-300 text-blue-600
          font-bold text-sm hover:bg-blue-50 transition-all mb-3">
        + Ajouter un mur déperditif
      </button>
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-xs text-gray-400 self-center font-bold">Rapide :</span>
        {["Façade N","Façade S","Façade E","Façade O","Pignon G","Pignon D"].map(n=>{
          const ori = n.includes("N")?"N":n.includes("S")?"S":n.includes("E")?"E":n.includes("O")?"O":"N";
          return (
            <button key={n} onClick={()=>upd("murs",[...d.murs,{id:Date.now(),nom:n,orientation:ori,longueur:"",hauteur:"2.50",materiau:"parpaing",isolation:"non",epaisseurIso:"",epaisseurMur:"",local_adjacent:"exterieur",aiu:"",aue:""}])}
              className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-xl hover:bg-blue-50
                hover:text-blue-700 border border-gray-200 font-semibold transition-all">
              + {n}
            </button>
          );
        })}
      </div>

      {/* ── Section Ponts Thermiques ── */}
      {d.murs.length > 0 && (
        <div className="border-2 border-indigo-200 bg-indigo-50 rounded-3xl p-5 mb-5">
          <button onClick={()=>setShowPT(v=>!v)}
            className="w-full flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="text-xl">🔗</span>
              <div className="text-left">
                <p className="text-sm font-black text-indigo-900">Ponts thermiques — calcul automatique</p>
                {ptData && (
                  <p className="text-xs text-indigo-600 font-semibold">
                    Total calculé : <strong>{ptData.totalPT} W/K</strong> · Isolation dominante : <strong>{({non:"Non isolé",iti:"ITI",ite:"ITE",reparti:"Répartie"}[ptData.isoDom]||ptData.isoDom)}</strong>
                  </p>
                )}
              </div>
            </div>
            <span className="text-indigo-600 font-black text-sm">{showPT?"▲":"▼"}</span>
          </button>

          {showPT && ptData && (
            <div className="mt-4">
              <div className="bg-indigo-100 rounded-2xl p-3 mb-3">
                <p className="text-[10px] text-indigo-700 font-semibold leading-relaxed">
                  <strong>Méthode 3CL-DPE 2021 :</strong> Les Ψ (psi) forfaitaires sont appliqués selon l'isolation dominante
                  de vos murs. Les longueurs sont calculées depuis vos métrés. Cliquez sur chaque type pour comprendre le calcul.
                </p>
              </div>

              <div className="space-y-2 mb-3">
                {ptData.pts.map((pt,i)=>{
                  const def = PSI_DISPLAY[pt.type];
                  return (
                    <div key={i} className="bg-white rounded-2xl p-3 border border-indigo-100">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{def?.ico||"🔗"}</span>
                          <div>
                            <p className="text-xs font-black text-gray-800">{def?.lbl||pt.type}</p>
                            <p className="text-[10px] text-gray-400">
                              L = {pt.longueur} m · Ψ = {pt.psi} W/m.K
                            </p>
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-xs font-black text-indigo-700">{pt.pt} W/K</p>
                          <p className="text-[10px] text-gray-400">L × Ψ</p>
                        </div>
                      </div>
                      {/* Barre de contribution */}
                      <div className="mt-2 h-1.5 bg-indigo-100 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full"
                          style={{width:`${Math.min(100, pt.pt/ptData.totalPT*100)}%`}}/>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="bg-indigo-200 rounded-2xl p-3 flex items-center justify-between">
                <p className="text-sm font-black text-indigo-900">Total ponts thermiques</p>
                <p className="text-lg font-black text-indigo-900">{ptData.totalPT} W/K</p>
              </div>

              {/* Tableau Ψ de référence */}
              <div className="mt-3">
                <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-2">
                  Ψ de référence selon isolation (W/m.K)
                </p>
                <div className="rounded-2xl overflow-hidden border border-indigo-200">
                  <div className="grid grid-cols-5 text-[10px] font-black text-white bg-indigo-700 px-2 py-1.5">
                    <span>Liaison</span><span className="text-center">Non iso.</span>
                    <span className="text-center">ITI</span><span className="text-center">ITE</span><span className="text-center">ITI+ITE</span>
                  </div>
                  {/* Tableau Ψ 3CL — matrice pb/mur comme référence */}
                  {[
                    {k:"pb_mur",    ico:"⬛", lbl:"PB/Mur",    vals:{non:KPB.non,    iti:KPB.iti,    ite:KPB.ite,    iti_ite:KPB.iti_ite}},
                    {k:"ph_mur",    ico:"🏠", lbl:"PH/Mur",    vals:{non:KPH.non,    iti:KPH.iti,    ite:KPH.ite,    iti_ite:KPH.iti_ite}},
                    {k:"pi_mur",    ico:"📐", lbl:"PI/Mur",    vals:{non:{[ptData.isoDomMur||"non"]:KPI[ptData.isoDomMur||"non"]||0.86}}},
                    {k:"refend",    ico:"🧱", lbl:"Refend/Mur", vals:{non:{[ptData.isoDomMur||"non"]:KRF[ptData.isoDomMur||"non"]||0.73}}},
                    {k:"menu_mur",  ico:"🪟", lbl:"Menu/Mur",  vals:{non:{[ptData.isoDomMur||"non"]:KMEN[ptData.isoDomMur||"non"]||0.45}}},
                  ].map((row,i)=>(
                    <div key={row.k} className={`grid grid-cols-5 text-[10px] px-2 py-1.5 border-b border-indigo-100 ${i%2===0?"bg-white":"bg-indigo-50"}`}>
                      <span className="font-bold text-gray-700">{row.ico} {row.lbl}</span>
                      {["non","iti","ite","iti_ite"].map(isoKey=>{
                        const murVals = row.vals[isoKey] || row.vals["non"] || {};
                        const val = typeof murVals === "object" ? (murVals[ptData.isoDomMur||"non"]||"-") : murVals;
                        const active = isoKey===(ptData.isoDomMur||"non");
                        return <span key={isoKey} className={`text-center font-black ${active?"text-indigo-700 bg-indigo-100 rounded":""}`}>{typeof val==="number"?val:"-"}</span>;
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-[10px] text-indigo-600 mt-2 font-semibold">
                💡 ITE (Isolation par l'Extérieur) supprime quasi totalement les ponts thermiques — gain majeur vs ITI.
              </p>
            </div>
          )}
        </div>
      )}

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Planchers bas →" canNext={d.murs.length>0}/>
    </div>
  );
}

// ─── Step 4 : Planchers bas ──────────────────────────

function Step4({ d, upd, onNext, onPrev }) {
  const sRef = d.pieces.reduce((s,p)=>s+(parseFloat(p.surface)||0),0);
  const zone = d.identification?.zone || "H1";

  const add = () => upd("planchers", [...d.planchers, {
    id:Date.now(), type:"beton_plein", situation:"vide_sanitaire",
    iso_type:"non", surface:Math.round(sRef).toString(),
    epaisseurIso:"", anneeIso:""
  }]);
  const del = id => upd("planchers", d.planchers.filter(p=>p.id!==id));
  const set = (id,k,v) => upd("planchers", d.planchers.map(p=>p.id===id?{...p,[k]:v}:p));

  return (
    <div>
      <InfoBox icon="🔍" color="blue">
        <strong>Identifier le plancher bas :</strong> descendez dans le vide sanitaire ou la cave si accessible.
        Isolation sous-face (ITE 3CL) = isolant fixé dessous du plancher.
        Isolation sous-chape (ITI 3CL) = polystyrène/laine noyé dans la dalle — invisible depuis le dessous.
        <strong> Avant 1975 : présumer non isolé.</strong>
      </InfoBox>

      {/* Légende types */}
      <div className="grid grid-cols-2 gap-2 my-3">
        {PB_TYPES_3CL.map(t=>(
          <div key={t.v} className="bg-gray-50 border border-gray-200 rounded-2xl p-2.5 flex gap-2 items-start">
            <span className="text-base flex-shrink-0">{t.l.split(" ")[0]}</span>
            <div>
              <p className="text-[11px] font-bold text-gray-700 leading-tight">{t.l.split(" ").slice(1).join(" ")}</p>
              <p className="text-[10px] text-gray-400 leading-snug mt-0.5">{t.d}</p>
              <p className="text-[10px] font-bold text-blue-600 mt-0.5">U₀={t.upb0} W/m²K{t.lourd?"":" · PT=0"}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-4 mb-4">
        {d.planchers.map((p,i)=>{
          const upb = computeUpb(p, zone);
          const sit = p.situation || "vide_sanitaire";
          const sitDef = PB_SITUATIONS.find(s=>s.v===sit);
          const ue = sitDef?.ue ? computeUe(upb, sit) : null;
          const uAff = ue !== null ? ue : upb;
          const isGood = uAff < 0.5;
          const psiKey = PB_ISO_TYPES.find(ii=>ii.v===(p.iso_type||"non"))?.psi_key || "non";
          const isoMur = "non"; // résolu dans autoPontsThermiques au niveau global
          const psiVal = (KPB[psiKey]||KPB.non)[isoMur];

          return (
          <div key={p.id} className="bg-gray-50 border-2 border-gray-100 rounded-3xl p-4">
            <div className="flex justify-between mb-3">
              <span className="text-xs font-black text-gray-400 uppercase tracking-widest">Plancher bas {i+1}</span>
              <button onClick={()=>del(p.id)} className="text-red-400 text-xs font-bold">✕</button>
            </div>

            {/* Structure + Surface */}
            <div className="grid grid-cols-2 gap-2.5 mb-3">
              <div>
                <p className="text-xs text-gray-500 font-bold mb-1.5">Structure (Upb0)</p>
                <Select value={p.type||"beton_plein"} onChange={v=>set(p.id,"type",v)}
                  opts={PB_TYPES_3CL.map(t=>({v:t.v,l:t.l}))}/>
              </div>
              <div>
                <p className="text-xs text-gray-500 font-bold mb-1.5">Surface (m²)</p>
                <Input type="number" value={p.surface} onChange={v=>set(p.id,"surface",v)}
                  placeholder={Math.round(sRef).toString()} min="1"/>
              </div>
            </div>

            {/* Situation */}
            <div className="mb-3">
              <p className="text-xs text-gray-500 font-bold mb-1.5">Situation — local en dessous</p>
              <div className="grid grid-cols-1 gap-1.5">
                {PB_SITUATIONS.map(s=>(
                  <button key={s.v} onClick={()=>set(p.id,"situation",s.v)}
                    className={`flex items-start gap-2.5 px-3 py-2 rounded-xl border-2 text-left transition-all ${
                      (p.situation||"vide_sanitaire")===s.v
                        ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white hover:border-blue-300"
                    }`}>
                    <span className="text-base flex-shrink-0">{s.l.split(" ")[0]}</span>
                    <div>
                      <p className="text-xs font-bold text-gray-800 leading-tight">{s.l.split(" ").slice(1).join(" ")}</p>
                      <p className="text-[10px] text-gray-400">{s.d}</p>
                    </div>
                    {s.ue && <span className="ml-auto text-[10px] text-blue-600 font-bold flex-shrink-0 self-center">→ Ue</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Type d'isolation */}
            <div className="mb-3">
              <p className="text-xs text-gray-500 font-bold mb-1.5">Type d'isolation (3CL)</p>
              <div className="grid grid-cols-1 gap-1.5">
                {PB_ISO_TYPES.map(iso=>(
                  <button key={iso.v} onClick={()=>set(p.id,"iso_type",iso.v)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-xl border-2 text-left transition-all ${
                      (p.iso_type||"non")===iso.v
                        ? "border-green-500 bg-green-50" : "border-gray-200 bg-white hover:border-green-300"
                    }`}>
                    <div className="flex-1">
                      <p className="text-xs font-bold text-gray-800">{iso.l}</p>
                      <p className="text-[10px] text-gray-400">{iso.d}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Épaisseur + année si isolé */}
            {(p.iso_type && p.iso_type !== "non" && p.iso_type !== "inconnue") && (
              <div className="grid grid-cols-2 gap-2.5 mb-3">
                <div>
                  <p className="text-xs text-gray-500 font-bold mb-1.5">Épaisseur isolant (cm)</p>
                  <Input type="number" value={p.epaisseurIso||""} onChange={v=>set(p.id,"epaisseurIso",v)}
                    placeholder="ex: 10" min="1" max="30"/>
                </div>
                <div>
                  <p className="text-xs text-gray-500 font-bold mb-1.5">Année d'isolation</p>
                  <Input type="number" value={p.anneeIso||""} onChange={v=>set(p.id,"anneeIso",v)}
                    placeholder="ex: 1990" min="1970" max="2030"/>
                </div>
              </div>
            )}

            {/* Résultat Upb / Ue */}
            <div className={`rounded-2xl p-3 flex items-center justify-between mt-1 ${isGood?"bg-green-50 border border-green-200":"bg-orange-50 border border-orange-200"}`}>
              <div>
                <p className={`text-xs font-black ${isGood?"text-green-700":"text-orange-700"}`}>
                  {ue !== null ? "Ue" : "Upb"} = {uAff.toFixed(2)} W/m²K
                  {ue !== null && <span className="text-[10px] font-normal ml-1">(Upb={upb.toFixed(2)})</span>}
                </p>
                <p className={`text-[10px] ${isGood?"text-green-600":"text-orange-600"}`}>
                  {ue !== null ? "Coefficient Ue 3CL (sol/sous-sol)" : "Coefficient de transmission plancher"}
                </p>
              </div>
              <span className="text-2xl">{isGood?"✅":"⚠️"}</span>
            </div>

            {/* PT liaison pb/mur */}
            <div className="mt-2 bg-indigo-50 rounded-xl px-3 py-2 border border-indigo-100">
              <p className="text-[10px] text-indigo-700 font-bold">
                🔗 Ψ liaison Plancher bas/Mur (3CL) : {psiVal} W/m.K
                <span className="font-normal ml-1">(iso plancher: {p.iso_type||"non"} × iso mur: calculé à l'étape murs)</span>
              </p>
            </div>
          </div>
        )})}
      </div>

      <button onClick={add}
        className="w-full py-3.5 rounded-2xl border-2 border-dashed border-blue-300 text-blue-600
          font-bold text-sm hover:bg-blue-50 transition-all mb-3">
        + Ajouter un plancher bas
      </button>

      <InfoBox icon="💡" color="amber">
        <strong>R ≥ 3 m²K/W recommandé (H1)</strong> · Équivalent : 12 cm laine de verre λ=0,040.
        <strong> Terre-plein et vide sanitaire :</strong> 3CL calcule un Ue (coefficient sol) depuis Upb et le rapport 2S/P —
        valeur plus faible que Upb brut. Ne pas boucher les entrées d'air en vide sanitaire (risque humidité).
      </InfoBox>

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Planchers hauts / Toiture →" canNext={d.planchers.length>0}/>
    </div>
  );
}

// ─── Step 5 : Planchers hauts / Toiture ──────────────

function Step5({ d, upd, onNext, onPrev }) {
  const sRef = d.pieces.reduce((s,p)=>s+(parseFloat(p.surface)||0),0);
  const zone = d.identification?.zone || "H1";

  const add = () => upd("toiture", [...d.toiture, {
    id:Date.now(), type:"combles_perdus", iso_type:"non",
    surface:Math.round(sRef).toString(), epaisseurIso:"", anneeIso:""
  }]);
  const del = id => upd("toiture", d.toiture.filter(t=>t.id!==id));
  const set = (id,k,v) => upd("toiture", d.toiture.map(t=>t.id===id?{...t,[k]:v}:t));

  return (
    <div>
      <InfoBox icon="🔍" color="blue">
        <strong>Combles perdus :</strong> mesurez l'épaisseur d'isolant au plancher (laine, ouate, liège).
        <strong> Rampants :</strong> isolant entre les chevrons — côté intérieur (ITI) ou côté extérieur sous le toit (ITE).
        <strong> Terrasse :</strong> isolant en toiture-terrasse = ITE (dessus de la dalle).
        R = épaisseur (m) ÷ λ · <strong>Objectif R ≥ 5 m²K/W en H1.</strong>
      </InfoBox>

      {/* Légende types */}
      <div className="grid grid-cols-2 gap-2 my-3">
        {PH_TYPES_3CL.map(t=>(
          <div key={t.v} className="bg-gray-50 border border-gray-200 rounded-2xl p-2.5 flex gap-2 items-start">
            <span className="text-base flex-shrink-0">{t.l.split(" ")[0]}</span>
            <div>
              <p className="text-[11px] font-bold text-gray-700 leading-tight">{t.l.split(" ").slice(1).join(" ")}</p>
              <p className="text-[10px] text-gray-400 leading-snug mt-0.5">{t.d}</p>
              <p className="text-[10px] font-bold text-blue-600 mt-0.5">U₀={t.uph0} W/m²K{!t.lourd?" · PT léger=0":""}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-4 mb-4">
        {d.toiture.map((t,i)=>{
          const uph = computeUph(t, zone);
          const isGood = uph < 0.3;
          const rVal = parseFloat(t.epaisseurIso)>0 ? (parseFloat(t.epaisseurIso)/100/0.040).toFixed(1) : null;
          const typeDef = PH_TYPES_3CL.find(tt=>tt.v===t.type)||PH_TYPES_3CL[0];
          const psiKey = PH_ISO_TYPES.find(ii=>ii.v===(t.iso_type||"non"))?.psi_key || "non";
          const psiVal = (KPH[psiKey]||KPH.non)["non"]; // valeur mur non isolé comme référence affichage

          return (
          <div key={t.id} className="bg-gray-50 border-2 border-gray-100 rounded-3xl p-4">
            <div className="flex justify-between mb-3">
              <span className="text-xs font-black text-gray-400 uppercase tracking-widest">Plancher haut {i+1}</span>
              <button onClick={()=>del(t.id)} className="text-red-400 text-xs font-bold">✕</button>
            </div>

            {/* Type + Surface */}
            <div className="grid grid-cols-2 gap-2.5 mb-3">
              <div>
                <p className="text-xs text-gray-500 font-bold mb-1.5">Type (Uph0)</p>
                <Select value={t.type||"combles_perdus"} onChange={v=>set(t.id,"type",v)}
                  opts={PH_TYPES_3CL.map(tt=>({v:tt.v,l:tt.l}))}/>
              </div>
              <div>
                <p className="text-xs text-gray-500 font-bold mb-1.5">Surface (m²)</p>
                <Input type="number" value={t.surface} onChange={v=>set(t.id,"surface",v)}
                  placeholder={Math.round(sRef).toString()} min="1"/>
              </div>
            </div>

            {/* Type d'isolation */}
            <div className="mb-3">
              <p className="text-xs text-gray-500 font-bold mb-1.5">Type d'isolation (3CL)</p>
              <div className="grid grid-cols-1 gap-1.5">
                {PH_ISO_TYPES.map(iso=>(
                  <button key={iso.v} onClick={()=>set(t.id,"iso_type",iso.v)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-xl border-2 text-left transition-all ${
                      (t.iso_type||"non")===iso.v
                        ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white hover:border-blue-300"
                    }`}>
                    <div className="flex-1">
                      <p className="text-xs font-bold text-gray-800">{iso.l}</p>
                      <p className="text-[10px] text-gray-400">{iso.d}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Épaisseur + Année si isolé */}
            {(t.iso_type && t.iso_type !== "non" && t.iso_type !== "inconnue") && (
              <div className="grid grid-cols-2 gap-2.5 mb-3">
                <div>
                  <p className="text-xs text-gray-500 font-bold mb-1.5">Épaisseur isolant (cm)</p>
                  <Input type="number" value={t.epaisseurIso||""} onChange={v=>set(t.id,"epaisseurIso",v)}
                    placeholder="ex: 20" min="1" max="60"/>
                </div>
                <div>
                  {rVal ? (
                    <div className={`h-full flex flex-col items-center justify-center rounded-2xl border-2 px-2 py-2 ${parseFloat(rVal)>=5?"border-green-300 bg-green-50":"border-orange-200 bg-orange-50"}`}>
                      <p className="text-[10px] text-gray-500 font-bold">R estimé (λ=0,040)</p>
                      <p className={`text-xl font-black ${parseFloat(rVal)>=5?"text-green-600":"text-orange-500"}`}>{rVal} m²K/W</p>
                      <p className={`text-[10px] font-bold ${parseFloat(rVal)>=5?"text-green-600":"text-orange-500"}`}>
                        {parseFloat(rVal)>=5?"✅ Excellent":"⚠️ R < 5 recommandé"}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-xs text-gray-500 font-bold mb-1.5">Année d'isolation</p>
                      <Input type="number" value={t.anneeIso||""} onChange={v=>set(t.id,"anneeIso",v)}
                        placeholder="ex: 1995" min="1970" max="2030"/>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Résultat Uph */}
            <div className={`rounded-2xl p-3 flex items-center justify-between mt-1 ${isGood?"bg-green-50 border border-green-200":"bg-orange-50 border border-orange-200"}`}>
              <div>
                <p className={`text-xs font-black ${isGood?"text-green-700":"text-orange-700"}`}>
                  Uph = {uph.toFixed(2)} W/m²K
                </p>
                <p className={`text-[10px] ${isGood?"text-green-600":"text-orange-600"}`}>
                  {typeDef.l.split(" ").slice(1,3).join(" ")} — {typeDef.tbl==="terrasse"?"Uph_tab terrasse":"Uph_tab combles"}
                </p>
              </div>
              <span className="text-2xl">{isGood?"✅":"⚠️"}</span>
            </div>

            {/* PT liaison ph/mur (si structure lourde) */}
            {typeDef.lourd && (
              <div className="mt-2 bg-indigo-50 rounded-xl px-3 py-2 border border-indigo-100">
                <p className="text-[10px] text-indigo-700 font-bold">
                  🔗 Ψ liaison PH/Mur (3CL, mur non isolé ref.) : {psiVal} W/m.K
                  <span className="font-normal ml-1">(recalculé avec isolation réelle mur à l'étape 3)</span>
                </p>
              </div>
            )}
          </div>
        )})}
      </div>

      <button onClick={add}
        className="w-full py-3.5 rounded-2xl border-2 border-dashed border-blue-300 text-blue-600
          font-bold text-sm hover:bg-blue-50 transition-all">
        + Ajouter un plancher haut
      </button>

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Fenêtres et vitrages →" canNext={d.toiture.length>0}/>
    </div>
  );
}

// ─── Step 6 : Menuiseries ────────────────────────────

const VITRAGES = [
  { v:"simple",     l:"Simple vitrage",           u:5.8, info:"1 reflet (briquet)" },
  { v:"double_old", l:"Double vitrage avant 2000", u:2.9, info:"2 reflets espacés — gaz air" },
  { v:"double_rec", l:"Double vitrage récent",     u:1.4, info:"2 reflets — gaz argon, Low-E" },
  { v:"triple",     l:"Triple vitrage",            u:0.8, info:"3 reflets — très performant" },
];
const CHASSIS = [
  { v:"bois",       l:"Bois" },
  { v:"pvc",        l:"PVC" },
  { v:"metal_nrpt", l:"Métal sans rupt. thermique" },
  { v:"metal_rpt",  l:"Métal avec rupt. thermique" },
];
const OUVERTURES = [
  { v:"fenetre",    l:"Fenêtre (battante / coulissante)" },
  { v:"pf",         l:"Porte-fenêtre" },
  { v:"velux",      l:"Fenêtre de toit (Velux)" },
  { v:"porte_opa",  l:"Porte opaque (pleine)" },
  { v:"porte_vit",  l:"Porte avec vitrage partiel" },
];
// Matériaux de porte — U opaque de référence (W/m²K)
const MATERIAUX_PORTE = [
  { v:"bois_massif",  l:"Bois massif",           u_opa:1.5,  d:"Chêne, pin — isolation modérée" },
  { v:"bois_isole",   l:"Bois isolé (sandwich)",  u_opa:0.8,  d:"Porte à âme isolante — performant" },
  { v:"acier",        l:"Acier / métal non isolé",u_opa:4.0,  d:"Très conducteur — passoire" },
  { v:"acier_isole",  l:"Acier isolé (rupteur)",  u_opa:1.2,  d:"Acier avec rupteur thermique" },
  { v:"alu",          l:"Aluminium non isolé",    u_opa:3.5,  d:"Conducteur — standard ancien" },
  { v:"alu_rpt",      l:"Aluminium avec RPT",     u_opa:1.8,  d:"Rupture de pont thermique" },
  { v:"pvc",          l:"PVC",                    u_opa:1.2,  d:"Standard collectif" },
  { v:"autre",        l:"Autre / inconnu",         u_opa:2.0,  d:"Valeur U par défaut" },
];

// Calcul Uw effectif d'une menuiserie mixte (porte avec vitrage)
function computeUw(m) {
  if (!m.type_ouv) return 2.9;
  const isPorte = m.type_ouv === "porte_opa" || m.type_ouv === "porte_vit";
  if (!isPorte) {
    return U_VITRAGE[m.vitrage] || 2.9;
  }
  const matDef = MATERIAUX_PORTE.find(mp=>mp.v===m.materiau_porte) || { u_opa:2.0 };
  const uOpaque = matDef.u_opa;
  const pctVit = parseFloat(m.pct_vitrage)||0;
  if (pctVit <= 0) return uOpaque;
  const uVit = U_VITRAGE[m.vitrage] || 2.9;
  return Math.round((uOpaque*(1-pctVit/100) + uVit*(pctVit/100))*100)/100;
}

function Step6({ d, upd, onNext, onPrev }) {
  const add = () => upd("menuiseries", [...d.menuiseries, {
    id:Date.now(), type_ouv:"fenetre", largeur:"1.20", hauteur:"1.20", nb:"1",
    mur_id:"", orientation:"S", vitrage:"double_rec", chassis:"pvc", masque:"aucun",
    materiau_porte:"bois_massif", pct_vitrage:"0",
    local_adjacent:"exterieur", aiu:"", aue:""
  }]);
  const del = id => upd("menuiseries", d.menuiseries.filter(m=>m.id!==id));
  const set = (id,k,v) => upd("menuiseries", d.menuiseries.map(m=>m.id===id?{...m,[k]:v}:m));
  const [selVit, setSelVit] = useState("double_rec");
  const sVit = d.menuiseries.reduce((s,m)=>(parseFloat(m.largeur)||0)*(parseFloat(m.hauteur)||0)*(parseInt(m.nb)||1)+s,0);

  // Murs disponibles pour le lien
  const mursOpts = [
    { v:"", l:"— Mur non renseigné / extérieur direct —" },
    ...d.murs.map(m=>({ v:String(m.id), l:`${m.nom||"Mur sans nom"} (${m.orientation}) — ${m.materiau}` }))
  ];

  return (
    <div>
      {/* Vitromètre visuel */}
      <div className="bg-blue-950 rounded-3xl p-5 mb-4">
        <p className="text-xs font-black text-blue-300 uppercase tracking-widest mb-3">Test des reflets (briquet / vitromètre)</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {VITRAGES.map(v=>(
            <button key={v.v} onClick={()=>setSelVit(v.v)}
              style={selVit===v.v?{borderColor:"#60a5fa",background:"rgba(96,165,250,.15)"}:{borderColor:"#334155"}}
              className="p-2.5 rounded-2xl border-2 text-left text-white transition-all">
              <p className="text-xs font-black">{v.l}</p>
              <p className="text-[10px] text-blue-300 mt-0.5">{v.info} · Uw = {v.u} W/m²K</p>
            </button>
          ))}
        </div>
        <div className="aspect-video rounded-2xl bg-blue-900/40 overflow-hidden border border-blue-800">
          <IlluWindow vitrage={selVit}/>
        </div>
      </div>

      <div className="flex items-center justify-between bg-blue-950 text-white rounded-2xl px-5 py-3 mb-4">
        <span className="text-sm font-bold opacity-70">Surface vitrée totale</span>
        <span className="text-xl font-black">{sVit.toFixed(2)} m²</span>
      </div>

      <div className="space-y-4 mb-4">
        {d.menuiseries.map((m,i)=>{
          const isPorte = m.type_ouv==="porte_opa" || m.type_ouv==="porte_vit";
          const hasVitrage = m.type_ouv!=="porte_opa";
          const pctVit = parseFloat(m.pct_vitrage)||0;
          const uw = computeUw(m);
          // Orientation déduite du mur lié
          const murLie = d.murs.find(mu=>String(mu.id)===String(m.mur_id));
          const oriEffective = murLie ? murLie.orientation : (m.orientation || "S");
          const surf = (parseFloat(m.largeur)||0)*(parseFloat(m.hauteur)||0)*(parseInt(m.nb)||1);
          const btr_menu = (() => {
            if (m.local_adjacent === "local_nc_calc" && m.aiu && m.aue) {
              return Math.round(parseFloat(m.aue)/(parseFloat(m.aiu)+parseFloat(m.aue))*100)/100;
            }
            return (LOCAL_ADJACENT.find(l=>l.v===(m.local_adjacent||"exterieur"))?.btr ?? 1.0);
          })();

          return (
          <div key={m.id} className="bg-gray-50 border-2 border-gray-100 rounded-3xl p-4">
            <div className="flex justify-between mb-3">
              <span className="text-xs font-black text-gray-400 uppercase tracking-widest">
                Menuiserie {i+1}{m.type_ouv ? ` — ${OUVERTURES.find(o=>o.v===m.type_ouv)?.l||m.type_ouv}` : ""}
              </span>
              <button onClick={()=>del(m.id)} className="text-red-400 text-xs font-bold hover:text-red-600">✕</button>
            </div>

            {/* Type d'ouverture */}
            <div className="mb-2.5">
              <p className="text-xs text-gray-400 font-bold mb-1.5">Type d'ouverture</p>
              <div className="grid grid-cols-3 gap-1.5">
                {OUVERTURES.map(o=>(
                  <button key={o.v} onClick={()=>set(m.id,"type_ouv",o.v)}
                    style={m.type_ouv===o.v?{background:"#0f2d5e",color:"#fff",borderColor:"#0f2d5e"}:{}}
                    className="py-2 px-2 rounded-xl border-2 border-gray-200 text-[10px] font-bold text-center hover:border-gray-400 transition-all leading-snug">
                    {o.l}
                  </button>
                ))}
              </div>
            </div>

            {/* ── LIEN VERS UN MUR ── */}
            <div className="mb-2.5">
              <p className="text-xs text-gray-400 font-bold mb-1.5">
                Mur sur lequel se place cette menuiserie
                <span className="text-[10px] text-blue-500 font-normal ml-1">→ orientation déduite automatiquement</span>
              </p>
              {d.murs.length > 0 ? (
                <Select value={String(m.mur_id||"")} onChange={v=>set(m.id,"mur_id",v)} opts={mursOpts}/>
              ) : (
                <div className="rounded-2xl bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-700 font-semibold">
                  ⚠️ Aucun mur renseigné — revenez à l'étape Murs pour lier cette menuiserie.
                </div>
              )}
              {murLie && (
                <p className="text-[10px] text-blue-600 font-bold mt-1">
                  ✅ Orientation retenue : <strong>{oriEffective}</strong> · U mur = {(U_MUR[murLie.materiau]||U_MUR.parpaing)[murLie.isolation||"non"]} W/m²K
                </p>
              )}
              {!murLie && d.murs.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-[10px] text-gray-400 font-bold mb-1">Orientation manuelle</p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1"><Select value={m.orientation} onChange={v=>set(m.id,"orientation",v)} opts={ORIS}/></div>
                    <IlluCompass orientation={m.orientation}/>
                  </div>
                </div>
              )}
              {!murLie && d.murs.length === 0 && (
                <div className="mt-1.5">
                  <p className="text-[10px] text-gray-400 font-bold mb-1">Orientation manuelle</p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1"><Select value={m.orientation} onChange={v=>set(m.id,"orientation",v)} opts={ORIS}/></div>
                    <IlluCompass orientation={m.orientation}/>
                  </div>
                </div>
              )}
            </div>

            {/* Dimensions */}
            <div className="grid grid-cols-4 gap-2 mb-2.5">
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Larg. m</p>
                <Input type="number" value={m.largeur} onChange={v=>set(m.id,"largeur",v)} placeholder="1.20" step="0.05"/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Haut. m</p>
                <Input type="number" value={m.hauteur} onChange={v=>set(m.id,"hauteur",v)} placeholder="1.20" step="0.05"/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Nb</p>
                <Input type="number" value={m.nb} onChange={v=>set(m.id,"nb",v)} placeholder="1" min="1" max="50" step="1"/>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-bold mb-1.5">Total m²</p>
                <div className="w-full rounded-2xl border-2 border-blue-100 bg-blue-50 px-2 py-3 text-sm font-black text-blue-900 text-center">
                  {surf.toFixed(2)}
                </div>
              </div>
            </div>

            {/* ── SECTION PORTE ── */}
            {isPorte && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 mb-2.5">
                <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2">🚪 Caractéristiques de la porte</p>

                {/* Matériau */}
                <div className="mb-2">
                  <p className="text-xs text-gray-500 font-bold mb-1.5">Matériau / type de porte</p>
                  <div className="space-y-1">
                    {MATERIAUX_PORTE.map(mp=>(
                      <button key={mp.v} onClick={()=>set(m.id,"materiau_porte",mp.v)}
                        style={(m.materiau_porte||"bois_massif")===mp.v?{borderColor:"#d97706",background:"#fffbeb"}:{}}
                        className="w-full p-2 rounded-xl border-2 border-gray-200 text-left hover:border-amber-300 transition-all">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-xs font-black text-gray-800">{mp.l}</p>
                            <p className="text-[10px] text-gray-400">{mp.d}</p>
                          </div>
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-xl flex-shrink-0
                            ${mp.u_opa >= 3?"bg-red-100 text-red-700":mp.u_opa>=1.5?"bg-orange-100 text-orange-700":"bg-green-100 text-green-700"}`}>
                            U={mp.u_opa}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* % vitrage — seulement pour porte_vit */}
                {m.type_ouv === "porte_vit" && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-500 font-bold mb-1.5">
                      % de vitrage dans la porte
                      <span className="text-[10px] font-normal text-gray-400 ml-1">(surface vitrée / surface totale)</span>
                    </p>
                    <div className="grid grid-cols-5 gap-1.5 mb-2">
                      {["10","20","30","40","60"].map(pct=>(
                        <button key={pct} onClick={()=>set(m.id,"pct_vitrage",pct)}
                          style={(m.pct_vitrage||"0")===pct?{background:"#d97706",color:"#fff",borderColor:"#d97706"}:{}}
                          className="py-2 rounded-xl border-2 border-gray-200 text-xs font-black hover:border-amber-400 transition-all text-center">
                          {pct}%
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Input type="number" value={m.pct_vitrage||"0"}
                        onChange={v=>set(m.id,"pct_vitrage",Math.min(100,Math.max(0,parseInt(v)||0)).toString())}
                        placeholder="%" min="0" max="100" step="5"/>
                      <span className="text-xs text-gray-400 font-bold whitespace-nowrap">% vitré</span>
                    </div>
                    {/* Barre visuelle */}
                    <div className="mt-2 relative h-5 rounded-xl overflow-hidden bg-gray-200 border border-gray-300">
                      <div className="h-full bg-blue-400 rounded-l-xl transition-all"
                        style={{width:`${pctVit}%`}}/>
                      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-gray-700">
                        {Math.round(pctVit)}% vitré · {Math.round(100-pctVit)}% opaque
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Vitrage (affiché si pas porte opaque) */}
            {hasVitrage && (
              <div className="grid grid-cols-2 gap-2.5 mb-2.5">
                <div>
                  <p className="text-xs text-gray-400 font-bold mb-1.5">
                    {isPorte ? "Vitrage de la porte" : "Vitrage"}
                  </p>
                  <Select value={m.vitrage} onChange={v=>set(m.id,"vitrage",v)} opts={VITRAGES.map(v=>({v:v.v,l:v.l}))}/>
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-bold mb-1.5">Châssis</p>
                  <Select value={m.chassis} onChange={v=>set(m.id,"chassis",v)} opts={CHASSIS.map(c=>({v:c.v,l:c.l}))}/>
                </div>
              </div>
            )}

            {/* Masque solaire (uniquement vitrages, pas portes opaques) */}
            {!isPorte && (
              <div className="mb-2.5">
                <p className="text-xs text-gray-400 font-bold mb-1.5">Masque solaire proche (balcon, loggia, auvent...)</p>
                <Select value={m.masque} onChange={v=>set(m.id,"masque",v)} opts={[
                  {v:"aucun",    l:"Aucun masque proche"},
                  {v:"inf1m",    l:"Avancée / balcon < 1 m"},
                  {v:"1_2m",     l:"Avancée / balcon 1–2 m"},
                  {v:"2_3m",     l:"Avancée / balcon 2–3 m"},
                  {v:"sup3m",    l:"Avancée / balcon > 3 m"},
                  {v:"loggia",   l:"Fenêtre en fond de loggia fermée"},
                  {v:"paroi_lat",l:"Paroi latérale masquant le Sud"},
                ]}/>
              </div>
            )}

            {/* Local adjacent / Aiu-Aue */}
            {isPorte && (
              <div className="mb-2.5">
                <p className="text-xs text-gray-400 font-bold mb-1.5">Cette porte donne sur…</p>
                <div className="grid grid-cols-1 gap-1">
                  {LOCAL_ADJACENT.filter(l=>["exterieur","circ_ouverte","circ_fermee","garage_nc","cave_nc","tampon_solar","local_nc_calc","mitoyen"].includes(l.v)).map(opt=>(
                    <button key={opt.v} onClick={()=>set(m.id,"local_adjacent",opt.v)}
                      style={(m.local_adjacent||"exterieur")===opt.v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
                      className="w-full p-2 rounded-xl border-2 border-gray-200 text-left hover:border-gray-300 transition-all">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-black text-gray-800">{opt.l}</p>
                          <p className="text-[10px] text-gray-400 leading-snug">{opt.d}</p>
                        </div>
                        {opt.btr !== null ? (
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-xl flex-shrink-0
                            ${opt.btr===1?"bg-red-100 text-red-700":opt.btr===0?"bg-green-100 text-green-700":"bg-orange-100 text-orange-700"}`}>
                            b={opt.btr}
                          </span>
                        ) : (
                          <span className="text-[10px] font-black px-2 py-0.5 rounded-xl bg-purple-100 text-purple-700 flex-shrink-0">b calculé</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                {m.local_adjacent === "local_nc_calc" && (
                  <div className="grid grid-cols-2 gap-2 mt-2 bg-purple-50 border border-purple-200 rounded-xl p-2.5">
                    <div>
                      <p className="text-[10px] text-purple-700 font-bold mb-1">Aiu (m²) — vers logement</p>
                      <Input type="number" value={m.aiu||""} onChange={v=>set(m.id,"aiu",v)} placeholder="Ex: 15"/>
                    </div>
                    <div>
                      <p className="text-[10px] text-purple-700 font-bold mb-1">Aue (m²) — vers extérieur</p>
                      <Input type="number" value={m.aue||""} onChange={v=>set(m.id,"aue",v)} placeholder="Ex: 25"/>
                    </div>
                    {m.aiu && m.aue && (
                      <p className="col-span-2 text-[10px] font-black text-purple-700 text-center">
                        b_tr = {Math.round(parseFloat(m.aue)/(parseFloat(m.aiu)+parseFloat(m.aue))*100)/100}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Récapitulatif Uw effectif */}
            <div className={`rounded-2xl p-2.5 border flex items-center justify-between gap-3
              ${uw<=1.4?"border-green-200 bg-green-50":uw<=2.9?"border-orange-200 bg-orange-50":"border-red-200 bg-red-50"}`}>
              <div>
                <p className="text-[10px] text-gray-500 font-bold">
                  {isPorte
                    ? `Uw = ${uw} W/m²K (${MATERIAUX_PORTE.find(mp=>mp.v===m.materiau_porte)?.l||""}${m.type_ouv==="porte_vit"?` · ${pctVit}% vitré`:""})` 
                    : `Uw = ${uw} W/m²K · b = ${btr_menu}`
                  }
                </p>
                <p className="text-xs font-black" style={{color:uw<=1.4?"#166534":uw<=2.9?"#92400e":"#991b1b"}}>
                  {uw<=1.4?"✅ Très performant":uw<=2.9?"⚠️ Performance modérée":"❌ Très déperditif"}
                  {surf > 0 && ` · Dép. ≈ ${Math.round(uw*surf*btr_menu*10)/10} W/K`}
                </p>
              </div>
              {isPorte && uw > 2 && <span className="text-lg">🚪⚠️</span>}
              {!isPorte && m.vitrage==="simple" && <span className="text-lg">🪟❌</span>}
            </div>

            {m.vitrage==="simple" && !isPorte && (
              <p className="text-xs text-red-600 font-bold mt-1.5">⚠️ Remplacement prioritaire — perte ×4 vs double récent</p>
            )}
          </div>
          );
        })}
      </div>

      <button onClick={add}
        className="w-full py-3.5 rounded-2xl border-2 border-dashed border-blue-300 text-blue-600
          font-bold text-sm hover:bg-blue-50 transition-all mb-3">
        + Ajouter une menuiserie
      </button>
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-xs text-gray-400 self-center font-bold">Rapide :</span>
        {[
          {n:"Fenêtre SdB",  ouv:"fenetre",   extras:{}},
          {n:"Baie vitrée",  ouv:"pf",        extras:{}},
          {n:"Velux",        ouv:"velux",     extras:{}},
          {n:"Porte entrée", ouv:"porte_opa", extras:{materiau_porte:"acier_isole"}},
          {n:"Porte vitrée", ouv:"porte_vit", extras:{materiau_porte:"bois_massif",pct_vitrage:"30"}},
        ].map(f=>(
          <button key={f.n}
            onClick={()=>upd("menuiseries",[...d.menuiseries,{
              id:Date.now(), type_ouv:f.ouv, largeur:"1.00", hauteur:"2.10", nb:"1",
              mur_id:"", orientation:"S", vitrage:"double_rec", chassis:"pvc", masque:"aucun",
              materiau_porte:"bois_massif", pct_vitrage:"0",
              local_adjacent:"exterieur", aiu:"", aue:"",
              ...f.extras
            }])}
            className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-xl hover:bg-blue-50
              hover:text-blue-700 border border-gray-200 font-semibold transition-all">
            + {f.n}
          </button>
        ))}
      </div>

      <InfoBox icon="☀️" color="amber">
        <strong>Masques solaires (obligatoire dans le DPE officiel) :</strong> un balcon de 2 m réduit les apports
        solaires de ~30 %. Mesurez l'avancée à la règle. Les masques lointains se mesurent à la boussole + inclinomètre.
      </InfoBox>

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Ventilation →" canNext={d.menuiseries.length>0}/>
    </div>
  );
}

// ─── Step 7 : Ventilation ────────────────────────────

function Step7({ d, upd, onNext, onPrev }) {
  const set = (k,v) => upd("ventilation", {...d.ventilation,[k]:v});
  const [openGroupe, setOpenGroupe] = useState(null);

  // Déterminer le groupe actif et la clé Qvar courante
  const selItem   = VENTS_FLAT.find(i=>i.v===d.ventilation.type);
  const selGroupe = VENT_GROUPES.find(g=>g.items?.some(i=>i.v===d.ventilation.type));
  const qvarKey   = ventQvarKey(d.ventilation.type||"fenetres", d.ventilation.periode||"");
  const qvarVal   = QVAR_TABLE[qvarKey] ?? 1.2;

  // Périodes du groupe sélectionné
  const currentGroupe = VENT_GROUPES.find(g=>g.key===openGroupe) || selGroupe;

  return (
    <div>
      <InfoBox icon="🔍" color="blue">
        <strong>Identifier le système :</strong> cherchez des bouches d'extraction en cuisine, SdB et WC.
        Un caisson VMC se trouve en combles ou local technique — la plaque indique la marque et l'année.
        Des grilles sur châssis = entrées d'air VMC. Des grilles basses + hautes sans moteur = entrées hautes/basses.
        <strong> Sans système = ouverture des fenêtres (hypothèse la plus défavorable).</strong>
      </InfoBox>

      <div className="space-y-2.5 my-4">
        {VENT_GROUPES.map(groupe => {
          const isOpen = openGroupe===groupe.key || selGroupe?.key===groupe.key;
          const hasSelection = selGroupe?.key===groupe.key;
          return (
            <div key={groupe.key} className={`rounded-3xl border-2 overflow-hidden transition-all ${
              hasSelection?"border-blue-500":"border-gray-200"
            }`}>
              {/* En-tête groupe */}
              <button
                onClick={()=>setOpenGroupe(isOpen && !hasSelection ? null : groupe.key)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all ${
                  hasSelection?"bg-blue-50":"bg-white hover:bg-gray-50"
                }`}>
                <span className="text-xl w-7 text-center flex-shrink-0">{groupe.ico}</span>
                <p className={`flex-1 text-sm font-black ${hasSelection?"text-blue-900":"text-gray-700"}`}>{groupe.label}</p>
                {hasSelection && selItem && (
                  <span className="text-[10px] font-black bg-blue-600 text-white px-2 py-0.5 rounded-lg flex-shrink-0">
                    ✓ {selItem.l.split(" ").slice(1,3).join(" ")}
                  </span>
                )}
                <span className="text-gray-400 text-xs">{isOpen?"▲":"▼"}</span>
              </button>

              {/* Items du groupe */}
              {isOpen && (
                <div className="border-t border-gray-100 bg-gray-50 px-3 pt-2 pb-3 space-y-1.5">
                  {groupe.items.map(item => {
                    const isSelected = d.ventilation.type===item.v;
                    return (
                      <button key={item.v}
                        onClick={()=>{ set("type",item.v); set("periode",""); }}
                        className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-2xl border-2 text-left transition-all ${
                          isSelected?"border-blue-500 bg-blue-50":"border-gray-200 bg-white hover:border-blue-300"
                        }`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-black text-gray-800 leading-tight">{item.l.split(" ").slice(1).join(" ")}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">{item.d}</p>
                        </div>
                        {isSelected && (
                          <div className="flex-shrink-0 text-right">
                            <p className="text-[10px] font-black text-blue-500">Qva.conv</p>
                            <p className="text-base font-black text-blue-900">{qvarVal}</p>
                            <p className="text-[10px] text-blue-500 font-bold">m³/h.m²</p>
                          </div>
                        )}
                        {!isSelected && item.periodeMap && (
                          <span className="text-[10px] text-gray-400 flex-shrink-0 self-center">
                            {Math.min(...Object.values(item.periodeMap).map(k=>QVAR_TABLE[k]??99)).toFixed(2)}–
                            {Math.max(...Object.values(item.periodeMap).map(k=>QVAR_TABLE[k]??0)).toFixed(2)}
                          </span>
                        )}
                        {!isSelected && !item.periodeMap && (
                          <span className="text-[10px] font-bold text-gray-500 flex-shrink-0 self-center">
                            Qva={item.qvarRef}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Sélecteur de période si le type sélectionné a des variantes datées */}
      {selItem?.periodeMap && (() => {
        const groupe = VENT_GROUPES.find(g=>g.items?.some(i=>i.v===d.ventilation.type));
        if (!groupe?.periodes) return null;
        return (
          <div className="mt-2 mb-4">
            <p className="text-xs font-black text-gray-600 mb-1.5">{groupe.periodeLabel}</p>
            <div className="flex gap-2 flex-wrap">
              {groupe.periodes.map(p=>{
                const isP = (d.ventilation.periode||groupe.periodes[2]?.v||groupe.periodes[0]?.v)===p.v;
                const qk = selItem.periodeMap[p.v];
                return (
                  <button key={p.v}
                    onClick={()=>set("periode",p.v)}
                    className={`flex-1 min-w-[80px] px-2 py-2 rounded-xl border-2 text-center transition-all ${
                      isP?"border-blue-500 bg-blue-50":"border-gray-200 bg-white hover:border-blue-300"
                    }`}>
                    <p className={`text-xs font-black ${isP?"text-blue-800":"text-gray-700"}`}>{p.l}</p>
                    <p className={`text-[10px] font-bold mt-0.5 ${isP?"text-blue-600":"text-gray-400"}`}>
                      Qva={QVAR_TABLE[qk]??"-"}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Résumé */}
      {d.ventilation.type && (
        <InfoBox icon="📊" color="green">
          <strong>Qvarepconv = {qvarVal} m³/(h·m²)</strong>
          {selItem && <span> — {selItem.l.split(" ").slice(1).join(" ")}</span>}
          {qvarVal <= 0.50 && " ✅ Excellent — déperditions ventilation très réduites."}
          {qvarVal > 0.50 && qvarVal <= 1.00 && " ✅ Bon — système efficace."}
          {qvarVal > 1.00 && " ⚠️ Déperditions ventilation importantes (Qva élevé)."}
          {selItem?.periodeMap && !d.ventilation.periode && (
            <span className="block mt-1 font-semibold text-orange-700">⚠️ Sélectionnez la période d'installation pour une valeur précise.</span>
          )}
        </InfoBox>
      )}

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Chauffage →" canNext={!!d.ventilation.type}/>
    </div>
  );
}

// ─── Step 8 : Chauffage ──────────────────────────────

const NSP_IMPACT_CHAUFFAGE = {
  title: "Impact du « Je ne sais pas » sur votre DPE",
  items: [
    { label: "Meilleur cas (PAC air/eau, COP 3)", delta: "↓ 40 à 80 kWhep/m²/an", color: "#00843D", badge: "Gain 1–2 lettres" },
    { label: "Cas moyen (chaudière gaz cond.)", delta: "± 0 à 20 kWhep/m²/an", color: "#F0A030", badge: "Référence" },
    { label: "Pire cas (fioul standard, Rdt 78%)", delta: "↑ 30 à 70 kWhep/m²/an", color: "#C0001A", badge: "Perte 1–2 lettres" },
  ],
  note: "Par défaut, la simulation utilisera une chaudière fioul standard (hypothèse défavorable). Identifiez votre système pour améliorer la précision."
};

function NspWarning({ impact }) {
  return (
    <div className="rounded-3xl border-2 border-orange-300 bg-orange-50 p-4 my-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl">⚠️</span>
        <p className="font-black text-orange-800 text-sm">{impact.title}</p>
      </div>
      <div className="space-y-2 mb-3">
        {impact.items.map((item, i) => (
          <div key={i} className="flex items-center gap-2.5 bg-white rounded-2xl p-2.5 border border-orange-100">
            <span className="text-xs font-black px-2 py-1 rounded-xl text-white flex-shrink-0"
              style={{ background: item.color }}>{item.badge}</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-gray-700 truncate">{item.label}</p>
              <p className="text-xs font-black" style={{ color: item.color }}>{item.delta}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-orange-700 font-semibold leading-relaxed">{impact.note}</p>
    </div>
  );
}

function Step8({ d, upd, onNext, onPrev }) {
  const set = (k,v) => upd("chauffage", {...d.chauffage,[k]:v});
  const ch = d.chauffage.nsp ? null : CHAUFFAGES[d.chauffage.type];
  const zone = d.identification?.zone || "H1";
  const canGoNext = d.chauffage.nsp || !!d.chauffage.type;
  const [openGroupe, setOpenGroupe] = useState(null);

  // Rendement effectif affiché
  const effStr   = ch ? (ch.eff >= 2 ? `COP ${ch.eff}` : `Rdt ${Math.round(ch.eff*100)} %`) : null;
  const effColor = ch ? (ch.eff>=3?"#00843D":ch.eff>=2?"#39A84E":ch.eff>=0.9?"#F0A030":"#E0551E") : null;

  return (
    <div>
      <InfoBox icon="🔍" color="blue">
        <strong>Identifier le générateur :</strong> trouvez la plaque signalétique (marque, modèle, puissance, année).
        Pour une PAC, le SCOP est sur la fiche technique.
        Chaudière collective = carnet d'entretien ou AG de copropriété.
        <br/>Pour les radiateurs électriques, regardez l'étiquette en face avant (logo NF, type d'émetteur).
      </InfoBox>

      {/* Individuel / Collectif */}
      <div className="my-4">
        <Label sub="Détermine si vous maîtrisez votre consommation de chauffage">Type d'installation</Label>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {[
            { v:"individuel", l:"🏠 Individuel", d:"Chaudière, PAC ou convecteurs propres à votre logement" },
            { v:"collectif",  l:"🏢 Collectif",  d:"Chaufferie commune à l'immeuble ou réseau urbain" },
          ].map(opt => (
            <button key={opt.v} onClick={()=>set("type_installation", opt.v)}
              style={d.chauffage.type_installation===opt.v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
              className="p-3.5 rounded-2xl border-2 border-gray-200 text-left hover:border-gray-300 transition-all">
              <p className="text-sm font-black text-gray-800">{opt.l}</p>
              <p className="text-xs text-gray-400 mt-1 leading-snug">{opt.d}</p>
            </button>
          ))}
        </div>
        {d.chauffage.type_installation==="collectif" && (
          <div className="mt-3 bg-blue-50 border border-blue-200 rounded-2xl p-3">
            <p className="text-xs text-blue-800 font-semibold leading-relaxed">
              📋 <strong>Copropriété :</strong> caractéristiques du système collectif dans le carnet d'entretien
              ou le rapport d'AG de copropriété.
            </p>
          </div>
        )}
      </div>

      {/* NSP toggle */}
      <div className="flex items-center gap-3 bg-gray-50 rounded-2xl p-3.5 mb-4 border-2 border-gray-200">
        <button onClick={()=>{ set("nsp", !d.chauffage.nsp); if(!d.chauffage.nsp) set("type",""); }}
          style={d.chauffage.nsp?{background:"#F0A030"}:{}}
          className="w-10 h-5 rounded-full border-2 border-gray-300 transition-all relative flex items-center flex-shrink-0">
          <div style={{transform:d.chauffage.nsp?"translateX(20px)":"translateX(2px)"}}
            className="w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform absolute"/>
        </button>
        <div>
          <p className="text-sm font-black text-gray-700">Je ne sais pas quel système est installé</p>
          <p className="text-xs text-gray-400">Simulation avec hypothèse défavorable (fioul standard)</p>
        </div>
      </div>

      {d.chauffage.nsp && <NspWarning impact={NSP_IMPACT_CHAUFFAGE}/>}

      {/* ── Sélecteur générateur par groupe énergie ── */}
      {!d.chauffage.nsp && (
        <div className="space-y-2.5 my-4">
          {CHAUFFAGE_GROUPES.map(groupe => {
            const items = Object.entries(CHAUFFAGES).filter(([,c])=>c.groupe===groupe.key);
            const activeKey = d.chauffage.type;
            const hasSelection = items.some(([k])=>k===activeKey);
            const isOpen = openGroupe===groupe.key || hasSelection;
            return (
              <div key={groupe.key} className={`rounded-3xl border-2 overflow-hidden transition-all ${
                hasSelection?"border-blue-500":"border-gray-200"
              }`}>
                <button
                  onClick={()=>setOpenGroupe(isOpen&&!hasSelection?null:groupe.key)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all ${
                    hasSelection?"bg-blue-50":"bg-white hover:bg-gray-50"
                  }`}>
                  <span className="text-xl w-7 text-center flex-shrink-0">{groupe.ico}</span>
                  <p className={`flex-1 text-sm font-black ${hasSelection?"text-blue-900":"text-gray-700"}`}>{groupe.label}</p>
                  {hasSelection && (
                    <span className="text-[10px] font-black bg-blue-600 text-white px-2 py-0.5 rounded-lg flex-shrink-0 truncate max-w-[120px]">
                      ✓ {CHAUFFAGES[activeKey]?.label?.split(" ").slice(0,3).join(" ")}
                    </span>
                  )}
                  <span className="text-gray-400 text-xs flex-shrink-0">{isOpen?"▲":"▼"}</span>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-100 bg-gray-50 px-3 pt-2 pb-3 space-y-1.5">
                    {items.map(([k,c])=>(
                      <button key={k} onClick={()=>set("type",k)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl border-2 text-left transition-all ${
                          activeKey===k?"border-blue-500 bg-blue-50":"border-gray-200 bg-white hover:border-blue-300"
                        }`}>
                        <span className="text-base w-6 text-center flex-shrink-0">{c.ico}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-black text-gray-800 leading-tight">{c.label}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">{c.d}</p>
                        </div>
                        <span className="text-[10px] font-black px-2 py-1 rounded-xl text-white flex-shrink-0"
                          style={{background: c.eff>=3?"#00843D":c.eff>=2?"#39A84E":c.eff>=0.9?"#F0A030":"#E0551E"}}>
                          {c.eff>=2?`COP ${c.eff}`:`${Math.round(c.eff*100)} %`}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Sélectionné : fiche + paramètres ── */}
      {ch && (
        <>
          <div className="bg-blue-50 border-2 border-blue-100 rounded-2xl p-4 mb-4">
            <div className="flex items-center gap-4">
              <span className="text-4xl">{ch.ico}</span>
              <div>
                <p className="text-xs font-black text-blue-400 uppercase tracking-widest">Sélectionné</p>
                <p className="font-black text-blue-900">{ch.label}</p>
                <p className="text-xs text-blue-700 font-semibold">
                  Énergie : <strong>{ch.ep}</strong> · Rendement : <strong style={{color:effColor}}>{effStr}</strong>
                </p>
              </div>
            </div>
          </div>

          <Label sub="Estimez depuis la plaque signalétique ou l'acte d'achat">Année d'installation</Label>
          <Select value={d.chauffage.annee} onChange={v=>set("annee",v)} opts={[
            {v:"av_1980",l:"Avant 1980"},{v:"1980_2000",l:"1980 – 2000"},{v:"ap_2001",l:"Après 2001"},
          ]} placeholder="— Sélectionner —"/>

          {/* Isolation réseau (collectif) */}
          {d.chauffage.type_installation==="collectif" && (
            <div className="mt-4">
              <Label sub="Tuyaux apparents en sous-sol ou en chaufferie : sont-ils calorifugés ?">
                Isolation du réseau de distribution
              </Label>
              <div className="grid grid-cols-3 gap-2 mt-2">
                {[
                  { v:"bien_isole",  l:"✅ Bien isolé",  d:"Calorifuge ≥ 30 mm" },
                  { v:"partiel",     l:"⚠️ Partiel",      d:"Isolation incomplète" },
                  { v:"non_isole",   l:"❌ Non isolé",    d:"Tuyaux nus" },
                ].map(opt => (
                  <button key={opt.v} onClick={()=>set("isolation_reseau", opt.v)}
                    style={d.chauffage.isolation_reseau===opt.v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
                    className="p-2.5 rounded-2xl border-2 border-gray-200 text-center hover:border-gray-300 transition-all">
                    <p className="text-xs font-black text-gray-800">{opt.l}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{opt.d}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Émetteurs (individuel) */}
          {d.chauffage.type_installation==="individuel" && (
            <div className="mt-4">
              <Label sub="Le type d'émetteur influence Re et Rr (§12.1–12.3 arrêté)">
                Type d'émetteurs de chaleur
              </Label>
              <Select value={d.chauffage.distribution||""} onChange={v=>set("distribution",v)} opts={[
                {v:"radiateur_eau_rt", l:"Radiateur eau chaude avec robinet thermostatique (Rr=0,95)"},
                {v:"radiateur_eau",    l:"Radiateur eau chaude sans robinet thermostatique (Rr=0,90)"},
                {v:"radiateur_fonte",  l:"Radiateur fonte / inertie haute (Rr=0,90)"},
                {v:"plancher_eau",     l:"Plancher chauffant eau (Re=1,00 — Rr=0,95 indiv.)"},
                {v:"soufflage",        l:"Soufflage / gainable (Re=0,95 — Rd=0,85)"},
                {v:"conv_elec",        l:"Convecteur électrique NFC/NF** (Re=0,95 — Rr=0,99)"},
                {v:"rayon_elec",       l:"Panneau rayonnant électrique NF** (Re=0,97 — Rr=0,99)"},
                {v:"inertiel",         l:"Radiateur inertiel fonte/céramique (Rr=0,95)"},
                {v:"plancher_elec",    l:"Plancher chauffant électrique (Re=1,00 — Rr=0,98)"},
              ]} placeholder="— Type d'émetteurs —"/>
            </div>
          )}

          {/* ── Régulation — 5 niveaux + détection de présence (§8 arrêté) ── */}
          <div className="mt-4">
            <Label sub="I0 §8 arrêté — 5 niveaux selon équipement d'intermittence">
              Régulation du chauffage
            </Label>
            <div className="space-y-2 mt-2">
              {[
                { v:"aucune",     l:"⛔ Aucune régulation",                        d:"Pas d'équipement permettant un ralenti — Absent (§8)",                  i0:"0,84", int_label:"I₀=0,84", color:"#E0551E" },
                { v:"horloge",    l:"🕐 Horloge / programmateur central",          d:"Marche/arrêt uniquement — Central sans minimum de température (§8)",    i0:"0,83", int_label:"I₀=0,83", color:"#E0551E" },
                { v:"central_min",l:"🌡️ Thermostat central avec minimum",          d:"Ralenti ou abaissement de température, hors-gel garanti (§8)",          i0:"0,81", int_label:"I₀=0,81", color:"#F0A030" },
                { v:"thermostat", l:"🌡️ Thermostat central + minimum de temp.",    d:"Abaissement au choix de l'occupant + hors-gel — Central avec min (§8)", i0:"0,81", int_label:"I₀=0,81", color:"#F0A030" },
                { v:"zonale",     l:"🎛️ Régulation pièce par pièce (TRV / zone)", d:"Robinets thermostatiques ou zone jour/nuit — ralenti pièce par pièce",  i0:"0,77", int_label:"I₀=0,77", color:"#39A84E" },
                { v:"detection",  l:"👁️ Pièce par pièce + détection de présence", d:"TRV ou zone + capteur de présence ou fil pilote 6 ordres (§8 arrêté)",  i0:"0,75", int_label:"I₀=0,75", color:"#00843D" },
              ].map(opt=>(
                <button key={opt.v} onClick={()=>set("regulation",opt.v)}
                  style={d.chauffage.regulation===opt.v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
                  className="w-full p-3.5 rounded-2xl border-2 border-gray-200 text-left hover:border-gray-300 transition-all">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <p className="text-sm font-black text-gray-800">{opt.l}</p>
                      <p className="text-xs text-gray-400 mt-0.5 leading-snug">{opt.d}</p>
                    </div>
                    <span className="text-[10px] font-black px-2 py-1 rounded-xl flex-shrink-0 text-white"
                      style={{background:opt.color}}>
                      {opt.int_label}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-2 leading-snug">
              💡 I₀ = facteur d'intermittence §8 arrêté 31/03/2021. Pièce par pièce + détection de présence
              est le niveau d'économie maximal : <strong>I₀=0,75 vs 0,84 sans régulation → écart ~11 % sur Bch.</strong>
            </p>
          </div>
        </>
      )}

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Eau chaude sanitaire →" canNext={canGoNext}/>
    </div>
  );
}

// ─── Step 9 : ECS ────────────────────────────────────

const NSP_IMPACT_ECS = {
  title: "Impact du « Je ne sais pas » sur votre DPE",
  items: [
    { label: "Meilleur cas (chauffe-eau thermodynamique, COP 2,8)", delta: "↓ 10 à 20 kWhep/m²/an", color: "#00843D", badge: "Gain 0–1 lettre" },
    { label: "Cas moyen (ballon électrique standard)", delta: "± référence", color: "#F0A030", badge: "Référence" },
    { label: "Pire cas (ballon électrique sans isolation)", delta: "↑ 5 à 15 kWhep/m²/an", color: "#C0001A", badge: "Perte partielle" },
  ],
  note: "Par défaut, la simulation utilisera un ballon électrique standard. Identifiez votre système pour affiner le résultat."
};

function Step9({ d, upd, onNext, onPrev }) {
  const set = (k,v) => upd("ecs", {...d.ecs,[k]:v});
  const pv  = (k,v) => upd("photovoltaique", {...d.photovoltaique,[k]:v});
  const canGoNext = d.ecs.nsp || !!d.ecs.type;

  return (
    <div>
      <InfoBox icon="🔍" color="blue">
        <strong>Identifier le chauffe-eau :</strong> ballon dans cuisine, SdB ou placard technique.
        La plaque indique le type (électrique, gaz, thermodynamique), le volume et l'année.
        Une chaudière mixte produit simultanément le chauffage et l'eau chaude.
      </InfoBox>

      {/* Type individuel / collectif */}
      <div className="my-4">
        <Label sub="Un ECS collectif est partagé avec d'autres logements (compteur ou sous-compteur)">
          Type d'installation ECS
        </Label>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {[
            { v:"individuel", l:"🏠 Individuel", d:"Votre propre chauffe-eau ou production couplée à votre chaudière" },
            { v:"collectif",  l:"🏢 Collectif",  d:"Ballon ou échangeur commun à l'immeuble, avec distribution vers chaque logement" },
          ].map(opt => (
            <button key={opt.v} onClick={()=>set("type_installation", opt.v)}
              style={d.ecs.type_installation===opt.v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
              className="p-3.5 rounded-2xl border-2 border-gray-200 text-left hover:border-gray-300 transition-all">
              <p className="text-sm font-black text-gray-800">{opt.l}</p>
              <p className="text-xs text-gray-400 mt-1 leading-snug">{opt.d}</p>
            </button>
          ))}
        </div>
        {d.ecs.type_installation==="collectif" && (
          <div className="mt-3 bg-blue-50 border border-blue-200 rounded-2xl p-3">
            <p className="text-xs text-blue-800 font-semibold leading-relaxed">
              📋 <strong>ECS collectif :</strong> les pertes en distribution peuvent représenter <strong>15 à 30 %</strong> de
              la consommation ECS totale. L'isolation des colonnes montantes est un levier important.
            </p>
          </div>
        )}
      </div>

      {/* NSP toggle */}
      <div className="flex items-center gap-3 bg-gray-50 rounded-2xl p-3.5 mb-4 border-2 border-gray-200">
        <button onClick={()=>{ set("nsp", !d.ecs.nsp); if(!d.ecs.nsp) set("type",""); }}
          style={d.ecs.nsp?{background:"#F0A030"}:{}}
          className="w-10 h-5 rounded-full border-2 border-gray-300 transition-all relative flex items-center flex-shrink-0">
          <div style={{transform:d.ecs.nsp?"translateX(20px)":"translateX(2px)"}}
            className="w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform absolute"/>
        </button>
        <div>
          <p className="text-sm font-black text-gray-700">Je ne sais pas quel système ECS est installé</p>
          <p className="text-xs text-gray-400">Simulation avec ballon électrique standard (hypothèse conservative)</p>
        </div>
      </div>

      {d.ecs.nsp && <NspWarning impact={NSP_IMPACT_ECS}/>}

      {!d.ecs.nsp && (
        <div className="space-y-2 my-4">
          {Object.entries(ECS_SYS).map(([k,c])=>(
            <button key={k} onClick={()=>set("type",k)}
              style={d.ecs.type===k?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
              className="w-full p-4 rounded-2xl border-2 border-gray-200 text-left hover:border-gray-300
                transition-all flex items-center gap-3">
              <span className="text-2xl w-8 text-center flex-shrink-0">{c.ico}</span>
              <div className="flex-1">
                <p className="text-sm font-bold text-gray-800">{c.label}</p>
                {c.eff && <p className="text-xs text-gray-400">{c.eff>=2?`COP ${c.eff}`:`Rdt ${Math.round(c.eff*100)}%`} · énergie : {c.ep}</p>}
              </div>
              {d.ecs.type===k && <span className="text-blue-600 font-bold">✓</span>}
            </button>
          ))}
        </div>
      )}

      {d.ecs.type==="elec_bal" && (
        <div className="mb-4">
          <Label sub="Visible sur l'étiquette du chauffe-eau">Volume du ballon (litres)</Label>
          <Select value={d.ecs.volume||""} onChange={v=>set("volume",v)} opts={[
            {v:"50",l:"50 L — 1 personne"},{v:"100",l:"100 L — 2 personnes"},
            {v:"150",l:"150 L — 3–4 personnes"},{v:"200",l:"200+ L — 5+ personnes"},
          ]} placeholder="— Sélectionner —"/>
        </div>
      )}

      {/* Isolation du ballon / circuit */}
      {(d.ecs.type || d.ecs.nsp) && (
        <div className="mt-4">
          <Label sub="Un ballon ou une tuyauterie bien isolés réduisent les pertes thermiques en veille">
            Isolation du ballon et de la tuyauterie ECS
          </Label>
          <div className="space-y-2 mt-2">
            {[
              { v:"bonne",     l:"✅ Bonne isolation",         d:"Ballon classe A+, calorifuge sur toutes les canalisations ≥ 30 mm",   impact:"✅ Référence" },
              { v:"partielle", l:"⚠️ Isolation partielle",     d:"Ballon isolé, tuyauteries partiellement ou non calorifugées",          impact:"⚠️ +3 à 8 kWhep/m²/an" },
              { v:"aucune",    l:"❌ Peu ou pas isolé",         d:"Ancien ballon sans isolation ou isolant dégradé (toucher chaud)",      impact:"⚠️ +8 à 15 kWhep/m²/an" },
              { v:"nsp",       l:"🤷 NSP — Je ne sais pas",    d:"Hypothèse : isolation partielle retenue par défaut",                  impact:"⚠️ Incertitude ±5 kWhep/m²" },
            ].map(opt=>(
              <button key={opt.v} onClick={()=>set("isolation_ballon",opt.v)}
                style={d.ecs.isolation_ballon===opt.v?{borderColor:"#0f2d5e",background:"#f0f4fb"}:{}}
                className="w-full p-3.5 rounded-2xl border-2 border-gray-200 text-left hover:border-gray-300 transition-all">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-sm font-black text-gray-800">{opt.l}</p>
                    <p className="text-xs text-gray-400 mt-0.5 leading-snug">{opt.d}</p>
                  </div>
                  <span className={`text-[10px] font-black px-2 py-1 rounded-xl flex-shrink-0 whitespace-nowrap ${
                    opt.impact.startsWith("✅")?"bg-green-100 text-green-700":"bg-orange-100 text-orange-700"
                  }`}>{opt.impact}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Photovoltaïque */}
      <div className="bg-yellow-50 border-2 border-yellow-200 rounded-3xl p-5 mt-6">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="text-2xl">☀️</span>
          <h4 className="font-black text-yellow-800">Production photovoltaïque</h4>
        </div>
        <label className="flex items-center gap-3 cursor-pointer mb-4">
          <div onClick={()=>pv("present",!d.photovoltaique.present)}
            style={d.photovoltaique.present?{background:"#ca8a04"}:{}}
            className="w-10 h-5 rounded-full border-2 border-yellow-400 transition-all relative flex items-center">
            <div style={{transform:d.photovoltaique.present?"translateX(20px)":"translateX(2px)"}}
              className="w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform absolute"/>
          </div>
          <span className="text-sm font-bold text-yellow-800">Panneaux solaires PV installés</span>
        </label>
        {d.photovoltaique.present && (
          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <p className="text-xs text-yellow-700 font-bold mb-1.5">Surface (m²)</p>
              <Input type="number" value={d.photovoltaique.surface||""} onChange={v=>pv("surface",v)} placeholder="Ex: 12" min="1"/>
            </div>
            <div>
              <p className="text-xs text-yellow-700 font-bold mb-1.5">Orientation</p>
              <Select value={d.photovoltaique.orientation||"S"} onChange={v=>pv("orientation",v)} opts={ORIS}/>
            </div>
            <div>
              <p className="text-xs text-yellow-700 font-bold mb-1.5">Inclinaison °</p>
              <Input type="number" value={d.photovoltaique.inclinaison||"30"} onChange={v=>pv("inclinaison",v)} placeholder="30" min="0" max="90"/>
            </div>
          </div>
        )}
        <p className="text-xs text-yellow-700 mt-2 font-semibold">
          💡 Seule la part autoconsommée est prise en compte. À défaut de la surface, comptez nb modules × 1,6 m².
        </p>
      </div>

      <NavButtons onPrev={onPrev} onNext={onNext} nextLabel="Calculer mon DPE 🎯" canNext={canGoNext}/>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
//  SYNTHÈSE DOCUMENT
// ═══════════════════════════════════════════════════════

function computeCoherence(data, res) {
  let score = 100;
  const malus = [];
  const nspFields = [];

  // NSP chauffage = gros impact
  if (data.chauffage.nsp) {
    score -= 25;
    malus.push({ w: 25, label: "Système de chauffage inconnu", impact: "±40–80 kWhep/m²/an → ±1–2 lettres DPE" });
    nspFields.push("Chauffage");
  }
  // NSP ECS
  if (data.ecs.nsp) {
    score -= 12;
    malus.push({ w: 12, label: "Système ECS inconnu", impact: "±10–20 kWhep/m²/an → ±0–1 lettre DPE" });
    nspFields.push("ECS");
  }
  // Isolation ballon NSP
  if (data.ecs.isolation_ballon === "nsp" || !data.ecs.isolation_ballon) {
    score -= 5;
    malus.push({ w: 5, label: "Isolation ballon ECS inconnue", impact: "±5 kWhep/m²/an" });
    nspFields.push("Isolation ballon");
  }
  // Type installation chauffage inconnu
  if (!data.chauffage.type_installation && !data.chauffage.nsp) {
    score -= 5;
    malus.push({ w: 5, label: "Type d'installation chauffage non renseigné", impact: "Données réseau/émetteurs manquantes" });
  }
  // Murs : matériau non renseigné ou isolation inconnue
  if (data.murs.length === 0) {
    score -= 10;
    malus.push({ w: 10, label: "Aucun mur renseigné", impact: "Déperditions parois estimées par défaut" });
  }
  // Plancher non renseigné
  if (data.planchers.length === 0) {
    score -= 5;
    malus.push({ w: 5, label: "Plancher bas non renseigné", impact: "U plancher par défaut appliqué" });
  }
  // Toiture non renseignée
  if (data.toiture.length === 0) {
    score -= 8;
    malus.push({ w: 8, label: "Toiture non renseignée", impact: "Source de déperdition majeure non calculée" });
  }
  // Menuiseries absentes
  if (data.menuiseries.length === 0) {
    score -= 5;
    malus.push({ w: 5, label: "Menuiseries non renseignées", impact: "Apports solaires et pertes vitrages non calculés" });
  }
  // Ventilation absente
  if (!data.ventilation.type) {
    score -= 5;
    malus.push({ w: 5, label: "Ventilation non renseignée", impact: "Renouvellement d'air par défaut (défavorable)" });
  }
  // Régulation non renseignée
  if (!data.chauffage.regulation && !data.chauffage.nsp) {
    score -= 3;
    malus.push({ w: 3, label: "Régulation du chauffage non renseignée", impact: "±5–15% sur consommation chauffage" });
  }

  return { score: Math.max(score, 5), malus, nspFields };
}

const LABEL_MAP = {
  // identification
  type:         { "maison":"Maison individuelle", "appartement":"Appartement" },
  periode:      {
    av_1948:"Avant 1948", "1948_1974":"1948–1974", "1975_1977":"1975–1977",
    "1978_1982":"1978–1982", "1983_1988":"1983–1988", "1989_2000":"1989–2000",
    "2001_2005":"2001–2005", "2006_2012":"2006–2012", "ap_2013":"Après 2013"
  },
  zone:         { H1a:"H1a", H1b:"H1b", H1c:"H1c", H2a:"H2a", H2b:"H2b", H2c:"H2c", H2d:"H2d", H3:"H3" },
  vent_type:    { fenetres:"Fenêtres (aucun syst.)", naturelle:"Ventilation naturelle",
    vmc_auto:"VMC simple flux auto", vmc_hygro:"VMC hygroréglable B",
    vmc_double:"VMC double flux", hybride:"Hybride" },
  regulation:   { aucune:"Aucune", horloge:"Horloge / programmateur", thermostat:"Thermostat central",
    zonale:"Pièce par pièce (TRV)", smart:"Thermostat connecté" },
  isolation_ballon: { bonne:"Bien isolé (A+)", partielle:"Partielle", aucune:"Non isolé / dégradé", nsp:"NSP" },
  isolation_reseau: { bien_isole:"Bien isolé", partiel:"Partiel", non_isole:"Non isolé" },
  type_installation: { individuel:"Individuel", collectif:"Collectif" },
  distribution:  { radiateur_fonte:"Radiateurs fonte", radiateur_acier:"Radiateurs acier/alu",
    plancher_chauffant:"Plancher chauffant BT", convecteur_elec:"Convecteurs élec.", soufflage:"Soufflage / gainable" },
};

function SyntheseModal({ data, res, onClose }) {
  const { score, malus, nspFields } = computeCoherence(data, res);
  const { classe, cep, eges, cc, cg, sRef, coutMin, coutMax, nbOcc,
    conCh, conEcs, conAux, depertitons } = res;
  const consTot = conCh + conEcs + conAux;
  const LETTR = ["A","B","C","o","E","F","G"];
  const date = new Date().toLocaleDateString("fr-FR", { day:"2-digit", month:"long", year:"numeric" });

  const ch = data.chauffage.nsp ? null : CHAUFFAGES[data.chauffage.type];
  const ecsSys = data.ecs.nsp ? null : ECS_SYS[data.ecs.type];

  // Forces : éléments correctement renseignés et performants
  const forces = [];
  if (data.toiture[0]?.isole) forces.push({ i:"🏠", t:"Toiture isolée", d:"Déperditions par toiture maîtrisées" });
  if (data.planchers[0]?.isole) forces.push({ i:"⬛", t:"Plancher bas isolé", d:"Pont thermique plancher limité" });
  if (data.murs.length > 0 && data.murs.every(m=>m.isolation!=="non")) forces.push({ i:"🧱", t:"Murs tous isolés", d:"Enveloppe opaque performante" });
  if (data.menuiseries.length > 0 && data.menuiseries.every(m=>m.vitrage!=="simple")) forces.push({ i:"🪟", t:"Pas de simple vitrage", d:"Menuiseries ≥ double vitrage" });
  if (["vmc_double","vmc_hygro"].includes(data.ventilation.type)) forces.push({ i:"💨", t:"Ventilation performante", d:`${LABEL_MAP.vent_type[data.ventilation.type]}` });
  if (ch && ch.eff >= 2.5) forces.push({ i:"🔥", t:"Chauffage très efficace", d:`${ch.label} — ${ch.eff>=2?`COP ${ch.eff}`:`Rdt ${Math.round(ch.eff*100)}%`}` });
  if (["thermostat","zonale","smart","detection","central_min"].includes(data.chauffage.regulation)) forces.push({ i:"🎛️", t:"Bonne régulation", d:LABEL_MAP.regulation[data.chauffage.regulation] });
  if (data.ecs.type==="thermo" || data.ecs.type==="solaire") forces.push({ i:"💧", t:"ECS économe", d:ecsSys?.label || "" });
  if (data.photovoltaique?.present) forces.push({ i:"☀️", t:"Production PV", d:`${data.photovoltaique.surface} m² de panneaux solaires` });

  // Faiblesses
  const faiblesses = [];
  if (!data.toiture[0]?.isole && data.toiture.length > 0) faiblesses.push({ i:"🏠", t:"Toiture non isolée", d:"Jusqu'à 30% des déperditions — priorité n°1", delta:"↑ 30–80 kWhep/m²/an" });
  if (!data.planchers[0]?.isole && data.planchers.length > 0) faiblesses.push({ i:"⬛", t:"Plancher bas non isolé", d:"7–10% des déperditions", delta:"↑ 10–25 kWhep/m²/an" });
  if (data.murs.some(m=>m.isolation==="non")) faiblesses.push({ i:"🧱", t:"Murs non isolés", d:"Source majeure de déperditions", delta:"↑ 20–60 kWhep/m²/an" });
  if (data.menuiseries.some(m=>m.vitrage==="simple")) faiblesses.push({ i:"🪟", t:"Simple vitrage présent", d:"U = 5,8 W/m²K vs 1,4 pour double récent", delta:"↑ 5–20 kWhep/m²/an" });
  if (["fenetres","hautes_basses","naturelle_conduit","naturelle"].includes(data.ventilation.type)) faiblesses.push({ i:"💨", t:"Ventilation insuffisante", d:"Renouvellement incontrôlé — déperditions élevées", delta:"↑ 10–30 kWhep/m²/an" });
  if (ch && ch.eff < 0.85) faiblesses.push({ i:"🔥", t:"Chauffage peu efficace", d:`${ch.label} — Rdt ${Math.round(ch.eff*100)}%`, delta:"↑ 30–70 kWhep/m²/an vs PAC" });
  if (!data.chauffage.regulation || data.chauffage.regulation==="aucune") faiblesses.push({ i:"🎛️", t:"Régulation absente", d:"Surchauffe probable", delta:"↑ 10–15% conso chauffage" });
  if (data.ecs.type==="elec_bal" && data.ecs.isolation_ballon==="aucune") faiblesses.push({ i:"💧", t:"Ballon ECS non isolé", d:"Pertes en veille importantes", delta:"↑ 8–15 kWhep/m²/an" });

  const scoreColor = score >= 75 ? "#00843D" : score >= 50 ? "#F0A030" : "#C0001A";
  const scoreLabel = score >= 75 ? "Bonne cohérence" : score >= 50 ? "Cohérence modérée" : "Faible cohérence";

  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto"
      style={{ fontFamily: "system-ui, sans-serif" }}>
      <div className="min-h-screen py-6 px-4 print:py-0 print:px-0">
        <div id="synthese-print" className="max-w-2xl mx-auto bg-white rounded-3xl overflow-hidden shadow-2xl print:shadow-none print:rounded-none">

          {/* ── HEADER ── */}
          <div className="px-8 py-6 print:py-4" style={{ background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)" }}>
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/20">
                    <span className="text-white font-black text-lg">D</span>
                  </div>
                  <div>
                    <p className="text-white font-black text-xl leading-none">openDPE</p>
                    <p className="text-blue-300 text-xs">Méthode 3CL-DPE 2021 · Guide Cerema v3 2024</p>
                  </div>
                </div>
                <p className="text-blue-200 text-xs mt-2">Document de synthèse généré le {date}</p>
                <p className="text-blue-200 text-xs">
                  {LABEL_MAP.type[data.identification.type] || "Logement"} ·{" "}
                  {Math.round(sRef)} m² · Zone {data.identification.zone || "—"} ·{" "}
                  {LABEL_MAP.periode[data.identification.periode] || "période inconnue"}
                </p>
              </div>
              <button onClick={onClose}
                className="text-white/60 hover:text-white text-2xl font-black print:hidden">✕</button>
            </div>
          </div>

          {/* ── PRINT BUTTON ── */}
          <div className="flex gap-3 px-8 pt-4 print:hidden">
            <button onClick={()=>window.print()}
              className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-white text-sm font-black shadow-lg hover:opacity-90 transition-all"
              style={{ background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)" }}>
              🖨️ Imprimer / Enregistrer en PDF
            </button>
            <button onClick={onClose}
              className="px-5 py-2.5 rounded-2xl bg-gray-100 text-gray-600 text-sm font-bold hover:bg-gray-200 transition-all">
              ← Retour
            </button>
          </div>

          <div className="px-8 py-6 space-y-6">

            {/* ── NOTE DPE DOUBLE ÉTIQUETTE ── */}
            <section>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">Note DPE finale</p>
              <div className="grid grid-cols-2 gap-4">
                {/* Énergie primaire */}
                <div className="rounded-2xl overflow-hidden border-2" style={{ borderColor: CLASS_COL[cc].bg }}>
                  <div className="px-4 py-2 text-xs font-black text-white" style={{ background: CLASS_COL[cc].bg }}>
                    ⚡ CONSOMMATION ÉNERGÉTIQUE
                  </div>
                  <div className="p-4 bg-white">
                    <div className="flex items-end gap-2 mb-1">
                      <span className="text-5xl font-black leading-none" style={{ color: CLASS_COL[cc].bg }}>{cc}</span>
                      <span className="text-sm font-black text-gray-500 mb-1">{cep} kWhep/m²/an</span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {LETTR.map(c => (
                        <div key={c} className={`flex items-center gap-1.5 ${c===cc?"opacity-100":"opacity-30"}`}>
                          <div className="w-5 h-3.5 rounded-sm flex-shrink-0" style={{ background: CLASS_COL[c].bg }}/>
                          <span className="text-[10px] font-bold text-gray-600">{c}</span>
                          {c===cc && <span className="text-[10px] font-black" style={{ color:CLASS_COL[c].bg }}>◄ {cep}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {/* GES */}
                <div className="rounded-2xl overflow-hidden border-2" style={{ borderColor: CLASS_COL[cg].bg }}>
                  <div className="px-4 py-2 text-xs font-black text-white" style={{ background: CLASS_COL[cg].bg }}>
                    🌿 ÉMISSIONS GES (CO₂)
                  </div>
                  <div className="p-4 bg-white">
                    <div className="flex items-end gap-2 mb-1">
                      <span className="text-5xl font-black leading-none" style={{ color: CLASS_COL[cg].bg }}>{cg}</span>
                      <span className="text-sm font-black text-gray-500 mb-1">{eges} kgCO₂/m²/an</span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {LETTR.map(c => (
                        <div key={c} className={`flex items-center gap-1.5 ${c===cg?"opacity-100":"opacity-30"}`}>
                          <div className="w-5 h-3.5 rounded-sm flex-shrink-0" style={{ background: CLASS_COL[c].bg }}/>
                          <span className="text-[10px] font-bold text-gray-600">{c}</span>
                          {c===cg && <span className="text-[10px] font-black" style={{ color:CLASS_COL[c].bg }}>◄ {eges}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              {/* Note finale retenue */}
              <div className="mt-3 rounded-2xl p-4 flex items-center gap-4 border-2"
                style={{ borderColor: CLASS_COL[classe].bg, background: CLASS_COL[classe].bg + "15" }}>
                <span className="text-5xl font-black" style={{ color: CLASS_COL[classe].bg }}>{classe}</span>
                <div>
                  <p className="font-black text-sm text-gray-700">
                    Note retenue : <strong style={{ color: CLASS_COL[classe].bg }}>classe {classe}</strong>
                    {cc !== cg && <span className="text-xs text-gray-500 ml-2">(déclassée par l'énergie {cc !== classe ? "primaire" : "GES"})</span>}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">La note finale est la moins bonne des deux composantes énergie et GES.</p>
                  <p className="text-sm font-black mt-1" style={{ color: CLASS_COL[classe].bg }}>
                    Coût estimé : {coutMin.toLocaleString("fr")} – {coutMax.toLocaleString("fr")} €/an
                  </p>
                </div>
              </div>
            </section>

            {/* ── INDICATEURS CLÉS ── */}
            <section>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">Indicateurs clés</p>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { e:"⚡", l:"Énergie primaire", v:`${cep} kWhep/m²/an`, c:"#0f2d5e", bg:"#f0f4fb" },
                  { e:"🌿", l:"Émissions GES",    v:`${eges} kgCO₂/m²/an`, c:"#166534", bg:"#f0fdf4" },
                  { e:"💶", l:"Coût annuel",       v:`${coutMin.toLocaleString("fr")}–${coutMax.toLocaleString("fr")} €`, c:"#92400e", bg:"#fffbeb" },
                  { e:"🔥", l:"Chauffage",         v:`${conCh.toLocaleString("fr")} kWh/an`, c:"#9a3412", bg:"#fff7ed" },
                  { e:"💧", l:"ECS",               v:`${conEcs.toLocaleString("fr")} kWh/an`, c:"#075985", bg:"#f0f9ff" },
                  { e:"👥", l:"Occupants estimés", v:`${nbOcc} pers. (${Math.round(sRef)} m²)`, c:"#4c1d95", bg:"#f5f3ff" },
                ].map(k => (
                  <div key={k.l} style={{ background: k.bg }} className="rounded-2xl p-3 border border-white">
                    <span className="text-lg">{k.e}</span>
                    <p className="text-[10px] text-gray-400 mt-1 leading-tight font-bold">{k.l}</p>
                    <p className="font-black text-xs mt-0.5" style={{ color: k.c }}>{k.v}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* ── RÉCAPITULATIF OPTIONS ── */}
            <section>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">Récapitulatif des options saisies</p>
              <div className="rounded-2xl overflow-hidden border border-gray-100">
                {[
                  { cat:"🏡 Bien",        items:[
                    { l:"Type", v: LABEL_MAP.type[data.identification.type] || "—" },
                    { l:"Période de construction", v: LABEL_MAP.periode[data.identification.periode] || "—" },
                    { l:"Zone climatique", v: data.identification.zone || "—" },
                    { l:"Altitude", v: data.identification.altitude ? `${data.identification.altitude} m` : "—" },
                    { l:"ID-RNB", v: data.identification.rnb_id || "Non renseigné" },
                    { l:"Surface habitable", v: `${Math.round(sRef)} m²` },
                  ]},
                  { cat:"🧱 Enveloppe",   items:[
                    { l:"Murs", v: data.murs.length > 0 ? `${data.murs.length} paroi(s) — ${[...new Set(data.murs.map(m=>m.materiau))].join(", ")}` : "Non renseigné" },
                    { l:"Isolation murs", v: data.murs.length > 0 ? [...new Set(data.murs.map(m=>m.isolation))].map(v=>({non:"Non isolé",iti:"ITI",ite:"ITE",reparti:"Réparti"}[v]||v)).join(", ") : "—" },
                    { l:"Plancher bas", v: data.planchers[0] ? `${({terre_plein:"Terre-plein",vide_sanitaire:"Vide sanitaire",sous_sol:"Sous-sol",bois:"Plancher bois"}[data.planchers[0].type]||data.planchers[0].type)} — ${data.planchers[0].isole?"Isolé":"Non isolé"}` : "Non renseigné" },
                    { l:"Toiture", v: data.toiture[0] ? `${({combles_perdus:"Combles perdus",rampant:"Rampant",terrasse:"Terrasse",plafond_inter:"Plafond inter."}[data.toiture[0].type]||data.toiture[0].type)} — ${data.toiture[0].isole?"Isolé":"Non isolé"}` : "Non renseigné" },
                    { l:"Vitrages", v: data.menuiseries.length > 0 ? `${data.menuiseries.length} menuiserie(s) — ${[...new Set(data.menuiseries.map(m=>({simple:"Simple",double_old:"Double ancien",double_rec:"Double récent",triple:"Triple"}[m.vitrage]||m.vitrage)))].join(", ")}` : "Non renseigné" },
                  ]},
                  { cat:"💨 Ventilation", items:[
                    { l:"Système", v: LABEL_MAP.vent_type[data.ventilation.type] || "Non renseigné" },
                    { l:"Année", v: ({av_1982:"Avant 1982","1982_2000":"1982–2000","2001_2012":"2001–2012",ap_2012:"Après 2012"}[data.ventilation.annee]) || "—" },
                  ]},
                  { cat:"🔥 Chauffage",   items:[
                    { l:"Type d'installation", v: LABEL_MAP.type_installation[data.chauffage.type_installation] || "—" },
                    { l:"Générateur", v: data.chauffage.nsp ? "⚠️ NSP — hypothèse fioul std" : (ch?.label || "—") },
                    { l:"Rendement", v: data.chauffage.nsp ? "NSP" : (ch ? (ch.eff>=2?`COP ${ch.eff}`:`Rdt ${Math.round(ch.eff*100)}%`) : "—") },
                    { l:"Énergie", v: data.chauffage.nsp ? "NSP" : (ch?.ep || "—") },
                    { l:"Année d'installation", v: ({av_1980:"Avant 1980","1980_2000":"1980–2000",ap_2001:"Après 2001"}[data.chauffage.annee]) || "—" },
                    { l:"Régulation", v: LABEL_MAP.regulation[data.chauffage.regulation] || "Non renseignée" },
                    { l:"Émetteurs", v: LABEL_MAP.distribution[data.chauffage.distribution] || "—" },
                    { l:"Isolation réseau", v: LABEL_MAP.isolation_reseau[data.chauffage.isolation_reseau] || "—" },
                  ]},
                  { cat:"💧 ECS",         items:[
                    { l:"Type d'installation", v: LABEL_MAP.type_installation[data.ecs.type_installation] || "—" },
                    { l:"Système", v: data.ecs.nsp ? "⚠️ NSP — hypothèse ballon élec." : (ecsSys?.label || "—") },
                    { l:"Rendement", v: data.ecs.nsp ? "NSP" : (ecsSys ? (ecsSys.eff>=2?`COP ${ecsSys.eff}`:`Rdt ${Math.round(ecsSys.eff*100)}%`) : "Couplé chaudière") },
                    { l:"Isolation ballon", v: LABEL_MAP.isolation_ballon[data.ecs.isolation_ballon] || "Non renseignée" },
                  ]},
                ].map(section => (
                  <div key={section.cat}>
                    <div className="px-4 py-2.5 text-xs font-black text-white"
                      style={{ background:"#0f2d5e" }}>{section.cat}</div>
                    {section.items.map((item, idx) => (
                      <div key={idx}
                        className={`flex items-start px-4 py-2 border-b border-gray-50 ${idx%2===0?"bg-white":"bg-gray-50/50"}`}>
                        <span className="text-xs text-gray-400 font-semibold w-44 flex-shrink-0">{item.l}</span>
                        <span className={`text-xs font-black ${item.v?.startsWith("⚠️")?"text-orange-600":"text-gray-800"}`}>{item.v}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>

            {/* ── DÉPERDITIONS ── */}
            <section>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">Répartition des déperditions thermiques</p>
              <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                {[
                  { l:"🧱 Murs",          v: depertitons.murs, c:"#E0551E" },
                  { l:"⬛ Plancher bas",   v: depertitons.pb,   c:"#6366f1" },
                  { l:"🏠 Toiture",       v: depertitons.toit, c:"#0f2d5e" },
                  { l:"🪟 Vitrages",      v: depertitons.vit,  c:"#1E8A6E" },
                  { l:"💨 Ventilation",   v: depertitons.vent, c:"#92400e" },
                ].map(p => (
                  <div key={p.l} className="mb-2.5">
                    <div className="flex justify-between text-xs font-bold mb-1">
                      <span className="text-gray-700">{p.l}</span>
                      <span style={{ color: p.c }}>{p.v}%</span>
                    </div>
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width:`${p.v}%`, background: p.c }}/>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* ── FORCES ── */}
            {forces.length > 0 && (
              <section>
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">✅ Forces du bien</p>
                <div className="grid grid-cols-2 gap-2">
                  {forces.map((f,i) => (
                    <div key={i} className="flex items-start gap-2.5 bg-green-50 border border-green-200 rounded-2xl p-3">
                      <span className="text-lg flex-shrink-0">{f.i}</span>
                      <div>
                        <p className="text-xs font-black text-green-800">{f.t}</p>
                        <p className="text-[10px] text-green-700 mt-0.5">{f.d}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── FAIBLESSES ── */}
            {faiblesses.length > 0 && (
              <section>
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">⚠️ Faiblesses identifiées</p>
                <div className="space-y-2">
                  {faiblesses.map((f,i) => (
                    <div key={i} className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-2xl p-3">
                      <span className="text-lg flex-shrink-0">{f.i}</span>
                      <div className="flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-black text-red-800">{f.t}</p>
                          <span className="text-[10px] font-black bg-red-100 text-red-700 px-2 py-0.5 rounded-xl flex-shrink-0">{f.delta}</span>
                        </div>
                        <p className="text-[10px] text-red-700 mt-0.5">{f.d}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── ÉLÉMENTS NSP ET IMPACTS ── */}
            {malus.length > 0 && (
              <section>
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">🤷 Éléments non connus — impact sur le résultat</p>
                <div className="space-y-2">
                  {malus.map((m, i) => (
                    <div key={i} className="flex items-start gap-3 bg-orange-50 border border-orange-200 rounded-2xl p-3">
                      <span className="text-lg flex-shrink-0">❓</span>
                      <div className="flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-black text-orange-800">{m.label}</p>
                          <span className="text-[10px] font-black bg-orange-200 text-orange-800 px-2 py-0.5 rounded-xl flex-shrink-0 whitespace-nowrap">
                            -{m.w} pts
                          </span>
                        </div>
                        <p className="text-[10px] text-orange-700 mt-0.5 font-semibold">{m.impact}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── INDICE DE COHÉRENCE ── */}
            <section>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">🎯 Probabilité de cohérence du DPE simulé</p>
              <div className="rounded-2xl border-2 p-5" style={{ borderColor: scoreColor, background: scoreColor + "10" }}>
                <div className="flex items-center gap-5 mb-4">
                  <div className="relative w-20 h-20 flex-shrink-0">
                    <svg viewBox="0 0 80 80" className="w-full h-full">
                      <circle cx="40" cy="40" r="34" fill="none" stroke="#e5e7eb" strokeWidth="8"/>
                      <circle cx="40" cy="40" r="34" fill="none" stroke={scoreColor} strokeWidth="8"
                        strokeDasharray={`${2*Math.PI*34*score/100} ${2*Math.PI*34*(100-score)/100}`}
                        strokeLinecap="round"
                        transform="rotate(-90 40 40)"/>
                      <text x="40" y="38" textAnchor="middle" fill={scoreColor} fontSize="16" fontWeight="900">{score}%</text>
                      <text x="40" y="52" textAnchor="middle" fill="#6b7280" fontSize="7">cohérence</text>
                    </svg>
                  </div>
                  <div>
                    <p className="text-lg font-black" style={{ color: scoreColor }}>{scoreLabel}</p>
                    <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                      {score >= 75
                        ? "Les données saisies sont suffisamment complètes pour que le résultat soit une approximation fiable. L'écart avec un DPE officiel devrait rester limité (±1 lettre)."
                        : score >= 50
                        ? "Plusieurs données importantes sont manquantes ou estimées. L'écart avec un DPE officiel peut atteindre 1–2 lettres."
                        : "De nombreux éléments clés sont inconnus. Le résultat est très indicatif — l'écart avec la réalité peut dépasser 2 lettres."
                      }
                    </p>
                  </div>
                </div>
                {/* Barre de score */}
                <div className="h-3 bg-gray-200 rounded-full overflow-hidden mb-2">
                  <div className="h-full rounded-full transition-all"
                    style={{ width:`${score}%`, background:`linear-gradient(90deg,#C0001A,#F0A030,#00843D)` }}/>
                </div>
                <div className="flex justify-between text-[10px] text-gray-400 font-bold">
                  <span>0% — Aucune donnée</span>
                  <span>50% — Données partielles</span>
                  <span>100% — Données complètes</span>
                </div>
                {malus.length > 0 && (
                  <p className="text-xs text-gray-500 mt-3 font-semibold">
                    <strong>Pour améliorer la précision :</strong> renseigner{" "}
                    {malus.slice(0,3).map(m=>m.label.toLowerCase()).join(", ")}{malus.length>3?" et d'autres champs":"."}.
                  </p>
                )}
              </div>
            </section>

            {/* ── DISCLAIMER ── */}
            <section className="bg-gray-50 rounded-2xl p-4 border border-gray-200">
              <p className="text-[10px] text-gray-500 leading-relaxed">
                <strong>⚠️ Simulation à titre pédagogique.</strong> Cette synthèse ne saurait en aucun cas remplacer le travail d'un
                diagnostiqueur certifié. La méthode est volontairement simplifiée. Seul un DPE effectué par un{" "}
                <strong>diagnostiqueur certifié et assuré, enregistré à l'ADEME</strong>, peut avoir une <strong>opposabilité légale</strong>.
                openDPE · Méthode 3CL-DPE 2021 · {date}
              </p>
            </section>

          </div>
        </div>
      </div>

      {/* Print styles */}
      <style>{`
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
          .fixed { position: static !important; }
          .overflow-y-auto { overflow: visible !important; }
          .bg-black\\/70 { background: white !important; }
          .shadow-2xl { box-shadow: none !important; }
          .rounded-3xl { border-radius: 0 !important; }
          @page { margin: 1cm; size: A4; }
        }
      `}</style>
    </div>
  );
}

// ─── Step 10 : Résultats ─────────────────────────────

// Correspondance recommandation → étape de saisie
const ISSUE_STEP = {
  "Toiture":     5,
  "Plancher":    4,
  "Murs":        3,
  "Vitrages":    6,
  "Ventilation": 7,
  "Chauffage":   8,
  "ECS":         9,
};

// ═══════════════════════════════════════════════════════
//  SAVE MODAL
// ═══════════════════════════════════════════════════════

function SaveModal({ data, res, onClose }) {
  const { classe, cep, eges, coutMin, coutMax, sRef } = res;

  // Form state
  const [form, setForm] = useState({
    prenom:"", nom:"", email:"",
    adresse:"", cp:"", ville:"", etage:"",
  });
  const [ssoProvider, setSsoProvider] = useState(null); // "google"|"apple"|"meta"
  const [status, setStatus] = useState("idle"); // idle|saving|saved|error
  const [savedId, setSavedId] = useState(null);
  const [existing, setExisting] = useState([]); // DPE sauvegardés
  const [showExisting, setShowExisting] = useState(false);
  const [errors, setErrors] = useState({});

  // Charger les DPE existants
  const loadExisting = async () => {
    try {
      const keys = await window.storage.list("dpe:");
      const items = [];
      for (const k of (keys?.keys||[])) {
        try {
          const r = await window.storage.get(k);
          if (r?.value) items.push({ key: k, ...JSON.parse(r.value) });
        } catch {}
      }
      items.sort((a,b)=>(b.date||0)-(a.date||0));
      setExisting(items);
    } catch {}
  };

  // Mock SSO — pré-remplir le formulaire
  const mockSSO = (provider) => {
    setSsoProvider(provider);
    const mocks = {
      google: { prenom:"Jean", nom:"Dupont", email:"jean.dupont@gmail.com" },
      apple:  { prenom:"Marie", nom:"Martin", email:"m.martin@icloud.com" },
      meta:   { prenom:"Pierre", nom:"Durand", email:"pierre.durand@outlook.com" },
    };
    setForm(f=>({ ...f, ...mocks[provider] }));
  };

  const validate = () => {
    const e = {};
    if (!form.prenom.trim()) e.prenom = "Requis";
    if (!form.nom.trim()) e.nom = "Requis";
    if (!form.email.trim() || !/^[^@]+@[^@]+\.[^@]+$/.test(form.email)) e.email = "Email invalide";
    if (!form.adresse.trim()) e.adresse = "Requis";
    if (!form.ville.trim()) e.ville = "Requis";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setStatus("saving");
    try {
      const id = `dpe:${Date.now()}`;
      const payload = {
        date: Date.now(),
        prenom: form.prenom, nom: form.nom, email: form.email,
        adresse: form.adresse, cp: form.cp, ville: form.ville, etage: form.etage,
        ssoProvider,
        classe, cep, eges, coutMin, coutMax, sRef,
        // Snapshot clés du logement
        periode: data.identification.periode,
        zone: data.identification.zone,
        type: data.identification.type,
        murs: data.murs.length,
        nbMenuiseries: data.menuiseries.length,
        chauffage: data.chauffage.type,
        snapshot: JSON.stringify(data).slice(0,4000), // snapshot tronqué
      };
      await window.storage.set(id, JSON.stringify(payload));
      setSavedId(id);
      setStatus("saved");
      loadExisting();
    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  };

  // Charger au montage
  const [mounted, setMounted] = useState(false);
  if (!mounted) { loadExisting(); }

  const fld = (key, label, placeholder, type="text", required=false) => (
    <div>
      <p className="text-xs font-bold text-gray-600 mb-1">
        {label}{required&&<span className="text-red-500 ml-0.5">*</span>}
      </p>
      <input
        type={type}
        value={form[key]}
        onChange={e=>{ setForm(f=>({...f,[key]:e.target.value})); setErrors(er=>({...er,[key]:undefined})); }}
        placeholder={placeholder}
        className={`w-full px-3 py-2.5 rounded-xl border-2 text-sm font-medium outline-none transition-all
          ${errors[key]?"border-red-400 bg-red-50":"border-gray-200 bg-gray-50 focus:border-blue-400 focus:bg-white"}`}
      />
      {errors[key] && <p className="text-[10px] text-red-500 font-bold mt-0.5">{errors[key]}</p>}
    </div>
  );

  const SSO_PROVIDERS = [
    {
      id:"google", label:"Google",
      bg:"#fff", border:"#dadce0", color:"#3c4043",
      logo:(
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
      ),
    },
    {
      id:"apple", label:"Apple",
      bg:"#000", border:"#000", color:"#fff",
      logo:(
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
        </svg>
      ),
    },
    {
      id:"meta", label:"Facebook",
      bg:"#1877F2", border:"#1877F2", color:"#fff",
      logo:(
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
        </svg>
      ),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto flex items-start justify-center p-4"
      style={{fontFamily:"system-ui,sans-serif"}}>
      <div className="w-full max-w-lg my-6">
        <div className="bg-white rounded-3xl overflow-hidden shadow-2xl">

          {/* Header */}
          <div className="px-6 py-5 flex items-center justify-between"
            style={{background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)"}}>
            <div>
              <p className="text-white font-black text-lg leading-none">💾 Enregistrer mon DPE</p>
              <p className="text-blue-300 text-xs mt-1">Sauvegardez votre simulation pour y revenir plus tard</p>
            </div>
            <button onClick={onClose} className="text-white/60 hover:text-white text-2xl font-black">✕</button>
          </div>

          {/* Récapitulatif de la note */}
          <div className="mx-6 mt-5 rounded-2xl p-4 flex items-center gap-4 border-2"
            style={{borderColor:CLASS_COL[classe].bg, background:CLASS_COL[classe].bg+"15"}}>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-md"
              style={{background:CLASS_COL[classe].bg}}>
              <span className="text-3xl font-black leading-none text-white">{classe}</span>
            </div>
            <div>
              <p className="font-black text-gray-900">{cep} kWhep/m²/an · {eges} kgCO₂/m²/an</p>
              <p className="text-xs text-gray-500">{Math.round(sRef)} m² · {coutMin.toLocaleString("fr")}–{coutMax.toLocaleString("fr")} €/an</p>
            </div>
          </div>

          <div className="px-6 py-5 space-y-5">

            {/* ── Connexion SSO ── */}
            {status !== "saved" && (
              <div>
                <p className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">
                  Connexion rapide
                </p>
                <div className="space-y-2">
                  {SSO_PROVIDERS.map(p=>(
                    <button key={p.id}
                      onClick={()=>mockSSO(p.id)}
                      style={{background:p.bg, borderColor:p.border, color:p.color}}
                      className={`w-full flex items-center justify-center gap-3 py-3 px-4 rounded-2xl
                        border-2 font-bold text-sm transition-all hover:opacity-90 active:scale-[.98]
                        ${ssoProvider===p.id?"ring-2 ring-blue-400 ring-offset-2":""}`}>
                      {p.logo}
                      <span>Continuer avec {p.label}</span>
                      {ssoProvider===p.id && <span className="ml-auto text-xs opacity-60">✓ Connecté</span>}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-gray-200"/>
                  <span className="text-xs text-gray-400 font-bold">ou remplir manuellement</span>
                  <div className="flex-1 h-px bg-gray-200"/>
                </div>
              </div>
            )}

            {/* ── Formulaire ── */}
            {status !== "saved" && (
              <div className="space-y-3">
                {/* Nom / Prénom */}
                <div className="grid grid-cols-2 gap-3">
                  {fld("prenom","Prénom","Jean",      "text", true)}
                  {fld("nom",   "Nom",   "Dupont",    "text", true)}
                </div>
                {/* Email */}
                {fld("email","Email","jean@exemple.fr","email",true)}

                {/* Adresse */}
                <div>
                  <p className="text-xs font-bold text-gray-600 mb-1">Adresse<span className="text-red-500 ml-0.5">*</span></p>
                  <input type="text" value={form.adresse}
                    onChange={e=>{ setForm(f=>({...f,adresse:e.target.value})); setErrors(er=>({...er,adresse:undefined})); }}
                    placeholder="12 rue de la Paix"
                    className={`w-full px-3 py-2.5 rounded-xl border-2 text-sm font-medium outline-none transition-all
                      ${errors.adresse?"border-red-400 bg-red-50":"border-gray-200 bg-gray-50 focus:border-blue-400 focus:bg-white"}`}/>
                  {errors.adresse && <p className="text-[10px] text-red-500 font-bold mt-0.5">{errors.adresse}</p>}
                </div>

                {/* CP + Ville + Étage */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-xs font-bold text-gray-600 mb-1">Code postal</p>
                    <input type="text" value={form.cp} maxLength={5}
                      onChange={e=>setForm(f=>({...f,cp:e.target.value}))}
                      placeholder="75001"
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-gray-200 bg-gray-50 text-sm font-medium outline-none focus:border-blue-400 focus:bg-white transition-all"/>
                  </div>
                  <div className="col-span-1">
                    <p className="text-xs font-bold text-gray-600 mb-1">Ville<span className="text-red-500 ml-0.5">*</span></p>
                    <input type="text" value={form.ville}
                      onChange={e=>{ setForm(f=>({...f,ville:e.target.value})); setErrors(er=>({...er,ville:undefined})); }}
                      placeholder="Paris"
                      className={`w-full px-3 py-2.5 rounded-xl border-2 text-sm font-medium outline-none transition-all
                        ${errors.ville?"border-red-400 bg-red-50":"border-gray-200 bg-gray-50 focus:border-blue-400 focus:bg-white"}`}/>
                    {errors.ville && <p className="text-[10px] text-red-500 font-bold mt-0.5">{errors.ville}</p>}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-600 mb-1">Étage</p>
                    <input type="text" value={form.etage}
                      onChange={e=>setForm(f=>({...f,etage:e.target.value}))}
                      placeholder="RDC, 2ème…"
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-gray-200 bg-gray-50 text-sm font-medium outline-none focus:border-blue-400 focus:bg-white transition-all"/>
                  </div>
                </div>

                {/* RGPD note */}
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                  <p className="text-[10px] text-gray-500 leading-relaxed">
                    🔒 <strong>Confidentialité :</strong> vos données sont stockées localement dans votre navigateur.
                    Elles ne sont ni transmises à des tiers ni utilisées à des fins commerciales.
                    Les boutons SSO sont illustratifs — aucune connexion réelle n'est établie dans ce simulateur.
                  </p>
                </div>

                {/* Bouton sauvegarder */}
                <button onClick={handleSave} disabled={status==="saving"}
                  style={{background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)"}}
                  className="w-full py-3.5 rounded-2xl text-white font-black text-sm hover:opacity-90 transition-all shadow-lg disabled:opacity-60 flex items-center justify-center gap-2">
                  {status==="saving" ? (
                    <><span className="animate-spin">⏳</span> Enregistrement…</>
                  ) : (
                    <><span>💾</span> Enregistrer mon DPE</>
                  )}
                </button>

                {status==="error" && (
                  <p className="text-xs text-red-600 font-bold text-center">
                    ❌ Erreur lors de la sauvegarde. Stockage local peut-être indisponible.
                  </p>
                )}
              </div>
            )}

            {/* ── Succès ── */}
            {status==="saved" && (
              <div className="py-6 text-center">
                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">✅</span>
                </div>
                <p className="font-black text-gray-900 text-lg mb-1">DPE enregistré !</p>
                <p className="text-sm text-gray-500 mb-1">
                  {form.prenom} {form.nom} · {form.adresse}{form.etage?`, ${form.etage}`:""}, {form.cp} {form.ville}
                </p>
                <p className="text-xs text-gray-400 mb-5">Retrouvez-le dans "Mes DPE sauvegardés" ci-dessous</p>
                <button onClick={onClose}
                  style={{background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)"}}
                  className="px-8 py-3 rounded-2xl text-white font-black text-sm hover:opacity-90 transition-all">
                  ← Retour aux résultats
                </button>
              </div>
            )}

            {/* ── DPE sauvegardés ── */}
            {existing.length > 0 && (
              <div className="border-t border-gray-100 pt-4">
                <button onClick={()=>setShowExisting(v=>!v)}
                  className="w-full flex items-center justify-between py-2 group">
                  <p className="text-xs font-black text-gray-500 uppercase tracking-widest">
                    📂 Mes DPE sauvegardés ({existing.length})
                  </p>
                  <span className="text-gray-400 group-hover:text-gray-700 transition-colors">
                    {showExisting?"▲":"▼"}
                  </span>
                </button>
                {showExisting && (
                  <div className="mt-2 space-y-2">
                    {existing.map((item,i)=>(
                      <div key={i} className="bg-gray-50 border border-gray-200 rounded-2xl p-3 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 font-black text-white text-base shadow-sm"
                          style={{background:CLASS_COL[item.classe]?.bg||"#888"}}>
                          {item.classe}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-black text-gray-800 truncate">
                            {item.prenom} {item.nom}
                          </p>
                          <p className="text-[10px] text-gray-400 truncate">
                            {item.adresse}{item.etage?`, ${item.etage}`:""} — {item.ville}
                          </p>
                          <p className="text-[10px] text-gray-400">
                            {item.cep} kWhep/m²/an · {new Date(item.date).toLocaleDateString("fr-FR")}
                          </p>
                        </div>
                        <button
                          onClick={async()=>{ try{ await window.storage.delete(item.key); loadExisting(); }catch{} }}
                          className="text-gray-300 hover:text-red-400 transition-colors text-sm font-black flex-shrink-0">
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}


function Step10({ data, onRestart, onPrev, onGoToStep }) {
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const [showSynthese, setShowSynthese] = useState(false);
  const [showRevision, setShowRevision] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const res = useMemo(() => computeDPE(data), [data]);
  if (!res) return (
    <div className="text-center py-12">
      <span className="text-5xl mb-4 block">⚠️</span>
      <p className="font-black text-gray-700 text-xl">Données insuffisantes</p>
      <button onClick={onPrev} className="mt-4 px-6 py-3 rounded-2xl bg-gray-100 font-bold text-sm">← Compléter</button>
    </div>
  );

  const { classe, cep, eges, sRef, coutMin, coutMax, nbOcc, cc, cg,
    conCh, conEcs, conAux, depertitons } = res;
  const ccfg = CLASS_COL[classe];
  const LETTR = ["A","B","C","o","E","F","G"];

  const issues = [];
  if (!data.toiture[0]?.isole)                               issues.push({i:"🏠",t:"Toiture",m:"Isoler les combles — gain jusqu'à 30% de chauffage",s:5});
  if (!data.planchers[0]?.isole)                             issues.push({i:"⬛",t:"Plancher",m:"Isoler le plancher bas — gain 7–10%",s:4});
  if (data.murs.some(m=>m.isolation==="non"))                issues.push({i:"🧱",t:"Murs",m:"Isoler les murs déperditifs (ITI ou ITE)",s:3});
  if (data.menuiseries.some(m=>m.vitrage==="simple"))        issues.push({i:"🪟",t:"Vitrages",m:"Remplacer le simple vitrage (U=5,8 → 1,4 W/m²K)",s:6});
  if (["fenetres","hautes_basses","naturelle_conduit","naturelle"].includes(data.ventilation.type))                    issues.push({i:"💨",t:"Ventilation",m:"Installer une VMC hygroréglable",s:7});
  if (["elec_joul","fioul_std"].includes(data.chauffage.type)) issues.push({i:"🔥",t:"Chauffage",m:"Passer à une PAC (COP 3) ou chaudière à condensation",s:8});

  const consTot = conCh + conEcs + conAux;

  return (
    <div>
      {/* Modal synthèse */}
      {showSynthese && <SyntheseModal data={data} res={res} onClose={()=>setShowSynthese(false)}/>}

      {/* Modal enregistrement */}
      {showSave && <SaveModal data={data} res={res} onClose={()=>setShowSave(false)}/>}

      {/* Boutons actions */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <button onClick={()=>setShowSynthese(true)}
          className="py-3.5 rounded-2xl font-black text-sm flex items-center justify-center gap-2 border-2 hover:opacity-90 transition-all shadow-md"
          style={{ background:"linear-gradient(135deg,#0f7a5e,#1a9a78)", color:"#fff", borderColor:"#0f7a5e" }}>
          <span>📄</span>
          Synthèse PDF
        </button>
        <button onClick={()=>setShowSave(true)}
          className="py-3.5 rounded-2xl font-black text-sm flex items-center justify-center gap-2 border-2 hover:opacity-90 transition-all shadow-md"
          style={{ background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)", color:"#fff", borderColor:"#0f2d5e" }}>
          <span>💾</span>
          Enregistrer
        </button>
      </div>

      {/* Étiquette DPE officielle */}
      <div className="relative">
        <div className="rounded-3xl overflow-hidden border-4 shadow-2xl mb-6"
          style={{borderColor:ccfg.bg}}>
          <div className="px-6 py-4" style={{background:"#0f2d5e"}}>
            <p className="text-xs font-black text-blue-300 uppercase tracking-widest">Résultat simulation DPE 3CL-2021</p>
            <p className="text-white font-bold text-sm opacity-70">Surface : {Math.round(sRef)} m² · {nbOcc} occupant{nbOcc>1?"s":""} estimé{nbOcc>1?"s":""}</p>
          </div>
          {/* Barres étiquettes */}
          {LETTR.map(c=>{
            const cfg = CLASS_COL[c];
            const active = c === classe;
            return (
              <div key={c} className={`flex items-center transition-all ${active?"":"opacity-50"}`}
                style={{background: active?cfg.bg+"22":"#fff"}}>
                <div className="w-12 h-10 flex items-center justify-center flex-shrink-0"
                  style={{background:cfg.bg}}>
                  <span className="font-black text-base" style={{color:cfg.txt}}>{c}</span>
                </div>
                <div className="flex-1 h-10 flex items-center pr-4 pl-2 border-b border-gray-100 relative">
                  <div className="h-5 rounded-r-full flex items-center pl-2"
                    style={{width:`${cfg.bar}%`,background:cfg.bg+(active?"cc":"44")}}>
                  </div>
                  {active && (
                    <div className="absolute right-3 flex items-center gap-2">
                      <span className="text-sm font-black" style={{color:cfg.bg}}>{cep} kWhep/m²</span>
                      <span className="text-xl">◄</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {/* Badge classe */}
          <div className="px-6 py-5" style={{background:ccfg.bg}}>
            <div className="flex items-center gap-5">
              <div className="w-20 h-20 rounded-2xl bg-white/20 flex items-center justify-center">
                <span className="text-6xl font-black leading-none" style={{color:"#fff"}}>{classe}</span>
              </div>
              <div>
                <p className="font-black text-2xl" style={{color:"#fff"}}>{CLASS_COL[classe].bg === "#C0001A" ? "Passoire thermique ⚠️" : CLASS_COL[classe].bg === "#00843D" ? "Très performant ✅" : "Performance : "+classe}</p>
                <p style={{color:"rgba(255,255,255,.7)"}} className="text-sm mt-1">
                  {cep} kWhep/m²/an · {eges} kgCO₂/m²/an
                </p>
                <p style={{color:"rgba(255,255,255,.9)"}} className="text-sm font-bold mt-1">
                  Coût estimé : {coutMin.toLocaleString("fr")}€ – {coutMax.toLocaleString("fr")}€/an
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        {[
          {e:"⚡",l:"Énergie primaire",v:`${cep} kWhep/m²/an`,c:"#0f2d5e",bg:"#f0f4fb"},
          {e:"🌿",l:"Émissions GES",v:`${eges} kgCO₂/m²/an`,c:"#166534",bg:"#f0fdf4"},
          {e:"💶",l:"Coût annuel",v:`${coutMin.toLocaleString("fr")} – ${coutMax.toLocaleString("fr")} €`,c:"#92400e",bg:"#fffbeb"},
          {e:"👥",l:"Occupants estimés",v:`${nbOcc} personne${nbOcc>1?"s":""}`,c:"#4c1d95",bg:"#f5f3ff"},
        ].map(k=>(
          <div key={k.l} style={{background:k.bg}} className="rounded-2xl p-4 border border-white">
            <span className="text-xl">{k.e}</span>
            <p className="text-xs text-gray-400 mt-1.5 leading-tight">{k.l}</p>
            <p className="font-black text-sm mt-0.5" style={{color:k.c}}>{k.v}</p>
          </div>
        ))}
      </div>

      {/* Ponts thermiques */}
      {res.ptDetail?.pts?.length > 0 && (
        <div className="bg-indigo-950 rounded-3xl p-5 mb-5">
          <p className="text-xs font-black text-indigo-300 uppercase tracking-widest mb-4">
            🔗 Ponts thermiques — {res.ptDetail.totalPT} W/K total
          </p>
          {res.ptDetail.pts.map((pt,i)=>{
            const def = PSI_DISPLAY[pt.type];
            return (
              <div key={i} className="mb-3">
                <div className="flex justify-between text-xs font-bold mb-1.5">
                  <span className="text-indigo-200">{def?.ico} {def?.lbl}</span>
                  <span className="text-indigo-300">{pt.longueur}m · Ψ={pt.psi} → <span className="text-white font-black">{pt.pt} W/K</span></span>
                </div>
                <div className="h-2 bg-indigo-900 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-indigo-400"
                    style={{width:`${Math.min(100,pt.pt/res.ptDetail.totalPT*100)}%`}}/>
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-indigo-400 mt-3 font-semibold">
            Ψ forfaitaires 3CL-DPE 2021 · Isolation dominante : {({non:"Non isolé",iti:"ITI",ite:"ITE",reparti:"Répartie"}[res.ptDetail.isoDomMur||res.ptDetail.isoDom]||res.ptDetail.isoDomMur||res.ptDetail.isoDom)}
          </p>
        </div>
      )}

      {/* Déperditions */}
      <div className="bg-gray-50 rounded-3xl p-5 mb-5 border border-gray-100">
        <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4">Origine des déperditions</p>
        {[
          {l:"🧱 Murs",         v:depertitons.murs, c:"#E0551E"},
          {l:"⬛ Plancher bas",  v:depertitons.pb,   c:"#6366f1"},
          {l:"🏠 Toiture",      v:depertitons.toit, c:"#0f2d5e"},
          {l:"🪟 Vitrages",     v:depertitons.vit,  c:"#1E8A6E"},
          {l:"💨 Ventilation",  v:depertitons.vent, c:"#92400e"},
        ].map(p=>(
          <div key={p.l} className="mb-3">
            <div className="flex justify-between text-xs font-bold mb-1">
              <span className="text-gray-700">{p.l}</span>
              <span style={{color:p.c}}>{p.v}%</span>
            </div>
            <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-1000"
                style={{width:`${p.v}%`,background:p.c}}/>
            </div>
          </div>
        ))}
      </div>

      {/* Consommations */}
      <div className="bg-blue-950 rounded-3xl p-5 mb-5">
        <p className="text-xs font-black text-blue-300 uppercase tracking-widest mb-4">Consommations énergie finale</p>
        {[
          {l:"🔥 Chauffage",             v:conCh,   c:"#fb923c"},
          {l:"💧 ECS",                   v:conEcs,  c:"#38bdf8"},
          {l:"⚙️ Auxiliaires & éclairage",v:conAux,  c:"#a78bfa"},
        ].map(p=>(
          <div key={p.l} className="mb-3">
            <div className="flex justify-between text-xs font-bold mb-1.5">
              <span className="text-blue-200">{p.l}</span>
              <span style={{color:p.c}}>{Math.round(p.v/consTot*100)}% · {p.v.toLocaleString("fr")} kWh/an</span>
            </div>
            <div className="h-2 bg-blue-900 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{width:`${Math.round(p.v/consTot*100)}%`,background:p.c}}/>
            </div>
          </div>
        ))}
      </div>

      {/* ── Réviser les hypothèses ── */}
      <div className="border-2 border-gray-200 rounded-3xl mb-5 overflow-hidden">
        <button onClick={()=>setShowRevision(v=>!v)}
          className="w-full flex items-center justify-between px-5 py-4 bg-gray-50 hover:bg-gray-100 transition-all">
          <div className="flex items-center gap-3">
            <span className="text-lg">✏️</span>
            <div className="text-left">
              <p className="text-sm font-black text-gray-800">Réviser les hypothèses</p>
              <p className="text-xs text-gray-400">Retourner sur n'importe quelle étape de saisie</p>
            </div>
          </div>
          <span className="text-gray-400 font-bold">{showRevision?"▲":"▼"}</span>
        </button>

        {showRevision && (
          <div className="px-5 pb-5 pt-3 bg-white">
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-3">
              Cliquez sur une étape pour la modifier — les résultats seront recalculés automatiquement
            </p>
            <div className="grid grid-cols-3 gap-2">
              {STEPS.filter(s=>s.id<10).map(s=>{
                // Indicateur de complétude rapide
                const filled = (() => {
                  if (s.id===1) return !!data.identification.type && !!data.identification.zone;
                  if (s.id===2) return data.pieces.some(p=>parseFloat(p.surface)>0);
                  if (s.id===3) return data.murs.length>0;
                  if (s.id===4) return data.planchers.length>0;
                  if (s.id===5) return data.toiture.length>0;
                  if (s.id===6) return data.menuiseries.length>0;
                  if (s.id===7) return !!data.ventilation.type;
                  if (s.id===8) return !!data.chauffage.type || data.chauffage.nsp;
                  if (s.id===9) return !!data.ecs.type || data.ecs.nsp;
                  return false;
                })();
                return (
                  <button key={s.id}
                    onClick={()=>{ setShowRevision(false); onGoToStep(s.id); }}
                    className="relative flex flex-col items-center gap-1.5 p-3 rounded-2xl border-2 border-gray-200
                      hover:border-blue-400 hover:bg-blue-50 active:scale-95 transition-all text-center group">
                    <span className="text-xl">{s.icon}</span>
                    <span className="text-[10px] font-black text-gray-700 leading-snug">{s.label}</span>
                    <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${filled?"bg-green-400":"bg-amber-300"}`}/>
                    <span className="absolute inset-0 rounded-2xl ring-2 ring-blue-400 ring-offset-1 opacity-0 group-hover:opacity-100 transition-all pointer-events-none"/>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-400 mt-3">
              <span className="inline-block w-2 h-2 rounded-full bg-green-400 mr-1 align-middle"/>Complété
              <span className="inline-block w-2 h-2 rounded-full bg-amber-300 mx-1 ml-3 align-middle"/>Partiel / vide
            </p>
          </div>
        )}
      </div>

      {/* Recommandations — cliquables → étape de saisie */}
      {issues.length > 0 && (
        <div className="border-2 border-amber-200 bg-amber-50 rounded-3xl p-5 mb-5">
          <p className="text-xs font-black text-amber-700 uppercase tracking-widest mb-1">
            ⚠️ Travaux prioritaires identifiés
          </p>
          <p className="text-[10px] text-amber-600 mb-3 font-semibold">
            → Cliquez sur un élément pour vérifier et corriger sa saisie
          </p>
          <div className="space-y-2">
            {issues.map((r,i)=>(
              <button key={i}
                onClick={()=>onGoToStep(r.s)}
                className="w-full flex gap-3 bg-white rounded-2xl p-3.5 border border-amber-100
                  hover:border-amber-400 hover:bg-amber-50 active:scale-[.98] transition-all text-left group">
                <span className="text-xl flex-shrink-0">{r.i}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-black text-amber-800">{r.t}</p>
                  <p className="text-xs text-amber-700 mt-0.5">{r.m}</p>
                </div>
                <span className="flex-shrink-0 self-center text-amber-400 group-hover:text-amber-600 font-black text-sm transition-colors">
                  ✏️
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {classe <= "C" && (
        <InfoBox icon="✅" color="green">
          <strong>Logement énergétiquement performant.</strong> Maintenez vos équipements en bon état
          et continuez à optimiser vos usages. Pensez à vérifier l'entretien annuel du système de chauffage.
        </InfoBox>
      )}

      {/* Disclaimer obligatoire */}
      <div className={`rounded-3xl border-2 p-5 mb-5 mt-4 transition-all ${
        disclaimerChecked ? "border-green-400 bg-green-50" : "border-red-300 bg-red-50"
      }`}>
        <div className="flex items-start gap-3 mb-4">
          <button onClick={()=>setDisclaimerChecked(v=>!v)}
            className={`mt-0.5 w-6 h-6 rounded-lg border-2 flex-shrink-0 flex items-center justify-center transition-all ${
              disclaimerChecked
                ? "bg-green-500 border-green-500"
                : "bg-white border-red-400 animate-pulse"
            }`}>
            {disclaimerChecked && <span className="text-white text-xs font-black">✓</span>}
          </button>
          <div>
            {!disclaimerChecked && (
              <p className="text-xs font-black text-red-600 uppercase tracking-wide mb-2">
                ⚠️ À lire et cocher obligatoirement avant toute utilisation
              </p>
            )}
            {disclaimerChecked && (
              <p className="text-xs font-black text-green-700 uppercase tracking-wide mb-2">
                ✅ Lu et accepté
              </p>
            )}
            <p className="text-xs text-gray-700 leading-relaxed">
              Cette simulation à titre pédagogique <strong>ne saurait en aucun cas remplacer le travail d'un diagnostiqueur certifié.</strong>{" "}
              openDPE vise à vous permettre d'appréhender le diagnostic de performance énergétique.
              La méthode est <strong>volontairement simplifiée</strong> : la note réelle de votre bien pourra donc être éloignée de celle attribuée par openDPE.
            </p>
            <p className="text-xs text-gray-700 leading-relaxed mt-2">
              Seul un DPE effectué par un <strong>diagnostiqueur certifié et assuré, enregistré à l'ADEME</strong>, peut avoir une <strong>opposabilité légale</strong>.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 pt-3 border-t border-gray-200">
          <a href="https://france-renov.gouv.fr" target="_blank" rel="noopener noreferrer"
            className="text-xs font-bold text-blue-600 hover:underline">🏠 france-renov.gouv.fr</a>
          <a href="https://observatoire-dpe-audit.ademe.fr" target="_blank" rel="noopener noreferrer"
            className="text-xs font-bold text-blue-600 hover:underline">📊 Observatoire ADEME</a>
        </div>
      </div>

      <button onClick={onRestart} disabled={!disclaimerChecked}
        style={disclaimerChecked ? {background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)"} : {background:"#d1d5db"}}
        className={`w-full py-4 rounded-2xl text-white font-black text-sm transition-all shadow-lg ${
          disclaimerChecked ? "hover:opacity-90 cursor-pointer" : "cursor-not-allowed opacity-60"
        }`}>
        {disclaimerChecked ? "🔄 Nouvelle simulation" : "☝️ Cochez l'avertissement ci-dessus pour continuer"}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
//  APP ROOT
// ═══════════════════════════════════════════════════════

export default function App() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState(INIT);

  const upd = useCallback((section, value) => {
    setData(d => ({ ...d, [section]: value }));
  }, []);

  const next = () => setStep(s => Math.min(s + 1, 10));
  const prev = () => setStep(s => Math.max(s - 1, 0));
  const restart = () => { setData(INIT); setStep(0); };
  const goTo = (n) => setStep(n);

  const stepProps = { d:data, upd, onNext:next, onPrev:prev };

  // ── Écran d'accueil ─────────────────────────────────
  if (step === 0) return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{background:"linear-gradient(160deg,#0f2d5e 0%,#1a4a8a 50%,#0f7a5e 100%)"}}>
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-24 h-24 rounded-3xl mb-5 shadow-2xl"
            style={{background:"linear-gradient(135deg,#1a5c8a,#0f7a5e)"}}>
            <span className="text-5xl">🏠</span>
          </div>
          <h1 className="text-5xl font-black text-white tracking-tighter mb-2">
            open<span style={{color:"#5eead4"}}>DPE</span>
          </h1>
          <p className="text-blue-200 font-light text-lg">Diagnostiqueur de performance énergétique</p>
          <div className="inline-flex items-center gap-2 mt-3 bg-white/10 backdrop-blur rounded-full px-4 py-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"/>
            <span className="text-xs text-white font-bold">Méthode 3CL-DPE 2021 · Guide Cerema v3 juillet 2024</span>
          </div>
        </div>

        <div className="bg-white rounded-3xl p-6 shadow-2xl mb-5">
          <p className="text-gray-600 text-sm leading-relaxed mb-5 text-center">
            Calculez la classe énergétique de votre logement étape par étape,
            selon la méthode officielle des diagnostiqueurs immobiliers.
          </p>
          <div className="grid grid-cols-3 gap-2.5 mb-5">
            {STEPS.filter(s=>s.id<10).map(s=>(
              <div key={s.id} className="bg-gray-50 rounded-2xl p-2.5 text-center border border-gray-100">
                <span className="text-xl block mb-1">{s.icon}</span>
                <p className="text-xs font-bold text-gray-600">{s.label}</p>
              </div>
            ))}
          </div>
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-3.5 mb-5">
            <p className="text-xs text-blue-800 leading-relaxed">
              <strong>🛠️ Préparez :</strong> mètre ruban ou télémètre, plans si disponibles,
              plaques signalétiques des équipements de chauffage et ECS.
              Durée estimée : <strong>5–10 minutes</strong>.
            </p>
          </div>
          <button onClick={next}
            style={{background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)"}}
            className="w-full py-4 rounded-2xl text-white font-black text-base
              hover:opacity-90 transition-all shadow-lg shadow-blue-900/30">
            Commencer la simulation →
          </button>
        </div>

        <p className="text-center text-blue-300 text-xs">
          Simulation indicative · DPE officiel par diagnostiqueur certifié
        </p>
      </div>
    </div>
  );

  // ── App wrapper ─────────────────────────────────────
  return (
    <div className="min-h-screen" style={{background:"#F1F5F9"}}>
      {/* Top bar */}
      <div className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-gray-200 shadow-sm">
        <div className="max-w-lg mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shadow"
                style={{background:"linear-gradient(135deg,#0f2d5e,#1a5c8a)"}}>
                <span className="text-white font-black text-sm">D</span>
              </div>
              <div>
                <p className="font-black text-sm leading-none" style={{color:"#0f2d5e"}}>openDPE</p>
                <p className="text-xs text-gray-400 leading-none">3CL-2021 · Cerema 2024</p>
              </div>
            </div>
            {step < 10 && (
              <div className="text-right">
                <p className="text-xs font-black text-gray-400">{step > 0 ? STEPS[step-1]?.label : ""}</p>
                <p className="text-xs text-gray-400">Étape {step}/9</p>
              </div>
            )}
            {step === 10 && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-emerald-600">✅ Résultats</span>
              </div>
            )}
          </div>
          {/* Barre de progression — visible étapes 1-9 seulement */}
          {step > 0 && step < 10 && (
            <div className="flex gap-1">
              {STEPS.filter(s=>s.id<=9).map(s=>(
                <div key={s.id}
                  className={`h-1.5 flex-1 rounded-full transition-all duration-500
                    ${s.id < step ? "opacity-100" : s.id === step ? "opacity-100" : "opacity-20"}`}
                  style={{background: s.id <= step ? "linear-gradient(90deg,#0f2d5e,#1a5c8a)" : "#cbd5e1"}}/>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Steps nav (mini) — visible étapes 1-9 ET étape 10 pour la révision */}
      {step > 0 && (
        <div className="max-w-lg mx-auto px-4 pt-3">
          <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide">
            {STEPS.filter(s=>s.id<=9).map(s=>(
              <button key={s.id}
                onClick={()=>goTo(s.id)}
                style={s.id===step?{background:"#0f2d5e",color:"#fff",borderColor:"#0f2d5e"}:
                       step===10?{background:"#f0f4ff",color:"#0f2d5e",borderColor:"#bfcfff"}:{}}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-gray-200
                  text-xs font-bold flex-shrink-0 transition-all
                  ${step < 10 && s.id < step ? "bg-gray-100 text-gray-500 hover:bg-blue-50 cursor-pointer" : ""}
                  ${step < 10 && s.id > step ? "opacity-30 cursor-not-allowed bg-white text-gray-400" : ""}
                  ${step === 10 ? "hover:bg-blue-100 hover:border-blue-400 cursor-pointer" : ""}`}>
                <span>{s.icon}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
            ))}
            {/* Onglet Résultats */}
            <button
              onClick={()=>goTo(10)}
              style={step===10?{background:"#0f7a5e",color:"#fff",borderColor:"#0f7a5e"}:{}}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-gray-200
                text-xs font-bold flex-shrink-0 transition-all hover:bg-emerald-50 hover:border-emerald-400 cursor-pointer">
              <span>🎯</span>
              <span className="hidden sm:inline">Résultats</span>
            </button>
          </div>
          {step === 10 && (
            <p className="text-[10px] text-blue-500 font-semibold pb-1 px-1">
              ← Cliquez sur n'importe quelle étape pour corriger vos saisies
            </p>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="max-w-lg mx-auto px-4 py-4 pb-16">
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-5 md:p-7">
          {step === 1  && <Step1  {...stepProps}/>}
          {step === 2  && <Step2  {...stepProps}/>}
          {step === 3  && <Step3  {...stepProps}/>}
          {step === 4  && <Step4  {...stepProps}/>}
          {step === 5  && <Step5  {...stepProps}/>}
          {step === 6  && <Step6  {...stepProps}/>}
          {step === 7  && <Step7  {...stepProps}/>}
          {step === 8  && <Step8  {...stepProps}/>}
          {step === 9  && <Step9  {...stepProps}/>}
          {step === 10 && <Step10 data={data} onRestart={restart} onPrev={prev} onGoToStep={goTo}/>}
        </div>
        {/* Bandeau "Retour aux résultats" quand on est sur une étape après avoir vu les résultats */}
        {step > 0 && step < 10 && (
          <button onClick={()=>goTo(10)}
            className="mt-3 w-full py-2.5 rounded-2xl bg-emerald-50 border border-emerald-200
              text-emerald-700 font-bold text-xs hover:bg-emerald-100 transition-all flex items-center justify-center gap-2">
            <span>🎯</span> Retourner aux résultats
          </button>
        )}
      </div>
    </div>
  );
}
