// Polish (Polski). A complete translation — the first fully-translated language
// besides English, and the reference for how a plural-rich language fills this
// catalog. Keys mirror en.js (JS-rendered strings) plus the data-i18n keys from
// index.html (static chrome); any key left out here falls back to English.
//
// Polish counts with THREE plural forms, not two: 1 (rachunek), 2–4 excluding
// the teens (rachunki), and everything else including the teens (rachunków). The
// plu() helper below encodes exactly that rule; every counted string routes
// through it, which is why those values are functions of { n }.

import { registerVersion } from "../version.js";
registerVersion("js/i18n/pl.js", 1);

// Polish plural selector: `one` for n==1, `few` for n%10 ∈ 2..4 (but not the
// 12..14 teens), `many` otherwise (0, the teens, 5+, and non-integers).
function plu(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  if (d >= 2 && d <= 4 && !(h >= 12 && h <= 14)) return few;
  return many;
}

export default {
  // ── Shared ──────────────────────────────────────────────────────────────────
  "common.on": "Wł.",
  "common.off": "Wył.",
  "common.untitled": "Bez nazwy",
  "common.untitledTrip": "Wyjazd bez nazwy",

  // ── Top bar ───────────────────────────────────────────────────────────────────
  "topbar.billWord": ({ n }) => plu(n, "rachunek", "rachunki", "rachunków"),
  "topbar.live": "na żywo",
  "topbar.offline": "offline",
  "topbar.billsHistory": "Historia rachunków",
  "topbar.addMeal": "Dodaj rachunek",
  "topbar.settings": "Ustawienia",
  "topbar.openSettings": "Otwórz ustawienia",
  "topbar.syncStatus": "status synchronizacji",

  // ── Meal card ─────────────────────────────────────────────────────────────────
  "card.iconPickerLabel": "Wybierz ikonę",
  "card.useIcon": "Użyj tej ikony",
  "card.gripTitle": "Przeciągnij, aby przesunąć",
  "card.emojiTitle": "Dotknij, aby zmienić ikonę · przeciągnij, aby przesunąć",
  "card.mealNamePlaceholder": "Nazwa rachunku",
  "card.mealNameAria": "Nazwa rachunku",
  "card.mealNameTitle": "Dotknij, aby zmienić nazwę · przeciągnij, aby przesunąć",
  "card.thisBill": "ten rachunek",
  "card.closeTitle": "Zamknij kartę (pozostaje w historii rachunków)",
  "card.customBadge": "własne 📌",
  "card.perHead": ({ amount }) => `${amount}/os.`,
  "card.total": "Suma",
  "card.totalAria": "suma",
  "card.markPayer": "Oznacz jako płatnika",
  "card.holdShare": "Przytrzymaj, aby ustawić dokładny udział",
  "card.customShareTitle": "Własny udział",
  "card.paidSuffix": " · płatnik",
  "card.removeFromMeal": "Usuń z rachunku",
  "card.diffTitle": "Suma rachunku minus zadeklarowane udziały — celuj w 0.00",
  "card.dropHere": "upuść tu podróżnych",
  "card.mealHint": "przytrzymaj imię, aby ustawić dokładny udział · 💳 oznacza płatnika",
  "card.createdTitle": "Kiedy utworzono ten rachunek",
  "card.deleteTitle": "Usuń rachunek",
  "card.deleteAria": ({ name }) => `Usuń ${name}`,
  "card.conflictTitle": "Dwie osoby ustawiły to naraz — wybierz jedną.",
  "card.conflictAmount": ({ values }) => `suma ustawiona też na ${values}`,
  "card.conflictShare": ({ values }) => `udział ustawiony też na ${values}`,

  // ── Transient "+ add all" ─────────────────────────────────────────────────────
  "quick.addAllTitle": "Dodaj wszystkich podróżnych do tego nowego rachunku",
  "quick.addAll": "(+ dodaj wszystkich)",

  // ── Board empty / dock ────────────────────────────────────────────────────────
  "board.dockEmpty": "Brak podróżnych — dotknij tutaj, aby dodać pierwszego w ⚙️ Ustawieniach.",
  "board.emptyMain": '<span class="shine">Przeciągnij tu podróżnego</span>, aby rozpocząć rachunek — lub dotknij ➕. Potem upuść pozostałych, aby podzielić rachunek 🍽️',
  "board.emptySub": "jeden palec przesuwa · dwa palce / szczypta przybliża",

  // ── Dock ──────────────────────────────────────────────────────────────────────
  "dock.travellers": "Podróżni",
  "dock.tip": "przeciągnij na rachunek ↑",

  // ── Confirm dialogs ───────────────────────────────────────────────────────────
  "confirm.default": "Na pewno?",
  "confirm.no": "Nie",
  "confirm.yes": "Tak",
  "confirm.deleteMeal": ({ name }) =>
    `Usunąć „${name}” na stałe? Jej koszt zniknie z rozliczeń wszystkich osób.`,
  "confirm.removeMember": ({ name }) =>
    `Usunąć ${name} z wyjazdu? Rachunki i udziały zostaną przeliczone.`,
  "confirm.removeTrip": ({ name }) =>
    `Usunąć „${name}” z tego urządzenia? (Sam wyjazd nie zostanie skasowany.)`,

  // ── Balance / settlement phrasing ─────────────────────────────────────────────
  "balance.isOwed": ({ amount }) => `do odebrania ${amount}`,
  "balance.owes": ({ amount }) => `do oddania ${amount}`,
  "balance.settled": "rozliczone",

  // ── Bills drawer ──────────────────────────────────────────────────────────────
  "bills.drawerTitle": "🧾 Rachunki",
  "bills.syncOfflineAria": "Synchronizacja offline",
  "bills.syncOfflineLbl": "sync<br>offline",
  "bills.reportAria": "Raport",
  "bills.sortAria": "Sortuj rachunki",
  "bills.closeAria": "Zamknij rachunki",
  "bills.tapHint": "Dotknij rachunku, aby otworzyć go na planszy i edytować.",
  "bills.sort.nameAsc": "Nazwa (A–Z)",
  "bills.sort.nameDesc": "Nazwa (Z–A)",
  "bills.sort.createdAsc": "Data dodania (od najstarszych)",
  "bills.sort.createdDesc": "Data dodania (od najnowszych)",
  "bills.sort.cashAsc": "Kwota (rosnąco)",
  "bills.sort.cashDesc": "Kwota (malejąco)",
  "bills.empty": "Brak rachunków — dotknij ➕, aby dodać.",
  "bills.filtered": ({ name }) =>
    `Pokazuję tylko rachunki: ${name} — dotknij imienia ponownie, aby zobaczyć wszystkie.`,
  "bills.oneTraveller": "jednego podróżnego",
  "bills.people": ({ n }) => `${n} ${plu(n, "osoba", "osoby", "osób")}`,
  "bills.paidBy": ({ name }) => ` · płatnik: ${name}`,
  "bills.draftSuffix": " · szkic",
  "bills.onBoard": "na planszy",
  "bills.closed": "zamknięty",

  // ── Settings: install card ────────────────────────────────────────────────────
  "menu.install.title": "📲 Zainstaluj Siano",
  "menu.install.iosLead": "Dodaj Siano do ekranu głównego, aby mieć pełnoekranową aplikację działającą offline:",
  "menu.install.iosStep1Pre": "Dotknij ikony ",
  "menu.install.share": "Udostępnij",
  "menu.install.iosStep1Mid": " ",
  "menu.install.iosStep1Post": " na pasku narzędzi.",
  "menu.install.iosStep2Pre": "Wybierz ",
  "menu.install.addToHome": "Dodaj do ekranu głównego",
  "menu.install.iosStep2Post": ".",
  "menu.install.iosStep3Pre": "Dotknij ",
  "menu.install.add": "Dodaj",
  "menu.install.iosStep3Post": " — Siano pojawi się na ekranie głównym.",
  "menu.install.androidNote": "Zainstaluj Siano jako aplikację — pełny ekran, działa offline, jedno dotknięcie z ekranu głównego.",
  "menu.install.androidBtn": "⬇️ Zainstaluj aplikację",

  // ── Settings: appearance ──────────────────────────────────────────────────────
  "menu.appearance.title": "Wygląd",
  "menu.appearance.theme": "Motyw",
  "menu.appearance.dark": "🌙 Ciemny",
  "menu.appearance.light": "☀️ Jasny",
  "menu.appearance.textSize": "Rozmiar tekstu",
  "menu.appearance.smaller": "Mniejszy",
  "menu.appearance.smallerAria": "Mniejszy tekst",
  "menu.appearance.larger": "Większy",
  "menu.appearance.largerAria": "Większy tekst",
  "menu.appearance.weight": "Grubość czcionki",
  "menu.appearance.lighter": "Cieńsza",
  "menu.appearance.lighterAria": "Cieńszy tekst",
  "menu.appearance.bolder": "Grubsza",
  "menu.appearance.bolderAria": "Grubszy tekst",
  "menu.appearance.fullscreen": "Pełny ekran",
  "menu.appearance.language": "Język",
  "menu.appearance.languageAria": "Język aplikacji",
  "menu.appearance.languageAuto": "Automatycznie (urządzenie)",
  "menu.appearance.reset": "↺ Resetuj wygląd",

  // ── Settings: travellers ──────────────────────────────────────────────────────
  "menu.travellers.title": "Podróżni",
  "menu.travellers.solo": "osobno",
  "menu.travellers.sharedWith": ({ name }) => `wspólnie z ${name}`,
  "menu.travellers.nameAria": "imię podróżnego",
  "menu.travellers.remove": "Usuń podróżnego",
  "menu.travellers.budget": "💰 budżet",
  "menu.travellers.sharedBudget": ({ name }) => `💰 wspólny budżet: ${name}`,
  "menu.travellers.addPlaceholder": "Dodaj podróżnego…",
  "menu.travellers.add": "Dodaj",

  // ── Settings: budgets ─────────────────────────────────────────────────────────
  "menu.budgets.title": "Budżety ",
  "menu.budgets.subtitle": "(kto komu jest winien)",

  // ── Settings: total ───────────────────────────────────────────────────────────
  "menu.total.label": "Łącznie śledzone",
  "menu.total.travellers": ({ n }) => `${n} ${plu(n, "podróżny", "podróżnych", "podróżnych")}`,
  "menu.total.budgets": ({ n }) => ` · ${n} ${plu(n, "budżet", "budżety", "budżetów")}`,

  // ── Settings: settle up ───────────────────────────────────────────────────────
  "menu.settle.title": "Rozliczenie",
  "menu.settle.even": "Wszyscy na zero — nie ma czego rozliczać 🎉",

  // ── Settings: your ledger ─────────────────────────────────────────────────────
  "menu.ledger.title": "Twoje rozliczenie",
  "menu.ledger.hi": "Cześć ",
  "menu.ledger.wave": " 👋",
  "menu.ledger.budget": ({ name }) => `budżet: 💰 ${name}`,
  "menu.ledger.youAreOwed": ({ amount }) => `Masz do odebrania ${amount}`,
  "menu.ledger.youOwe": ({ amount }) => `Masz do oddania ${amount}`,
  "menu.ledger.youSettled": "Wszystko rozliczone",
  "menu.ledger.pay": ({ name }) => `zapłać ${name}`,
  "menu.ledger.collect": ({ name }) => `odbierz od ${name}`,
  "menu.ledger.pickPrompt": "Wybierz, kim jesteś, aby zobaczyć osobiste podsumowanie.",

  // ── Settings: offline sync entry ──────────────────────────────────────────────
  "menu.osync.title": "Synchronizacja offline",
  "menu.osync.button": "📡 Synchronizacja offline",

  // ── Settings: trip name / share ───────────────────────────────────────────────
  "menu.trip.title": "Nazwa wyjazdu",
  "menu.trip.placeholder": "Nazwij ten wyjazd…",
  "menu.trip.aria": "Nazwa wyjazdu",
  "menu.trip.idLabel": "ID wyjazdu: ",
  "menu.trip.qrAria": "Kod QR wyjazdu",
  "menu.trip.qrNote": "Zeskanuj, aby otworzyć ten wyjazd na innym telefonie",
  "menu.trip.copyLink": "🔗 Kopiuj link do wyjazdu",
  "menu.trip.newTrip": "✨ Nowy wyjazd",

  // ── Settings: your trips ──────────────────────────────────────────────────────
  "menu.trips.title": "Twoje wyjazdy",
  "menu.trips.empty": "Brak wyjazdów.",
  "menu.trips.current": " · bieżący",
  "menu.trips.copyLink": "Kopiuj link do udostępnienia",
  "menu.trips.removeDevice": "Usuń z tego urządzenia",

  // ── Settings: help / debug / disclaimer ───────────────────────────────────────
  "menu.help.button": "❓ Jak korzystać z Siano",
  "menu.debug.title": "🐞 Debug",
  "menu.debug.label": "Debug",
  "menu.debug.serviceWorker": "service worker",
  "menu.debug.network": "sieć",
  "menu.debug.note": ({ n, via }) => `Załadowano ${n} ${plu(n, "moduł JS", "moduły JS", "modułów JS")} · źródło: ${via}.`,
  "menu.disclaimer.title": "Zastrzeżenie",
  "menu.disclaimer.body":
    "Siano jest udostępniane wyłącznie w celach informacyjnych i dla wygody, bez żadnej gwarancji. Może zawierać błędy i pomyłki w obliczeniach, podziale i śledzeniu, więc pokazywane kwoty są szacunkami — nie zapisem finansowym. Zawsze samodzielnie sprawdzajcie kwoty przed rozliczeniem. Autor nie ponosi żadnej odpowiedzialności za błędy, straty ani spory wynikające z korzystania z tej aplikacji. Korzystając z niej, zgadzasz się, że robisz to na własne ryzyko.",

  // ── Report overlay ────────────────────────────────────────────────────────────
  "report.empty": "Nic tu jeszcze nie ma — dodaj podróżnych i rachunki, a potem wróć, aby sprawdzić sumy i pobrać kopię.",
  "report.matrixTitle": "Rachunki — udział każdego podróżnego",
  "report.col.bill": "Rachunek",
  "report.col.payer": "Płatnik",
  "report.col.total": "Suma",
  "report.col.diff": "Różn.",
  "report.draftTag": " · szkic",
  "report.consumed": "Skonsumowane",
  "report.paid": "Zapłacone",
  "report.net": "Saldo",
  "report.draftNote": ({ n }) =>
    plu(
      n,
      `${n} szkic rachunku jest nadal niekompletny (brakuje sumy, płatnika lub osób) i nie liczy się do sum.`,
      `${n} szkice rachunków są nadal niekompletne (brakuje sumy, płatnika lub osób) i nie liczą się do sum.`,
      `${n} szkiców rachunków jest nadal niekompletnych (brakuje sumy, płatnika lub osób) i nie liczy się do sum.`,
    ),
  "report.balancesTitle": "Salda — per budżet",
  "report.settlementsTitle": "Sugerowane rozliczenia",
  "report.allSettled": "🎉 Wszyscy rozliczeni.",
  "report.pays": "płaci",
  "report.footer": "Tylko do odczytu — nic tu nie zmienia planszy. „Skonsumowane” to udział podróżnego w rachunkach; „Saldo” to ile wyłożył minus ile skonsumował (jego bilans).",

  // ── Report CSV backup ─────────────────────────────────────────────────────────
  "report.csv.title": "Raport wyjazdu Siano",
  "report.csv.trip": "Wyjazd",
  "report.csv.tripId": "ID wyjazdu",
  "report.csv.generated": ({ tz }) => `Wygenerowano (${tz})`,
  "report.csv.total": "Suma",
  "report.csv.bills": "Rachunki",
  "report.csv.drafts": "Szkice (nie liczone)",
  "report.csv.travellers": "Podróżni",
  "report.csv.matrixTitle": "Rachunki — udział każdego podróżnego",
  "report.csv.colBill": "Rachunek",
  "report.csv.colPayer": "Płatnik",
  "report.csv.colStatus": "Status",
  "report.csv.colTotal": "Suma",
  "report.csv.colAssigned": "Przypisane",
  "report.csv.colUnassigned": "Nieprzypisane",
  "report.csv.statusComplete": "kompletny",
  "report.csv.statusDraft": "szkic",
  "report.csv.rowConsumed": "Skonsumowane (udział)",
  "report.csv.rowPaid": "Zapłacone",
  "report.csv.rowNet": "Saldo (zapłacone - skonsumowane)",
  "report.csv.balancesTitle": "Salda — per budżet",
  "report.csv.colBudget": "Budżet",
  "report.csv.colMembers": "Osoby",
  "report.csv.colConsumed": "Skonsumowane",
  "report.csv.colBalance": "Saldo",
  "report.csv.colDirection": "Kierunek",
  "report.csv.dirOwed": "do odebrania",
  "report.csv.dirOwes": "do oddania",
  "report.csv.dirSettled": "rozliczone",
  "report.csv.settlementsTitle": "Sugerowane rozliczenia",
  "report.csv.allSettled": "Wszyscy rozliczeni",
  "report.csv.colFrom": "Od",
  "report.csv.colTo": "Do",
  "report.csv.colAmount": "Kwota",

  // ── Toasts / app-level ────────────────────────────────────────────────────────
  "app.travellerDefault": ({ n }) => `Podróżny ${n}`,
  "app.toast.linkCopied": "Skopiowano link do wyjazdu — udostępnij go, aby zaprosić innych",
  "app.toast.linkCopiedGroup": "🔗 Skopiowano link — udostępnij go swojej grupie.",
  "app.toast.installing": "Instaluję Siano…",
  "app.failedStart": "Nie udało się uruchomić: ",

  // ── Onboarding (static + traveller rows) ──────────────────────────────────────
  "onboard.title": "Witaj w Siano!",
  "onboard.lede": "Pierwszy raz? Zacznij od nazwania wyjazdu i towarzyszy podróży — o tak. Wszystko można później zmienić.",
  "onboard.tripLabel": "Nazwa wyjazdu",
  "onboard.tripPlaceholder": "np. Włochy 2026",
  "onboard.tripAria": "Nazwa wyjazdu",
  "onboard.travellersLabel": "Podróżni",
  "onboard.addAnother": "＋ Dodaj kolejnego podróżnego",
  "onboard.later": "Później",
  "onboard.done": "Gotowe",
  "onboard.about": "Siano dzieli rachunki podczas wspólnych wyjazdów: dzielcie koszty, śledźcie kto za co zapłacił i rozliczcie się sprawiedliwie na koniec.",
  "onboard.tagSplit": "Dziel rachunki",
  "onboard.tagTrack": "Śledź koszty",
  "onboard.tagSettle": "Rozliczaj się",
  "onboard.travellerNameAria": ({ n }) => `Imię: Podróżny ${n}`,

  // ── Offline sync ──────────────────────────────────────────────────────────────
  "osync.modalTitle": "📡 Synchronizacja offline",
  "osync.closeAria": "Zamknij synchronizację offline",
  "osync.sendingLoopNote": "Wszystkie rachunki tego wyjazdu są wysyłane w ciągłej pętli. Teraz naciśnij Odbierz na drugim telefonie.",
  "osync.qrPlaceholder": "Tu pojawi się kod QR / aparat",
  "osync.receiveLead": "Dotknij przycisku poniżej na drugim telefonie — tym, który odbierze rachunki.",
  "osync.cameraHint": "Po dotknięciu zezwól na dostęp do aparatu, jeśli telefon o to poprosi.",
  "osync.startSending": "Zacznij wysyłać",
  "osync.startReceiving": "Zacznij odbierać",
  "osync.sending": "Wysyłanie…",
  "osync.receiving": "Odbieranie…",
  "osync.received": "Odebrano ✓",
  "osync.cameraError": "Aparat niedostępny — zezwól na dostęp do aparatu, a potem znów dotknij Zacznij odbierać.",
  "osync.readError": "Nie udało się odczytać transferu — spróbuj ponownie.",
  "osync.receivedOps": ({ n }) =>
    `Odebrano ${n} ${plu(n, "nową operację", "nowe operacje", "nowych operacji")} 🎉`,
  "osync.upToDate": "Wszystko aktualne — nic nowego 🎉",
  "osync.aNewTrip": "nowy wyjazd",
  "osync.receivedTrip": ({ label, n }) =>
    `Odebrano ${label} — ${n} ${plu(n, "rachunek", "rachunki", "rachunków")}. Otwieram…`,

  // ── Help drawer ───────────────────────────────────────────────────────────────
  "help.title": "❓ Jak korzystać z Siano",
  "help.closeAria": "Zamknij pomoc",
  "help.intro": 'Siano dzieli rachunki z grupowego wyjazdu. Każdy, kto otworzy link do wyjazdu, widzi <b>tę samą planszę na żywo</b> — udostępnij ją z ⚙️ Ustawień.',
  "help.travellers.title": "🧑‍🤝‍🧑 Podróżni",
  "help.travellers.1": "Dodawaj i usuwaj podróżnych w <b>⚙️ Ustawieniach</b>.",
  "help.travellers.2": "<b>Przeciągnij</b> podróżnego na kartę rachunku, aby dodać go do tego rachunku.",
  "help.travellers.3": "Przeciągnij kogoś na <b>puste miejsce planszy</b>, aby zacząć z nim nowy rachunek.",
  "help.meals.title": "🍽️ Posiłki i rachunki",
  "help.meals.1": "Dodaj kartę przyciskiem <b>➕</b> (u góry) lub upuszczając podróżnego na puste miejsce.",
  "help.meals.2": "<b>Przesuwaj</b> kartę, ciągnąc za <b>⠿ uchwyt</b> lub jej emoji.",
  "help.meals.3": "<b>Zmień nazwę</b>: dotknij tytułu. <b>Suma</b>: dotknij kwoty i wpisz.",
  "help.meals.4": "<b>Kto zapłacił</b>: dotknij okrągłego żetonu osoby → 💳 oznacza płatnika.",
  "help.meals.5": "<b>Dokładny udział</b>: przytrzymaj imię osoby, aby wpisać jej kwotę (📌 = własna).",
  "help.meals.6": "<b>✕ Zamknij</b> zachowuje rachunek w historii; <b>🗑 Usuń</b> kasuje go.",
  "help.board.title": "🖐️ Poruszanie planszą",
  "help.board.1": "<b>Jeden palec</b> na pustym miejscu (lub pustej części karty) przesuwa planszę.",
  "help.board.2": "<b>Dwa palce</b> przesuwają; <b>szczypta</b> przybliża.",
  "help.board.3": "Obróć telefon — to, co było na środku, zostaje na środku.",
  "help.budgets.title": "💰 Wspólne budżety",
  "help.budgets.1": "W Ustawieniach ustaw podróżnego na <b>„wspólnie z …”</b>, aby połączyć pieniądze (np. para).",
  "help.budgets.2": "Posiłki nadal dzielą się <b>na osobę</b>, ale kto komu jest winien, rozlicza się <b>per budżet</b>.",
  "help.drawers.title": "📂 Panele",
  "help.drawers.1": "<b>Historia rachunków</b>: przycisk ☰.",
  "help.drawers.2": "<b>Ustawienia</b>: przycisk ⚙️.",
  "help.drawers.3": "Panel <b>Rachunki</b> ma przycisk raportu (ikona tabeli, u góry po prawej), który otwiera szczegółowy panel <b>Raport</b>.",
  "help.drawers.4": "Przycisk <b>Wstecz</b> w telefonie zamyka otwarty panel.",
  "help.foot": "Wszystkiego można się też nauczyć, po prostu klikając — nic nieodwracalnego nie stanie się bez potwierdzenia. Wróć tu w każdej chwili przez ⚙️ Ustawienia → ❓.",

  // ── Settings drawer / report drawer (static chrome) ───────────────────────────
  "menu.drawerTitle": "⚙️ Ustawienia",
  "menu.closeAria": "Zamknij ustawienia",
  "report.drawerTitle": "📊 Raport",
  "report.csvButton": "⬇ CSV",
  "report.csvTitle": "Pobierz kopię CSV",
  "report.closeAria": "Zamknij raport",
};
