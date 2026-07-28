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
// Furniture is bought once from petshop.html, stored as owned:true flags
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
