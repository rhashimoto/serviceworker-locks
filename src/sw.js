const LOCK_HEADER = 'X-Lock-Request';
const UPDATE_INTERVAL = 5_000;

const IDB_DB_NAME = 'serviceworker-locks';
const IDB_STORE_NAME = 'locks';

console.debug(new Date().toLocaleTimeString(), 'service worker restart');

/**
 * Lock state object in both memory and IndexedDB.
 * @typedef Lock
 * @property {string} type 'shared' or 'exclusive'
 * @property {Set<string>} holders Each entry is a combination of clientId
 *   and contextId.
 */

/**
 * @typedef Request
 * @property {string} type 'shared', 'exclusive', or 'release'
 * @property {string} clientId obtained from FetchEvent.clientId
 * @property {string} contextId arbitrary string chosen by the client
 * @property {function} resolve callback executed when request fulfilled
 */

 class Locks {
  /**
   * Maps lock name to its state.
   * @type {Map<string, Lock}
   */
   _locks = new Map();

   /**
   * Maps lock name to its request queue.
   * @type {Map<string, Request>}
   */
  _queues = new Map();

  /**
   * Maps lock name to its setTimeout id.
   * If a client exits (e.g. tab closed) without releasing a lock, we need
   * some way to clear it. This is done by polling with setTimeout when
   * clients are waiting, and the timeout identifiers are kept here.
   * @type {Map<string, number}
   */
  _updates = new Map();

  /**
   * @param {Request} request 
   */
  async handleRequest(request) {
    if (!this._db) {
      await this._initialize();
    }

    if (typeof request.name !== 'string') {
      throw new Error(`invalid request: ${JSON.stringify(request)}`);
    }

    if (!request.type || request.type === 'release') {
      console.debug(`${request.clientId} ${request.contextId} release ${request.name}`)
      const lock = this._locks.get(request.name);
      lock?.holders?.delete?.(this._makeKey(request.clientId, request.contextId));
      request.resolve();
    } else {
      if (!this._queues.has(request.name)) {
        this._queues.set(request.name, []);
      }
      this._queues.get(request.name).push(request);
    }
    await this._updateLock(request.name);
  }

  async _initialize() {
    // Open the IndexedDB database of lock states.
    this._db = await idb(globalThis.indexedDB.open(IDB_DB_NAME, 1), {
      upgradeneeded(event) {
        const db = event.target.result;
        db.createObjectStore(IDB_STORE_NAME);
      }
    });

    // Load all the locks.
    await idb(this._getStore().openCursor(), {
      success: event => {
        const cursor = event.target.result;
        if (cursor) {
          this._locks.set(cursor.key, cursor.value);
          return cursor.continue();
        }
        return event.target.resolve();
      }
    });
  }

  /**
   * @param {string} [mode] 'readonly' or 'readwrite'
   * @returns {IDBObjectStore}
   */
  _getStore(mode) {
    return this._db.transaction(IDB_STORE_NAME, mode).objectStore(IDB_STORE_NAME);
  }

  /**
   * @param {string} name 
   */
  async _updateLock(name) {
    const queue = this._queues.get(name) ?? [];
    const lock = this._locks.get(name) ?? {
      type: undefined,
      holders: new Set()
    };

    // Clear any pending schedule update. If a new one is needed it will
    // be scheduled below.
    clearTimeout(this._updates.get(name) ?? 0);

    // Get current list of Window/Worker clients.
    // Note that not all browsers (Safari, Chromium-based) return Worker
    // clients here; Worker requests use their Window clientId. That does
    // not cause a problem as long as the association of client to clientId
    // is consistent.
    const clients = await globalThis.clients.matchAll({ type: 'all' });
    const clientIds = new Set(clients.map(client => client.id));

    // Remove lock holders that no longer exist. This occurs when a client
    // exits while holding locks.
    for (const holder of Array.from(lock.holders)) {
      const clientId = this._getClientIdFromKey(holder);
      if (!clientIds.has(clientId)) {
        lock.holders.delete(holder);
      }
    }

    // If no one has the lock, accept the first valid request.
    while (!lock.holders.size && queue.length) {
      const request = queue.shift();
      if (clientIds.has(request.clientId)) {
        console.debug(`${request.clientId} ${request.contextId} acquire ${name} ${request.type}`)
        lock.type = request.type;
        lock.holders = new Set([this._makeKey(request.clientId, request.contextId)]);
      }
      request.resolve();
    }

    // If the lock is shared, accept additional shared requests.
    if (lock.type === 'shared') {
      while (queue.length && queue[0].type === 'shared') {
        const request = queue.shift();
        if (clientIds.has(request.name)) {
          console.debug(`${request.clientId} ${request.contextId} acquire ${name} ${request.type}`)
          lock.holders.add(this._makeKey(request.clientId, request.contextId));
        }
        request.resolve();
      }
    }

    // If no one still has the lock, remove it.
    const store = this._getStore('readwrite');
    if (!lock.holders.size) {
      this._locks.delete(name);
      this._queues.delete(name);
      store.delete(name);
    } else {
      // Otherwise, schedule an update if anyone is waiting.
      if (queue.length) {
        this._updates.set(name, setTimeout(() => this._updateLock(name), UPDATE_INTERVAL));
      }

      // And preserve the lock state both in memory and IndexedDB.
      this._locks.set(name, lock);
      store.put(lock, name);
    }
  }

  /**
   * @param {string} clientId 
   * @param {string} contextId 
   * @returns 
   */
  _makeKey(clientId, contextId) {
    return `${clientId}%swl%${contextId}`
  }

  /**
   * Parse the clientId from a key generated by `_makeKey`.
   * @param {string} key 
   * @returns 
   */
  _getClientIdFromKey(key) {
    return key.match(/(.*)%swl%/)[1];
  }
}

const locks = new Locks();

globalThis.addEventListener('install', function() {
  globalThis.skipWaiting();
});

globalThis.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

globalThis.addEventListener('fetch', function(event) {
  // Ignore requests that don't have the special header.
  const headers = event.request.headers;
  if (!headers.has(LOCK_HEADER)) return;

  // Build and submit the lock request.
  const result = new Promise(resolve => {
    const request = JSON.parse(headers.get(LOCK_HEADER));
    Object.assign(request, { resolve, clientId: event.clientId });
    locks.handleRequest(request);
  }).then(function() {
    return new Response(null, {
      status: 200,
      statusText: 'OK'
    });
  });

  // Extend the event lifetime until the request is satisfied.
  event.respondWith(result);
  event.waitUntil?.(result);
});

// Convenience Promisification for IDBRequest.
function idb(request, listeners = {}) {
  listeners = Object.assign({
    'success': () => request.resolve(request.result),
    'error': () => request.reject('idb error')
  }, listeners);
  return new Promise(function(resolve, reject) {
    Object.assign(request, { resolve, reject });
    for (const type of Object.keys(listeners)) {
      request.addEventListener(type, listeners[type]);
    }
  });
}