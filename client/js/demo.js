// Demo-trip seeder.
//
// When a first-run newcomer dismisses the welcome overlay ("Later"/skip) without
// naming a trip or adding anyone, we don't want to drop them on an empty board.
// Instead we pre-build a small, believable trip they can poke at — five
// travellers and seven bills — so every part of the interface (a card on the
// board, the Bills drawer, the Report, per-person balances) already has
// something to show. app.js calls this only when the trip is still empty; the
// ops it emits are ordinary local ops (they persist + sync like any other), so
// the "demo" is really just a pre-filled real trip the user can edit or clear.
//
// Names and labels follow the CREATOR's locale (like the default `Traveller N`),
// so a Polish phone gets Polish names, a German phone German ones, etc. — falling
// back to English for any locale without its own pool. Money stays integer cents.

import * as ops from "./core/ops.js";
import { initialsFor } from "./core/snapshot.js";
import { registerVersion } from "./version.js";
registerVersion("js/demo.js", 1);

// Locale → a pool of first names to draw the demo travellers from (we pick 5).
// Every shipped UI locale has a pool; anything else falls back to English.
const NAMES = {
  en: ["Alex", "Sam", "Jordan", "Taylor", "Casey", "Riley", "Morgan", "Jamie", "Chris", "Robin"],
  pl: ["Kasia", "Tomek", "Ania", "Michał", "Ola", "Piotr", "Zosia", "Marek", "Ewa", "Bartek"],
  de: ["Lukas", "Anna", "Max", "Sophie", "Paul", "Marie", "Jonas", "Laura", "Felix", "Lena"],
  es: ["Lucía", "Mateo", "Sofía", "Diego", "Valeria", "Javier", "Carmen", "Pablo", "Elena", "Hugo"],
  fr: ["Louis", "Emma", "Hugo", "Léa", "Jules", "Chloé", "Lucas", "Manon", "Nathan", "Camille"],
  it: ["Marco", "Giulia", "Luca", "Sofia", "Matteo", "Chiara", "Davide", "Martina", "Andrea", "Sara"],
  pt: ["João", "Maria", "Pedro", "Ana", "Tiago", "Beatriz", "Rui", "Inês", "Miguel", "Sofia"],
  zh: ["伟", "芳", "娜", "强", "敏", "静", "磊", "洋", "艳", "勇"],
  ja: ["春斗", "陽菜", "蓮", "結衣", "大翔", "さくら", "悠真", "美咲", "律", "陽向"],
  ko: ["민준", "서연", "도윤", "지우", "시우", "하은", "주원", "지호", "예준", "수아"],
  ar: ["أحمد", "فاطمة", "محمد", "سارة", "علي", "ليلى", "حسن", "نور", "يوسف", "مريم"],
};

// Eight everyday trip expenses, each with a fitting emoji. We pick 7. The labels
// are localized per UI locale; the emoji are universal.
const BILL_EMOJI = ["🍽️", "🍝", "🥐", "☕", "🛒", "🚕", "🏨", "🍺"];
const BILL_LABELS = {
  en: ["Dinner", "Lunch", "Breakfast", "Coffee", "Groceries", "Taxi", "Hotel", "Drinks"],
  pl: ["Kolacja", "Obiad", "Śniadanie", "Kawa", "Zakupy", "Taksówka", "Hotel", "Drinki"],
  de: ["Abendessen", "Mittagessen", "Frühstück", "Kaffee", "Einkäufe", "Taxi", "Hotel", "Getränke"],
  es: ["Cena", "Almuerzo", "Desayuno", "Café", "Compras", "Taxi", "Hotel", "Bebidas"],
  fr: ["Dîner", "Déjeuner", "Petit-déj", "Café", "Courses", "Taxi", "Hôtel", "Boissons"],
  it: ["Cena", "Pranzo", "Colazione", "Caffè", "Spesa", "Taxi", "Hotel", "Drink"],
  pt: ["Jantar", "Almoço", "Café da manhã", "Café", "Compras", "Táxi", "Hotel", "Bebidas"],
  zh: ["晚餐", "午餐", "早餐", "咖啡", "杂货", "出租车", "酒店", "饮料"],
  ja: ["夕食", "昼食", "朝食", "コーヒー", "食料品", "タクシー", "ホテル", "ドリンク"],
  ko: ["저녁", "점심", "아침", "커피", "장보기", "택시", "호텔", "음료"],
  ar: ["عشاء", "غداء", "فطور", "قهوة", "بقالة", "سيارة أجرة", "فندق", "مشروبات"],
};

// Localized name for the demo trip itself, so the top bar isn't blank.
const TRIP_NAME = {
  en: "Demo trip", pl: "Wyjazd demo", de: "Demo-Reise", es: "Viaje de ejemplo",
  fr: "Voyage démo", it: "Viaggio demo", pt: "Viagem demo", zh: "示例行程",
  ja: "デモ旅行", ko: "데모 여행", ar: "رحلة تجريبية",
};

// A small default palette (mirrors app.js) so the demo stands alone in tests; the
// app passes its own PALETTE so demo avatars match freshly-added travellers.
const DEFAULT_PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

const DEMO_MEMBERS = 5;
const DEMO_BILLS = 7;

const pick = (obj, locale, fallback) => obj[locale] || obj[(locale || "").split("-")[0]] || fallback;
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Fisher–Yates shuffle of a copy (leaves the source array untouched). */
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Seed a demo trip into `log` (emits ordinary local ops). Returns the id of the
 * single bill left OPEN on the board, so the caller can pan to it.
 *
 * @param {OpLog} log
 * @param {{ locale?: string, palette?: string[], center?: {x:number,y:number},
 *           uid?: (p:string)=>string, rng?: ()=>number }} [opts]
 */
export function seedDemoTrip(log, opts = {}) {
  const {
    locale = "en",
    palette = DEFAULT_PALETTE,
    center = { x: 0, y: 0 },
    uid = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : p + Math.random().toString(36).slice(2, 10)),
    rng = Math.random,
  } = opts;

  const names = shuffled(pick(NAMES, locale, NAMES.en), rng).slice(0, DEMO_MEMBERS);
  const labels = pick(BILL_LABELS, locale, BILL_LABELS.en);
  const tripName = pick(TRIP_NAME, locale, TRIP_NAME.en);

  log.emit((c) => ops.setTripName(c, tripName));

  // Five travellers (each their own budget by default — solo, like a fresh add).
  const memberIds = names.map((nm, i) => {
    const id = uid("m-");
    log.emit((c) => ops.addMember(c, id, { name: nm, color: palette[i % palette.length], initials: initialsFor(nm) || "?" }));
    return id;
  });

  // Seven bills. Most include EVERYONE; a couple include a random subset, so the
  // board shows both the common case and a partial split. Payers round-robin
  // across the travellers (kept within each bill's participants) so the user sees
  // a different person marked as having paid on each card. Amounts are ~20–65.
  const cats = shuffled(labels.map((name, i) => ({ name, emoji: BILL_EMOJI[i] })), rng).slice(0, DEMO_BILLS);
  // Two of the seven get a partial guest list; the rest include all five.
  const subsetBills = new Set(shuffled([...Array(DEMO_BILLS).keys()], rng).slice(0, 2));
  const openIndex = randInt(rng, 0, DEMO_BILLS - 1); // the one card left open on the board

  let openMealId = null;
  cats.forEach((cat, i) => {
    const mealId = uid("meal-");
    const open = i === openIndex;
    if (open) openMealId = mealId;

    // Participants: everyone, unless this is a subset bill (then 3–4 of them).
    let participants = memberIds;
    if (subsetBills.has(i)) {
      const size = randInt(rng, 3, 4);
      participants = shuffled(memberIds, rng).slice(0, size);
    }

    // Payer: round-robin over all members, but must be someone on this bill.
    let payerId = memberIds[i % memberIds.length];
    if (!participants.includes(payerId)) payerId = participants[0];

    const cents = randInt(rng, 20, 65) * 100 + randInt(rng, 0, 95);

    // Spread the closed cards around the open one so opening one from the drawer
    // doesn't stack them all at the same spot (openMeal re-pans regardless).
    const angle = (i / DEMO_BILLS) * Math.PI * 2;
    const x = Math.round(center.x - 160 + (open ? 0 : Math.cos(angle) * 420));
    const y = Math.round(center.y - 60 + (open ? 0 : Math.sin(angle) * 300));

    log.emit((c) => ops.addMeal(c, mealId, { name: cat.name, emoji: cat.emoji, x, y, open }));
    for (const pid of participants) log.emit((c) => ops.addParticipant(c, mealId, pid));
    log.emit((c) => ops.setPayer(c, mealId, payerId));
    log.emit((c) => ops.setAmount(c, mealId, cents)); // even split is automatic (no locked shares)
  });

  return openMealId;
}
