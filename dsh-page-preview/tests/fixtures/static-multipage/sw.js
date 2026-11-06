/* 仅用于隔离浏览器内的注册探针，未接管业务页。 */
self.addEventListener('install', function () { self.skipWaiting() })
