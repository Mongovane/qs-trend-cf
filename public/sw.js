/**
 * Service Worker for 趋势终端 PWA.
 *
 * 策略：网络优先（network-first），因为这是**行情工具**——
 * 数据必须尽量新鲜。缓存只作为离线兜底，不能让用户看到过期行情。
 *
 * - 对 /api/* 请求：永远走网络，不缓存（行情数据）
 * - 对静态资源（HTML/JS/CSS）：网络优先，失败时回退缓存
 * - 离线时至少能打开壳页面
 */
const CACHE_NAME = 'qs-trend-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 请求（行情数据）：永远走网络，绝不用缓存，避免看到过期数据
  if (url.pathname.startsWith('/api/')) {
    return; // 不拦截，交给浏览器默认网络请求
  }

  // 只处理同源 GET
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // 静态资源：网络优先，失败回退缓存
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        // 成功则更新缓存
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
  );
});
