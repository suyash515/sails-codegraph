module.exports.create = async function (req, res) {
  await sails.models.user.updateOne({ id: req.param('id') }).set({ admin: true });
  return res.ok();
};
