// ---- CONFIGURE THIS ----
// Paste your deployed Apps Script Web App URL here (ends in /exec).
const API_URL = 'https://script.google.com/macros/s/AKfycbxHmIZjP5GxTRJ5erXzxQQT-CLu1SOVmvqVCD1xLXy9W2GMRDoguwXn9gY2C84XGw1sTw/exec';
// -------------------------

const CATEGORIES = ['Initials', 'EMS', 'Customs', 'Doms'];

function apiGet(action, params = {}) {
  const usp = new URLSearchParams({ action, ...params });
  return fetch(`${API_URL}?${usp.toString()}`)
    .then(r => r.json())
    .then(json => {
      if (!json.ok) throw new Error(json.error || 'Something went wrong.');
      return json;
    });
}

function apiPost(action, data = {}) {
  // text/plain avoids a CORS preflight against Apps Script; the body is still JSON.
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...data })
  })
    .then(r => r.json())
    .then(json => {
      if (!json.ok) throw new Error(json.error || 'Something went wrong.');
      return json;
    });
}

// ---- session (Instagram ID + PIN), kept for this browser tab only ----

function saveSession(igId, pin) {
  sessionStorage.setItem('igId', igId.trim().toLowerCase());
  sessionStorage.setItem('pin', pin);
}
function getSession() {
  const igId = sessionStorage.getItem('igId');
  const pin = sessionStorage.getItem('pin');
  return igId && pin ? { igId, pin } : null;
}
function clearSession() {
  sessionStorage.removeItem('igId');
  sessionStorage.removeItem('pin');
}

// ---- small UI helpers shared across pages ----

function money(n) {
  const v = Number(n) || 0;
  return '£' + v.toFixed(2);
}

function showMessage(el, text, kind = 'error') {
  el.textContent = text;
  el.className = `message message--${kind}`;
  el.hidden = false;
}
function hideMessage(el) {
  el.hidden = true;
}

function setNavActive() {
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a').forEach(a => {
    if (a.getAttribute('href') === path) a.classList.add('nav__link--active');
  });
}
document.addEventListener('DOMContentLoaded', setNavActive);
