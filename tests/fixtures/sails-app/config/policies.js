module.exports.policies = {
  '*': 'isLoggedIn',
  'payment/*': ['isLoggedIn', 'isAdmin'],
  'payment/refund': ['isAdmin', 'isLoggedIn'],
  'user/view-profile': true,
  'legacy': false,
  UserController: {
    '*': 'isLoggedIn',
    find: true
  },
  'admin/*': ['isLoggedIn', 'isAdmin', 'isAuditor']
};
