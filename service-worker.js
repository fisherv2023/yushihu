// Painting Eye Service Worker v1
const CACHE = 'painting-eye-v1';

const PRECACHE = [
  '/painting-eye.html',
  '/draw.html',
  '/ink-flow.html',
  '/de.html',
  '/icons/shader.png',
  '/icons/flow.png',
  '/icons/expo.png',
  '/icons/draw.png',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(cache){
      return cache.addAll(PRECACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e){
  e.respondWith(
    caches.match(e.request).then(function(cached){
      return cached || fetch(e.request);
    })
  );
});
