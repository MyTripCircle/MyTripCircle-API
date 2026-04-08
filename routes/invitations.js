const express = require("express");
const crypto = require("node:crypto");
const logger = require("../utils/logger");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendTripInvitationEmail } = require("../utils/email");
const { API_BASE_URL } = require("../config");

const router = express.Router();

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

    const isOwner = trip.ownerId === inviterId;
    const isCollaborator = trip.collaborators.some(
      (c) => c.userId === inviterId && c.permissions.canInvite
    );
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: "Non autorisé à inviter" });
    }

    const existingCollaborator = trip.collaborators.find(
      (c) =>
        (inviteeEmail && c.email === inviteeEmail) ||
        (inviteePhone && c.phone === inviteePhone)
    );
    if (existingCollaborator) {
      return res.status(400).json({ error: "Utilisateur déjà collaborateur" });
    }

    const inviteQuery = { tripId, status: "pending" };
    if (inviteeEmail) inviteQuery.inviteeEmail = inviteeEmail;
    if (inviteePhone) inviteQuery.inviteePhone = inviteePhone;

    const existingInvitation = await db.collection("invitations").findOne(inviteQuery);
    if (existingInvitation) return res.status(400).json({ error: "Invitation déjà en attente" });

    const token = crypto.randomBytes(32).toString("hex");
    const invitation = {
      tripId,
      inviterId,
      ...(inviteeEmail && { inviteeEmail }),
      ...(inviteePhone && { inviteePhone }),
      status: "pending",
      token,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      permissions: permissions || { role: "editor", canEdit: true, canInvite: false, canDelete: false },
      message: message || "",
      createdAt: new Date(),
      respondedAt: null,
    };

    const result = await db.collection("invitations").insertOne(invitation);
    invitation._id = result.insertedId;

    if (inviteeEmail) {
      const inviter = await db.collection("users").findOne({ _id: new ObjectId(inviterId) });
      const inviteeUser = await db.collection("users").findOne({ email: inviteeEmail });
      await sendTripInvitationEmail(inviteeEmail, inviteeUser?.language || "fr", {
        inviterName: inviter?.name || "Quelqu'un",
        tripTitle: trip.title,
        tripDestination: trip.destination,
        tripStartDate: trip.startDate,
        tripEndDate: trip.endDate,
        message,
        invitationLink: `mytripcircle://invitation/${token}`,
      });
    }

    return res.status(201).json(invitation);
  } catch (e) {

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
    if (req.user.email !== email.toLowerCase()) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const query = { inviteeEmail: email };
    if (status) query.status = status;

    const invitations = await db.collection("invitations").find(query).toArray();

    const enriched = await Promise.all(
      invitations.map(async (inv) => {
        const trip = await db.collection("trips").findOne({ _id: new ObjectId(inv.tripId) });
        const inviter = await db.collection("users").findOne({ _id: new ObjectId(inv.inviterId) });
        return {
          ...inv,
          trip: trip ? { _id: trip._id, title: trip.title, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate } : null,
          inviter: inviter ? { _id: inviter._id, name: inviter.name, email: inviter.email, avatar: inviter.avatar } : null,
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
router.get("/token/:token", async (req, res) => {
  try {
    const db = getDb();
    const invitation = await db.collection("invitations").findOne({ token: req.params.token });
    if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });

    const trip = await db.collection("trips").findOne({ _id: new ObjectId(invitation.tripId) });
    const inviter = await db.collection("users").findOne({ _id: new ObjectId(invitation.inviterId) });

    return res.json({
      ...invitation,
      trip: trip ? { _id: trip._id, title: trip.title, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate, coverImage: trip.coverImage, description: trip.description } : null,
      inviter: inviter ? { _id: inviter._id, name: inviter.name, email: inviter.email, avatar: inviter.avatar } : null,
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
      usageCount: 0,
    });

    return res.status(201).json({ token, link: `${API_BASE_URL}/join/${token}` });
  } catch (e) {

    logger.error("[invitations]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

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

    if (invitation.type === "link") {
      if (action === "decline") return res.json({ success: true, status: "declined" });

      const trip = await db.collection("trips").findOne({ _id: new ObjectId(invitation.tripId) });
      if (!trip) return res.status(404).json({ error: "Voyage introuvable" });

      const alreadyCollab = trip.collaborators.some((c) => c.userId === userId);
      if (alreadyCollab || trip.ownerId === userId) {
        return res.json({ success: true, status: "accepted", message: "Déjà membre" });
      }

      await db.collection("invitations").updateOne({ _id: invitation._id }, { $inc: { usageCount: 1 } });

      const linkPerms = invitation.permissions || { role: "editor", canEdit: true, canInvite: false, canDelete: false };
      await db.collection("trips").updateOne(
        { _id: new ObjectId(invitation.tripId) },
        { $push: { collaborators: { userId, role: linkPerms.role, joinedAt: new Date(), permissions: linkPerms, invitedBy: invitation.inviterId } } }
      );

      return res.json({ success: true, status: "accepted" });
    }

    if (new Date() > invitation.expiresAt) {
      await db.collection("invitations").updateOne({ _id: invitation._id }, { $set: { status: "expired" } });
      return res.status(400).json({ error: "Invitation expirée" });
    }

    if (invitation.status !== "pending") {
      return res.status(400).json({ error: "Invitation déjà traitée" });
    }

    const newStatus = action === "accept" ? "accepted" : "declined";

    if (action === "accept") {
      const permissions = invitation.permissions || { role: "editor", canEdit: true, canInvite: false, canDelete: false };
      await db.collection("trips").updateOne(
        { _id: new ObjectId(invitation.tripId) },
        { $push: { collaborators: { userId, role: permissions.role, joinedAt: new Date(), permissions, invitedBy: invitation.inviterId } } }
      );
    }

    await db.collection("invitations").updateOne(
      { _id: invitation._id },
      { $set: { status: newStatus, respondedAt: new Date() } }
    );

    return res.json({ success: true, status: newStatus });
  } catch (e) {

    logger.error("[invitations]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /invitations/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    let inv;
    try { inv = await db.collection("invitations").findOne({ _id: new ObjectId(id) }); } catch { inv = null; }
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
