module.exports = {
  friendlyName: 'Refund payment',
  inputs: { id: { type: 'string', required: true } },
  fn: async (inputs, exits) => {
    await sails.helpers.payment.process
      .with({ amount: 0 })
      .intercept('E_DECLINED', () => 'badRequest')
      .tolerate('notFound');
    await PaymentService.refund(inputs.id);
    return exits.success();
  }
};
