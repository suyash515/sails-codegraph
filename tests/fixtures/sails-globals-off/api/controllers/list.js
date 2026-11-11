module.exports = {
  fn: async function (inputs, exits) {
    const a = await User.find();
    const b = await sails.models.user.find();
    MailService.send();
    return exits.success([a, b]);
  }
};
