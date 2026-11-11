module.exports = {
  friendlyName: 'Process payment',
  fn: async function (inputs, exits) {
    const record = await Payment.create({ amount: inputs.amount }).fetch();
    return exits.success(record);
  }
};
