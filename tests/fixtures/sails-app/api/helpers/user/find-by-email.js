module.exports = {
  friendlyName: 'Find by email',
  inputs: { email: { type: 'string', required: true } },
  exits: { notFound: { description: 'No user' } },
  fn: async function (inputs, exits) {
    const user = await User.findOne({ email: inputs.email });
    if (!user) { return exits.notFound(); }
    return exits.success(user);
  }
};
