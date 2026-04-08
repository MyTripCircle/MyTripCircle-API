const nodemailer = require("nodemailer");
const { MAIL_USER, MAIL_PASS, API_BASE_URL } = require("../config");

let transporter = null;

if (MAIL_USER && MAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });
} else {
  console.warn("[email] Transporteur non configuré – les emails ne seront pas envoyés");
}

// ─── Charte graphique ─────────────────────────────────────────────────────────

const COLORS = {
  terra: "#C4714A",
  terraDark: "#A35830",
  terraLight: "#F5E5DC",
  sand: "#F5F0E8",
  sandLight: "#FDFAF5",
  sandMid: "#EDE5D8",
  ink: "#2A2318",
  inkMid: "#7A6A58",
  inkLight: "#B0A090",
  moss: "#6B8C5A",
  white: "#FFFFFF",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMAIL_HEADER = `
  <div style="background: linear-gradient(135deg, ${COLORS.terra} 0%, ${COLORS.terraDark} 100%); padding: 32px 30px; text-align: center; border-radius: 12px 12px 0 0;">
    <h1 style="color: ${COLORS.white}; margin: 0; font-family: Georgia, 'Times New Roman', serif; font-size: 26px; font-weight: 700; letter-spacing: 0.5px;">🌍 MyTripCircle</h1>
  </div>
`;

const EMAIL_FOOTER = `
  <div style="border-top: 1px solid ${COLORS.sandMid}; padding-top: 20px; margin-top: 30px; text-align: center;">
    <p style="color: ${COLORS.inkLight}; font-size: 12px; margin: 0 0 6px;">MyTripCircle — Partagez vos voyages entre amis</p>
    <p style="color: ${COLORS.inkLight}; font-size: 11px; margin: 0;">Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
  </div>
`;

function wrap(content) {
  return `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(42, 35, 24, 0.08);">
      ${EMAIL_HEADER}
      <div style="background: ${COLORS.sandLight}; padding: 32px 30px; border-radius: 0 0 12px 12px;">
        ${content}
        ${EMAIL_FOOTER}
      </div>
    </div>
  `;
}

async function _send(to, subject, html, text) {
  if (!transporter) {
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
    return { success: true };
  } catch (err) {
    console.error("[email] Erreur lors de l'envoi d'un email");
    return { success: false, error: err.message };
  }
}

// ─── Fonctions d'envoi publiques ──────────────────────────────────────────────

async function sendOtpEmail(to, otp) {
  const html = wrap(`
    <h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">Votre code de vérification</h2>
    <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 20px;">Utilisez le code suivant pour vérifier votre compte :</p>
    <div style="background: ${COLORS.white}; padding: 24px; text-align: center; border-radius: 10px; margin: 0 0 20px; border: 1px solid ${COLORS.sandMid};">
      <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: ${COLORS.terra}; font-family: 'Courier New', monospace;">${otp}</span>
    </div>
    <p style="color: ${COLORS.inkMid}; font-size: 14px; margin: 0 0 6px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
    <p style="color: ${COLORS.inkLight}; font-size: 13px; margin: 0;">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
  `);
  return _send(to, "Votre code de vérification MyTripCircle", html);
}

async function sendPasswordResetEmail(to, resetToken) {
  const resetLink = `${API_BASE_URL}/reset-password?token=${resetToken}`;
  const html = wrap(`
    <h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">Réinitialisation du mot de passe</h2>
    <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 24px;">Cliquez sur le bouton ci-dessous pour réinitialiser votre mot de passe :</p>
    <div style="text-align: center; margin: 0 0 24px;">
      <a href="${resetLink}" style="background: ${COLORS.terra}; color: ${COLORS.white}; padding: 14px 32px; text-decoration: none; border-radius: 10px; display: inline-block; font-weight: 600; font-size: 15px;">Réinitialiser le mot de passe</a>
    </div>
    <p style="color: ${COLORS.inkMid}; font-size: 13px; margin: 0 0 8px;">Ou copiez ce lien :</p>
    <p style="background: ${COLORS.white}; padding: 12px; border-radius: 8px; word-break: break-all; font-size: 12px; color: ${COLORS.inkMid}; border: 1px solid ${COLORS.sandMid}; margin: 0 0 20px;">${resetLink}</p>
    <p style="color: ${COLORS.inkLight}; font-size: 13px; margin: 0 0 4px;">⏱ Ce lien expire dans <strong>1 heure</strong>.</p>
    <p style="color: ${COLORS.inkLight}; font-size: 13px; margin: 0;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
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
      ? `<h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">Nouvelle demande d'ami !</h2>
         <div style="background: ${COLORS.white}; padding: 20px; border-radius: 10px; margin: 16px 0 20px; border-left: 4px solid ${COLORS.moss}; border: 1px solid ${COLORS.sandMid}; border-left: 4px solid ${COLORS.moss};">
           <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0;">👋 <strong style="color: ${COLORS.ink};">${senderName}</strong> souhaite vous ajouter en ami sur MyTripCircle.</p>
         </div>
         <p style="color: ${COLORS.inkLight}; font-size: 13px; text-align: center; margin: 0;">Ouvrez l'application MyTripCircle pour répondre.</p>`
      : `<h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">New friend request!</h2>
         <div style="background: ${COLORS.white}; padding: 20px; border-radius: 10px; margin: 16px 0 20px; border: 1px solid ${COLORS.sandMid}; border-left: 4px solid ${COLORS.moss};">
           <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0;">👋 <strong style="color: ${COLORS.ink};">${senderName}</strong> wants to add you as a friend on MyTripCircle.</p>
         </div>
         <p style="color: ${COLORS.inkLight}; font-size: 13px; text-align: center; margin: 0;">Open the MyTripCircle app to respond.</p>`
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
      ? `<h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">Bonne nouvelle !</h2>
         <div style="background: ${COLORS.white}; padding: 20px; border-radius: 10px; margin: 16px 0 20px; border: 1px solid ${COLORS.sandMid}; border-left: 4px solid ${COLORS.moss};">
           <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 8px;">🎉 <strong style="color: ${COLORS.ink};">${newUserName}</strong> vient de s'inscrire sur MyTripCircle.</p>
           <p style="color: ${COLORS.inkMid}; font-size: 14px; margin: 0;">La demande d'ami que vous avez envoyée est maintenant visible dans leur application !</p>
         </div>`
      : `<h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">Great news!</h2>
         <div style="background: ${COLORS.white}; padding: 20px; border-radius: 10px; margin: 16px 0 20px; border: 1px solid ${COLORS.sandMid}; border-left: 4px solid ${COLORS.moss};">
           <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 8px;">🎉 <strong style="color: ${COLORS.ink};">${newUserName}</strong> just signed up on MyTripCircle.</p>
           <p style="color: ${COLORS.inkMid}; font-size: 14px; margin: 0;">The friend request you sent is now visible in their app!</p>
         </div>`
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
    ? `<div style="background: ${COLORS.terraLight}; padding: 16px; border-radius: 8px; margin: 0 0 20px;">
         <p style="color: ${COLORS.inkMid}; font-style: italic; margin: 0; font-size: 14px;">"${message}"</p>
       </div>`
    : "";
  const tripCard = `
    <div style="background: ${COLORS.white}; padding: 20px; border-radius: 10px; margin: 16px 0 20px; border: 1px solid ${COLORS.sandMid}; border-left: 4px solid ${COLORS.terra};">
      <h3 style="color: ${COLORS.terra}; margin: 0 0 12px 0; font-family: Georgia, 'Times New Roman', serif; font-size: 18px;">${tripTitle}</h3>
      <p style="color: ${COLORS.inkMid}; margin: 0 0 6px; font-size: 14px;">📍 ${tripDestination}</p>
      <p style="color: ${COLORS.inkMid}; margin: 0; font-size: 14px;">📅 ${startFmt} → ${endFmt}</p>
    </div>
  `;
  const isFr = lang !== "en";
  const subject = isFr
    ? "Invitation à rejoindre un voyage sur MyTripCircle"
    : "You've been invited to join a trip on MyTripCircle";
  const html = wrap(
    isFr
      ? `<h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">Vous avez été invité à un voyage !</h2>
         <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 4px;"><strong style="color: ${COLORS.ink};">${inviterName}</strong> vous a invité à rejoindre le voyage :</p>
         ${tripCard}${msgBlock}
         <div style="text-align: center; margin: 0 0 20px;">
           <a href="${invitationLink}" style="background: ${COLORS.terra}; color: ${COLORS.white}; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 600; display: inline-block; font-size: 15px;">Accepter l'invitation</a>
         </div>
         <p style="color: ${COLORS.inkLight}; font-size: 12px; text-align: center; margin: 0;">⏱ Cette invitation expire dans 7 jours.</p>`
      : `<h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">You've been invited to a trip!</h2>
         <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 4px;"><strong style="color: ${COLORS.ink};">${inviterName}</strong> has invited you to join:</p>
         ${tripCard}${msgBlock}
         <div style="text-align: center; margin: 0 0 20px;">
           <a href="${invitationLink}" style="background: ${COLORS.terra}; color: ${COLORS.white}; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 600; display: inline-block; font-size: 15px;">Accept the invitation</a>
         </div>
         <p style="color: ${COLORS.inkLight}; font-size: 12px; text-align: center; margin: 0;">⏱ This invitation expires in 7 days.</p>`
  );
  return _send(to, subject, html);
}

async function sendFriendJoinedEmail(to, newFriendName) {
  const html = wrap(`
    <h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">Nouvel ami !</h2>
    <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 16px;"><strong style="color: ${COLORS.ink};">${newFriendName}</strong> a accepté votre invitation et est maintenant votre ami sur MyTripCircle.</p>
    <div style="background: ${COLORS.white}; padding: 20px; border-radius: 10px; margin: 0 0 20px; border: 1px solid ${COLORS.sandMid}; border-left: 4px solid ${COLORS.moss};">
      <p style="color: ${COLORS.inkMid}; margin: 0; font-size: 14px;">🌍 Commencez à partager vos voyages ensemble !</p>
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
