const express = require("express");
const crypto = require("node:crypto");
const logger = require("../utils/logger");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendTripInvitationEmail } = require("../utils/email");
const { API_BASE_URL } = require("../config");
const { hashField, encrypt, decrypt, decryptUserFields } = require("../utils/crypto");
const { getUserFeatures } = require("../utils/subscriptionHelper");

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertInviterCanInvite(trip, inviterId) {
  const isOwner = trip.ownerId === inviterId;
  const canInvite = trip.collaborators.some(
    (c) => c.userId === inviterId && c.permissions.canInvite
  );
  if (!isOwner && !canInvite) throw httpError("Non autorisé à inviter", 403);
}

async function assertCollaboratorLimit(db, trip) {
  const features = await getUserFeatures(db, trip.ownerId);
  if (features.maxCollaborators !== -1 && trip.collaborators.length >= features.maxCollaborators) {
    throw httpError(
      `Limite de ${features.maxCollaborators} collaborateurs atteinte — passez à Premium pour en inviter davantage`,
      403
    );
  }
}

async function assertNoDuplicate(db, trip, inviteQuery, inviteeEmail, inviteePhone) {
  const alreadyMember = trip.collaborators.find(
    (c) => (inviteeEmail && c.email === inviteeEmail) || (inviteePhone && c.phone === inviteePhone)
  );
  if (alreadyMember) throw httpError("Utilisateur déjà collaborateur", 400);

  const existing = await db.collection("invitations").findOne(inviteQuery);
  if (existing) throw httpError("Invitation déjà en attente", 400);
}

function buildInviteQuery(tripId, inviteeEmail, inviteePhone) {
  const query = { tripId, status: "pending" };
  if (inviteeEmail) query.inviteeEmailHash = hashField(inviteeEmail);
  if (inviteePhone) query.inviteePhoneHash = hashField(inviteePhone);
  return query;
}

function buildInvitationDoc(tripId, inviterId, { inviteeEmail, inviteePhone, token, permissions, message }) {
  return {
    tripId,
    inviterId,
    ...(inviteeEmail && { inviteeEmail: encrypt(inviteeEmail), inviteeEmailHash: hashField(inviteeEmail) }),
    ...(inviteePhone && { inviteePhone: encrypt(inviteePhone), inviteePhoneHash: hashField(inviteePhone) }),
    status: "pending",
    token,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    permissions: permissions || { role: "editor", canEdit: true, canInvite: false, canDelete: false },
    message: message || "",
    createdAt: new Date(),
    respondedAt: null,
  };
}

async function maybeSendInvitationEmail(db, inviteeEmail, inviterId, trip, token, message) {
  if (!inviteeEmail) return;
  const [inviter, inviteeUser] = await Promise.all([
    db.collection("users").findOne({ _id: new ObjectId(inviterId) }),
    db.collection("users").findOne({ emailHash: hashField(inviteeEmail) }),
  ]);
  await sendTripInvitationEmail(inviteeEmail, {
    inviterName: (inviter?.name ? decrypt(inviter.name) : null) || "Quelqu'un",
    tripTitle: trip.title,
    tripDestination: trip.destination,
    tripStartDate: trip.startDate,
    tripEndDate: trip.endDate,
    message,
    invitationLink: `mytripcircle://invitation/${token}`,
  }, inviteeUser?.language || "fr");
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /invitations
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const inviterId = String(req.user._id);
    const { tripId, inviteeEmail, inviteePhone, message, permissions } = req.body;

    if (!inviteeEmail && !inviteePhone) {
      return res.status(400).json({ error: "Email ou numéro de téléphone requis" });
    }

    const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
    if (!trip) return res.status(404).json({ error: "Voyage introuvable" });

    assertInviterCanInvite(trip, inviterId);
    await assertCollaboratorLimit(db, trip);

    const inviteQuery = buildInviteQuery(tripId, inviteeEmail, inviteePhone);
    await assertNoDuplicate(db, trip, inviteQuery, inviteeEmail, inviteePhone);

    const token = crypto.randomBytes(32).toString("hex");
    const invitation = buildInvitationDoc(tripId, inviterId, { inviteeEmail, inviteePhone, token, permissions, message });

    const result = await db.collection("invitations").insertOne(invitation);
    invitation._id = result.insertedId;

    await maybeSendInvitationEmail(db, inviteeEmail, inviterId, trip, token, message);

    return res.status(201).json(invitation);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    logger.error("[invitations]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /invitations/user/:email — nécessite authentification (anti-énumération)
router.get("/user/:email", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { email } = req.params;
    const { status } = req.query;

    // Vérification : seul l'utilisateur connecté peut voir ses propres invitations
    // req.user.email est déchiffré par le middleware
    if (req.user.email?.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const query = { inviteeEmailHash: hashField(email) };
    if (status) query.status = status;

    const invitations = await db.collection("invitations").find(query).toArray();

    const enriched = await Promise.all(
      invitations.map(async (inv) => {
        const trip = await db.collection("trips").findOne({ _id: new ObjectId(inv.tripId) });
        const inviter = await db.collection("users").findOne({ _id: new ObjectId(inv.inviterId) });
        return {
          ...inv,
          trip: trip ? { _id: trip._id, title: trip.title, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate } : null,
          inviter: inviter ? { _id: inviter._id, name: inviter.name ? decrypt(inviter.name) : null, email: inviter.email ? decrypt(inviter.email) : null, avatar: inviter.avatar } : null,
        };
      })
    );

    return res.json(enriched);
  } catch (e) {
    logger.error("[invitations]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /invitations/token/:token
router.get("/token/:token", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const invitation = await db.collection("invitations").findOne({ token: req.params.token });
    if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });

    const trip = await db.collection("trips").findOne({ _id: new ObjectId(invitation.tripId) });
    const inviter = await db.collection("users").findOne({ _id: new ObjectId(invitation.inviterId) });

    return res.json({
      ...invitation,
      trip: trip ? { _id: trip._id, title: trip.title, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate, coverImage: trip.coverImage, description: trip.description } : null,
      inviter: inviter ? { _id: inviter._id, name: inviter.name ? decrypt(inviter.name) : null, avatar: inviter.avatar } : null,
    });
  } catch (e) {
    logger.error("[invitations]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /invitations/sent — récupérer les invitations envoyées (authentifié)
router.get("/sent", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { status } = req.query;

    const query = { inviterId: userId };
    if (status) query.status = status;

    const invitations = await db.collection("invitations").find(query).toArray();

    const enriched = await Promise.all(
      invitations.map(async (inv) => {
        const trip = await db.collection("trips").findOne({ _id: new ObjectId(inv.tripId) });
        return {
          ...inv,
          trip: trip ? { _id: trip._id, title: trip.title, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate } : null,
        };
      })
    );

    return res.json(enriched);
  } catch (e) {
    logger.error("[invitations]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// POST /invitations/trip-link/:tripId
router.post("/trip-link/:tripId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const inviterId = String(req.user._id);
    const { tripId } = req.params;
    const { force } = req.body;

    const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
    if (!trip) return res.status(404).json({ error: "Voyage introuvable" });

    const isOwner = trip.ownerId === inviterId;
    const isCollaborator = trip.collaborators.some((c) => c.userId === inviterId && c.permissions.canInvite);
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: "Non autorisé à créer un lien d'invitation" });
    }

    if (force) {
      await db.collection("invitations").deleteMany({ tripId, inviterId, type: "link" });
    } else {
      const existing = await db.collection("invitations").findOne({ tripId, inviterId, type: "link" });
      if (existing) {
        return res.json({ token: existing.token, link: `${API_BASE_URL}/join/${existing.token}` });
      }
    }

    const token = crypto.randomBytes(32).toString("hex");
    await db.collection("invitations").insertOne({
      tripId,
      inviterId,
      type: "link",
      status: "pending",
      token,
      permissions: { role: "editor", canEdit: true, canInvite: false, canDelete: false },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      usageCount: 0,
    });

    return res.status(201).json({ token, link: `${API_BASE_URL}/join/${token}` });
  } catch (e) {
    logger.error("[invitations]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// ── Helpers PUT /:token ────────────────────────────────────────────────────

async function acceptLinkInvitation(db, invitation, userId) {
  if (invitation.expiresAt && new Date() > invitation.expiresAt) {
    throw httpError("Ce lien d'invitation a expiré", 400);
  }

  const trip = await db.collection("trips").findOne({ _id: new ObjectId(invitation.tripId) });
  if (!trip) throw httpError("Voyage introuvable", 404);

  const alreadyMember = trip.collaborators.some((c) => c.userId === userId) || trip.ownerId === userId;
  if (alreadyMember) return { success: true, status: "accepted", message: "Déjà membre" };

  await db.collection("invitations").updateOne({ _id: invitation._id }, { $inc: { usageCount: 1 } });

  const perms = invitation.permissions || { role: "editor", canEdit: true, canInvite: false, canDelete: false };
  await db.collection("trips").updateOne(
    { _id: new ObjectId(invitation.tripId) },
    { $push: { collaborators: { userId, role: perms.role, joinedAt: new Date(), permissions: perms, invitedBy: invitation.inviterId } } }
  );

  return { success: true, status: "accepted" };
}

async function handleDirectInvitation(db, invitation, user, userId, action) {
  if (new Date() > invitation.expiresAt) {
    await db.collection("invitations").updateOne({ _id: invitation._id }, { $set: { status: "expired" } });
    throw httpError("Invitation expirée", 400);
  }

  if (invitation.status !== "pending") throw httpError("Invitation déjà traitée", 400);

  if (action === "accept") {
    const emailMatch = invitation.inviteeEmailHash && user.emailHash === invitation.inviteeEmailHash;
    const phoneMatch = invitation.inviteePhoneHash && user.phoneHash === invitation.inviteePhoneHash;
    if (!emailMatch && !phoneMatch) throw httpError("Cette invitation ne vous est pas destinée", 403);

    const permissions = invitation.permissions || { role: "editor", canEdit: true, canInvite: false, canDelete: false };
    await db.collection("trips").updateOne(
      { _id: new ObjectId(invitation.tripId) },
      { $push: { collaborators: { userId, role: permissions.role, joinedAt: new Date(), permissions, invitedBy: invitation.inviterId } } }
    );
  }

  const newStatus = action === "accept" ? "accepted" : "declined";
  await db.collection("invitations").updateOne(
    { _id: invitation._id },
    { $set: { status: newStatus, respondedAt: new Date() } }
  );

  return { success: true, status: newStatus };
}

// PUT /invitations/:token — accepter/refuser (authentification requise)
router.put("/:token", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { token } = req.params;
    const { action } = req.body;
    const userId = String(req.user._id);

    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ error: "Action invalide" });
    }

    const invitation = await db.collection("invitations").findOne({ token });
    if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });

    let result;
    if (invitation.type === "link") {
      if (action === "decline") return res.json({ success: true, status: "declined" });
      result = await acceptLinkInvitation(db, invitation, userId);
    } else {
      result = await handleDirectInvitation(db, invitation, req.user, userId, action);
    }

    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    const message = status === 500 ? "Erreur interne du serveur" : e.message;
    logger.error("[invitations]", e.message);
    return res.status(status).json({ error: message });
  }
});

// DELETE /invitations/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    let inv;
    try { inv = await db.collection("invitations").findOne({ _id: new ObjectId(id) }); } catch (e) { logger.warn("[invitations] ID invalide:", e.message); inv = null; }
    if (!inv) return res.status(404).json({ error: "Invitation introuvable" });
    if (inv.inviterId !== userId) return res.status(403).json({ error: "Impossible d'annuler l'invitation d'un autre" });

    await db.collection("invitations").deleteOne({ _id: new ObjectId(id) });
    return res.json({ success: true });
  } catch (e) {
    logger.error("[invitations]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /join/:token — deep link redirect
router.get("/join/:token", async (req, res) => {
  try {
    const db = getDb();
    const { token } = req.params;
    const invitation = await db.collection("invitations").findOne({ token });
    if (!invitation) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Lien invalide ou expiré</h2>
          <p>Ce lien d'invitation n'est plus valide.</p>
        </body></html>
      `);
    }
    return res.redirect(`mytripcircle://invitation/${token}`);
  } catch (e) {
    logger.error("[invitations]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
