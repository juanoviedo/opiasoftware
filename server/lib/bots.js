'use strict';

const BOTS = /(bot|crawl|spider|slurp|curl|wget|python-requests|python-urllib|httpclient|okhttp|java\/|libwww|node-fetch|axios|headlesschrome|phantomjs|selenium|playwright|puppeteer|lighthouse|pagespeed|pingdom|uptimerobot|statuscake|dataprovider|semrush|ahrefs|mj12|dotbot|baiduspider|yandex|facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterest|applebot|google-extended|gptbot|claudebot|perplexitybot|bytespider|amazonbot|meta-externalagent)/i;

const PREVIEW_FETCHERS = /(facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|slackbot|discordbot|embedly|outbrain|pinterest|showyoubot)/i;

function isBot(userAgent) {
  if (!userAgent) return true; // sin UA casi nunca es un navegador real
  return BOTS.test(userAgent);
}

/** Los crawlers de vista previa de redes no son visitas humanas ni leads. */
function isSocialPreview(userAgent) {
  return !!userAgent && PREVIEW_FETCHERS.test(userAgent);
}

module.exports = { isBot, isSocialPreview, BOTS };
