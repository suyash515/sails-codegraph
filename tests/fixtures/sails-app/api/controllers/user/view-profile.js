module.exports = {
  inputs: { email: { type: 'string' } },
  fn: async function (inputs, exits) {
    const user = await sails.helpers.user.findByEmail.with({ email: inputs.email });
    const again = await sails.helpers['user']['findByEmail'].with({ email: inputs.email });
    const name = 'user';
    const dyn = await sails.helpers[name].findByEmail();
    const withPets = await User.find({ id: user.id }).populate('pets');
    const greeting = sails.helpers.formatWelcomeMessage(user.fullName);
    return exits.success({ user, again, dyn, withPets, greeting });
  }
};
