'use strict';

function parseOs(ua) {
  if (/Windows NT 10/i.test(ua)) return 'Windows';
  if (/Windows NT/i.test(ua)) return 'Windows';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Android/i.test(ua)) return 'Android';
  if (/(iPhone|iPad|iPod)/i.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Otro';
}

function parseBrowser(ua) {
  if (/EdgA?\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//i.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'Otro';
}

function parseDevice(ua) {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  // Chrome en Android no incluye "Mobile" en tabletas.
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function parseUserAgent(rawUa) {
  const ua = String(rawUa || '');
  return {
    device: parseDevice(ua),
    os: parseOs(ua),
    browser: parseBrowser(ua),
  };
}

module.exports = { parseUserAgent };
