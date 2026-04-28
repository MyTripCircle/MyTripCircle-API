const FREE_FEATURES = {
  maxTrips: 3,
  maxCollaborators: 2,
  canExport: false,
  prioritySupport: false,
  maxAttachments: 2,
};

async function getUserFeatures(db, userId) {
  const sub = await db.collection("subscriptions").findOne({ userId });
  if (!sub) return { ...FREE_FEATURES };

  const isActive =
    sub.status === "active" ||
    (sub.status === "cancelled" &&
      sub.endDate &&
      new Date(sub.endDate) > new Date());

  return isActive ? sub.features : { ...FREE_FEATURES };
}

module.exports = { FREE_FEATURES, getUserFeatures };
