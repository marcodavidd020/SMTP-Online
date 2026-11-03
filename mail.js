'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const MAX_MESSAGES = 50;               // correos guardados en memoria como máximo
const MAX_AGE_MS = 60 * 60 * 1000;     // se olvidan pasada 1 hora
const MAX_SOURCE_BYTES = 1_000_000;    // no descargamos más de 1 MB por correo
const MAX_HTML_CHARS = 500_000;
const MAX_TEXT_CHARS = 50_000;
const RECONNECT_MS = 10_000;
const SAFETY_SYNC_MS = 30_000;         // revisión periódica por si el IDLE se pierde un aviso

// Mantiene una conexión IMAP abierta (solo lectura) y guarda en memoria únicamente
// los correos que llegan desde que arrancó el servidor. El historial nunca se descarga.
class MailWatcher {
  constructor({ host, port, secure, user, pass, mailbox, lookbackMs, fromFilter }) {
    this.imap = { host, port, secure, auth: { user, pass }, logger: false };
    this.mailbox = mailbox;
    this.lookbackMs = lookbackMs;
    this.fromFilter = fromFilter;
    this.messages = [];      // ordenados por uid ascendente
    this.lastUid = 0;
    this.uidValidity = null;
    this.client = null;
    this.syncing = null;
    this.resync = false;
    this.reconnectTimer = null;
  }

  get connected() {
    return this.client !== null;
  }

  start() {
    this.connect();
    setInterval(() => this.sync(), SAFETY_SYNC_MS).unref();
  }

  async connect() {
    const client = new ImapFlow(this.imap);
    client.on('error', (err) => console.error('IMAP error:', err.message));
    client.on('close', () => this.onClose(client));
    client.on('exists', () => this.sync());

    try {
      await client.connect();
      const box = await client.mailboxOpen(this.mailbox, { readOnly: true });
      const firstConnection = this.uidValidity !== box.uidValidity;
      this.client = client;

      if (firstConnection) {
        // Buzón nuevo (o UIDVALIDITY cambió): empezamos desde "ahora".
        this.uidValidity = box.uidValidity;
        this.messages = [];
        this.lastUid = box.uidNext - 1;
        if (this.lookbackMs > 0) await this.fetchLookback();
      }
      console.log(`IMAP conectado a ${this.mailbox}`);
      await this.sync();     // en una reconexión trae lo que llegó mientras estábamos caídos
    } catch (err) {
      console.error('IMAP no pudo conectar:', err.message);
      this.onClose(client);
    }
  }

  onClose(client) {
    if (this.client === client) this.client = null;
    client.close();
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  // Trae los correos de los últimos LOOKBACK_MINUTES (útil si el servidor recién despertó).
  async fetchLookback() {
    const cutoff = Date.now() - this.lookbackMs;
    const uids = await this.client.search({ since: new Date(cutoff) }, { uid: true });
    if (!uids || uids.length === 0) return;
    await this.fetch(uids, 0, cutoff);
  }

  sync() {
    if (this.syncing) {
      this.resync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.resync = false;
        if (this.client) await this.fetch(`${this.lastUid + 1}:*`, this.lastUid + 1, 0);
      } while (this.resync);
    })()
      .catch((err) => console.error('IMAP sync falló:', err.message))
      .finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async fetch(range, minUid, minDate) {
    const query = { uid: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } };
    const fetched = [];
    for await (const msg of this.client.fetch(range, query, { uid: true })) {
      // "n:*" devuelve el último correo aunque sea más viejo que n, por eso filtramos.
      if (msg.uid < minUid) continue;
      if (msg.internalDate && msg.internalDate.getTime() < minDate) continue;
      fetched.push(msg);
    }

    for (const msg of fetched) {
      if (msg.uid > this.lastUid) this.lastUid = msg.uid;
      if (this.messages.some((m) => m.uid === msg.uid)) continue;
      const parsed = await this.parse(msg);
      if (parsed) this.messages.push(parsed);
    }
    this.messages.sort((a, b) => a.uid - b.uid);
    this.prune();
  }

  async parse(msg) {
    const mail = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
    const from = mail.from ? mail.from.text : '';
    if (this.fromFilter.length > 0) {
      const lower = from.toLowerCase();
      if (!this.fromFilter.some((f) => lower.includes(f))) return null;
    }
    return {
      uid: msg.uid,
      receivedAt: (msg.internalDate || new Date()).getTime(),
      storedAt: Date.now(),
      from,
      subject: mail.subject || '(sin asunto)',
      text: (mail.text || '').slice(0, MAX_TEXT_CHARS),
      html: mail.html ? mail.html.slice(0, MAX_HTML_CHARS) : null,
    };
  }

  prune() {
    const oldest = Date.now() - MAX_AGE_MS;
    this.messages = this.messages.filter((m) => m.storedAt >= oldest).slice(-MAX_MESSAGES);
  }

  // Primer uid visible para una página que se abre ahora mismo.
  viewStartUid() {
    const cutoff = Date.now() - this.lookbackMs;
    const recent = this.messages.filter((m) => m.receivedAt >= cutoff);
    return recent.length > 0 ? Math.min(...recent.map((m) => m.uid)) : this.lastUid + 1;
  }

  messagesFrom(uid) {
    this.prune();
    return this.messages.filter((m) => m.uid >= uid);
  }
}

module.exports = { MailWatcher };
