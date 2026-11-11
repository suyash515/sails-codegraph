module.exports.routes = {
  'GET /': { view: 'pages/homepage' },
  'POST /api/payments': 'payment/create',
  'POST /api/payments/:id/refund': { action: 'payment/refund', csrf: false },
  'GET /users/:id': { action: 'user/view-profile' },
  'GET /users/me': 'user/view-profile',
  'POST /legacy-user': 'UserController.create',
  'GET /legacy-user/:id': { controller: 'UserController', action: 'find' },
  'POST /admin/user': 'admin/UserController.create',
  '/legacy': 'legacy',
  'GET /old': '/new',
  'GET /moved': { redirect: '/elsewhere' },
  'GET /health': function (req, res) { return res.ok(); },
  'GET /missing': 'nothing/here',
  ...require('./routes/admin')
};
