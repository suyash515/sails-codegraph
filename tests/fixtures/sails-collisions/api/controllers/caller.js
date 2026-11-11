module.exports = {
  fn: async function (inputs, exits) {
    await sails.helpers.findByEmail();
    return exits.success();
  }
};
