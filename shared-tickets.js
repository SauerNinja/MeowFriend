// Shared ticket economy — used by both index.html and slots.html.
// Tickets are a for-fun, non-redeemable score. No connection to MEWC or
// any real value. Persisted in localStorage so the balance carries across
// pages.

const TICKET_KEY = "meowfriend_tickets";
const TICKET_INIT_KEY = "meowfriend_tickets_initialized";
const STARTING_TICKETS = 10;

function getTickets(){
  return parseInt(localStorage.getItem(TICKET_KEY) || "0", 10);
}

function setTickets(amount){
  localStorage.setItem(TICKET_KEY, String(Math.max(0, amount)));
  document.dispatchEvent(new CustomEvent("tickets:changed", { detail: { tickets: getTickets() } }));
}

function addTickets(amount){
  setTickets(getTickets() + amount);
  return getTickets();
}

function ensureStartingTickets(){
  if(!localStorage.getItem(TICKET_INIT_KEY)){
    localStorage.setItem(TICKET_INIT_KEY, "1");
    setTickets(STARTING_TICKETS);
  }
}

// Call on every page load so the balance is correct even if this is the
// visitor's first time landing on slots.html directly.
ensureStartingTickets();

// --- Gotchya cross-game item drops ---
// Slots, Crossing, and Runner can each award a small chance of a Gotchya
// weight/IQ item on a win/success, plus guaranteed bonus items at score
// milestones. Items are written directly into the same pet inventory
// Gotchya reads from, so nothing needs a separate sync step — whatever's
// in localStorage when the player opens gotchya.html is already there.

const GOTCHYA_PET_KEY = "meowfriend_gotchya_pet";

// Weighted like a loot table: common small items far more likely than the
// rare big ones. Kept in sync with the DROP_ITEMS list in gotchya.html —
// if that list changes, update this one too.
const GOTCHYA_DROP_TABLE = [
  { id: "kibble_bag", weight: 40 },
  { id: "picture_book", weight: 40 },
  { id: "cat_burger", weight: 12 },
  { id: "novel", weight: 12 },
  { id: "feast", weight: 3 },
  { id: "encyclopedia", weight: 3 },
];

function grantGotchyaItem(itemId){
  let pet;
  try {
    const raw = localStorage.getItem(GOTCHYA_PET_KEY);
    pet = raw ? JSON.parse(raw) : null;
  } catch { pet = null; }

  // No pet adopted yet — nothing to grant the item to. Callers can check
  // the return value if they want to tell the player to adopt a pet first.
  if(!pet) return false;

  pet.inventory = pet.inventory || {};
  pet.inventory[itemId] = (pet.inventory[itemId] || 0) + 1;
  localStorage.setItem(GOTCHYA_PET_KEY, JSON.stringify(pet));
  document.dispatchEvent(new CustomEvent("gotchya:item-dropped", { detail: { itemId } }));
  return true;
}

function hasAdoptedPet(){
  return !!localStorage.getItem(GOTCHYA_PET_KEY);
}

// Rolls the weighted drop table and grants one item. Call this on a
// win/success in any game. Returns the granted item id, or null if the
// roll didn't hit (chance param controls overall drop frequency) or no
// pet has been adopted yet.
function rollGotchyaDrop(chance){
  if(Math.random() > chance) return null;
  if(!hasAdoptedPet()) return null;

  const total = GOTCHYA_DROP_TABLE.reduce((sum, e) => sum + e.weight, 0);
  let r = Math.random() * total;
  for(const entry of GOTCHYA_DROP_TABLE){
    if(r < entry.weight){
      grantGotchyaItem(entry.id);
      return entry.id;
    }
    r -= entry.weight;
  }
  return null;
}

// Guaranteed drop for hitting a score/streak milestone, independent of the
// random roll above — always grants a mid-tier item so milestones feel
// reliably rewarding rather than subject to the same RNG as regular play.
function grantGotchyaMilestone(){
  if(!hasAdoptedPet()) return null;
  const midTier = ["cat_burger", "novel"];
  const id = midTier[Math.floor(Math.random() * midTier.length)];
  grantGotchyaItem(id);
  return id;
}

// --- Gotchya furniture (permanent, one-time purchases) ---
// Furniture is bought once from shop.html, stored as owned:true flags
// on the pet object, and modifies the decay/growth RATES computed in
// gotchya.html. Defined here as the single source of truth so the shop
// page (which shows what each item does) and gotchya.html (which applies
// the effect) can never disagree about the numbers.
const GOTCHYA_FURNITURE = [
  { id: "bookcase", name: "Bookcase", icon: "📚", desc: "+50% IQ gain rate", cost: 5000, effect: "iqGainMult", value: 1.5 },
  { id: "fridge", name: "Fridge", icon: "🧊", desc: "+50% weight gain rate", cost: 5000, effect: "weightGainMult", value: 1.5 },
  { id: "cozy_bed", name: "Cozy Bed", icon: "🛌", desc: "-30% energy decay rate", cost: 3000, effect: "energyDecayMult", value: 0.7 },
  { id: "food_bowl", name: "Automatic Feeder", icon: "🥣", desc: "-30% hunger decay rate", cost: 3000, effect: "hungerDecayMult", value: 0.7 },
  { id: "scratch_post", name: "Scratching Post", icon: "🪵", desc: "-30% happiness decay rate", cost: 3000, effect: "happinessDecayMult", value: 0.7 },
  { id: "alarm_clock", name: "Alarm Clock", icon: "⏰", desc: "Shows current time + days since adoption", cost: 500, effect: "display", value: 1 },
];

// Computes the combined multiplier for a given effect across all furniture
// the pet owns. Same-effect items stack multiplicatively (two -30% decay
// items compound to 0.7 * 0.7 = 0.49, i.e. -51%, not a flat -60%) so decay
// approaches zero with diminishing returns rather than being stackable to
// literally nothing.
function getFurnitureMultiplier(pet, effectKey){
  const owned = (pet && pet.furniture) || {};
  return GOTCHYA_FURNITURE
    .filter(f => f.effect === effectKey && owned[f.id])
    .reduce((mult, f) => mult * f.value, 1);
}

function getGotchyaPet(){
  try {
    const raw = localStorage.getItem(GOTCHYA_PET_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveGotchyaPet(pet){
  localStorage.setItem(GOTCHYA_PET_KEY, JSON.stringify(pet));
  document.dispatchEvent(new CustomEvent("gotchya:pet-updated", { detail: { pet } }));
}

// --- Cross-page win notifications ---
// A win queued on one page (e.g. mid-burst-spin on slots.html) needs to
// surface even if the player has since navigated elsewhere. Queued in
// localStorage and drained/rendered as a toast by whichever page is open
// when it's next checked — plus a real OS-level Notification if the user
// has granted permission, which is the only way to actually reach them if
// the tab isn't focused at all.

const WIN_NOTIF_QUEUE_KEY = "meowfriend_win_notifications";

function queueWinNotification(message){
  let queue = [];
  try {
    queue = JSON.parse(localStorage.getItem(WIN_NOTIF_QUEUE_KEY) || "[]");
  } catch {}
  queue.push({ message, ts: Date.now() });
  localStorage.setItem(WIN_NOTIF_QUEUE_KEY, JSON.stringify(queue));
  document.dispatchEvent(new CustomEvent("meowfriend:win-queued", { detail: { message } }));

  // Real OS-level notification, only if already permitted — never
  // request permission from here (that should be an explicit opt-in
  // action on the Slots page, not a side effect of spinning).
  if(typeof Notification !== "undefined" && Notification.permission === "granted"){
    try {
      new Notification("MeowFriend", { body: message, icon: "icon-192.png" });
    } catch {}
  }
}

function drainWinNotifications(){
  let queue = [];
  try {
    queue = JSON.parse(localStorage.getItem(WIN_NOTIF_QUEUE_KEY) || "[]");
  } catch {}
  localStorage.removeItem(WIN_NOTIF_QUEUE_KEY);
  return queue;
}

// Renders a small push-notification-style card in the top corner of the
// current page. Call this once per page (it self-initializes a container)
// to both drain any queued wins from elsewhere and to display new ones
// live as they're queued while this page is open.
function initWinNotificationUI(){
  if(document.getElementById("meowfriendWinToastContainer")) return;

  const container = document.createElement("div");
  container.id = "meowfriendWinToastContainer";
  container.style.cssText = `
    position: fixed; top: 14px; right: 14px; z-index: 9999;
    display: flex; flex-direction: column; gap: 8px;
    pointer-events: none;
  `;
  document.body.appendChild(container);

  function showToast(message){
    const card = document.createElement("div");
    card.style.cssText = `
      background: linear-gradient(180deg, #222228, #17171a);
      border: 2px solid #ff1e43;
      box-shadow: 0 0 20px rgba(255,30,67,0.5), 0 4px 12px rgba(0,0,0,0.5);
      color: #ffc7cf;
      font-family: 'Press Start 2P', monospace, sans-serif;
      font-size: 10px;
      line-height: 1.6;
      padding: 12px 14px;
      max-width: 260px;
      pointer-events: auto;
      animation: meowfriendToastIn 0.3s ease-out;
    `;
    card.innerHTML = `<div style="color:#ff1e43; text-shadow:0 0 6px #ff1e43; margin-bottom:4px;">🎰 MEOWFRIEND</div><div>${message}</div>`;
    container.appendChild(card);
    setTimeout(() => {
      card.style.transition = "opacity 0.4s ease, transform 0.4s ease";
      card.style.opacity = "0";
      card.style.transform = "translateX(20px)";
      setTimeout(() => card.remove(), 400);
    }, 5000);
  }

  if(!document.getElementById("meowfriendToastKeyframes")){
    const style = document.createElement("style");
    style.id = "meowfriendToastKeyframes";
    style.textContent = `@keyframes meowfriendToastIn{ from{opacity:0; transform:translateX(20px);} to{opacity:1; transform:translateX(0);} }`;
    document.head.appendChild(style);
  }

  // Drain anything queued from a previous page/session immediately.
  drainWinNotifications().forEach(item => showToast(item.message));

  // Show new ones live if a win happens while this page is open.
  document.addEventListener("meowfriend:win-queued", (e) => showToast(e.detail.message));
}

// Auto-init on every page that loads this script, once the DOM exists.
if(document.body){
  initWinNotificationUI();
} else {
  document.addEventListener("DOMContentLoaded", initWinNotificationUI);
}

