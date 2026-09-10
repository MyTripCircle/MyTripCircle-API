/**
 * Envoi des courriels transactionnels.
 *
 * Le transporteur est optionnel : en l'absence d'identifiants, le module reste
 * chargeable et les envois deviennent silencieusement inopérants. Cette
 * dégradation est délibérée — elle permet de faire tourner l'environnement de
 * développement et la suite de tests sans compte de messagerie, et sans qu'un
 * parcours d'inscription échoue pour cette seule raison.
 *
 * Toute valeur d'origine utilisateur insérée dans un corps HTML passe par
 * {@link escapeHtml}. Un nom ou un message libre non échappé permettrait
 * d'injecter du balisage dans un courriel envoyé sous l'identité du service.
 *
 * @module utils/email
 */

const nodemailer = require("nodemailer");
const { MAIL_USER, MAIL_PASS, API_BASE_URL } = require("../config");

let transporter = null;

if (MAIL_USER && MAIL_PASS) {
  // Le service « gmail » de nodemailer se connecte déjà en TLS implicite
  // (port 465) ; `secure: true` l'écrit explicitement, pour qu'un changement de
  // service ou de port ne fasse pas retomber l'envoi sur une connexion en clair.
  transporter = nodemailer.createTransport({
    service: "gmail",
    secure: true,
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

// ─── Sécurité HTML ────────────────────────────────────────────────────────────

/**
 * Échappe les caractères significatifs du HTML.
 *
 * L'esperluette est traitée en premier : la remplacer après les autres
 * réécrirait les entités que celles-ci viennent de produire, et laisserait
 * passer une séquence reconstituable côté client.
 *
 * @param {*} str Valeur à insérer dans un corps HTML.
 * @returns {string} Chaîne échappée. Une valeur non textuelle est convertie,
 *   une valeur absente devenant une chaîne vide plutôt que le mot « null ».
 */
function escapeHtml(str) {
  if (typeof str !== "string") return String(str ?? "");
  return str
    .replaceAll('&', "&amp;")
    .replaceAll('<', "&lt;")
    .replaceAll('>', "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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

/**
 * Remet un courriel au transporteur, ou l'ignore si aucun n'est configuré.
 *
 * L'issue est toujours rendue sous forme de valeur, jamais d'erreur émise :
 * l'envoi d'une notification est accessoire au parcours qui le déclenche, et
 * faire échouer une inscription ou une invitation parce qu'un serveur de
 * messagerie est indisponible dégraderait le service bien au-delà de
 * l'incident. Le drapeau `logged` distingue l'absence de transporteur d'un
 * envoi réellement effectué.
 *
 * Le message d'erreur du transporteur est journalisé sans l'adresse
 * destinataire, celle-ci étant une donnée personnelle qui n'a pas à figurer
 * dans les journaux.
 *
 * @param {string} to Adresse du destinataire.
 * @param {string} subject Objet du message.
 * @param {string} html Corps HTML.
 * @param {string} [text] Version texte, pour les clients qui n'affichent pas le
 *   HTML.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 * @private
 */
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

/**
 * Transmet un code de vérification à usage unique.
 *
 * Le code est le seul élément de sécurité du message : aucun lien cliquable n'y
 * figure, afin que l'utilisateur n'apprenne pas à suivre un lien reçu par
 * courriel dans un contexte d'authentification — habitude sur laquelle repose
 * l'hameçonnage. La durée de validité est rappelée dans le corps pour que la
 * péremption soit comprise comme normale et non comme une panne.
 *
 * @param {string} to Adresse du destinataire.
 * @param {string} otp Code produit par `utils/authHelpers.generateOtp`.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 */
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

/**
 * Transmet le lien de réinitialisation du mot de passe.
 *
 * Le lien est aussi reproduit en clair dans le corps : un utilisateur averti
 * peut ainsi vérifier le domaine avant de cliquer, ce que le bouton seul ne
 * permet pas. Une version texte accompagne le HTML, ce message étant parfois le
 * seul moyen de reprendre la main sur un compte — il doit rester exploitable
 * dans un client qui n'affiche pas le HTML.
 *
 * La validité d'une heure, plus courte que celle d'un code de vérification,
 * tient à ce que ce lien suffit à lui seul à prendre le contrôle du compte.
 *
 * @param {string} to Adresse du destinataire.
 * @param {string} resetToken Jeton de réinitialisation à usage unique.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 */
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

/**
 * Signale une demande d'ami en attente.
 *
 * Le message renvoie vers l'application sans proposer d'action directe : une
 * acceptation par simple clic dans un courriel s'exécuterait hors de toute
 * session authentifiée et suffirait à établir un lien social à l'insu du
 * destinataire.
 *
 * Le nom de l'émetteur est échappé : il est librement saisi par un tiers.
 *
 * @param {string} to Adresse du destinataire.
 * @param {string} senderName Nom de la personne à l'origine de la demande.
 * @param {string} [lang="fr"] Langue du destinataire ; toute valeur autre que
 *   `"en"` retombe sur le français, langue de référence du produit.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 */
async function sendFriendRequestEmail(to, senderName, lang = "fr") {
  const isFr = lang !== "en";
  const t = isFr
    ? {
        subject: "Nouvelle demande d'ami sur MyTripCircle",
        title: "Nouvelle demande d'ami !",
        body: `👋 ${bold(escapeHtml(senderName))} souhaite vous ajouter en ami sur MyTripCircle.`,
        footer: "Ouvrez l'application MyTripCircle pour répondre.",
      }
    : {
        subject: "New friend request on MyTripCircle",
        title: "New friend request!",
        body: `👋 ${bold(escapeHtml(senderName))} wants to add you as a friend on MyTripCircle.`,
        footer: "Open the MyTripCircle app to respond.",
      };
  const html = wrap(
    heading(t.title) +
    infoCard(cardLine(t.body)) +
    caption(t.footer)
  );
  return _send(to, t.subject, html);
}

/**
 * Informe l'émetteur d'une demande d'ami que son destinataire vient de
 * s'inscrire.
 *
 * Une demande adressée à quelqu'un qui n'a pas encore de compte reste en
 * attente sans que personne ne puisse la voir. Ce message ferme cette boucle,
 * qui resterait autrement ouverte indéfiniment du point de vue de l'émetteur.
 *
 * @param {string} to Adresse de l'émetteur de la demande initiale.
 * @param {string} newUserName Nom du nouvel inscrit.
 * @param {string} [lang="fr"] Langue du destinataire ; toute valeur autre que
 *   `"en"` retombe sur le français.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 */
async function sendFriendRequestFoundEmail(to, newUserName, lang = "fr") {
  const isFr = lang !== "en";
  const t = isFr
    ? {
        subject: "Votre demande d'ami a été trouvée !",
        title: "Bonne nouvelle !",
        line1: `🎉 ${bold(escapeHtml(newUserName))} vient de s'inscrire sur MyTripCircle.`,
        line2: "La demande d'ami que vous avez envoyée est maintenant visible dans leur application !",
      }
    : {
        subject: "Your friend request has been found!",
        title: "Great news!",
        line1: `🎉 ${bold(escapeHtml(newUserName))} just signed up on MyTripCircle.`,
        line2: "The friend request you sent is now visible in their app!",
      };
  const html = wrap(
    heading(t.title) +
    infoCard(cardLine(t.line1, { size: 15, marginBottom: 8 }) + cardLine(t.line2, { size: 14 }))
  );
  return _send(to, t.subject, html);
}

/**
 * Adresse une invitation à rejoindre un voyage.
 *
 * Le titre, la destination et le message d'accompagnement sont saisis par
 * l'invitant et échappés avant insertion ; ce message part vers une adresse qui
 * n'est pas nécessairement celle d'un utilisateur inscrit, donc vers un
 * destinataire sur lequel le service n'a aucune prise.
 *
 * Les dates sont formatées selon la locale du destinataire et non celle du
 * serveur : un intervalle lu dans le mauvais ordre jour-mois ferait manquer un
 * voyage.
 *
 * @param {string} to Adresse de l'invité.
 * @param {object} details Détails de l'invitation.
 * @param {string} details.inviterName Nom de l'invitant.
 * @param {string} details.tripTitle Titre du voyage.
 * @param {string} details.tripDestination Destination.
 * @param {string|Date} details.tripStartDate Date de début.
 * @param {string|Date} details.tripEndDate Date de fin.
 * @param {string} [details.message] Message libre de l'invitant.
 * @param {string} details.invitationLink Lien d'acceptation, valable sept jours.
 * @param {string} [lang="fr"] Langue du destinataire ; toute valeur autre que
 *   `"en"` retombe sur le français.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 */
async function sendTripInvitationEmail(
  to,
  { inviterName, tripTitle, tripDestination, tripStartDate, tripEndDate, message, invitationLink },
  lang = "fr"
) {
  const locale = lang === "en" ? "en-US" : "fr-FR";
  const startFmt = new Date(tripStartDate).toLocaleDateString(locale);
  const endFmt = new Date(tripEndDate).toLocaleDateString(locale);

  const msgBlock = message
    ? `<div style="background: ${COLORS.terraLight}; padding: 16px; border-radius: 8px; margin: 0 0 20px;">
         <p style="color: ${COLORS.inkMid}; font-style: italic; margin: 0; font-size: 14px;">"${escapeHtml(message)}"</p>
       </div>`
    : "";

  const tripCard = infoCard(
    `<h3 style="color: ${COLORS.terra}; margin: 0 0 12px 0; font-family: Georgia, 'Times New Roman', serif; font-size: 18px;">${escapeHtml(tripTitle)}</h3>` +
    cardLine(`📍 ${escapeHtml(tripDestination)}`, { size: 14, marginBottom: 6 }) +
    cardLine(`📅 ${startFmt} → ${endFmt}`, { size: 14 }),
    COLORS.terra
  );

  const isFr = lang !== "en";
  const t = isFr
    ? {
        subject: "Invitation à rejoindre un voyage sur MyTripCircle",
        title: "Vous avez été invité à un voyage !",
        intro: `${bold(escapeHtml(inviterName))} vous a invité à rejoindre le voyage :`,
        cta: "Accepter l'invitation",
        expiry: "⏱ Cette invitation expire dans 7 jours.",
      }
    : {
        subject: "You've been invited to join a trip on MyTripCircle",
        title: "You've been invited to a trip!",
        intro: `${bold(escapeHtml(inviterName))} has invited you to join:`,
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

/**
 * Remet à l'utilisateur l'intégralité de ses données personnelles.
 *
 * Répond au droit à la portabilité de l'article 20 du RGPD, exercé ici à
 * l'occasion d'une demande de suppression. Le corps HTML n'expose qu'un
 * récapitulatif chiffré, tandis que la version texte porte l'export JSON
 * complet : c'est cette dernière qui satisfait l'exigence d'un format
 * structuré et lisible par machine, un tableau HTML ne s'y prêtant pas.
 *
 * L'envoi précède la suppression effective, de sorte que l'utilisateur dispose
 * de ses données avant qu'elles ne deviennent irrécupérables. Le délai de
 * rétractation restant est rappelé dans le message.
 *
 * @param {string} to Adresse du titulaire du compte.
 * @param {object} exportData Données rassemblées : `profile`, `trips`,
 *   `bookings`, `addresses`, `friends`, déjà déchiffrées.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 */
async function sendDataExportEmail(to, exportData) {
  const profile = exportData.profile || {};
  const tripsCount = (exportData.trips || []).length;
  const bookingsCount = (exportData.bookings || []).length;
  const addressesCount = (exportData.addresses || []).length;
  const friendsCount = (exportData.friends || []).length;
  const exportJson = JSON.stringify(exportData, null, 2);

  const html = wrap(`
    ${heading("Export de vos données personnelles")}
    <p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 20px;">
      Suite à votre demande de suppression de compte, voici l'intégralité de vos données personnelles au format JSON.
    </p>
    ${infoCard(`
      ${cardLine(`👤 Nom : ${bold(escapeHtml(profile.name || "—"))}`, { size: 14, marginBottom: 6 })}
      ${cardLine(`✉️ Email : ${bold(escapeHtml(profile.email || "—"))}`, { size: 14, marginBottom: 6 })}
      ${cardLine(`🌍 Voyages : ${bold(String(tripsCount))}`, { size: 14, marginBottom: 6 })}
      ${cardLine(`🎫 Réservations : ${bold(String(bookingsCount))}`, { size: 14, marginBottom: 6 })}
      ${cardLine(`📍 Adresses : ${bold(String(addressesCount))}`, { size: 14, marginBottom: 6 })}
      ${cardLine(`👥 Amis : ${bold(String(friendsCount))}`, { size: 14 })}
    `)}
    <p style="color: ${COLORS.inkLight}; font-size: 13px; margin: 16px 0 0;">
      ⏳ Votre compte sera définitivement supprimé dans <strong>7 jours</strong>.<br>
      Si vous changez d'avis, vous pouvez annuler la suppression depuis l'application.
    </p>
    <p style="color: ${COLORS.inkLight}; font-size: 12px; margin: 12px 0 0;">
      Export généré le ${new Date().toLocaleDateString("fr-FR")} à ${new Date().toLocaleTimeString("fr-FR")}.
    </p>
  `);

  const text = `Export de vos données MyTripCircle\n\nVotre compte sera supprimé dans 7 jours.\n\n${exportJson}`;

  return _send(to, "Export de vos données personnelles — MyTripCircle", html, text);
}

/**
 * Confirme qu'une invitation d'ami a été acceptée.
 *
 * Le nom apparaît échappé dans le corps, mais brut dans l'objet : les en-têtes
 * de message ne sont pas interprétés comme du HTML, et les y échapper afficherait
 * des entités littérales dans la liste des messages du destinataire.
 *
 * @param {string} to Adresse de l'invitant.
 * @param {string} newFriendName Nom de la personne ayant accepté.
 * @returns {Promise<{ success: boolean, logged?: boolean, error?: string }>}
 *   Issue de l'envoi.
 */
async function sendFriendJoinedEmail(to, newFriendName) {
  const html = wrap(
    heading("Nouvel ami !") +
    `<p style="color: ${COLORS.inkMid}; font-size: 15px; margin: 0 0 16px;">${bold(escapeHtml(newFriendName))} a accepté votre invitation et est maintenant votre ami sur MyTripCircle.</p>` +
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
  sendDataExportEmail,
};
