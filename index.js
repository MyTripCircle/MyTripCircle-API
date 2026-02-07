// Simple Express API (JS) for Expo dev
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const os = require("os");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Auth + user routes backed by MongoDB (users collection)
const authRoutes = express.Router();

const userRoutes = express.Router();

function getJwtSecret() {
  return process.env.JWT_SECRET || "dev-secret-change-me";
}

console.log("ENV CHECK:", {
  MAIL_USER: process.env.MAIL_USER,
  MAIL_PASS: process.env.MAIL_PASS ? "OK" : "MISSING",
});

// Email transporter configuration
let transporter = null;
if (process.env.MAIL_USER && process.env.MAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });
  console.log("[server] Email transporter configured");
} else {
  console.log("[server] Email transporter NOT configured - emails will be logged only");
}

// Send OTP email
async function sendOtpEmail(to, otp) {
  if (!transporter) {
    console.log(`[EMAIL] Would send OTP ${otp} to ${to} (transporter not configured)`);
    return { success: true, logged: true };
  }

  try {
    await transporter.sendMail({
      from: `"MyTripCircle" <${process.env.MAIL_USER}>`,
      to,
      subject: "Your verification code",
      text: `Your verification code is: ${otp}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2891FF;">Your verification code</h2>
          <p>Use the following code to verify your account:</p>
          <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #2891FF;">${otp}</span>
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p style="color: #666; font-size: 14px;">If you didn't request this code, please ignore this email.</p>
        </div>
      `,
    });
    console.log(`[EMAIL] OTP sent to ${to}`);
    return { success: true };
  } catch (error) {
    console.error("[EMAIL] Error sending OTP:", error.message);
    // Fallback: log OTP instead of throwing
    console.log(`[EMAIL] Fallback - OTP ${otp} for ${to}`);
    return { success: true, logged: true, error: error.message };
  }
}

// Send password reset email
async function sendPasswordResetEmail(to, resetToken) {
  if (!transporter) {
    console.log(`[EMAIL] Would send reset link to ${to} (transporter not configured)`);
    return { success: true, logged: true };
  }

  try {
    const resetLink = `${process.env.API_BASE_URL || 'http://localhost:19006'}/reset-password?token=${resetToken}`;

    await transporter.sendMail({
      from: `"MyTripCircle" <${process.env.MAIL_USER}>`,
      to,
      subject: "Reset your password",
      text: `You requested a password reset. Click the link below to reset your password:\n\n${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you didn't request this, please ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2891FF;">Reset your password</h2>
          <p>You requested a password reset. Click the button below to reset your password:</p>
          <div style="margin: 30px 0;">
            <a href="${resetLink}" style="background: #2891FF; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Reset Password</a>
          </div>
          <p>Or copy this link:</p>
          <p style="background: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all; font-size: 12px;">${resetLink}</p>
          <p style="color: #666; font-size: 14px;">This link will expire in 1 hour.</p>
          <p style="color: #666; font-size: 14px;">If you didn't request this, please ignore this email.</p>
        </div>
      `,
    });
    console.log(`[EMAIL] Password reset link sent to ${to}`);
    return { success: true };
  } catch (error) {
    console.error("[EMAIL] Error sending password reset:", error.message);
    // Fallback: log token instead of throwing
    console.log(`[EMAIL] Fallback - Reset token for ${to}: ${resetToken}`);
    return { success: true, logged: true, error: error.message };
  }
}

function sanitizeUser(userDoc) {
  if (!userDoc) return null;
  return {
    id: String(userDoc._id),
    name: userDoc.name,
    email: userDoc.email,
    phone: userDoc.phone,
    avatar: userDoc.avatar,
    verified: userDoc.verified || false,
    createdAt: userDoc.createdAt,
  };
}

function isStrongPassword(password) {
  if (typeof password !== "string") return false;
  // min 8 chars, 1 uppercase, 1 lowercase, 1 digit, 1 special character
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(
    password,
  );
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, getJwtSecret());
    const userId = typeof decoded === "string" ? decoded : decoded.id;

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
}

// Fonction pour lier les demandes d'amis en attente à un utilisateur nouvellement inscrit/mis à jour
async function linkPendingFriendRequests(userId, userEmail, userPhone) {
  try {
    // Trouver les demandes d'amis en attente pour cet email ou téléphone
    const pendingRequests = await db.collection("friendRequests").find({
      recipientId: null,
      status: "pending",
      $or: [
        userEmail ? { recipientEmail: userEmail } : {},
        userPhone ? { recipientPhone: userPhone } : {},
      ].filter(Boolean),
    }).toArray();

    if (pendingRequests.length > 0) {
      // Mettre à jour ces demandes avec l'ID du destinataire
      const requestIds = pendingRequests.map(r => r._id);
      await db.collection("friendRequests").updateMany(
        { _id: { $in: requestIds } },
        { $set: { recipientId: userId } }
      );

      // Envoyer des notifications aux senders
      for (const request of pendingRequests) {
        if (transporter) {
          try {
            const sender = await db.collection("users").findOne({ _id: new ObjectId(request.senderId) });
            if (sender) {
              const newUser = await db.collection("users").findOne({ _id: new ObjectId(userId) });
              await transporter.sendMail({
                from: process.env.MAIL_USER || "noreply@mytripcircle.com",
                to: sender.email,
                subject: "Votre demande d'ami a été trouvée !",
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #2891FF 0%, #8869FF 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                      <h1 style="color: white; margin: 0;">🌍 MyTripCircle</h1>
                    </div>
                    <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
                      <h2 style="color: #333;">Bonne nouvelle !</h2>
                      <p style="color: #666; font-size: 16px;">
                        <strong>${newUser?.name || userEmail}</strong> vient de s'inscrire sur MyTripCircle.
                      </p>
                      <p style="color: #666;">
                        La demande d'ami que vous avez envoyée est maintenant visible dans leur application !
                      </p>
                    </div>
                  </div>
                `,
              });
            }
          } catch (emailError) {
            console.error("Error sending friend request notification:", emailError);
          }
        }
      }

      return pendingRequests.length;
    }
    return 0;
  } catch (error) {
    console.error("Error linking pending friend requests:", error);
    return 0;
  }
}

authRoutes.post("/register", async (req, res) => {
  try {
    const name = trimIfString(req.body?.name);
    const email = trimIfString(req.body?.email)?.toLowerCase();
    const password = req.body?.password;
    const phone = trimIfString(req.body?.phone);

    if (!name || !email || !password || !phone) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        error: "Weak password",
        field: "password",
      });
    }

    // Very permissive phone validation (E.164-ish)
    const phoneOk = /^[+]?[\d\s().-]{7,20}$/.test(phone);
    if (!phoneOk) {
      return res.status(400).json({
        success: false,
        error: "Invalid phone number",
        field: "phone",
      });
    }

    const existing = await db.collection("users").findOne({ email });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: "Email already in use",
        field: "email",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const userDoc = {
      name,
      email,
      // Store the hash under `password` to satisfy MongoDB validators/schemas.
      password: passwordHash,
      phone,
      otp,
      otpExpiresAt,
      verified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("users").insertOne(userDoc);
    const userId = String(result.insertedId);

    // Send OTP email
    await sendOtpEmail(email, otp);

    return res.status(201).json({
      success: true,
      userId,
      message: "OTP sent to your email",
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

authRoutes.post("/login", async (req, res) => {
  try {
    const email = trimIfString(req.body?.email)?.toLowerCase();
    const password = req.body?.password;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields" });
    }

    const user = await db.collection("users").findOne({ email });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
        field: "password",
      });
    }

    const storedHash = user.passwordHash || user.password;
    if (!storedHash) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
        field: "password",
      });
    }

    const ok = await bcrypt.compare(password, storedHash);
    if (!ok) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
        field: "password",
      });
    }

    // Check if user is verified (OTP validated)
    if (!user.verified) {
      // Check if OTP is still valid
      if (user.otp && user.otpExpiresAt && new Date() < new Date(user.otpExpiresAt)) {
        return res.status(403).json({
          success: false,
          error: "Please verify your account with the OTP sent to your email",
          requiresOtp: true,
          userId: String(user._id),
        });
      }
      // OTP expired, generate a new one
      const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await db.collection("users").updateOne(
        { _id: user._id },
        { $set: { otp: newOtp, otpExpiresAt } }
      );

      // Send new OTP email
      await sendOtpEmail(user.email, newOtp);

      return res.status(403).json({
        success: false,
        error: "Your verification code expired. A new code has been sent to your email",
        requiresOtp: true,
        userId: String(user._id),
      });
    }

    const token = jwt.sign({ id: String(user._id) }, getJwtSecret(), {
      expiresIn: "7d",
    });

    return res.json({
      success: true,
      token,
      user: sanitizeUser(user),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

userRoutes.put("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const name = trimIfString(req.body?.name);
    const email = trimIfString(req.body?.email)?.toLowerCase();
    const phone = trimIfString(req.body?.phone);

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: "Name and email are required",
      });
    }

    const existing = await db.collection("users").findOne({
      email,
      _id: { $ne: userId },
    });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, error: "Email already in use" });
    }

    const updateData = { name, email, updatedAt: new Date() };
    if (phone) {
      updateData.phone = phone;
    }

    await db
      .collection("users")
      .updateOne(
        { _id: userId },
        { $set: updateData },
      );

    // Lier les demandes d'amis en attente (si le téléphone a été ajouté/modifié)
    const user = await db.collection("users").findOne({ _id: userId });
    if (user) {
      await linkPendingFriendRequests(String(userId), user.email, user.phone);
    }

    const updated = await db.collection("users").findOne({ _id: userId });
    return res.json({ success: true, user: sanitizeUser(updated) });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

userRoutes.put("/change-password", requireAuth, async (req, res) => {
  try {
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields" });
    }

    const storedHash = req.user.passwordHash || req.user.password;
    if (!storedHash) {
      return res.status(400).json({
        success: false,
        error: "Current password is incorrect",
      });
    }

    const ok = await bcrypt.compare(currentPassword, storedHash);
    if (!ok) {
      return res.status(400).json({
        success: false,
        error: "Current password is incorrect",
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        error: "Weak password",
        field: "password",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.collection("users").updateOne(
      { _id: req.user._id },
      {
        $set: { password: passwordHash, updatedAt: new Date() },
        $unset: { passwordHash: "" },
      },
    );

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Forgot password - request reset link
authRoutes.post("/forgot-password", async (req, res) => {
  try {
    const email = trimIfString(req.body?.email)?.toLowerCase();

    if (!email) {
      return res
        .status(400)
        .json({ success: false, error: "Email is required" });
    }

    const user = await db.collection("users").findOne({ email });
    if (!user) {
      // Don't reveal if email exists for security
      return res.json({
        success: true,
        message: "If an account exists, a reset link has been sent",
      });
    }

    // Generate reset token (simple implementation - in production use crypto.randomBytes)
    const resetToken = require("crypto").randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store reset token (in production, use a separate collection)
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: {
          resetToken,
          resetTokenExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      },
    );

    // Send password reset email
    await sendPasswordResetEmail(email, resetToken);

    return res.json({
      success: true,
      message: "If an account exists, a reset link has been sent",
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Reset password with token
authRoutes.post("/reset-password", async (req, res) => {
  try {
    const token = req.body?.token;
    const newPassword = req.body?.newPassword;

    if (!token || !newPassword) {
      return res
        .status(400)
        .json({ success: false, error: "Token and new password are required" });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        error: "Weak password",
        field: "password",
      });
    }

    const user = await db.collection("users").findOne({
      resetToken: token,
      resetTokenExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired reset token",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: {
          password: passwordHash,
          updatedAt: new Date(),
        },
        $unset: {
          resetToken: "",
          resetTokenExpiresAt: "",
          passwordHash: "",
        },
      },
    );

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Verify OTP
authRoutes.post("/verify-otp", async (req, res) => {
  try {
    const userId = req.body?.userId;
    const otp = req.body?.otp;

    if (!userId || !otp) {
      return res.status(400).json({
        success: false,
        error: "User ID and OTP are required",
      });
    }

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // Check if OTP exists and is valid
    if (!user.otp || user.otp !== otp) {
      return res.status(400).json({
        success: false,
        error: "Invalid OTP",
      });
    }

    // Check if OTP has expired
    if (user.otpExpiresAt && new Date() > new Date(user.otpExpiresAt)) {
      return res.status(400).json({
        success: false,
        error: "OTP has expired",
      });
    }

    // Mark user as verified and clear OTP
    await db.collection("users").updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          verified: true,
          updatedAt: new Date(),
        },
        $unset: {
          otp: "",
          otpExpiresAt: "",
        },
      },
    );

    // Lier les demandes d'amis en attente pour cet utilisateur
    await linkPendingFriendRequests(userId, user.email, user.phone);

    // Generate JWT token
    const token = jwt.sign({ id: userId }, getJwtSecret(), {
      expiresIn: "7d",
    });

    // Get updated user
    const updatedUser = await db
      .collection("users")
      .findOne({ _id: new ObjectId(userId) });

    return res.json({
      success: true,
      token,
      user: sanitizeUser(updatedUser),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.use("/users", authRoutes);
// Middleware de logging pour debug
app.use((req, res, next) => {
  console.log(`[server] ${req.method} ${req.path}`);
  next();
});

app.use("/users", userRoutes);

const PORT = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 4000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "mytripcircle";

// IP depuis .env ou détection automatique
const ACTIVE_IP =
  process.env.API_IP_PRIMARY ||
  (() => {
    console.log(
      "[server] API_IP_PRIMARY not set, detecting IP automatically...",
    );
    const interfaces = os.networkInterfaces();
    const priorityInterfaces = ["Wi-Fi", "Ethernet", "en0", "eth0"];

    for (const interfaceName of priorityInterfaces) {
      if (interfaces[interfaceName]) {
        for (const iface of interfaces[interfaceName]) {
          if (iface.family === "IPv4" && !iface.internal) {
            return iface.address;
          }
        }
      }
    }

    // Fallback: première IP non-internale
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }

    return "localhost";
  })();

let db;
const trimIfString = (value) =>
  typeof value === "string" ? value.trim() : value;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`[server] Connected to MongoDB: ${DB_NAME}`);
  // Best effort: ensure unique emails
  try {
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
  } catch (_) {
    // ignore
  }

  // Best effort: ensure `phone` is allowed by users collection validator (if any)
  try {
    const infos = await db
      .listCollections({ name: "users" }, { nameOnly: false })
      .toArray();
    const info = infos[0];
    const schema = info?.options?.validator?.$jsonSchema;

    if (schema?.properties && !schema.properties.phone) {
      const nextSchema = {
        ...schema,
        properties: {
          ...schema.properties,
          phone: { bsonType: "string" },
        },
      };

      await db.command({
        collMod: "users",
        validator: { $jsonSchema: nextSchema },
        validationLevel: info?.options?.validationLevel || "strict",
        validationAction: info?.options?.validationAction || "error",
      });

      console.log("[server] users validator updated (phone enabled)");
    }
  } catch (e) {
    console.log("[server] Could not update users validator:", e?.message || e);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/test", (req, res) => {
  res.status(200).json({
    message: "Backend is working!",
    timestamp: new Date().toISOString(),
    trips: "Use /trips endpoint",
    bookings: "Use /bookings endpoint",
    addresses: "Use /addresses endpoint",
  });
});

app.get("/trips", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    // Filtrer : voyages où l'utilisateur est propriétaire OU collaborateur
    const items = await db.collection("trips").find({
      $or: [
        { ownerId: userId },
        { "collaborators.userId": userId }
      ]
    }).toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/trips/:id", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const item = await db
      .collection("trips")
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: "Not found" });

    // Vérifier que l'utilisateur a accès à ce voyage
    const isOwner = item.ownerId === userId;
    const isCollaborator = item.collaborators?.some(c => c.userId === userId);
    if (!isOwner && !isCollaborator && !item.isPublic) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Créer un nouveau voyage
app.post("/trips", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const {
      title,
      description,
      destination,
      startDate,
      endDate,
      isPublic,
      visibility,
      tags,
      status,
    } = req.body;

    console.log("=== CREATE TRIP DEBUG ===");
    console.log("Request body:", req.body);
    console.log("User ID from token:", userId);

    // Validation des champs requis
    if (!title || !destination || !startDate || !endDate) {
      console.log("Missing required fields");
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Validation des dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    const now = new Date();

    // Permettre la date du jour (enlever les heures/minutes/secondes pour la comparaison)
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDateOnly = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
    );

    if (start >= end) {
      console.log("End date must be after start date");
      return res
        .status(400)
        .json({ error: "End date must be after start date" });
    }

    if (startDateOnly < today) {
      console.log("Start date cannot be in the past");
      return res
        .status(400)
        .json({ error: "Start date cannot be in the past" });
    }

    // Déterminer la visibilité basée sur les paramètres reçus
    const tripVisibility = visibility || (isPublic ? "public" : "private");

    // Créer un voyage avec tous les champs requis selon le schéma MongoDB
    const trip = {
      title: title.trim(),
      description: description ? description.trim() : "",
      destination: destination.trim(),
      startDate: start,
      endDate: end,
      ownerId: userId, // Utiliser l'ID de l'utilisateur connecté
      collaborators: [], // Initialiser avec un tableau vide
      isPublic: isPublic || false,
      visibility: tripVisibility, // Utiliser la visibilité fournie ou calculée
      status: status || "draft", // Utiliser le status fourni ou "draft" par défaut
      createdAt: new Date(),
      updatedAt: new Date(),
      stats: {
        // Ajouter les stats requises
        totalBookings: 0,
        totalAddresses: 0,
        totalCollaborators: 0,
      },
      location: {
        // Ajouter la géolocalisation (coordonnées par défaut pour l'instant)
        type: "Point",
        coordinates: [0, 0], // Coordonnées par défaut jusqu'à géolocalisation
      },
      tags: tags || [], // Utiliser les tags fournis ou tableau vide
    };

    console.log("Trip object to insert:", JSON.stringify(trip, null, 2));

    const result = await db.collection("trips").insertOne(trip);
    console.log("Insert result:", result);

    trip._id = result.insertedId;
    console.log("Final trip with _id:", trip);

    res.status(201).json(trip);
  } catch (e) {
    console.error("Error creating trip:", e);
    console.error("Error message:", e.message);
    console.error("Error code:", e.code);
    console.error("Error details:", e);
    res.status(500).json({ error: e.message });
  }
});

// Modifier un voyage
app.put("/trips/:id", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { id } = req.params;
    const {
      title,
      description,
      destination,
      startDate,
      endDate,
      isPublic,
      status,
    } = req.body;

    // Vérifier que le voyage existe
    const existingTrip = await db
      .collection("trips")
      .findOne({ _id: new ObjectId(id) });
    if (!existingTrip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    // Vérifier les permissions
    const isOwner = existingTrip.ownerId === userId;
    const isCollaborator = existingTrip.collaborators.some(
      (collab) => collab.userId === userId && collab.permissions.canEdit,
    );

    if (!isOwner && !isCollaborator) {
      return res
        .status(403)
        .json({ error: "Not authorized to edit this trip" });
    }

    // Validation des dates si fournies
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      if (start >= end) {
        return res
          .status(400)
          .json({ error: "End date must be after start date" });
      }
    }

    const updateData = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (destination !== undefined) updateData.destination = destination.trim();
    if (startDate !== undefined) updateData.startDate = new Date(startDate);
    if (endDate !== undefined) updateData.endDate = new Date(endDate);
    if (isPublic !== undefined) updateData.isPublic = isPublic;
    if (status !== undefined) updateData.status = status;

    const result = await db
      .collection("trips")
      .updateOne({ _id: new ObjectId(id) }, { $set: updateData });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Trip not found" });
    }

    // Récupérer le voyage mis à jour
    const updatedTrip = await db
      .collection("trips")
      .findOne({ _id: new ObjectId(id) });
    res.json(updatedTrip);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Supprimer un voyage
app.delete("/trips/:id", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { id } = req.params;

    // Vérifier que le voyage existe
    const existingTrip = await db
      .collection("trips")
      .findOne({ _id: new ObjectId(id) });
    if (!existingTrip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    // Vérifier les permissions (seul le propriétaire peut supprimer)
    if (existingTrip.ownerId !== userId) {
      return res
        .status(403)
        .json({ error: "Only the owner can delete this trip" });
    }

    // Supprimer le voyage et toutes ses données associées
    await Promise.all([
      db.collection("trips").deleteOne({ _id: new ObjectId(id) }),
      db.collection("bookings").deleteMany({ tripId: id }),
      db.collection("addresses").deleteMany({ tripId: id }),
      db.collection("invitations").deleteMany({ tripId: id }),
    ]);

    res.json({ success: true, message: "Trip deleted successfully" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Créer une nouvelle réservation (POST avant GET pour éviter les conflits)
app.post("/bookings", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const {
      tripId,
      type,
      title,
      description,
      date,
      endDate,
      time,
      address,
      confirmationNumber,
      price,
      currency,
      status,
      attachments,
    } = req.body;

    console.log("=== CREATE BOOKING DEBUG ===");
    console.log("Request body:", req.body);

    // Validation des champs requis
    if (!type || !title || !date) {
      console.log("Missing required fields");
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Créer la réservation
    const booking = {
      tripId: tripId || "",
      type,
      title: title.trim(),
      description: description ? description.trim() : undefined,
      date: new Date(date),
      endDate: endDate ? new Date(endDate) : undefined,
      time: time || undefined,
      address: address ? address.trim() : undefined,
      confirmationNumber: confirmationNumber
        ? confirmationNumber.trim()
        : undefined,
      price: price ? parseFloat(price) : undefined,
      currency: currency || "EUR",
      status: status || "pending",
      attachments: attachments || [],
      userId, // Lier la réservation à l'utilisateur connecté
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    console.log("Booking object to insert:", JSON.stringify(booking, null, 2));

    const result = await db.collection("bookings").insertOne(booking);
    console.log("Insert result:", result);

    booking._id = result.insertedId;
    console.log("Final booking with _id:", booking);

    res.status(201).json(booking);
  } catch (e) {
    console.error("Error creating booking:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/bookings", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    // Récupérer les réservations uniquement des voyages de l'utilisateur
    const userTrips = await db.collection("trips").find({
      $or: [
        { ownerId: userId },
        { "collaborators.userId": userId }
      ]
    }).project({ _id: 1 }).toArray();
    const tripIds = userTrips.map(t => String(t._id));

    const items = await db.collection("bookings").find({
      tripId: { $in: tripIds }
    }).toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/bookings/trip/:tripId", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const tripId = req.params.tripId;

    // Vérifier que l'utilisateur a accès à ce voyage
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
    if (!trip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const isOwner = trip.ownerId === userId;
    const isCollaborator = trip.collaborators?.some(c => c.userId === userId);
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: "Access denied" });
    }

    const items = await db
      .collection("bookings")
      .find({ tripId: tripId })
      .toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Supprimer une réservation
app.delete("/bookings/:id", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { id } = req.params;

    const booking = await db.collection("bookings").findOne({ _id: new ObjectId(id) });
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Vérifier les permissions : soit l'utilisateur est le créateur, soit il a accès au voyage
    const isCreator = booking.userId === userId;
    let hasTripAccess = false;

    if (booking.tripId && !isCreator) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(booking.tripId) });
      if (trip) {
        hasTripAccess = trip.ownerId === userId || trip.collaborators?.some(c => c.userId === userId && c.permissions.canDelete);
      }
    }

    if (!isCreator && !hasTripAccess) {
      return res.status(403).json({ error: "Access denied" });
    }

    await db.collection("bookings").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/addresses", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    // Récupérer les adresses liées aux voyages de l'utilisateur OU les adresses créées par l'utilisateur
    const userTrips = await db.collection("trips").find({
      $or: [
        { ownerId: userId },
        { "collaborators.userId": userId }
      ]
    }).project({ _id: 1 }).toArray();
    const tripIds = userTrips.map(t => String(t._id));

    const items = await db.collection("addresses").find({
      $or: [
        { tripId: { $in: tripIds } },
        { userId: userId }
      ]
    }).toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/addresses/trip/:tripId", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const tripId = req.params.tripId;

    // Vérifier que l'utilisateur a accès à ce voyage
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
    if (!trip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const isOwner = trip.ownerId === userId;
    const isCollaborator = trip.collaborators?.some(c => c.userId === userId);
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: "Access denied" });
    }

    const items = await db
      .collection("addresses")
      .find({ tripId: tripId })
      .toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/addresses/:id", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { id } = req.params;
    const item = await db
      .collection("addresses")
      .findOne({ _id: new ObjectId(id) });
    if (!item) {
      return res.status(404).json({ error: "Address not found" });
    }

    // Vérifier que l'utilisateur a accès à l'adresse
    const isOwner = item.userId === userId;
    let hasTripAccess = false;

    if (item.tripId && !isOwner) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(item.tripId) });
      if (trip) {
        hasTripAccess = trip.ownerId === userId || trip.collaborators?.some(c => c.userId === userId);
      }
    }

    if (!isOwner && !hasTripAccess) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/addresses", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { type, name, address, city, country, phone, website, notes, tripId } =
      req.body;

    if (!type || !name || !address || !city || !country) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const addressDoc = {
      type,
      name: trimIfString(name),
      address: trimIfString(address),
      city: trimIfString(city),
      country: trimIfString(country),
      phone: phone ? trimIfString(phone) : undefined,
      website: website ? trimIfString(website) : undefined,
      notes: notes ? trimIfString(notes) : undefined,
      tripId: tripId || undefined,
      userId, // Lier l'adresse à l'utilisateur connecté
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("addresses").insertOne(addressDoc);
    addressDoc._id = result.insertedId;
    res.status(201).json(addressDoc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/addresses/:id", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { id } = req.params;
    const existing = await db
      .collection("addresses")
      .findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ error: "Address not found" });
    }

    // Vérifier que l'utilisateur a accès à l'adresse
    const isOwner = existing.userId === userId;
    let hasTripEditAccess = false;

    if (existing.tripId && !isOwner) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(existing.tripId) });
      if (trip) {
        hasTripEditAccess = trip.ownerId === userId || trip.collaborators?.some(c => c.userId === userId && c.permissions.canEdit);
      }
    }

    if (!isOwner && !hasTripEditAccess) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { type, name, address, city, country, phone, website, notes } =
      req.body;

    const setData = { updatedAt: new Date() };
    const unsetData = {};

    if (type !== undefined) setData.type = type;
    if (name !== undefined) setData.name = trimIfString(name);
    if (address !== undefined) setData.address = trimIfString(address);
    if (city !== undefined) setData.city = trimIfString(city);
    if (country !== undefined) setData.country = trimIfString(country);

    if (phone !== undefined) {
      if (phone) {
        setData.phone = trimIfString(phone);
      } else {
        unsetData.phone = "";
      }
    }
    if (website !== undefined) {
      if (website) {
        setData.website = trimIfString(website);
      } else {
        unsetData.website = "";
      }
    }
    if (notes !== undefined) {
      if (notes) {
        setData.notes = trimIfString(notes);
      } else {
        unsetData.notes = "";
      }
    }

    const updatePayload = {};
    if (Object.keys(setData).length > 0) {
      updatePayload.$set = setData;
    }
    if (Object.keys(unsetData).length > 0) {
      updatePayload.$unset = unsetData;
    }

    await db
      .collection("addresses")
      .updateOne({ _id: new ObjectId(id) }, updatePayload);

    const updated = await db
      .collection("addresses")
      .findOne({ _id: new ObjectId(id) });

    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Supprimer une adresse
app.delete("/addresses/:id", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { id } = req.params;

    const address = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }

    // Vérifier les permissions : soit l'utilisateur est le créateur, soit il a accès au voyage
    const isCreator = address.userId === userId;
    let hasTripAccess = false;

    if (address.tripId && !isCreator) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(address.tripId) });
      if (trip) {
        hasTripAccess = trip.ownerId === userId || trip.collaborators?.some(c => c.userId === userId && c.permissions.canDelete);
      }
    }

    if (!isCreator && !hasTripAccess) {
      return res.status(403).json({ error: "Access denied" });
    }

    await db.collection("addresses").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== INVITATIONS ENDPOINTS =====

// Créer une invitation
app.post("/invitations", requireAuth, async (req, res) => {
  try {
    const inviterId = String(req.user._id);
    const { tripId, inviteeEmail, inviteePhone, message, permissions } = req.body;

    // Vérifier qu'au moins email ou téléphone est fourni
    if (!inviteeEmail && !inviteePhone) {
      return res.status(400).json({ error: "Email or phone number is required" });
    }

    // Vérifier que le trip existe
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
    if (!trip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    // Vérifier que l'inviteur est propriétaire ou collaborateur avec permissions
    const isOwner = trip.ownerId === inviterId;
    const isCollaborator = trip.collaborators.some(
      (collab) => collab.userId === inviterId && collab.permissions.canInvite,
    );

    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: "Not authorized to invite" });
    }

    // Vérifier que l'email/téléphone n'est pas déjà collaborateur
    const existingCollaborator = trip.collaborators.find(
      (collab) =>
        (inviteeEmail && (collab.userId === inviteeEmail || collab.email === inviteeEmail)) ||
        (inviteePhone && collab.phone === inviteePhone),
    );

    if (existingCollaborator) {
      return res.status(400).json({ error: "User is already a collaborator" });
    }

    // Vérifier qu'il n'y a pas d'invitation en attente
    const inviteQuery = { tripId, status: "pending" };
    if (inviteeEmail) inviteQuery.inviteeEmail = inviteeEmail;
    if (inviteePhone) inviteQuery.inviteePhone = inviteePhone;

    const existingInvitation = await db.collection("invitations").findOne(inviteQuery);

    if (existingInvitation) {
      return res.status(400).json({ error: "Invitation already pending" });
    }

    // Générer un token unique
    const token = require("crypto").randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 jours

    const invitation = {
      tripId,
      inviterId,
      ...(inviteeEmail && { inviteeEmail }),
      ...(inviteePhone && { inviteePhone }),
      status: "pending",
      token,
      expiresAt,
      permissions: permissions || {
        role: "editor",
        canEdit: true,
        canInvite: false,
        canDelete: false,
      },
      message: message || "",
      createdAt: new Date(),
      respondedAt: null,
    };

    const result = await db.collection("invitations").insertOne(invitation);
    invitation._id = result.insertedId;

    // Envoyer l'email d'invitation (seulement si email fourni)
    if (transporter && inviteeEmail) {
      try {
        // Récupérer les infos de l'inviteur
        const inviter = await db.collection("users").findOne({ _id: new ObjectId(inviterId) });
        const inviterName = inviter?.name || "Quelqu'un";

        // Créer le lien d'invitation (deep link pour l'app mobile)
        const invitationLink = `mytripcircle://invitation/${token}`;

        await transporter.sendMail({
          from: process.env.MAIL_USER || "noreply@mytripcircle.com",
          to: inviteeEmail,
          subject: `Invitation à rejoindre un voyage sur MyTripCircle`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #2891FF 0%, #8869FF 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0;">🌍 MyTripCircle</h1>
              </div>
              <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
                <h2 style="color: #333;">Vous avez été invité à un voyage !</h2>
                <p style="color: #666; font-size: 16px;">
                  <strong>${inviterName}</strong> vous a invité à rejoindre le voyage :
                </p>
                <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2891FF;">
                  <h3 style="color: #2891FF; margin: 0 0 10px 0;">${trip.title}</h3>
                  <p style="color: #666; margin: 5px 0;">📍 ${trip.destination}</p>
                  <p style="color: #666; margin: 5px 0;">📅 Du ${new Date(trip.startDate).toLocaleDateString('fr-FR')} au ${new Date(trip.endDate).toLocaleDateString('fr-FR')}</p>
                </div>
                ${message ? `<p style="color: #666; font-style: italic;">"${message}"</p>` : ''}
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${invitationLink}" style="background: linear-gradient(135deg, #2891FF 0%, #8869FF 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                    Accepter l'invitation
                  </a>
                </div>
                <p style="color: #999; font-size: 12px; text-align: center;">
                  Cette invitation expire dans 7 jours.<br>
                  Si vous n'avez pas l'application MyTripCircle, installez-la d'abord.
                </p>
              </div>
            </div>
          `,
          text: `
          Vous avez été invité à rejoindre un voyage sur MyTripCircle !

          ${inviterName} vous a invité à rejoindre : ${trip.title}
          Destination : ${trip.destination}
          Dates : Du ${new Date(trip.startDate).toLocaleDateString('fr-FR')} au ${new Date(trip.endDate).toLocaleDateString('fr-FR')}

          Pour accepter l'invitation, ouvrez le lien suivant dans l'application MyTripCircle :
          ${invitationLink}

          Cette invitation expire dans 7 jours.
          `,
        });
        console.log(`[EMAIL] Invitation sent to ${inviteeEmail}`);
      } catch (emailError) {
        console.error("[EMAIL] Error sending invitation email:", emailError);
        // Continuer même si l'email échoue
      }
    } else {
      console.log(`[EMAIL] Would send invitation to ${inviteeEmail} (transporter not configured)`);
    }

    res.status(201).json(invitation);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Récupérer les invitations d'un utilisateur
app.get("/invitations/user/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const { status } = req.query;

    let query = { inviteeEmail: email };
    if (status) {
      query.status = status;
    }

    const invitations = await db
      .collection("invitations")
      .find(query)
      .toArray();

    // Enrichir avec les données du trip
    const enrichedInvitations = await Promise.all(
      invitations.map(async (invitation) => {
        const trip = await db
          .collection("trips")
          .findOne({ _id: new ObjectId(invitation.tripId) });
        const inviter = await db
          .collection("users")
          .findOne({ _id: new ObjectId(invitation.inviterId) });

        return {
          ...invitation,
          trip: trip
            ? {
                _id: trip._id,
                title: trip.title,
                destination: trip.destination,
                startDate: trip.startDate,
                endDate: trip.endDate,
              }
            : null,
          inviter: inviter
            ? {
                _id: inviter._id,
                name: inviter.name,
                email: inviter.email,
                avatar: inviter.avatar,
              }
            : null,
        };
      }),
    );

    res.json(enrichedInvitations);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Récupérer une invitation par token (pour le lien d'invitation)
app.get("/invitations/token/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const invitation = await db.collection("invitations").findOne({ token });
    if (!invitation) {
      return res.status(404).json({ error: "Invitation not found" });
    }

    // Enrichir avec les données du trip et de l'inviteur
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(invitation.tripId) });
    const inviter = await db.collection("users").findOne({ _id: new ObjectId(invitation.inviterId) });

    const enrichedInvitation = {
      ...invitation,
      trip: trip
        ? {
            _id: trip._id,
            title: trip.title,
            destination: trip.destination,
            startDate: trip.startDate,
            endDate: trip.endDate,
            coverImage: trip.coverImage,
            description: trip.description,
          }
        : null,
      inviter: inviter
        ? {
            _id: inviter._id,
            name: inviter.name,
            email: inviter.email,
            avatar: inviter.avatar,
          }
        : null,
    };

    res.json(enrichedInvitation);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Accepter/Refuser une invitation
app.put("/invitations/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { action, userId } = req.body; // action: "accept" ou "decline"

    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    // Trouver l'invitation
    const invitation = await db.collection("invitations").findOne({ token });
    if (!invitation) {
      return res.status(404).json({ error: "Invitation not found" });
    }

    // Vérifier que l'invitation n'a pas expiré
    if (new Date() > invitation.expiresAt) {
      await db
        .collection("invitations")
        .updateOne({ _id: invitation._id }, { $set: { status: "expired" } });
      return res.status(400).json({ error: "Invitation has expired" });
    }

    // Vérifier que l'invitation est en attente
    if (invitation.status !== "pending") {
      return res.status(400).json({ error: "Invitation already processed" });
    }

    const newStatus = action === "accept" ? "accepted" : "declined";

    // Mettre à jour l'invitation
    await db.collection("invitations").updateOne(
      { _id: invitation._id },
      {
        $set: {
          status: newStatus,
          respondedAt: new Date(),
        },
      },
    );

    if (action === "accept") {
      // Ajouter l'utilisateur comme collaborateur
      const collaborator = {
        userId: userId || invitation.inviteeEmail, // Si pas d'userId, utiliser l'email
        role: invitation.permissions.role,
        joinedAt: new Date(),
        permissions: invitation.permissions,
        invitedBy: invitation.inviterId, // Stocker qui a invité ce collaborateur
      };

      await db
        .collection("trips")
        .updateOne(
          { _id: new ObjectId(invitation.tripId) },
          { $push: { collaborators: collaborator } },
        );
    }

    res.json({
      success: true,
      status: newStatus,
      message:
        action === "accept" ? "Invitation accepted" : "Invitation declined",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Récupérer les invitations envoyées par un utilisateur
app.get("/invitations/sent/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.query;

    let query = { inviterId: userId };
    if (status) {
      query.status = status;
    }

    const invitations = await db
      .collection("invitations")
      .find(query)
      .toArray();

    // Enrichir avec les données du trip
    const enrichedInvitations = await Promise.all(
      invitations.map(async (invitation) => {
        const trip = await db
          .collection("trips")
          .findOne({ _id: new ObjectId(invitation.tripId) });

        return {
          ...invitation,
          trip: trip
            ? {
                _id: trip._id,
                title: trip.title,
                destination: trip.destination,
                startDate: trip.startDate,
                endDate: trip.endDate,
              }
            : null,
        };
      }),
    );

    res.json(enrichedInvitations);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Récupérer les infos de plusieurs utilisateurs par leurs IDs
app.post("/users/batch", requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "IDs array is required" });
    }

    // Convertir les IDs en ObjectIds
    const objectIds = ids.map((id) => {
      try {
        return new ObjectId(id);
      } catch {
        return null;
      }
    }).filter((id) => id !== null);

    const users = await db
      .collection("users")
      .find({ _id: { $in: objectIds } })
      .toArray();

    // Sanitizer les utilisateurs
    const sanitizedUsers = users.map((user) => ({
      _id: user._id,
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      avatar: user.avatar,
    }));

    res.json(sanitizedUsers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== FRIENDS ENDPOINTS =====

// Envoyer une demande d'ami
app.post("/friends/request", requireAuth, async (req, res) => {
  try {
    const senderId = String(req.user._id);
    const { recipientEmail, recipientPhone } = req.body;

    if (!recipientEmail && !recipientPhone) {
      return res.status(400).json({ error: "Email or phone number is required" });
    }

    const sender = await db.collection("users").findOne({ _id: new ObjectId(senderId) });

    // Vérifier si l'utilisateur existe déjà (par email ou téléphone)
    let recipientUser = null;
    if (recipientEmail) {
      recipientUser = await db.collection("users").findOne({ email: recipientEmail });
    }
    if (!recipientUser && recipientPhone) {
      recipientUser = await db.collection("users").findOne({ phone: recipientPhone });
    }

    // Vérifier s'ils sont déjà amis
    if (recipientUser) {
      const existingFriendship = await db.collection("friends").findOne({
        $or: [
          { userId: senderId, friendId: String(recipientUser._id) },
          { userId: String(recipientUser._id), friendId: senderId },
        ],
      });

      if (existingFriendship) {
        return res.status(400).json({ error: "Already friends" });
      }

      // Vérifier si une demande est déjà en attente
      const existingRequest = await db.collection("friendRequests").findOne({
        senderId,
        recipientId: String(recipientUser._id),
        status: "pending",
      });

      if (existingRequest) {
        return res.status(400).json({ error: "Friend request already pending" });
      }
    } else {
      // Pour les utilisateurs sans compte, vérifier s'il y a une demande en attente
      const existingRequestQuery = { senderId, recipientId: null, status: "pending" };
      if (recipientEmail) {
        existingRequestQuery.recipientEmail = recipientEmail;
      }
      if (recipientPhone) {
        existingRequestQuery.recipientPhone = recipientPhone;
      }

      const existingRequest = await db.collection("friendRequests").findOne(existingRequestQuery);

      if (existingRequest) {
        return res.status(400).json({ error: "Friend request already pending" });
      }
    }

    // Créer la demande d'ami
    const friendRequest = {
      senderId,
      senderName: sender?.name || "Quelqu'un",
      recipientId: recipientUser ? String(recipientUser._id) : null,
      recipientEmail,
      recipientPhone,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await db.collection("friendRequests").insertOne(friendRequest);
    friendRequest._id = result.insertedId;

    // Envoyer un email si le destinataire a un compte
    if (recipientUser && transporter) {
      try {
        const requestLink = `mytripcircle://friends`; // Deep link vers la page amis

        await transporter.sendMail({
          from: process.env.MAIL_USER || "noreply@mytripcircle.com",
          to: recipientUser.email,
          subject: "Nouvelle demande d'ami sur MyTripCircle",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #2891FF 0%, #8869FF 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0;">🌍 MyTripCircle</h1>
              </div>
              <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
                <h2 style="color: #333;">Nouvelle demande d'ami !</h2>
                <p style="color: #666; font-size: 16px;">
                  <strong>${sender?.name || "Quelqu'un"}</strong> souhaite vous ajouter en ami sur MyTripCircle.
                </p>
                <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2891FF;">
                  <p style="color: #666; margin: 0;">
                    Acceptez cette demande pour commencer à partager vos voyages ensemble !
                  </p>
                </div>
                <p style="color: #9E9E9E; font-size: 14px; text-align: center; margin-top: 30px;">
                  Ouvrez l'application MyTripCircle pour répondre à cette demande.
                </p>
              </div>
            </div>
          `,
        });
      } catch (emailError) {
        console.error("Error sending friend request email:", emailError);
      }
    }

    res.json(friendRequest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Récupérer les demandes d'amis (pour l'utilisateur connecté)
app.get("/friends/requests", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);

    // Récupérer les demandes où l'utilisateur est le destinataire
    const requests = await db
      .collection("friendRequests")
      .find({ recipientId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    // Formater les demandes
    const formattedRequests = requests.map((req) => ({
      id: req._id.toString(),
      senderId: req.senderId,
      senderName: req.senderName,
      recipientEmail: req.recipientEmail,
      recipientPhone: req.recipientPhone,
      status: req.status,
      createdAt: req.createdAt,
      respondedAt: req.respondedAt,
    }));

    res.json(formattedRequests);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Répondre à une demande d'ami
app.put("/friends/requests/:requestId", requireAuth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action } = req.body; // "accept" ou "decline"

    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const request = await db.collection("friendRequests").findOne({
      _id: new ObjectId(requestId),
    });

    if (!request) {
      return res.status(404).json({ error: "Friend request not found" });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ error: "Friend request already processed" });
    }

    // Mettre à jour le statut de la demande
    if (action === "decline") {
      // Supprimer la demande pour permettre une nouvelle future
      await db.collection("friendRequests").deleteOne({ _id: new ObjectId(requestId) });
    } else {
      // Accepter : mettre à jour le statut
      await db.collection("friendRequests").updateOne(
        { _id: new ObjectId(requestId) },
        { $set: { status: "accepted", respondedAt: new Date() } }
      );
    }

    // Si accepté, créer l'amitié dans les deux sens
    if (action === "accept") {
      const now = new Date();

      // Récupérer les infos du sender
      const sender = await db.collection("users").findOne({ _id: new ObjectId(request.senderId) });

      await db.collection("friends").insertMany([
        {
          userId: request.senderId,
          friendId: request.recipientId,
          name: req.user.name,
          email: req.user.email,
          phone: req.user.phone,
          createdAt: now,
        },
        {
          userId: request.recipientId,
          friendId: request.senderId,
          name: sender?.name || request.senderName,
          email: sender?.email,
          phone: sender?.phone,
          createdAt: now,
        },
      ]);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Récupérer la liste d'amis
app.get("/friends", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);

    const friends = await db
      .collection("friends")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    const formattedFriends = friends.map((friend) => ({
      id: friend._id.toString(),
      userId: friend.userId,
      friendId: friend.friendId,
      name: friend.name,
      email: friend.email,
      phone: friend.phone,
      avatar: friend.avatar,
      createdAt: friend.createdAt,
    }));

    res.json(formattedFriends);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Supprimer un ami
app.delete("/friends/:friendId", requireAuth, async (req, res) => {
  try {
    const { friendId } = req.params;
    const userId = String(req.user._id);

    // Supprimer l'amitié dans les deux sens
    await db.collection("friends").deleteMany({
      $or: [
        { userId, friendId },
        { userId: friendId, friendId: userId },
      ],
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

connectMongo()
  .then(() => {
    // Log toutes les routes enregistrées pour debug
    console.log("[server] Routes registered:");
    console.log("  POST /bookings");
    console.log("  GET /bookings");
    console.log("  GET /bookings/trip/:tripId");

    app.listen(PORT, ACTIVE_IP, () => {
      console.log(`[server] API listening on http://${ACTIVE_IP}:${PORT}`);
      console.log(`[server] Accessible via http://localhost:${PORT}`);
      console.log(`[server] Use this IP in your app: ${ACTIVE_IP}`);
    });
  })
  .catch((err) => {
    console.error("[server] Mongo connection error:", err);
    process.exit(1);
  });

// Garder le processus actif
process.on("SIGINT", () => {
  console.log("\n[server] Shutting down gracefully...");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[server] Unhandled Rejection at:", promise, "reason:", reason);
});
