'use strict';

/** GET /api/logout — cierra la sesión del panel y vuelve al login. */

const auth = require('./_lib/auth');

module.exports = async (req, res) => {
  auth.destroySession(res);
  res.writeHead(303, { Location: '/opadmin', 'Cache-Control': 'no-store' });
  res.end();
};
