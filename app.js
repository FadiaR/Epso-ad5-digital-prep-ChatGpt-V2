/* EPSO Digital Skills — Revision (DigComp, iPhone-friendly, PWA)
   Features:
   - Exam & Practice modes
   - Daily plan 1 tap: 20m practice + 15m mini-exam + 25m wrong-review
   - Focus daily goal 60m + streak calendar
   - Domain stats (volume + accuracy)
   - Flag + note per question
   - Strict simulation: no back + minimal UI
   - Tap-to-next in practice
*/

const BANK = { file: "data/digital_skills.json" };

const LS_QCM = "epso_digital_qcm_v3";
const LS_FOCUS = "epso_digital_focus_v2";
const LS_ANNOT = "epso_digital_annot_v1"; // flags + notes
const LS_PREF = "epso_digital_prefs_v1";  // remember toggles

const $ = (s) => document.querySelector(s);

const DIGCOMP_DOMAINS = [
  "Information and data literacy",
  "Communication and collaboration",
  "Digital content creation",
  "Safety",
  "Problem solving"
];

const state = {
  allQuestions: [],
  session: null, // {mode, items, idx, answers: Map, minutes, strict, tapNext}
  sessionTimerId: null,
  sessionRemainingSec: null,

  focusTimerId: null,
  focusRunning: false,
  focusStage: null, // daily plan stage object {plan, idx, name, remainingSec}
  focusStageTimerId: null,

  currentModalQid: null
};

function todayKey(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function formatTime(sec){
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function clampInt(v, min, max){
  const n = Number.parseInt(v, 10);
  if(Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function show(id){
  ["#setup","#quiz","#results","#progress"].forEach(s => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
}

/* ---------------- Storage: QCM stats ---------------- */

function loadQcm(){
  try{
    const raw = localStorage.getItem(LS_QCM);
    if(!raw) return { byId:{}, byDomain:{} };
    const j = JSON.parse(raw);
    return {
      byId: j.byId || {},
      byDomain: j.byDomain || {}
    };
  } catch {
    return { byId:{}, byDomain:{} };
  }
}

function saveQcm(data){
  localStorage.setItem(LS_QCM, JSON.stringify(data));
}

function updateQcmStats(q, correct){
  const qcm = loadQcm();

  // per question
  const id = q.id;
  const cur = qcm.byId[id] || { attempts: 0, correct: 0, wrong: 0, last: null };
  cur.attempts += 1;
  if(correct) cur.correct += 1; else cur.wrong += 1;
  cur.last = new Date().toISOString();
  qcm.byId[id] = cur;

  // per domain
  const domain = q.domain || "Uncategorized";
  const d = qcm.byDomain[domain] || { attempts: 0, correct: 0 };
  d.attempts += 1;
  if(correct) d.correct += 1;
  qcm.byDomain[domain] = d;

  saveQcm(qcm);
}

function getWrongSet(){
  const qcm = loadQcm();
  const wrong = new Set();
  for(const [id, stats] of Object.entries(qcm.byId)){
    if((stats.wrong || 0) > (stats.correct || 0)) wrong.add(id);
  }
  return wrong;
}

function computeGlobalAccuracy(){
  const qcm = loadQcm();
  const ids = Object.keys(qcm.byId);
  let attempts = 0, correct = 0;
  for(const id of ids){
    attempts += qcm.byId[id].attempts || 0;
    correct += qcm.byId[id].correct || 0;
  }
  const pct = attempts ? Math.round((correct/attempts)*100) : 0;
  return { attempts, correct, pct };
}

/* ---------------- Storage: Flags + Notes ---------------- */

function loadAnnot(){
  try{
    const raw = localStorage.getItem(LS_ANNOT);
    if(!raw) return { flags:{}, notes:{} };
    const j = JSON.parse(raw);
    return { flags: j.flags || {}, notes: j.notes || {} };
  } catch {
    return { flags:{}, notes:{} };
  }
}
function saveAnnot(a){
  localStorage.setItem(LS_ANNOT, JSON.stringify(a));
}

function isFlagged(qid){
  const a = loadAnnot();
  return !!a.flags[qid];
}
function toggleFlag(qid){
  const a = loadAnnot();
  a.flags[qid] = !a.flags[qid];
  saveAnnot(a);
}

function getNote(qid){
  const a = loadAnnot();
  return a.notes[qid] || "";
}
function setNote(qid, text){
  const a = loadAnnot();
  const t = String(text || "").trim();
  if(t) a.notes[qid] = t;
  else delete a.notes[qid];
  saveAnnot(a);
}

/* ---------------- Storage: Focus + streak ---------------- */

function loadFocus(){
  try{
    const raw = localStorage.getItem(LS_FOCUS);
    if(!raw) return { days:{}, bestStreak:0 };
    const j = JSON.parse(raw);
    return { days: j.days || {}, bestStreak: j.bestStreak || 0 };
  } catch {
    return { days:{}, bestStreak:0 };
  }
}
function saveFocus(f){
  localStorage.setItem(LS_FOCUS, JSON.stringify(f));
}

function getTodaySeconds(){
  const f = loadFocus();
  return f.days[todayKey()] || 0;
}
function addFocusSeconds(delta){
  const f = loadFocus();
  const k = todayKey();
  f.days[k] = (f.days[k] || 0) + delta;
  saveFocus(f);
}

function computeStreak(){
  const f = loadFocus();
  const days = f.days;
  const goal = 60 * 60;

  let streak = 0;
  let best = f.bestStreak || 0;

  let d = new Date();
  while(true){
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const secs = days[k] || 0;
    if(secs >= goal){
      streak += 1;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }

  if(streak > best){
    best = streak;
    f.bestStreak = best;
    saveFocus(f);
  }

  return { streak, best };
}

function renderFocusUI(){
  const secs = getTodaySeconds();
  const mins = Math.floor(secs/60);

  $("#focusTodayText").textContent = `Aujourd’hui : ${mins} min / 60 min`;
  const pct = Math.min(100, Math.round((secs/3600)*100));
  $("#focusFill").style.width = `${pct}%`;

  const { streak, best } = computeStreak();
  $("#streakText").textContent = `Streak : ${streak} • Best : ${best}`;
}

/* ---------------- Preferences ---------------- */

function loadPrefs(){
  try{
    const raw = localStorage.getItem(LS_PREF);
    if(!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function savePrefs(p){
  localStorage.setItem(LS_PREF, JSON.stringify(p));
}
function syncPrefsFromUI(){
  const p = {
    tapNext: $("#tapNextToggle").checked,
    strict: $("#strictToggle").checked
  };
  savePrefs(p);
}
function applyPrefsToUI(){
  const p = loadPrefs();
  if(typeof p.tapNext === "boolean") $("#tapNextToggle").checked = p.tapNext;
  if(typeof p.strict === "boolean") $("#strictToggle").checked = p.strict;
}

/* ---------------- Bank loading & filters ---------------- */

async function fetchBank(){
  const res = await fetch(BANK.file, { cache: "no-store" });
  if(!res.ok) throw new Error(`Impossible de charger ${BANK.file} (HTTP ${res.status})`);
  const json = await res.json();
  if(!json.questions || !Array.isArray(json.questions)) throw new Error("Format JSON invalide : champ 'questions' manquant.");
  state.allQuestions = json.questions;
}

function mountDomains(){
  const domains = Array.from(new Set(state.allQuestions.map(q => q.domain).filter(Boolean)))
    .sort((a,b)=>a.localeCompare(b));

  const sel = $("#domainSelect");
  sel.innerHTML = `<option value="">Tous</option>`;
  for(const d of domains){
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    sel.appendChild(opt);
  }
}

/* ---------------- Session (Exam / Practice) ---------------- */

function stopSessionTimer(){
  if(state.sessionTimerId){
    clearInterval(state.sessionTimerId);
    state.sessionTimerId = null;
  }
  state.sessionRemainingSec = null;
  $("#sessionTimer").classList.add("hidden");
  $("#sessionTimer").classList.remove("danger");
}

function startSessionTimer(minutes){
  stopSessionTimer();
  if(minutes <= 0) return;

  state.sessionRemainingSec = minutes * 60;
  $("#sessionTimer").classList.remove("hidden");
  $("#sessionTimer").textContent = formatTime(state.sessionRemainingSec);

  state.sessionTimerId = setInterval(() => {
    state.sessionRemainingSec -= 1;
    $("#sessionTimer").textContent = formatTime(Math.max(0, state.sessionRemainingSec));
    if(state.sessionRemainingSec <= 60) $("#sessionTimer").classList.add("danger");

    // Session time counts towards daily focus
    addFocusSeconds(1);
    renderFocusUI();

    if(state.sessionRemainingSec <= 0){
      stopSessionTimer();
      finishSession(true);
    }
  }, 1000);
}

function computeFiltered({ domain, onlyWrong }){
  const wrong = getWrongSet();
  let qs = state.allQuestions.slice();
  if(domain) qs = qs.filter(q => q.domain === domain);
  if(onlyWrong) qs = qs.filter(q => wrong.has(q.id));
  return qs;
}

function buildSession({ mode, count, minutes, domain, onlyWrong, shuffleOn, strict, tapNext }){
  let items = computeFiltered({ domain, onlyWrong });
  if(items.length === 0){
    alert("Aucune question ne correspond aux filtres (ou aucune erreur identifiable).");
    return null;
  }

  if(shuffleOn) items = shuffle(items);
  items = items.slice(0, Math.min(count, items.length));

  return {
    mode,
    items,
    idx: 0,
    answers: new Map(),
    minutes,
    strict: !!strict,
    tapNext: !!tapNext
  };
}

function renderQuestion(){
  const s = state.session;
  const q = s.items[s.idx];

  $("#progressText").textContent = `Question ${s.idx + 1} / ${s.items.length}`;
  $("#progressFill").style.width = `${((s.idx+1)/s.items.length)*100}%`;

  $("#questionMeta").textContent = q.domain ? q.domain : "";
  $("#questionText").textContent = q.question;

  // Flag UI
  // Tools visibility (EPSO simulation): pas de notes / flags en examen ou en strict
  const toolsAllowed = (s.mode === "practice") && !s.strict;
  $("#btnFlag").classList.toggle("hidden", !toolsAllowed);
    if(toolsAllowed){
    $("#btnFlag").textContent = isFlagged(q.id) ? "★ Flag" : "☆ Flag";
  }

  const existing = s.answers.get(q.id);

  const choices = $("#choices");
  choices.innerHTML = "";

  q.choices.forEach((t, i) => {
    const div = document.createElement("div");
    div.className = "choice";
    div.textContent = t;
    if(existing && existing.choiceIndex === i) div.classList.add("selected");
    div.onclick = () => onSelectChoice(i);
    choices.appendChild(div);
  });

  // strict: no back
  $("#btnPrev").disabled = s.strict ? true : (s.idx === 0);
  $("#btnNext").textContent = (s.idx === s.items.length - 1) ? "Terminer" : "Suivant";

  // feedback area
  $("#feedback").classList.add("hidden");
  $("#feedback").classList.remove("ok","bad");
  document.querySelectorAll(".choice").forEach(c => c.classList.remove("correct","wrong"));

  if(s.mode === "practice" && existing){
    showPracticeFeedback(q, existing.choiceIndex);
  }
}

function showPracticeFeedback(q, chosenIndex){
  const correct = chosenIndex === q.answerIndex;
  const fb = $("#feedback");
  fb.classList.remove("hidden");
  fb.classList.toggle("ok", correct);
  fb.classList.toggle("bad", !correct);

  fb.innerHTML = `
    <div class="tag">${correct ? "Correct" : "Incorrect"}</div>
    <div class="exp"><strong>Explication :</strong> ${escapeHtml(q.explanation || "—")}</div>
  `;

  const nodes = Array.from(document.querySelectorAll(".choice"));
  nodes.forEach((node, i) => {
    if(i === q.answerIndex) node.classList.add("correct");
    if(i === chosenIndex && chosenIndex !== q.answerIndex) node.classList.add("wrong");
  });
}

function onSelectChoice(choiceIndex){
  const s = state.session;
  const q = s.items[s.idx];
  const correct = choiceIndex === q.answerIndex;

  s.answers.set(q.id, { choiceIndex, correct });
  updateQcmStats(q, correct);

  renderQuestion();

  if(s.mode === "practice" && s.tapNext){
    setTimeout(() => {
      if(!state.session) return;
      if(state.session.idx !== s.idx) return;
      if(s.idx === s.items.length - 1) finishSession(false);
      else {
        s.idx += 1;
        renderQuestion();
      }
    }, 650);
  }
}

function next(){
  const s = state.session;
  if(s.idx === s.items.length - 1) return finishSession(false);
  s.idx += 1;
  renderQuestion();
}

function prev(){
  const s = state.session;
  if(s.strict) return;
  if(s.idx === 0) return;
  s.idx -= 1;
  renderQuestion();
}

function finishSession(timeUp){
  stopSessionTimer();
  const s = state.session;
  if(!s) return;

  let correctCount = 0;
  const details = [];

  for(const q of s.items){
    const a = s.answers.get(q.id);
    const chosen = a ? a.choiceIndex : null;
    const isCorrect = a ? a.correct : false;
    if(isCorrect) correctCount += 1;
    details.push({ q, chosen, isCorrect });
  }

  const total = s.items.length;
  const pct = total ? Math.round((correctCount/total)*100) : 0;

  $("#scoreLine").textContent = `${correctCount} / ${total} (${pct}%)` + (timeUp ? " — Temps écoulé" : "");
  $("#passLine").textContent = "Seuil/durée/nombre exacts : à vérifier sur la notice (selon la version du concours).";

  const review = $("#review");
  review.innerHTML = "";

  for(const d of details){
    const q = d.q;
    const chosenText = (d.chosen == null) ? "—" : q.choices[d.chosen];
    const correctText = q.choices[q.answerIndex];
    const flagged = isFlagged(q.id);
    const note = getNote(q.id);

    const item = document.createElement("div");
    item.className = "review-item";
    item.innerHTML = `
      <div class="pill">${d.isCorrect ? "Correct" : "À revoir"}${q.domain ? " • " + escapeHtml(q.domain) : ""}${flagged ? " • ★" : ""}</div>
      <p class="q"><strong>${escapeHtml(q.question)}</strong></p>
      <p class="a">Votre réponse : ${escapeHtml(chosenText)}</p>
      <p class="a">Bonne réponse : ${escapeHtml(correctText)}</p>
      ${q.explanation ? `<p class="a"><em>Explication :</em> ${escapeHtml(q.explanation)}</p>` : ""}
          `;
    review.appendChild(item);
  }

  show("#results");
}

/* ---------------- Daily plan (60 min) ----------------
   Sequence: 20m practice + 15m mini-exam + 25m wrong-review
*/

function stopPlan(){
  if(state.focusStageTimerId){
    clearInterval(state.focusStageTimerId);
    state.focusStageTimerId = null;
  }
  state.focusStage = null;

  $("#planStatus").classList.add("hidden");
  $("#btnPlanSkip").classList.add("hidden");
  $("#btnPlanStop").classList.add("hidden");

  stopFocus(false, true);
}

function renderPlanStatus(){
  if(!state.focusStage){
    $("#planStatus").classList.add("hidden");
    return;
  }
  const st = state.focusStage;
  $("#planStatus").textContent = `Plan du jour — ${st.name} (${formatTime(Math.max(0, st.remainingSec))})`;
  $("#planStatus").classList.remove("hidden");
}

function startFocus(fromPlan){
  if(state.focusRunning) return;

  state.focusRunning = true;
  $("#btnFocusStart").disabled = true;
  $("#btnFocusPause").disabled = false;
  $("#btnFocusStop").disabled = false;

  let remaining = 60 * 60;
  $("#focusTimer").textContent = formatTime(remaining);

  state.focusTimerId = setInterval(() => {
    remaining -= 1;
    $("#focusTimer").textContent = formatTime(Math.max(0, remaining));

    addFocusSeconds(1);
    renderFocusUI();

    if(remaining <= 0){
      stopFocus(true, fromPlan);
      if(!fromPlan) alert("Objectif Focus atteint : 60 minutes.");
    }
  }, 1000);
}

function pauseFocus(){
  if(!state.focusRunning) return;
  state.focusRunning = false;

  if(state.focusTimerId){
    clearInterval(state.focusTimerId);
    state.focusTimerId = null;
  }

  $("#btnFocusStart").disabled = false;
  $("#btnFocusPause").disabled = true;
  $("#btnFocusStop").disabled = false;
}

function stopFocus(autoCompleted, fromPlan){
  state.focusRunning = false;

  if(state.focusTimerId){
    clearInterval(state.focusTimerId);
    state.focusTimerId = null;
  }

  $("#btnFocusStart").disabled = false;
  $("#btnFocusPause").disabled = true;
  $("#btnFocusStop").disabled = true;

  if(autoCompleted && !fromPlan){
    // already alerted
  }
}

function startDailyPlan(){
  stopSessionTimer();
  state.session = null;

  startFocus(true);

  const plan = [
    { key: "practice", name: "Entraînement 20 min", durationSec: 20*60 },
    { key: "exam", name: "Mini-examen 15 min", durationSec: 15*60 },
    { key: "wrong", name: "Revue erreurs 25 min", durationSec: 25*60 }
  ];

  state.focusStage = { plan, idx: 0, name: plan[0].name, remainingSec: plan[0].durationSec };
  $("#btnPlanSkip").classList.remove("hidden");
  $("#btnPlanStop").classList.remove("hidden");

  const beginStage = () => {
    const st = state.focusStage;
    const stage = st.plan[st.idx];
    st.name = stage.name;
    st.remainingSec = stage.durationSec;

    renderPlanStatus();

    if(stage.key === "practice"){
      startAutoSession({ mode:"practice", minutes: 20, onlyWrong:false, strict:false });
    } else if(stage.key === "exam"){
      startAutoSession({ mode:"exam", minutes: 15, onlyWrong:false, strict:true });
    } else if(stage.key === "wrong"){
      startAutoSession({ mode:"practice", minutes: 25, onlyWrong:true, strict:false });
    }

    if(state.focusStageTimerId) clearInterval(state.focusStageTimerId);
    state.focusStageTimerId = setInterval(() => {
      if(!state.focusStage) return;
      state.focusStage.remainingSec -= 1;

      addFocusSeconds(1);
      renderFocusUI();
      renderPlanStatus();

      if(state.focusStage.remainingSec <= 0){
        if(state.focusStageTimerId){
          clearInterval(state.focusStageTimerId);
          state.focusStageTimerId = null;
        }

        if(state.session){
          finishSession(false);
          state.session = null;
        }

        state.focusStage.idx += 1;
        if(state.focusStage.idx >= state.focusStage.plan.length){
          stopPlan();
          alert("Plan du jour terminé.");
          renderProgressPanel();
          show("#progress");
          return;
        }
        beginStage();
      }
    }, 1000);
  };

  beginStage();
}

/* ---------------- Progress panel ---------------- */

function renderCalendar(){
  const f = loadFocus();
  const goal = 3600;

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const first = new Date(y, m, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Monday=0
  const last = new Date(y, m+1, 0);
  const daysInMonth = last.getDate();

  const cal = $("#calendar");
  cal.innerHTML = "";

  for(let i=0;i<startWeekday;i++){
    const blank = document.createElement("div");
    blank.className = "day none";
    blank.innerHTML = `<div class="d"> </div><div class="m"> </div>`;
    cal.appendChild(blank);
  }

  for(let day=1; day<=daysInMonth; day++){
    const key = `${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const secs = f.days[key] || 0;
    const mins = Math.floor(secs/60);

    const cell = document.createElement("div");
    cell.className = "day";
    if(secs >= goal) cell.classList.add("done");
    else if(secs > 0) cell.classList.add("partial");
    else cell.classList.add("none");

    const symbol = secs >= goal ? "✅" : (secs > 0 ? "◔" : "—");
    cell.innerHTML = `<div class="d">${day}</div><div class="m">${symbol} ${mins}m</div>`;
    cal.appendChild(cell);
  }
}

function renderDomainStats(){
  const qcm = loadQcm();
  const domains = Array.from(new Set([...DIGCOMP_DOMAINS, ...Object.keys(qcm.byDomain)]));

  const wrap = $("#domainStats");
  wrap.innerHTML = "";

  for(const d of domains){
    const stats = qcm.byDomain[d] || { attempts: 0, correct: 0 };
    const attempts = stats.attempts || 0;
    const correct = stats.correct || 0;
    const pct = attempts ? Math.round((correct/attempts)*100) : 0;

    const row = document.createElement("div");
    row.className = "domain-row";
    row.innerHTML = `
      <div class="name">${escapeHtml(d)}</div>
      <div class="vals">${attempts} tentatives • ${pct}%</div>
    `;
    wrap.appendChild(row);
  }
}

function renderProgressPanel(){
  const f = loadFocus();
  const keys = Object.keys(f.days).sort();
  const last7 = keys.slice(-7).reduce((acc,k)=>acc + (f.days[k]||0), 0);
  $("#focus7").textContent = `${Math.round(last7/60)} min`;

  const g = computeGlobalAccuracy();
  $("#accuracyGlobal").textContent = `${g.pct}% (${g.correct}/${g.attempts})`;

  renderDomainStats();
  renderCalendar();
}


function closeNoteModal(){
  state.currentModalQid = null;
  $("#noteModal").classList.add("hidden");
  $("#noteModal").setAttribute("aria-hidden", "true");
}

function startAutoSession({ mode, minutes, onlyWrong, strict }){
  const domain = $("#domainSelect").value || "";
  const shuffleOn = true;

  const target = mode === "exam"
    ? Math.max(10, Math.round((minutes*60)/45))
    : Math.max(12, Math.round((minutes*60)/35));

  const sess = buildSession({
    mode,
    count: target,
    minutes,
    domain,
    onlyWrong,
    shuffleOn,
    strict: !!strict,
    tapNext: true
  });

  if(!sess) return;

  state.session = sess;
  show("#quiz");
  renderQuestion();
  startSessionTimer(sess.minutes);
}

/* ---------------- UI bindings ---------------- */

function bindUI(){
  $("#tapNextToggle").addEventListener("change", syncPrefsFromUI);
  $("#strictToggle").addEventListener("change", syncPrefsFromUI);

  $("#btnStart").onclick = () => {
    if(state.focusStage) stopPlan();

    const mode = $("#modeSelect").value;
    let count = clampInt($("#countInput").value, 1, 5000);
    let minutes = clampInt($("#timeInput").value, 0, 10000);
    if(mode === "exam"){
      // EPSO simulation: paramètres figés
      count = 40;
      minutes = 30;
    }
const domain = $("#domainSelect").value;
    const onlyWrong = $("#onlyWrongToggle").checked;
    const shuffleOn = $("#shuffleToggle").checked;
    const tapNext = $("#tapNextToggle").checked;
    const strict = $("#strictToggle").checked;

    const sess = buildSession({ mode, count, minutes, domain, onlyWrong, shuffleOn, strict, tapNext });
    if(!sess) return;

    state.session = sess;
    show("#quiz");
    renderQuestion();
    startSessionTimer(sess.minutes);
  };

  $("#btnPrev").onclick = prev;
  $("#btnNext").onclick = next;

  $("#btnQuit").onclick = () => {
    if(confirm("Quitter la session ?")){
      stopSessionTimer();
      state.session = null;
      show("#setup");
    }
  };

  $("#btnBackSetup").onclick = () => {
    state.session = null;
    show("#setup");
  };

  $("#btnRetryWrong").onclick = () => {
    if(state.focusStage) stopPlan();

    $("#onlyWrongToggle").checked = true;
    syncPrefsFromUI();

    show("#setup");

    const mode = $("#modeSelect").value;
    let count = clampInt($("#countInput").value, 1, 5000);
    let minutes = clampInt($("#timeInput").value, 0, 10000);
    if(mode === "exam"){
      // EPSO simulation: paramètres figés
      count = 40;
      minutes = 30;
    }
const domain = $("#domainSelect").value;
    const shuffleOn = true;
    const tapNext = $("#tapNextToggle").checked;
    const strict = $("#strictToggle").checked;

    const sess = buildSession({ mode, count, minutes, domain, onlyWrong:true, shuffleOn, strict, tapNext });
    if(!sess) return;

    state.session = sess;
    show("#quiz");
    renderQuestion();
    startSessionTimer(sess.minutes);
  };

  $("#btnDailyPlan").onclick = () => {
    if(state.focusStage){
      alert("Un plan est déjà en cours.");
      return;
    }
    startDailyPlan();
  };

  $("#btnPlanStop").onclick = () => {
    if(confirm("Arrêter le plan du jour ?")){
      stopPlan();
      stopSessionTimer();
      state.session = null;
      show("#setup");
    }
  };

  $("#btnPlanSkip").onclick = () => {
    if(state.focusStage) state.focusStage.remainingSec = 0;
  };

  $("#btnFocusStart").onclick = () => startFocus(false);
  $("#btnFocusPause").onclick = pauseFocus;
  $("#btnFocusStop").onclick = () => stopFocus(false, false);

  $("#btnOpenProgress").onclick = () => {
    renderProgressPanel();
    show("#progress");
  };
  $("#btnCloseProgress").onclick = () => show("#setup");

  $("#btnReset").onclick = () => {
    if(confirm("Réinitialiser stats QCM + Focus + flags/notes + préférences ?")){
      localStorage.removeItem(LS_QCM);
      localStorage.removeItem(LS_FOCUS);
      localStorage.removeItem(LS_ANNOT);
      localStorage.removeItem(LS_PREF);

      renderFocusUI();
      applyPrefsToUI();
      mountDomains();
      alert("Réinitialisé.");
      show("#setup");
    }
  };

  $("#modeSelect").addEventListener("change", () => {
    const isExam = $("#modeSelect").value === "exam";
    if(isExam){
      // EPSO simulation: format figé (à ajuster si ta notice diffère)
      $("#countInput").value = 40;
      $("#timeInput").value = 30;
      $("#countInput").disabled = true;
      $("#timeInput").disabled = true;
    } else {
      $("#countInput").disabled = false;
      $("#timeInput").disabled = false;
    }
  });
$("#btnFlag").onclick = () => {
    const s = state.session;
    if(!s) return;
    if(s.mode !== "practice" || s.strict) return;
    const q = s.items[s.idx];
    toggleFlag(q.id);
    renderQuestion();
  };

    };

  $("#btnNoteClose").onclick = closeNoteModal;
  $("#btnNoteSave").onclick = () => {
    const qid = state.currentModalQid;
    if(!qid) return;
    setNote(qid, $("#noteText").value);
    closeNoteModal();
    renderQuestion();
  };

  $("#noteModal").addEventListener("click", (e) => {
    if(e.target && e.target.id === "noteModal") closeNoteModal();
  });
}

async function init(){
  await fetchBank();
  mountDomains();
  applyPrefsToUI();
  bindUI();
  renderFocusUI();
  // appliquer verrouillage UI si mode = examen
  $("#modeSelect").dispatchEvent(new Event("change"));
  show("#setup");
}

init();
