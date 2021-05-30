# serviceworker-locks
Until the Web Locks API is universally available, a ServiceWorker is probably the best cross-platform mechanism for locking among contexts with the same origin. This is a proof-of-concept implementation of locking using a ServiceWorker.

[Try it!](https://rhashimoto.github.io/serviceworker-locks/demo/index.html)

## Implementation
See the [ServiceWorker code](https://github.com/rhashimoto/serviceworker-locks/blob/master/src/sw.js) and [how it is invoked](https://github.com/rhashimoto/serviceworker-locks/blob/8d09ba7a0cb1e044b220beff47dd604dc98236dc/demo/iframe/iframe.html#L58-L68) from a client (this would likely be abstracted into a library).

Locking requests are made from a client to the ServiceWorker using `fetch` with a special HTTP header providing the JSON request. The ServiceWorker holds the fetch request until it can be satisfied. A browser can stop the ServiceWorker at any time, including during an ongoing fetch, so clients must retry a request if rejected.

The global state of a ServiceWorker is reset whenever it is restarted, so lock state is persisted to IndexedDB.

Orphaned locks are detected by comparing the clientId of a lock holder to the active clients obtained by `Clients.matchAll`.

## Demo
Each box on the demo page is an iframe context. New iframes can be added and existing ones removed.

Within each context you can request a shared or exclusive lock, or release an acquired lock. When a lock is requested, its type is highlighted in yellow while pending and in green once acquired.

If a context is removed while holding a lock, it will eventually be released for the next requester. This may take a few seconds.
