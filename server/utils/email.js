const nodemailer = require("nodemailer");
const { MAIL_USER, MAIL_PASS, API_BASE_URL } = require("../config");

let transporter = null;

if (MAIL_USER && MAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });
  console.log("[email] Transporteur configuré");
} else {
  console.log("[email] Transporteur non configuré – emails uniquement loggés");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMAIL_HEADER = `
  <div style="background: linear-gradient(135deg, #2891FF 0%, #8869FF 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0;">🌍 MyTripCircle</h1>
  </div>
`;

function wrap(content) {
  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">${EMAIL_HEADER}<div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">${content}</div></div>`;
}

async function _send(to, subject, html, text) {
  if (!transporter) {
    console.log(`[email] (non envoyé) À: ${to} | Sujet: ${subject}`);
    return { success: true, logged: true };
  }
  try {
    await transporter.sendMail({
      from: `"MyTripCircle" <${MAIL_USER}>`,
      to,
      subject,
      html,
      text,
    });
    console.log(`[email] Envoyé à ${to}`);
    return { success: true };
  } catch (err) {
    console.error(`[email] Erreur lors de l'envoi à ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── Fonctions d'envoi publiques ──────────────────────────────────────────────

async function sendOtpEmail(to, otp) {
  const html = wrap(`
    <h2 style="color: #333;">Votre code de vérification</h2>
    <p>Utilisez le code suivant pour vérifier votre compte :</p>
    <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #2891FF;">${otp}</span>
    </div>
    <p>Ce code expire dans 10 minutes.</p>
    <p style="color: #666; font-size: 14px;">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
  `);
  return _send(to, "Votre code de vérification MyTripCircle", html);
}

async function sendPasswordResetEmail(to, resetToken) {
  const resetLink = `${API_BASE_URL}/reset-password?token=${resetToken}`;
  const html = wrap(`
    <h2 style="color: #333;">Réinitialisation du mot de passe</h2>
    <p>Cliquez sur le bouton ci-dessous pour réinitialiser votre mot de passe :</p>
    <div style="margin: 30px 0;">
      <a href="${resetLink}" style="background: #2891FF; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Réinitialiser le mot de passe</a>
    </div>
    <p>Ou copiez ce lien :</p>
    <p style="background: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all; font-size: 12px;">${resetLink}</p>
    <p style="color: #666; font-size: 14px;">Ce lien expire dans 1 heure.</p>
    <p style="color: #666; font-size: 14px;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
  `);
  const text = `Réinitialisez votre mot de passe MyTripCircle:\n\n${resetLink}\n\nCe lien expire dans 1 heure.`;
  return _send(to, "Réinitialisation de votre mot de passe", html, text);
}

async function sendFriendRequestEmail(to, senderName, lang = "fr") {
  const isFr = lang !== "en";
  const subject = isFr
    ? "Nouvelle demande d'ami sur MyTripCircle"
    : "New friend request on MyTripCircle";
  const html = wrap(
    isFr
      ? `<h2 style="color: #333;">Nouvelle demande d'ami !</h2>
         <p style="color: #666; font-size: 16px;"><strong>${senderName}</strong> souhaite vous ajouter en ami sur MyTripCircle.</p>
         <p style="color: #9E9E9E; font-size: 14px; text-align: center; margin-top: 30px;">Ouvrez l'application MyTripCircle pour répondre.</p>`
      : `<h2 style="color: #333;">New friend request!</h2>
         <p style="color: #666; font-size: 16px;"><strong>${senderName}</strong> wants to add you as a friend on MyTripCircle.</p>
         <p style="color: #9E9E9E; font-size: 14px; text-align: center; margin-top: 30px;">Open the MyTripCircle app to respond.</p>`
  );
  return _send(to, subject, html);
}

async function sendFriendRequestFoundEmail(to, newUserName, lang = "fr") {
  const isFr = lang !== "en";
  const subject = isFr
    ? "Votre demande d'ami a été trouvée !"
    : "Your friend request has been found!";
  const html = wrap(
    isFr
      ? `<h2 style="color: #333;">Bonne nouvelle !</h2>
         <p style="color: #666; font-size: 16px;"><strong>${newUserName}</strong> vient de s'inscrire sur MyTripCircle.</p>
         <p style="color: #666;">La demande d'ami que vous avez envoyée est maintenant visible dans leur application !</p>`
      : `<h2 style="color: #333;">Great news!</h2>
         <p style="color: #666; font-size: 16px;"><strong>${newUserName}</strong> just signed up on MyTripCircle.</p>
         <p style="color: #666;">The friend request you sent is now visible in their app!</p>`
  );
  return _send(to, subject, html);
}

async function sendTripInvitationEmail(
  to,
  lang = "fr",
  { inviterName, tripTitle, tripDestination, tripStartDate, tripEndDate, message, invitationLink }
) {
  const locale = lang === "en" ? "en-US" : "fr-FR";
  const startFmt = new Date(tripStartDate).toLocaleDateString(locale);
  const endFmt = new Date(tripEndDate).toLocaleDateString(locale);
  const msgBlock = message
    ? `<p style="color: #666; font-style: italic;">"${message}"</p>`
    : "";
  const tripCard = `
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2891FF;">
      <h3 style="color: #2891FF; margin: 0 0 10px 0;">${tripTitle}</h3>
      <p style="color: #666; margin: 5px 0;">📍 ${tripDestination}</p>
      <p style="color: #666; margin: 5px 0;">📅 ${startFmt} → ${endFmt}</p>
    </div>
  `;
  const isFr = lang !== "en";
  const subject = isFr
    ? "Invitation à rejoindre un voyage sur MyTripCircle"
    : "You've been invited to join a trip on MyTripCircle";
  const html = wrap(
    isFr
      ? `<h2 style="color: #333;">Vous avez été invité à un voyage !</h2>
         <p style="color: #666; font-size: 16px;"><strong>${inviterName}</strong> vous a invité à rejoindre le voyage :</p>
         ${tripCard}${msgBlock}
         <div style="text-align: center; margin: 30px 0;">
           <a href="${invitationLink}" style="background: linear-gradient(135deg, #2891FF 0%, #8869FF 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Accepter l'invitation</a>
         </div>
         <p style="color: #999; font-size: 12px; text-align: center;">Cette invitation expire dans 7 jours.</p>`
      : `<h2 style="color: #333;">You've been invited to a trip!</h2>
         <p style="color: #666; font-size: 16px;"><strong>${inviterName}</strong> has invited you to join:</p>
         ${tripCard}${msgBlock}
         <div style="text-align: center; margin: 30px 0;">
           <a href="${invitationLink}" style="background: linear-gradient(135deg, #2891FF 0%, #8869FF 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Accept the invitation</a>
         </div>
         <p style="color: #999; font-size: 12px; text-align: center;">This invitation expires in 7 days.</p>`
  );
  return _send(to, subject, html);
}

async function sendFriendJoinedEmail(to, newFriendName) {
  const html = wrap(`
    <h2 style="color: #333;">Nouvel ami !</h2>
    <p style="color: #666; font-size: 16px;"><strong>${newFriendName}</strong> a accepté votre invitation et est maintenant votre ami sur MyTripCircle.</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2891FF;">
      <p style="color: #666; margin: 0;">Commencez à partager vos voyages ensemble !</p>
    </div>
  `);
  return _send(
    to,
    `${newFriendName} a rejoint vos amis sur MyTripCircle`,
    html
  );
}

module.exports = {
  sendOtpEmail,
  sendPasswordResetEmail,
  sendFriendRequestEmail,
  sendFriendRequestFoundEmail,
  sendTripInvitationEmail,
  sendFriendJoinedEmail,
};
