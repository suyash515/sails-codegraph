module.exports = {
  fn: async function (inputs, exits) {
    const rows = await Payment.find();
    const total = await LedgerService.total(rows);
    return exits.success({ rows, total });
  }
};
