module.exports = {
  friendlyName: 'Create payment',
  inputs: {
    amount: { type: 'number', required: true }
  },
  exits: {
    success: { description: 'Created' }
  },
  fn: async function (inputs, exits) {
    const result = await sails.helpers.payment.process.with({ amount: inputs.amount });
    console.log('created', result);
    return exits.success(result);
  }
};
