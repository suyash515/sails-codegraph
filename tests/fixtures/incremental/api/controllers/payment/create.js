module.exports = {
  fn: async function (inputs, exits) {
    const result = await sails.helpers.payment.process.with({ amount: inputs.amount });
    return exits.success(result);
  }
};
