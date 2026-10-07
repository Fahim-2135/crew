// Crew's phone browser app: the service worker that makes it installable and shows its
// notifications. Messages arrive encrypted from the hub (io/webpush.mjs); tapping one opens the
// agent's chat. Nothing is cached: Crew only works while the PC answers.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = { title: "Crew", body: "Tap to open.", data: {} };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    /* an empty push: the default text */
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      data: message.data,
      icon: "/icon.png",
      badge: "/badge.png",
      tag: message.data?.agent ? `crew-${message.data.agent}` : "crew",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const agent = event.notification.data?.agent;
  const url = agent ? `/?agent=${encodeURIComponent(agent)}` : "/";
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if (agent) client.postMessage({ k: "open", agent });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
