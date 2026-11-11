const stripe = require('stripe');

function validate(card) {
  return !!card;
}

function charge(card) {
  validate(card);
  return stripe.charges.create({ card });
}

module.exports = {
  charge,
  refund: async function (id) {
    await this.charge(id);
    return Payment.updateOne({ id }).set({ refunded: true });
  },
  formatAll(cards) {
    return cards.map(validate);
  }
};
