/**
 * Service Worker for 育儿提醒应用
 * 提供离线缓存和后台通知功能
 */

const CACHE_NAME = 'reminder-app-v1';
const urlsToCache = [
    '/',
    '/reminder-app.html',
    '/reminder-styles.css',
    '/reminder-app.js',
    '/login.html',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap'
];

// 安装 Service Worker
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
    );
});

// 激活 Service Worker
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// 拦截网络请求
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // 如果缓存中有响应，返回缓存的版本
                if (response) {
                    return response;
                }

                // 否则从网络获取
                return fetch(event.request).then(response => {
                    // 检查是否收到有效响应
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }

                    // 克隆响应
                    const responseToCache = response.clone();

                    caches.open(CACHE_NAME)
                        .then(cache => {
                            cache.put(event.request, responseToCache);
                        });

                    return response;
                });
            })
    );
});

// 处理推送通知
self.addEventListener('push', event => {
    let data = {};

    if (event.data) {
        data = event.data.json();
    }

    const options = {
        body: data.body || '您有一个新的提醒',
        icon: data.icon || '/icon-192.png',
        badge: '/badge-72.png',
        vibrate: [200, 100, 200],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: data.id || 1
        },
        actions: [
            {
                action: 'complete',
                title: '完成',
                icon: '/check-icon.png'
            },
            {
                action: 'delay',
                title: '延后',
                icon: '/clock-icon.png'
            }
        ],
        requireInteraction: true
    };

    event.waitUntil(
        self.registration.showNotification(data.title || '育儿提醒', options)
    );
});

// 处理通知点击
self.addEventListener('notificationclick', event => {
    console.log('Notification click received:', event.action);

    event.notification.close();

    if (event.action === 'complete') {
        // 标记任务为完成
        clients.openWindow('/reminder-app.html?action=complete&id=' + event.notification.data.primaryKey);
    } else if (event.action === 'delay') {
        // 延后提醒
        clients.openWindow('/reminder-app.html?action=delay&id=' + event.notification.data.primaryKey);
    } else {
        // 打开应用主页
        clients.openWindow('/reminder-app.html');
    }
});

// 后台同步
self.addEventListener('sync', event => {
    if (event.tag === 'sync-reminders') {
        event.waitUntil(syncReminders());
    }
});

async function syncReminders() {
    try {
        const response = await fetch('/api/reminders');
        const data = await response.json();

        // 存储到 IndexedDB 以便离线访问
        const cache = await caches.open(CACHE_NAME);
        cache.put('/api/reminders', new Response(JSON.stringify(data)));

        console.log('Reminders synced successfully');
    } catch (error) {
        console.error('Failed to sync reminders:', error);
    }
}

// 定期后台同步（如果浏览器支持）
self.addEventListener('periodicsync', event => {
    if (event.tag === 'check-reminders') {
        event.waitUntil(checkAndNotifyReminders());
    }
});

async function checkAndNotifyReminders() {
    try {
        const response = await fetch('/api/reminders/pending');
        const reminders = await response.json();

        const now = new Date();

        reminders.forEach(reminder => {
            const reminderTime = new Date(reminder.reminderTime);
            const advanceTime = new Date(reminderTime.getTime() - reminder.advanceMinutes * 60 * 1000);

            if (now >= advanceTime && now <= reminderTime) {
                // 发送通知
                self.registration.showNotification(reminder.title, {
                    body: reminder.description,
                    icon: '/icon-192.png',
                    badge: '/badge-72.png',
                    tag: 'reminder-' + reminder.id,
                    data: {
                        id: reminder.id
                    },
                    requireInteraction: true
                });
            }
        });
    } catch (error) {
        console.error('Failed to check reminders:', error);
    }
}