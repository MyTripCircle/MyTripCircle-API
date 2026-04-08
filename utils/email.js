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
  sandLight: "#FDFAF5",
  sandMid: "#EDE5D8",
  ink: "#2A2318",
  inkMid: "#7A6A58",
  inkLight: "#B0A090",
  moss: "#6B8C5A",
  white: "#FFFFFF",
};

// ─── Composants HTML ──────────────────────────────────────────────────────────

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

function heading(text) {
  return `<h2 style="color: ${COLORS.ink}; margin: 0 0 8px; font-family: Georgia, 'Times New Roman', serif;">${text}</h2>`;
}

function infoCard(content, accentColor = COLORS.moss) {
  return `<div style="background: ${COLORS.white}; padding: 20px; border-radius: 10px; margin: 16px 0 20px; border: 1px solid ${COLORS.sandMid}; border-left: 4px solid ${accentColor};">${content}</div>`;
}

function ctaButton(text, link) {
  return `<div style="text-align: center; margin: 0 0 20px;"><a href="${link}" style="background: ${COLORS.terra}; color: ${COLORS.white}; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 600; display: inline-block; font-size: 15px;">${text}</a></div>`;
}

function caption(text) {
  return `<p style="color: ${COLORS.inkLight}; font-size: 13px; text-align: center; margin: 0;">${text}</p>`;
}

function cardLine(text, { size = 15, marginBottom = 0 } = {}) {
  return `<p style="color: ${COLORS.inkMid}; font-size: ${size}px; margin: 0 0 ${marginBottom}px;">${text}</p>`;
}

function bold(text) {
  return `<strong style="color: ${COLORS.ink};">${text}</strong>`;
}

// ─── Transport ────────────────────────────────────────────────────────────────

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
    ${heading("Votre code de vérification")}
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
    ${heading("Réinitialisation du mot de passe")}
    <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 24px;">Cliquez sur le bouton ci-dessous pour réinitialiser votre mot de passe :</p>
    ${ctaButton("Réinitialiser le mot de passe", resetLink)}
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
  const t = isFr
    ? {
        subject: "Nouvelle demande d'ami sur MyTripCircle",
        title: "Nouvelle demande d'ami !",
        body: `👋 ${bold(senderName)} souhaite vous ajouter en ami sur MyTripCircle.`,
        footer: "Ouvrez l'application MyTripCircle pour répondre.",
      }
    : {
        subject: "New friend request on MyTripCircle",
        title: "New friend request!",
        body: `👋 ${bold(senderName)} wants to add you as a friend on MyTripCircle.`,
        footer: "Open the MyTripCircle app to respond.",
      };
  const html = wrap(
    heading(t.title) +
    infoCard(cardLine(t.body)) +
    caption(t.footer)
  );
  return _send(to, t.subject, html);
}

async function sendFriendRequestFoundEmail(to, newUserName, lang = "fr") {
  const isFr = lang !== "en";
  const t = isFr
    ? {
        subject: "Votre demande d'ami a été trouvée !",
        title: "Bonne nouvelle !",
        line1: `🎉 ${bold(newUserName)} vient de s'inscrire sur MyTripCircle.`,
        line2: "La demande d'ami que vous avez envoyée est maintenant visible dans leur application !",
      }
    : {
        subject: "Your friend request has been found!",
        title: "Great news!",
        line1: `🎉 ${bold(newUserName)} just signed up on MyTripCircle.`,
        line2: "The friend request you sent is now visible in their app!",
      };
  const html = wrap(
    heading(t.title) +
    infoCard(cardLine(t.line1, { size: 15, marginBottom: 8 }) + cardLine(t.line2, { size: 14 }))
  );
  return _send(to, t.subject, html);
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

  const tripCard = infoCard(
    `<h3 style="color: ${COLORS.terra}; margin: 0 0 12px 0; font-family: Georgia, 'Times New Roman', serif; font-size: 18px;">${tripTitle}</h3>` +
    cardLine(`📍 ${tripDestination}`, { size: 14, marginBottom: 6 }) +
    cardLine(`📅 ${startFmt} → ${endFmt}`, { size: 14 }),
    COLORS.terra
  );

  const isFr = lang !== "en";
  const t = isFr
    ? {
        subject: "Invitation à rejoindre un voyage sur MyTripCircle",
        title: "Vous avez été invité à un voyage !",
        intro: `${bold(inviterName)} vous a invité à rejoindre le voyage :`,
        cta: "Accepter l'invitation",
        expiry: "⏱ Cette invitation expire dans 7 jours.",
      }
    : {
        subject: "You've been invited to join a trip on MyTripCircle",
        title: "You've been invited to a trip!",
        intro: `${bold(inviterName)} has invited you to join:`,
        cta: "Accept the invitation",
        expiry: "⏱ This invitation expires in 7 days.",
      };

  const html = wrap(
    heading(t.title) +
    `<p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 4px;">${t.intro}</p>` +
    tripCard +
    msgBlock +
    ctaButton(t.cta, invitationLink) +
    caption(t.expiry)
  );
  return _send(to, t.subject, html);
}

async function sendFriendJoinedEmail(to, newFriendName) {
  const html = wrap(
    heading("Nouvel ami !") +
    `<p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 16px;">${bold(newFriendName)} a accepté votre invitation et est maintenant votre ami sur MyTripCircle.</p>` +
    infoCard(cardLine("🌍 Commencez à partager vos voyages ensemble !", { size: 14 }))
  );
  return _send(to, `${newFriendName} a rejoint vos amis sur MyTripCircle`, html);
}

module.exports = {
  sendOtpEmail,
  sendPasswordResetEmail,
  sendFriendRequestEmail,
  sendFriendRequestFoundEmail,
  sendTripInvitationEmail,
  sendFriendJoinedEmail,
};
