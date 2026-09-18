// English catalog — the source of truth for every JS-rendered string (the keys
// board.js / app.js / interactions.js / onboarding.js pass to t()). The static
// chrome in index.html carries its own English inline and is handled by
// snapshot/restore in ui/i18n.js, so those strings are NOT here.
//
// A value is either a plain string (with {placeholder} tokens filled from the
// params object) or a function of params — used where English grammar or
// pluralization can't be a flat template. A translator copying this file keeps
// the placeholders and the function shape; they only translate the words.
//
// Money is formatted upstream (core/money.js, integer cents) and passed in as a
// ready string — the catalog never formats amounts.

import { registerVersion } from "../version.js";
registerVersion("js/i18n/en.js", 1);

export default {
  // ── Shared ──────────────────────────────────────────────────────────────────
  "common.on": "On",
  "common.off": "Off",
  "common.untitled": "Untitled",
  "common.untitledTrip": "Untitled trip",

  // ── Top bar ───────────────────────────────────────────────────────────────────
  // The count and the word are separate DOM nodes ("3" + "bills"); the word is a
  // function of the count so languages with more than two plural forms (e.g.
  // Polish: rachunek / rachunki / rachunków) render the right one.
  "topbar.billWord": ({ n }) => (n === 1 ? "bill" : "bills"),
  "topbar.live": "live",
  "topbar.offline": "offline",

  // ── Meal card ─────────────────────────────────────────────────────────────────
  "card.iconPickerLabel": "Choose an icon",
  "card.useIcon": "Use this icon",
  "card.gripTitle": "Drag to move",
  "card.emojiTitle": "Tap to change icon · drag to move",
  "card.mealNamePlaceholder": "Meal name",
  "card.mealNameAria": "Meal name",
  "card.mealNameTitle": "Tap to rename · drag to move",
  "card.thisBill": "this bill",
  "card.closeTitle": "Close card (kept in Bills history)",
  "card.customBadge": "custom 📌",
  "card.perHead": ({ amount }) => `${amount}/head`,
  "card.total": "Total",
  "card.totalAria": "total",
  "card.markPayer": "Mark as payer",
  "card.holdShare": "Hold to set an exact share",
  "card.customShareTitle": "Custom share",
  "card.paidSuffix": " · paid",
  "card.removeFromMeal": "Remove from meal",
  "card.diffTitle": "Bill total minus everyone's declared shares — aim for 0.00",
  "card.dropHere": "drop travellers here",
  "card.mealHint": "hold a name to set an exact share · 💳 marks who paid",
  "card.createdTitle": "When this bill was created",
  "card.deleteTitle": "Delete bill",
  "card.deleteAria": ({ name }) => `Delete ${name}`,
  "card.conflictTitle": "Two people set this at once — pick one.",
  "card.conflictAmount": ({ values }) => `total also set to ${values}`,
  "card.conflictShare": ({ values }) => `a share also set to ${values}`,

  // ── Transient "+ add all" ─────────────────────────────────────────────────────
  "quick.addAllTitle": "Add every traveller to this new meal",
  "quick.addAll": "(+ add all)",

  // ── Board empty / dock ────────────────────────────────────────────────────────
  "board.dockEmpty": "No travellers yet — tap here to add your first traveller in ⚙️ Settings.",

  // ── Confirm dialogs ───────────────────────────────────────────────────────────
  "confirm.default": "Are you sure?",
  "confirm.no": "No",
  "confirm.yes": "Yes",
  "confirm.deleteMeal": ({ name }) =>
    `Delete “${name}” permanently? This removes its cost from everyone's balance.`,
  "confirm.removeMember": ({ name }) =>
    `Remove ${name} from the trip? Their meals and shares will be recalculated.`,
  "confirm.removeTrip": ({ name }) =>
    `Remove “${name}” from this device? (The trip itself isn't deleted.)`,

  // ── Balance / settlement phrasing (shared by budgets, ledger, report) ─────────
  "balance.isOwed": ({ amount }) => `is owed ${amount}`,
  "balance.owes": ({ amount }) => `owes ${amount}`,
  "balance.settled": "settled up",

  // ── Bills drawer ──────────────────────────────────────────────────────────────
  "bills.sort.nameAsc": "Name (A–Z)",
  "bills.sort.nameDesc": "Name (Z–A)",
  "bills.sort.createdAsc": "Date added (oldest first)",
  "bills.sort.createdDesc": "Date added (newest first)",
  "bills.sort.cashAsc": "Amount (low to high)",
  "bills.sort.cashDesc": "Amount (high to low)",
  "bills.empty": "No bills yet — tap ➕ to add one.",
  "bills.filtered": ({ name }) =>
    `Showing only ${name}'s bills — tap their name again to see all.`,
  "bills.oneTraveller": "one traveller",
  "bills.people": ({ n }) => `${n} ${n === 1 ? "person" : "people"}`,
  "bills.paidBy": ({ name }) => ` · ${name} paid`,
  "bills.draftSuffix": " · draft",
  "bills.onBoard": "on board",
  "bills.closed": "closed",

  // ── Settings: install card ────────────────────────────────────────────────────
  "menu.install.title": "📲 Install Siano",
  "menu.install.iosLead": "Add Siano to your Home Screen for a full-screen, offline-ready app:",
  "menu.install.iosStep1Pre": "Tap the ",
  "menu.install.share": "Share",
  "menu.install.iosStep1Mid": " icon ",
  "menu.install.iosStep1Post": " in the toolbar.",
  "menu.install.iosStep2Pre": "Choose ",
  "menu.install.addToHome": "Add to Home Screen",
  "menu.install.iosStep2Post": ".",
  "menu.install.iosStep3Pre": "Tap ",
  "menu.install.add": "Add",
  "menu.install.iosStep3Post": " — Siano appears on your Home Screen.",
  "menu.install.androidNote": "Install Siano as an app — full-screen, offline-ready, one tap from your Home Screen.",
  "menu.install.androidBtn": "⬇️ Install app",

  // ── Settings: appearance ──────────────────────────────────────────────────────
  "menu.appearance.title": "Appearance",
  "menu.appearance.theme": "Theme",
  "menu.appearance.dark": "🌙 Dark",
  "menu.appearance.light": "☀️ Light",
  "menu.appearance.textSize": "Text size",
  "menu.appearance.smaller": "Smaller",
  "menu.appearance.smallerAria": "Smaller text",
  "menu.appearance.larger": "Larger",
  "menu.appearance.largerAria": "Larger text",
  "menu.appearance.weight": "Font weight",
  "menu.appearance.lighter": "Lighter",
  "menu.appearance.lighterAria": "Lighter text",
  "menu.appearance.bolder": "Bolder",
  "menu.appearance.bolderAria": "Bolder text",
  "menu.appearance.fullscreen": "Full screen",
  "menu.appearance.language": "Language",
  "menu.appearance.languageAria": "App language",
  "menu.appearance.languageAuto": "Auto (device)",
  "menu.appearance.reset": "↺ Reset appearance",

  // ── Settings: travellers ──────────────────────────────────────────────────────
  "menu.travellers.title": "Travellers",
  "menu.travellers.solo": "on their own",
  "menu.travellers.sharedWith": ({ name }) => `shared with ${name}`,
  "menu.travellers.nameAria": "traveller name",
  "menu.travellers.remove": "Remove traveller",
  "menu.travellers.budget": "💰 budget",
  "menu.travellers.sharedBudget": ({ name }) => `💰 shared budget: ${name}`,
  "menu.travellers.addPlaceholder": "Add traveller…",
  "menu.travellers.add": "Add",

  // ── Settings: budgets ─────────────────────────────────────────────────────────
  "menu.budgets.title": "Budgets ",
  "menu.budgets.subtitle": "(who owes whom)",

  // ── Settings: total ───────────────────────────────────────────────────────────
  "menu.total.label": "Total tracked",
  "menu.total.travellers": ({ n }) => `${n} travellers`,
  "menu.total.budgets": ({ n }) => ` · ${n} budgets`,

  // ── Settings: settle up ───────────────────────────────────────────────────────
  "menu.settle.title": "Settle up",
  "menu.settle.even": "Everyone's even — nothing to settle 🎉",

  // ── Settings: your ledger ─────────────────────────────────────────────────────
  "menu.ledger.title": "Your ledger",
  "menu.ledger.hi": "Hi ",
  "menu.ledger.wave": " 👋",
  "menu.ledger.budget": ({ name }) => `budget: 💰 ${name}`,
  "menu.ledger.youAreOwed": ({ amount }) => `You are owed ${amount}`,
  "menu.ledger.youOwe": ({ amount }) => `You owe ${amount}`,
  "menu.ledger.youSettled": "You're settled up",
  "menu.ledger.pay": ({ name }) => `pay ${name}`,
  "menu.ledger.collect": ({ name }) => `collect from ${name}`,
  "menu.ledger.pickPrompt": "Pick who you are to see a personal breakdown.",

  // ── Settings: offline sync entry ──────────────────────────────────────────────
  "menu.osync.title": "Offline sync",
  "menu.osync.button": "📡 Offline sync",

  // ── Settings: trip name / share ───────────────────────────────────────────────
  "menu.trip.title": "Trip name",
  "menu.trip.placeholder": "Name this trip…",
  "menu.trip.aria": "Trip name",
  "menu.trip.idLabel": "Trip ID: ",
  "menu.trip.qrAria": "Trip QR code",
  "menu.trip.qrNote": "Scan to open this trip on another phone",
  "menu.trip.e2eNote": "🔒 End-to-end encrypted — the link carries the key; the server can't read your data",
  "menu.trip.copyLink": "🔗 Copy trip link",
  "menu.trip.newTrip": "✨ New trip",

  // ── Settings: your trips ──────────────────────────────────────────────────────
  "menu.trips.title": "Your trips",
  "menu.trips.empty": "No trips yet.",
  "menu.trips.current": " · current",
  "menu.trips.copyLink": "Copy link to share",
  "menu.trips.removeDevice": "Remove from this device",

  // ── Settings: help / debug / disclaimer ───────────────────────────────────────
  "menu.help.button": "❓ How to use Siano",
  "menu.debug.title": "🐞 Debug",
  "menu.debug.label": "Debug",
  "menu.debug.serviceWorker": "service worker",
  "menu.debug.network": "network",
  "menu.debug.note": ({ n, via }) => `Loaded ${n} JS modules · served via ${via}.`,
  "menu.disclaimer.title": "Disclaimer",
  "menu.disclaimer.body":
    "Siano is provided for informational and convenience purposes only, with no warranty of any kind. It may contain bugs and can make mistakes in its calculations, splitting and tracking, so figures shown here are estimates — not a financial record. Always verify amounts yourselves before settling up. The author accepts no responsibility or liability for any errors, losses or disputes arising from use of this application. By using it you agree you do so at your own risk.",

  // ── Report overlay ────────────────────────────────────────────────────────────
  "report.empty": "Nothing to report yet — add some travellers and bills, then come back to check the totals and download a backup.",
  "report.matrixTitle": "Bills — each traveller's share",
  "report.col.bill": "Bill",
  "report.col.payer": "Payer",
  "report.col.total": "Total",
  "report.col.diff": "Diff",
  "report.draftTag": " · draft",
  "report.consumed": "Consumed",
  "report.paid": "Paid",
  "report.net": "Net",
  "report.draftNote": ({ n }) =>
    `${n} draft ${n === 1 ? "bill is" : "bills are"} still incomplete (missing a total, payer or people) and don't count toward the totals.`,
  "report.balancesTitle": "Balances — per budget",
  "report.settlementsTitle": "Suggested settlements",
  "report.allSettled": "🎉 Everyone is settled up.",
  "report.pays": "pays",
  "report.footer": "Read-only — nothing here changes the board. “Consumed” is a traveller's share of the bills; “Net” is what they fronted minus what they consumed (their balance).",

  // ── Report CSV backup ─────────────────────────────────────────────────────────
  "report.csv.title": "Siano trip report",
  "report.csv.trip": "Trip",
  "report.csv.tripId": "Trip id",
  "report.csv.generated": ({ tz }) => `Generated (${tz})`,
  "report.csv.total": "Total",
  "report.csv.bills": "Bills",
  "report.csv.drafts": "Drafts (not counted)",
  "report.csv.travellers": "Travellers",
  "report.csv.matrixTitle": "Bills — each traveller's share",
  "report.csv.colBill": "Bill",
  "report.csv.colPayer": "Payer",
  "report.csv.colStatus": "Status",
  "report.csv.colTotal": "Total",
  "report.csv.colAssigned": "Assigned",
  "report.csv.colUnassigned": "Unassigned",
  "report.csv.statusComplete": "complete",
  "report.csv.statusDraft": "draft",
  "report.csv.rowConsumed": "Consumed (share)",
  "report.csv.rowPaid": "Paid",
  "report.csv.rowNet": "Net (paid - consumed)",
  "report.csv.balancesTitle": "Balances — per budget",
  "report.csv.colBudget": "Budget",
  "report.csv.colMembers": "Members",
  "report.csv.colConsumed": "Consumed",
  "report.csv.colBalance": "Balance",
  "report.csv.colDirection": "Direction",
  "report.csv.dirOwed": "is owed",
  "report.csv.dirOwes": "owes",
  "report.csv.dirSettled": "settled",
  "report.csv.settlementsTitle": "Suggested settlements",
  "report.csv.allSettled": "Everyone is settled up",
  "report.csv.colFrom": "From",
  "report.csv.colTo": "To",
  "report.csv.colAmount": "Amount",

  // ── Toasts / app-level ────────────────────────────────────────────────────────
  "app.travellerDefault": ({ n }) => `Traveller ${n}`,
  "onboard.travellerNameAria": ({ n }) => `Traveller ${n} name`,
  "app.toast.linkCopied": "Trip link copied — share it to invite others",
  "app.toast.linkCopiedGroup": "🔗 Link copied — share it with your group.",
  "app.toast.installing": "Installing Siano…",
  // TEMPORARY (dev aid): shown by the Settings "Preview welcome screen" button.
  "app.toast.onboardingSoon": "Welcome screen in 5s…",
  "app.failedStart": "Failed to start: ",
  // Shown when a trip link was opened without its encryption key (`#k=`).
  "app.locked.banner": "🔒 This trip link is missing its key, so it can't be decrypted or synced here. Ask for the full share link or scan the trip's QR code.",

  // ── Offline sync (interactions.js dynamic states) ─────────────────────────────
  "osync.startSending": "Start sending",
  "osync.startReceiving": "Start receiving",
  "osync.sending": "Sending…",
  "osync.receiving": "Receiving…",
  "osync.received": "Received ✓",
  "osync.cameraError": "Camera unavailable — allow camera access, then tap Start receiving again.",
  "osync.readError": "Couldn't read the transfer — try again.",
  "osync.receivedOps": ({ n }) => `Received ${n} new ${n === 1 ? "op" : "ops"} 🎉`,
  "osync.upToDate": "Already up to date — nothing new 🎉",
  "osync.aNewTrip": "a new trip",
  "osync.receivedTrip": ({ label, n }) =>
    `Received ${label} — ${n} ${n === 1 ? "bill" : "bills"}. Opening…`,
};
