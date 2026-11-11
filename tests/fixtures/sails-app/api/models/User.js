module.exports = {
  attributes: {
    email: { type: 'string', required: true },
    pets: { collection: 'pet', via: 'owner' }
  },
  fullName: function (user) {
    return `${user.first} ${user.last}`;
  },
  beforeCreate: function (values, proceed) {
    return proceed();
  }
};
