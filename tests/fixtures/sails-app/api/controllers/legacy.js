module.exports = async function (req, res) {
  const p = await Paymnet.create({ amount: 1 });
  return res.json(p);
};
