module.exports = {
  fn: async function (inputs, exits) {
    const User = { findOne() { return null; } };
    const u = User.findOne({ id: 1 });
    return exits.success(u);
  }
};
