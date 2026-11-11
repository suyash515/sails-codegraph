module.exports = {
  _config: { actions: false },

  create: async function (req, res) {
    const user = await User.create(req.allParams()).fetch();
    sails.log.info('created user');
    return res.json(user);
  },

  find: function (req, res) {
    return User.findOne({ id: req.param('id') }).then((u) => res.ok(u));
  }
};
