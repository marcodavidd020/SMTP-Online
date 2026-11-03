'use strict';

const POLL_MS = 4000;
const MAX_SHOWN = 50;
const NEW_BADGE_MS = 12000;   // cuánto dura el resaltado "Nuevo" una vez que se ve
const listEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const template = document.getElementById('message-template');
const baseTitle = document.title;

let viewId = null;
let lastUid = 0;
let unread = 0;
const unseenItems = [];

async function api(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  if (res.status === 401) {
    location.assign('/login');
    throw new Error('sesión expirada');
  }
  return res;
}

async function poll() {
  try {
    if (!viewId) {
      const res = await api('/api/views', { method: 'POST' });
      ({ viewId } = await res.json());
    }
    const res = await api(`/api/views/${viewId}/messages?after=${lastUid}`);
    if (res.status === 404) {
      viewId = null;   // la vista se descartó; se abre otra en el siguiente ciclo
    } else {
      const data = await res.json();
      setStatus(data.connected ? 'ok' : 'down');
      for (const message of data.messages) addMessage(message);
    }
  } catch {
    setStatus('down');
  }
  setTimeout(poll, POLL_MS);
}

function setStatus(state) {
  statusEl.dataset.state = state;
  statusEl.textContent = state === 'ok' ? 'En vivo' : 'Reconectando…';
}

// '"Netflix" <info@netflix.com>' -> { name: 'Netflix', address: 'info@netflix.com' }
function splitSender(from) {
  const match = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { name: from, address: '' };
  return match[1] ? { name: match[1], address: match[2] } : { name: match[2], address: '' };
}

function hueOf(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

function fadeNewLater(item) {
  setTimeout(() => item.classList.remove('is-new'), NEW_BADGE_MS);
}

function addMessage(message) {
  lastUid = Math.max(lastUid, message.uid);
  const item = template.content.firstElementChild.cloneNode(true);
  const received = new Date(message.receivedAt);
  const sender = splitSender(message.from);

  item.querySelector('.subject').textContent = message.subject;
  item.querySelector('.from-name').textContent = sender.name;
  item.querySelector('.from-address').textContent = sender.address && `<${sender.address}>`;
  const avatar = item.querySelector('.avatar');
  avatar.textContent = (sender.name.trim().charAt(0) || '?').toUpperCase();
  avatar.style.setProperty('--hue', hueOf(sender.address || sender.name));
  const time = item.querySelector('.time');
  time.dateTime = received.toISOString();
  time.textContent = received.toLocaleTimeString();

  const body = item.querySelector('.body');
  if (message.hasHtml) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    frame.referrerPolicy = 'no-referrer';
    frame.title = message.subject;
    frame.src = `/api/views/${viewId}/messages/${message.uid}/html`;
    const wrapper = document.createElement('div');
    wrapper.className = 'frame';
    wrapper.append(frame);
    body.append(wrapper);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = message.text;
    body.append(pre);
  }

  listEl.prepend(item);
  while (listEl.children.length > MAX_SHOWN) listEl.lastElementChild.remove();
  emptyEl.hidden = true;

  if (document.hidden) {
    unread += 1;
    document.title = `(${unread}) ${baseTitle}`;
    unseenItems.push(item);
  } else {
    fadeNewLater(item);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    unread = 0;
    document.title = baseTitle;
    unseenItems.splice(0).forEach(fadeNewLater);
  }
});

poll();
