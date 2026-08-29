// Shared ticket economy — used across every page (Slots, Crossing,
// Runner, Gotchya, Shop, the homepage boop button, etc).
//
// The REAL, authoritative ticket balance lives server-side in the bridge
// server's ticketLedger (see server.js) — never trust localStorage as
// truth on its own. What's here is a synced local CACHE of that ledger:
// getTickets() stays synchronous so every existing game's logic (spin
// resolution, collision handlers, care actions, etc.) keeps working
// without a rewrite, but the cached number is kept in sync with the real
// server balance in the background, and every write-side action
// (addTickets) also pushes to the server, not just localStorage.
//
// If the bridge server is unreachable (e.g. the placeholder API_BASE
// hasn't been set to a real tunnel URL yet), everything gracefully falls
// back to the local-only cache so the games remain playable — but that
// state is not the real ledger, and will resync the moment the server
// becomes reachable again.

const TICKET_KEY = "meowfriend_tickets";
const TICKET_INIT_KEY = "meowfriend_tickets_initialized";
const STARTING_TICKETS = 10;

// Point this at your real Cloudflare Tunnel URL. Every page that loads
// shared-tickets.js picks this up automatically — no need to redeclare it
// per page.
const TICKETS_API_BASE = "https://YOUR_TUNNEL_URL.trycloudflare.com";

function getTickets(){
  return parseInt(localStorage.getItem(TICKET_KEY) || "0", 10);
}

function setTickets(amount){
  localStorage.setItem(TICKET_KEY, String(Math.max(0, amount)));
  document.dispatchEvent(new CustomEvent("tickets:changed", { detail: { tickets: getTickets() } }));
}

// Applies a ticket change locally (instant, so gameplay never blocks on
// network latency) AND pushes the same delta to the real server ledger in
// the background. The server is the actual source of truth; if the push
// fails (offline, bridge unreachable), the local cache still reflects the
// attempted change so games remain playable, and the next successful
// sync reconciles it against the server's real number.
function addTickets(amount){
  setTickets(getTickets() + amount);
  pushTicketDeltaToServer(amount);
  return getTickets();
}

async function pushTicketDeltaToServer(amount){
  if(amount === 0) return;
  try {
    await fetch(`${TICKETS_API_BASE}/api/tickets/sync-delta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ amount }),
    });
  } catch {
    // Bridge unreachable — local cache already reflects the change; a
    // later resync will reconcile once the server is reachable again.
  }
}

// Pulls the real balance from the server and overwrites the local cache
// with it — called on every page load and periodically, so the cache
// can't silently drift from the real ledger for long even if some
// individual sync-delta pushes were missed while offline.
async function resyncTicketsFromServer(){
  try {
    const response = await fetch(`${TICKETS_API_BASE}/api/tickets/balance`, { credentials: "include" });
    if(!response.ok) return;
    const data = await response.json();
    if(typeof data.tickets === "number"){
      setTickets(data.tickets);
    }
  } catch {
    // Bridge unreachable — keep whatever the local cache currently has.
  }
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

// Sync with the real server ledger on load, then periodically, so the
// local cache stays honest without every single game needing to be
// rewritten to await a network call before it can render a number.
resyncTicketsFromServer();
setInterval(resyncTicketsFromServer, 60000);

// --- Mandatory site-wide username + ToS gate ---
// Every device must set a username and agree to terms before using any
// part of the site. This is enforced server-side (leaderboard submission
// and other player-tied actions check for a real username on their own),
// but the gate below also blocks interaction client-side so the
// requirement is visible immediately rather than only failing later deep
// in some other flow. The modal is injected here so every page that loads
// shared-tickets.js gets it automatically, without needing matching HTML
// added to every single page.
// --- Server status indicator + username gate ---
// The server is only required for actions that actually mint tickets or
// credit donations/leaderboard entries — browsing pages and playing games
// works fine offline. A small persistent badge in the bottom-right shows
// live connectivity (green glow = online, red X = offline) instead of
// locking the whole site. window.MeowFriendServerStatus.isOnline is the
// flag any page should check before attempting a server-dependent action.
window.MeowFriendServerStatus = { isOnline: false };

(function setupServerStatusAndGate(){
  function injectStyles(){
    const style = document.createElement("style");
    style.textContent = `
      #mfStatusBadge{
        position: fixed; bottom: 16px; right: 16px; z-index: 9998;
        display: flex; align-items: center; gap: 6px;
        background: #0a0a0c; border: 2px solid #3a3a42;
        padding: 6px 10px; font-family: 'Press Start 2P', monospace;
        font-size: 8px; color: #7a3038; cursor: default;
        box-shadow: 0 0 10px rgba(0,0,0,0.6);
      }
      #mfStatusDot{
        width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
        background: #444; transition: background 0.3s ease, box-shadow 0.3s ease;
      }
      #mfStatusBadge.online #mfStatusDot{
        background: #29ff8a; box-shadow: 0 0 6px #29ff8a, 0 0 12px #29ff8a;
      }
      #mfStatusBadge.online{ color: #29ff8a; border-color: #1a4a2e; }
      #mfStatusBadge.offline #mfStatusDot{
        background: transparent;
      }
      #mfStatusBadge.offline #mfStatusIcon{ display: inline; }
      #mfStatusIcon{ display: none; color: #ff1e43; font-size: 10px; line-height: 1; }
      #mfPlayerGateBackdrop{
        position: fixed; inset: 0; background: rgba(0,0,0,0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; padding: 20px;
        font-family: 'Press Start 2P', monospace;
      }
      #mfPlayerGateBackdrop.mf-hidden{ display: none; }
      #mfPlayerGateModal{
        background: linear-gradient(180deg, #2a1418, #1a0a0d);
        border: 3px solid #ff1e43;
        box-shadow: 0 0 30px rgba(255,30,67,0.5);
        padding: 24px; max-width: 420px; width: 100%;
        color: #ffb3bd;
      }
      #mfPlayerGateModal h2{
        font-size: 14px; color: #ff1e43; text-shadow: 0 0 6px #ff1e43;
        margin-bottom: 14px; line-height: 1.5;
      }
      #mfPlayerGateModal p{
        font-family: 'VT323', monospace; font-size: 17px; line-height: 1.5;
        color: #ffc7cf; margin-bottom: 14px;
      }
      #mfPlayerGateModal input[type="text"]{
        width: 100%; background: #0a0a0c; border: 2px solid #3a3a42;
        color: #ff1e43; font-family: 'Press Start 2P', monospace;
        font-size: 11px; padding: 10px; margin-bottom: 12px;
      }
      #mfPlayerGateModal label{
        display: flex; align-items: flex-start; gap: 8px;
        font-family: 'VT323', monospace; font-size: 15px; color: #ffc7cf;
        margin-bottom: 14px; cursor: pointer;
      }
      #mfPlayerGateModal button{
        background: transparent; border: 2px solid #ff1e43; color: #ff1e43;
        font-family: 'Press Start 2P', monospace; font-size: 9px;
        padding: 12px 16px; width: 100%; cursor: pointer;
        text-shadow: 0 0 6px #ff1e43;
      }
      #mfPlayerGateModal button:disabled{ opacity: 0.35; cursor: not-allowed; }
      #mfPlayerGateModal button:hover:not(:disabled){ filter: brightness(1.3); }
      #mfPlayerGateModal .mf-secondary-btn{
        border-color: #4a2a30; color: #9a5a62; text-shadow: none; margin-top: 8px;
      }
      #mfPlayerGateError{ color: #ff8b96; font-size: 13px; margin-top: -6px; margin-bottom: 12px; display: none; }
    `;
    document.head.appendChild(style);
  }

  function injectStatusBadge(){
    const badge = document.createElement("div");
    badge.id = "mfStatusBadge";
    badge.className = "offline";
    badge.innerHTML = `<span id="mfStatusDot"></span><span id="mfStatusIcon">&times;</span><span id="mfStatusText">OFFLINE</span>`;
    document.body.appendChild(badge);
    return badge;
  }

  function setStatus(isOnline){
    window.MeowFriendServerStatus.isOnline = isOnline;
    const badge = document.getElementById("mfStatusBadge") || injectStatusBadge();
    badge.className = isOnline ? "online" : "offline";
    document.getElementById("mfStatusText").textContent = isOnline ? "ONLINE" : "OFFLINE";
    document.dispatchEvent(new CustomEvent("meowfriend:server-status", { detail: { isOnline } }));
  }

  function injectGateMarkup(){
    const backdrop = document.createElement("div");
    backdrop.id = "mfPlayerGateBackdrop";
    backdrop.className = "mf-hidden";
    backdrop.innerHTML = `
      <div id="mfPlayerGateModal">
        <h2>PICK A USERNAME</h2>
        <p>A username is required to mint tickets, register donations, or appear on leaderboards —
        these actions need a live connection to the MeowFriend server. Browsing the site and playing
        games works without a username or a server connection.</p>
        <p>MeowFriend is provided "as is," for entertainment and learning purposes only, with no
        warranty of any kind, express or implied. Tickets have no real-world monetary value, cannot
        be redeemed for cash or cryptocurrency, and are not a security, investment, or financial
        product. There is no expectation of profit, winning, or any return of value. To the fullest
        extent permitted by law, MeowFriend and its creator disclaim all liability for any loss,
        damage, or claim arising from use of this site, including loss of tickets, account data, or
        any donation made. Use is at your own risk and discretion.</p>
        <input type="text" id="mfGateUsername" placeholder="Username (3-16 chars)" autocomplete="off" spellcheck="false" maxlength="16">
        <label>
          <input type="checkbox" id="mfGateTerms" style="margin-top:3px;">
          <span>I agree to these terms and understand tickets have no real value.</span>
        </label>
        <div id="mfPlayerGateError"></div>
        <button type="button" id="mfGateSubmitBtn" disabled>CONTINUE</button>
        <button type="button" id="mfGateDismissBtn" class="mf-secondary-btn">CONTINUE BROWSING WITHOUT A USERNAME</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    return backdrop;
  }

  // Pings the server's health regardless of whether a username exists —
  // this is what drives the badge, independent of the gate.
  async function pollServerHealth(){
    try {
      const response = await fetch(`${TICKETS_API_BASE}/api/health`, { credentials: "include" });
      setStatus(response.ok);
    } catch {
      setStatus(false);
    }
  }

  async function checkPlayerStatus(){
    try {
      const response = await fetch(`${TICKETS_API_BASE}/api/player/status`, { credentials: "include" });
      if(!response.ok) return; // server reachable but errored — badge already reflects reachability
      const data = await response.json();
      if(!data.hasUsername){
        showGate();
      }
    } catch {
      // Server unreachable — the status badge already communicates this;
      // no need to also block the page. The gate will be offered again
      // once the server is back and this check re-runs.
    }
  }

  function showGate(){
    const backdrop = document.getElementById("mfPlayerGateBackdrop") || injectGateMarkup();
    backdrop.classList.remove("mf-hidden");

    const usernameInput = document.getElementById("mfGateUsername");
    const termsCheckbox = document.getElementById("mfGateTerms");
    const submitBtn = document.getElementById("mfGateSubmitBtn");
    const dismissBtn = document.getElementById("mfGateDismissBtn");
    const errorEl = document.getElementById("mfPlayerGateError");

    function updateButtonState(){
      const validLength = /^[a-zA-Z0-9_]{3,16}$/.test(usernameInput.value.trim());
      submitBtn.disabled = !(validLength && termsCheckbox.checked);
    }
    usernameInput.addEventListener("input", updateButtonState);
    termsCheckbox.addEventListener("change", updateButtonState);

    dismissBtn.addEventListener("click", () => {
      backdrop.classList.add("mf-hidden");
    });

    submitBtn.addEventListener("click", async () => {
      errorEl.style.display = "none";
      submitBtn.disabled = true;
      submitBtn.textContent = "...";

      try {
        const response = await fetch(`${TICKETS_API_BASE}/api/player/register-username`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            username: usernameInput.value.trim(),
            agreedToTerms: termsCheckbox.checked,
          }),
        });
        const data = await response.json().catch(() => ({}));

        if(!response.ok || !data.success){
          errorEl.textContent = data.error || "Could not set that username. Try another.";
          errorEl.style.display = "block";
          submitBtn.disabled = false;
          submitBtn.textContent = "CONTINUE";
          return;
        }

        backdrop.classList.add("mf-hidden");
      } catch {
        errorEl.textContent = "Could not reach the server. Try again, or continue browsing without a username.";
        errorEl.style.display = "block";
        submitBtn.disabled = false;
        submitBtn.textContent = "CONTINUE";
      }
    });
  }

  function initServerStatusAndGate(){
    injectStyles();
    injectStatusBadge();
    pollServerHealth();
    checkPlayerStatus();
    setInterval(pollServerHealth, 15000);
  }

  // This script loads synchronously in <head>, before <body> is parsed —
  // touching document.body immediately (as injectStatusBadge does) throws
  // and silently halts every script after it on the page, including each
  // page's own inline script. Defer until the DOM is actually ready.
  if(document.body){
    initServerStatusAndGate();
  } else {
    document.addEventListener("DOMContentLoaded", initServerStatusAndGate);
  }
})();


// --- Gotchya cross-game item drops ---
// Slots, Crossing, and Runner can each award a small chance of a Gotchya
// weight/IQ item on a win/success, plus guaranteed bonus items at score
// milestones. Items are written directly into the same pet inventory
// Gotchya reads from, so nothing needs a separate sync step — whatever's
// in localStorage when the player opens gotchya.html is already there.

const GOTCHYA_PET_KEY = "meowfriend_gotchya_pet";

// --- Item config: accessories ---
// Accessories are wearable items (one per equip slot) that boost stats
// while equipped — unlike furniture, which is a permanent passive
// multiplier, an accessory's effect only applies while pet.equipped[slot]
// points at it, and can be swapped out any time. Each accessory can boost
// MULTIPLE stats at once via the effects array (this is the "modular,
// easy to expand" shape — adding a new accessory or a new stat it boosts
// never requires changing any function below, only adding a data entry).
// stat values here match the pet's real field names directly: hunger,
// happiness, energy, weight, iq, strength, endurance, agility — so a
// single generic function can apply an effect to any of them.
const GOTCHYA_ACCESSORIES = [
  {
    id: "bow", name: "Cute Bow", icon: "🎀", desc: "+2 Happiness growth, +1 Agility growth",
    cost: 1200, rarity: "common", equipSlot: "head", renderIcon: "🎀", renderOffset: { x: 0, y: -20 },
    effects: [ { stat: "happiness", type: "decayMult", value: 0.95 }, { stat: "agility", type: "gainFlat", value: 1 } ],
  },
  {
    id: "top_hat", name: "Top Hat", icon: "🎩", desc: "+3 IQ growth",
    cost: 2000, rarity: "uncommon", equipSlot: "head", renderIcon: "🎩", renderOffset: { x: 0, y: -22 },
    effects: [ { stat: "iq", type: "gainFlat", value: 3 } ],
  },
  {
    id: "bandana", name: "Bandana", icon: "🧣", desc: "+2 Strength growth, +2 Endurance growth",
    cost: 1800, rarity: "uncommon", equipSlot: "neck", renderIcon: "🧣", renderOffset: { x: 0, y: -6 },
    effects: [ { stat: "strength", type: "gainFlat", value: 2 }, { stat: "endurance", type: "gainFlat", value: 2 } ],
  },
  {
    id: "crown", name: "Tiny Crown", icon: "👑", desc: "+2 all Training stats (Strength/Endurance/Agility)",
    cost: 6000, rarity: "epic", equipSlot: "head", renderIcon: "👑", renderOffset: { x: 0, y: -22 },
    effects: [ { stat: "strength", type: "gainFlat", value: 2 }, { stat: "endurance", type: "gainFlat", value: 2 }, { stat: "agility", type: "gainFlat", value: 2 } ],
  },
  {
    id: "goggles", name: "Swim Goggles", icon: "🥽", desc: "+3 Agility growth",
    cost: 1500, rarity: "common", equipSlot: "head", renderIcon: "🥽", renderOffset: { x: 0, y: -18 },
    effects: [ { stat: "agility", type: "gainFlat", value: 3 } ],
  },
  {
    id: "medal", name: "Champion Medal", icon: "🏅", desc: "+2 Strength growth, +1 all care stat decay reduction",
    cost: 4000, rarity: "rare", equipSlot: "neck", renderIcon: "🏅", renderOffset: { x: 0, y: -4 },
    effects: [ { stat: "strength", type: "gainFlat", value: 2 }, { stat: "hunger", type: "decayMult", value: 0.95 }, { stat: "happiness", type: "decayMult", value: 0.95 }, { stat: "energy", type: "decayMult", value: 0.95 } ],
  },
  // Find-only accessory — no cost field, never sold in the Shop.
  {
    id: "wizard_hat", name: "Wizard Hat", icon: "🧙", desc: "+5 IQ growth, +2 Agility growth — find only",
    rarity: "legendary", equipSlot: "head", renderIcon: "🧙", renderOffset: { x: 0, y: -22 },
    effects: [ { stat: "iq", type: "gainFlat", value: 5 }, { stat: "agility", type: "gainFlat", value: 2 } ],
  },
];

const ACCESSORY_SLOTS = ["head", "neck"]; // one equipped item per slot at a time

// Applies every effect from every currently-equipped accessory that
// matches (stat, type). type is either "decayMult" (multiplies a decay
// rate, like furniture does) or "gainFlat" (adds a flat amount per hour
// to a stat's growth, on top of its existing rate). Used the same way
// getFurnitureMultiplier is used — call once per stat/effect-type
// wherever that calculation already happens.
function getAccessoryEffect(pet, stat, type){
  const equipped = (pet && pet.equipped) || {};
  const equippedIds = Object.values(equipped).filter(Boolean);
  const activeAccessories = GOTCHYA_ACCESSORIES.filter(a => equippedIds.includes(a.id));

  if(type === "decayMult"){
    return activeAccessories
      .flatMap(a => a.effects)
      .filter(e => e.stat === stat && e.type === "decayMult")
      .reduce((mult, e) => mult * e.value, 1);
  }
  if(type === "gainFlat"){
    return activeAccessories
      .flatMap(a => a.effects)
      .filter(e => e.stat === stat && e.type === "gainFlat")
      .reduce((sum, e) => sum + e.value, 0);
  }
  return type === "decayMult" ? 1 : 0;
}

// Weighted like a loot table: common small items far more likely than the
// rare big ones. Kept in sync with the DROP_ITEMS list in gotchya.html —
// if that list changes, update this one too. Names/icons included here
// too so a notification can be shown without gotchya.html's page needing
// to be open.
const GOTCHYA_DROP_TABLE = [
  { id: "kibble_bag", weight: 40, name: "Kibble Bag", icon: "🥫" },
  { id: "picture_book", weight: 40, name: "Picture Book", icon: "📗" },
  { id: "cat_burger", weight: 12, name: "Cat Burger", icon: "🍔" },
  { id: "novel", weight: 12, name: "Novel", icon: "📘" },
  { id: "feast", weight: 3, name: "Big Feast", icon: "🍗" },
  { id: "encyclopedia", weight: 3, name: "Encyclopedia", icon: "📚" },
];

function getGotchyaDropItemInfo(itemId){
  return GOTCHYA_DROP_TABLE.find(e => e.id === itemId) || { name: itemId, icon: "🎁" };
}

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

  // Push-notification-style toast for any item found, same mechanism as
  // slot wins — queued so it still shows even if the player has since
  // navigated to another page.
  const info = getGotchyaDropItemInfo(itemId);
  queueWinNotification(`${info.icon} Found ${info.name} for ${pet.name || "your pet"}!`);

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
  // Purely decorative furniture — no stat effect, bought OR found, for the
  // room's look and to give the pet more things to walk around.
  // effect:"decor" never matches getFurnitureMultiplier's filter, so
  // these are always no-ops for gameplay math by construction, not by
  // convention. Each has a rarity tier controlling how often it can be
  // found as a random drop (see GOTCHYA_RARITY_WEIGHTS below) — cost
  // still applies if bought directly from the Shop instead.
  { id: "plant", name: "Potted Plant", icon: "🪴", desc: "Decorative", cost: 400, effect: "decor", value: 1, rarity: "common" },
  { id: "lamp", name: "Floor Lamp", icon: "💡", desc: "Decorative", cost: 600, effect: "decor", value: 1, rarity: "common" },
  { id: "rug", name: "Round Rug", icon: "🟤", desc: "Decorative", cost: 350, effect: "decor", value: 1, rarity: "common" },
  { id: "window", name: "Window", icon: "🪟", desc: "Decorative", cost: 800, effect: "decor", value: 1, rarity: "uncommon" },
  { id: "mirror", name: "Wall Mirror", icon: "🪞", desc: "Decorative", cost: 900, effect: "decor", value: 1, rarity: "uncommon" },
  { id: "scratcher_toy", name: "Cat Tree", icon: "🌳", desc: "Decorative", cost: 1200, effect: "decor", value: 1, rarity: "rare" },
  { id: "fishtank", name: "Fish Tank", icon: "🐠", desc: "Decorative", cost: 1500, effect: "decor", value: 1, rarity: "rare" },
  { id: "trophy", name: "Trophy Shelf", icon: "🏆", desc: "Decorative", cost: 2000, effect: "decor", value: 1, rarity: "epic" },
  // Find-only decorative furniture — never sold in the Shop at any price
  // (no "cost" field means the Shop UI can't list it for purchase), the
  // only way to get these is a lucky drop.
  { id: "disco_ball", name: "Disco Ball", icon: "🪩", desc: "Decorative — find only", effect: "decor", value: 1, rarity: "legendary" },
  { id: "golden_statue", name: "Golden Cat Statue", icon: "🗿", desc: "Decorative — find only", effect: "decor", value: 1, rarity: "legendary" },
];

// Shared rarity weighting for every randomly-earnable cosmetic — the same
// tiers and relative odds apply whether the roll is for a wallpaper, a
// flooring, or a decorative furniture piece, so "legendary" means the
// same ~0.6% chance everywhere rather than drifting per-catalog.
const GOTCHYA_RARITY_WEIGHTS = { common: 100, uncommon: 45, rare: 18, epic: 6, legendary: 1 };
const GOTCHYA_RARITY_LABELS = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
const GOTCHYA_RARITY_COLORS = { common: "#9a9aa0", uncommon: "#29ff8a", rare: "#33aaff", epic: "#c266ff", legendary: "#ffd700" };

// Cosmetic room customization — wallpaper (background pattern) and
// flooring (foreground grid tint). Purely visual, never touch stat math.
// "default" is free and is what every pet already has, so nobody's room
// changes until they actually buy or find something new. Each carries a
// rarity tier the same way furniture does.
const GOTCHYA_WALLPAPERS = [
  { id: "default", name: "Plain", icon: "⬛", cost: 0, rarity: "common", gradient: "radial-gradient(circle at 50% 30%, rgba(255,30,67,0.08), transparent 70%)" },
  { id: "sunset", name: "Sunset", icon: "🌇", cost: 1000, rarity: "common", gradient: "linear-gradient(180deg, rgba(255,120,60,0.18), rgba(255,30,67,0.08))" },
  { id: "forest", name: "Forest", icon: "🌲", cost: 1000, rarity: "common", gradient: "linear-gradient(180deg, rgba(40,160,90,0.14), rgba(20,60,40,0.1))" },
  { id: "ocean", name: "Ocean", icon: "🌊", cost: 1000, rarity: "uncommon", gradient: "linear-gradient(180deg, rgba(40,140,220,0.16), rgba(20,60,100,0.1))" },
  { id: "stars", name: "Starfield", icon: "✨", cost: 800, rarity: "rare", gradient: "radial-gradient(1px 1px at 20% 30%, #fff, transparent), radial-gradient(1px 1px at 70% 60%, #fff, transparent), radial-gradient(1px 1px at 40% 80%, #fff, transparent), radial-gradient(1px 1px at 85% 20%, #fff, transparent), radial-gradient(circle at 50% 30%, rgba(60,30,90,0.25), transparent 70%)" },
  { id: "candy", name: "Candy", icon: "🍬", cost: 1200, rarity: "epic", gradient: "linear-gradient(135deg, rgba(255,100,200,0.16), rgba(150,80,255,0.14))" },
  // Find-only wallpaper.
  { id: "aurora", name: "Aurora", icon: "🌌", rarity: "legendary", gradient: "linear-gradient(160deg, rgba(60,255,180,0.22), rgba(120,60,255,0.2), rgba(255,60,180,0.18))" },
];

const GOTCHYA_FLOORINGS = [
  { id: "default", name: "Concrete", icon: "⬛", cost: 0, rarity: "common", color: "rgba(255,30,67,0.06)" },
  { id: "wood", name: "Wood Floor", icon: "🟫", cost: 600, rarity: "common", color: "rgba(200,140,70,0.14)" },
  { id: "tile", name: "Checker Tile", icon: "⬜", cost: 600, rarity: "common", color: "rgba(220,220,230,0.1)" },
  { id: "grass", name: "Grass", icon: "🟩", cost: 900, rarity: "uncommon", color: "rgba(80,200,100,0.14)" },
  { id: "sand", name: "Sand", icon: "🟨", cost: 900, rarity: "rare", color: "rgba(230,200,110,0.14)" },
  // Find-only flooring.
  { id: "galaxy", name: "Galaxy Floor", icon: "🌠", rarity: "legendary", color: "rgba(140,70,255,0.2)" },
];

// Rolls one random cosmetic item across wallpaper + flooring + decorative
// furniture combined into a single pool, weighted first by rarity tier
// and then evenly within that tier. Call this on a win/success in any
// game, same trigger points as rollGotchyaDrop. Returns { kind, id } or
// null if the roll missed, no pet is adopted, or the item is already
// owned (never re-grants a duplicate cosmetic).
function rollGotchyaCosmetic(chance){
  if(Math.random() > chance) return null;
  const pet = getGotchyaPet();
  if(!pet) return null;

  const pool = [
    ...GOTCHYA_FURNITURE.filter(f => f.effect === "decor").map(f => ({ kind: "furniture", id: f.id, rarity: f.rarity, name: f.name, icon: f.icon })),
    ...GOTCHYA_WALLPAPERS.filter(w => w.id !== "default").map(w => ({ kind: "wallpaper", id: w.id, rarity: w.rarity, name: w.name, icon: w.icon })),
    ...GOTCHYA_FLOORINGS.filter(f => f.id !== "default").map(f => ({ kind: "flooring", id: f.id, rarity: f.rarity, name: f.name, icon: f.icon })),
  ].filter(entry => {
    // Skip anything already owned so a lucky roll never "wastes" itself
    // on a duplicate — re-rolls effectively favor what's left to find.
    if(entry.kind === "furniture") return !(pet.furniture && pet.furniture[entry.id]);
    if(entry.kind === "wallpaper") return !(pet.ownedWallpapers && pet.ownedWallpapers[entry.id]);
    if(entry.kind === "flooring") return !(pet.ownedFloorings && pet.ownedFloorings[entry.id]);
    return true;
  });
  if(pool.length === 0) return null; // everything already owned

  const totalWeight = pool.reduce((sum, e) => sum + (GOTCHYA_RARITY_WEIGHTS[e.rarity] || 1), 0);
  let r = Math.random() * totalWeight;
  let chosen = pool[0];
  for(const entry of pool){
    const w = GOTCHYA_RARITY_WEIGHTS[entry.rarity] || 1;
    if(r < w){ chosen = entry; break; }
    r -= w;
  }

  if(chosen.kind === "furniture"){
    pet.furniture = pet.furniture || {};
    pet.furniture[chosen.id] = true;
  } else if(chosen.kind === "wallpaper"){
    pet.ownedWallpapers = pet.ownedWallpapers || {};
    pet.ownedWallpapers[chosen.id] = true;
  } else if(chosen.kind === "flooring"){
    pet.ownedFloorings = pet.ownedFloorings || {};
    pet.ownedFloorings[chosen.id] = true;
  }
  saveGotchyaPet(pet);
  document.dispatchEvent(new CustomEvent("gotchya:cosmetic-found", { detail: chosen }));

  const rarityLabel = GOTCHYA_RARITY_LABELS[chosen.rarity] || "";
  queueWinNotification(`${chosen.icon} ${rarityLabel} find! ${chosen.name} for ${pet.name || "your pet"}!`);
  return chosen;
}

// Computes what rollGotchyaCosmetic would roll, using the exact same
// rarity-weighted pool and already-owned filtering, but WITHOUT granting
// or saving anything — for callers (like Crossing's on-board pickups)
// that need to know the item at spawn time for display purposes, while
// deferring the actual grant until the player successfully claims it.
// Call grantGotchyaCosmetic(result) later to actually apply a peeked roll.
function peekGotchyaCosmetic(){
  const pet = getGotchyaPet();
  if(!pet) return null;

  const pool = [
    ...GOTCHYA_FURNITURE.filter(f => f.effect === "decor").map(f => ({ kind: "furniture", id: f.id, rarity: f.rarity, name: f.name, icon: f.icon })),
    ...GOTCHYA_WALLPAPERS.filter(w => w.id !== "default").map(w => ({ kind: "wallpaper", id: w.id, rarity: w.rarity, name: w.name, icon: w.icon })),
    ...GOTCHYA_FLOORINGS.filter(f => f.id !== "default").map(f => ({ kind: "flooring", id: f.id, rarity: f.rarity, name: f.name, icon: f.icon })),
  ].filter(entry => {
    if(entry.kind === "furniture") return !(pet.furniture && pet.furniture[entry.id]);
    if(entry.kind === "wallpaper") return !(pet.ownedWallpapers && pet.ownedWallpapers[entry.id]);
    if(entry.kind === "flooring") return !(pet.ownedFloorings && pet.ownedFloorings[entry.id]);
    return true;
  });
  if(pool.length === 0) return null;

  const totalWeight = pool.reduce((sum, e) => sum + (GOTCHYA_RARITY_WEIGHTS[e.rarity] || 1), 0);
  let r = Math.random() * totalWeight;
  let chosen = pool[0];
  for(const entry of pool){
    const w = GOTCHYA_RARITY_WEIGHTS[entry.rarity] || 1;
    if(r < w){ chosen = entry; break; }
    r -= w;
  }
  return chosen;
}

// Actually applies a previously-peeked cosmetic roll: grants it to the
// pet, saves, and fires the same notification rollGotchyaCosmetic does.
// Re-checks ownership at grant time (not just at peek time) in case the
// player found the same item some other way in between.
function grantGotchyaCosmetic(peeked){
  if(!peeked) return null;
  const pet = getGotchyaPet();
  if(!pet) return null;

  if(peeked.kind === "furniture"){
    if(pet.furniture && pet.furniture[peeked.id]) return null; // already owned since the peek
    pet.furniture = pet.furniture || {};
    pet.furniture[peeked.id] = true;
  } else if(peeked.kind === "wallpaper"){
    if(pet.ownedWallpapers && pet.ownedWallpapers[peeked.id]) return null;
    pet.ownedWallpapers = pet.ownedWallpapers || {};
    pet.ownedWallpapers[peeked.id] = true;
  } else if(peeked.kind === "flooring"){
    if(pet.ownedFloorings && pet.ownedFloorings[peeked.id]) return null;
    pet.ownedFloorings = pet.ownedFloorings || {};
    pet.ownedFloorings[peeked.id] = true;
  }
  saveGotchyaPet(pet);
  document.dispatchEvent(new CustomEvent("gotchya:cosmetic-found", { detail: peeked }));

  const rarityLabel = GOTCHYA_RARITY_LABELS[peeked.rarity] || "";
  queueWinNotification(`${peeked.icon} ${rarityLabel} find! ${peeked.name} for ${pet.name || "your pet"}!`);
  return peeked;
}

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

// --- Cemetery / permadeath ---
// Called when a pet dies in Cat Hack. Archives its final stats to the
// cemetery record and permanently clears the active pet — there is no
// undo. Every caller of this function is expected to have already gotten
// explicit, unambiguous confirmation from the player before this fires.
const CEMETERY_KEY = "meowfriend_cemetery";

function killGotchyaPet(cause){
  const pet = getGotchyaPet();
  if(!pet) return null;

  let cemetery = [];
  try {
    cemetery = JSON.parse(localStorage.getItem(CEMETERY_KEY) || "[]");
  } catch {}

  const record = {
    name: pet.name,
    species: pet.species,
    glowColor: pet.glowColor || "red",
    finalWeight: pet.weight || 0,
    finalIq: pet.iq || 0,
    birthDate: pet.adoptedAt || Date.now(),
    deathDate: Date.now(),
    cause: cause || "Died in Cat Hack",
  };
  cemetery.push(record);
  localStorage.setItem(CEMETERY_KEY, JSON.stringify(cemetery));

  localStorage.removeItem(GOTCHYA_PET_KEY);
  document.dispatchEvent(new CustomEvent("gotchya:pet-died", { detail: { record } }));
  return record;
}

function getCemetery(){
  try {
    return JSON.parse(localStorage.getItem(CEMETERY_KEY) || "[]");
  } catch { return []; }
}

