// IncuVision Service Worker for Push & Background Notifications
const CACHE_NAME = 'incuvision-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Handle Notification Clicks (Focus or Open Dashboard)
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const targetUrl = event.notification.data?.url || '/dashboard/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes('/dashboard') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

// Background Push Event Receiver
self.addEventListener('push', (event) => {
    let data = {
        title: 'IncuVision Alert',
        body: 'Incubator status update',
        icon: '/dashboard/icons/icon-192.png',
        badge: '/dashboard/icons/icon-192.png'
    };

    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: data.icon || '/dashboard/icons/icon-192.png',
        badge: data.badge || '/dashboard/icons/icon-192.png',
        tag: data.tag || 'incuvision-alert',
        renotify: true,
        vibrate: [200, 100, 200],
        data: {
            url: data.url || '/dashboard/'
        }
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});
