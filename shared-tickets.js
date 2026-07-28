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
