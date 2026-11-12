module.exports = {
  friendlyName: 'Process payment',
  inputs: { amount: { type: 'number', required: true } },
  fn: async function (inputs, exits) {
    const record = await Payment.create({ amount: inputs.amount }).fetch();
    return exits.success(record);
  }
};
