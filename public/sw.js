// Lets phones install F the Bus as an app. The game always needs the live server, so requests go
// straight to the network; nothing is cached, and updates show up on the next open.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.mode === "navigate") e.respondWith(fetch(e.request));
});
