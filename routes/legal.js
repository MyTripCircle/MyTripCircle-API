const express = require("express");
const router = express.Router();

const privacyHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Politique de confidentialité — MyTripCircle</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f9f7f5;
      color: #1a1a1a;
      line-height: 1.7;
      padding: 40px 20px 80px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    header { margin-bottom: 40px; }
    header h1 { font-size: 2rem; font-weight: 700; color: #c4714a; margin-bottom: 6px; }
    header p  { font-size: 0.9rem; color: #888; }
    section   { margin-bottom: 32px; }
    h2 { font-size: 1.1rem; font-weight: 600; color: #333; margin-bottom: 8px; }
    p  { font-size: 0.95rem; color: #444; white-space: pre-line; }
    footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e0d9d2; font-size: 0.85rem; color: #aaa; text-align: center; }
    a { color: #c4714a; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Politique de confidentialité</h1>
      <p>Dernière mise à jour : avril 2026</p>
    </header>

    <section>
      <h2>1. Responsable du traitement</h2>
      <p>Responsable du traitement : Enzo Turpin, développeur indépendant — MyTripCircle.

Contact DPO / exercice des droits : <a href="mailto:privacy@mytripcircle.com">privacy@mytripcircle.com</a>

Pour toute demande (accès, rectification, suppression, portabilité), vous pouvez également utiliser les fonctionnalités intégrées à l'application (Paramètres > Mon compte).</p>
    </section>

    <section>
      <h2>2. Données collectées</h2>
      <p>Nous collectons les données suivantes : nom, adresse e-mail, numéro de téléphone, informations relatives à vos voyages (destinations, dates, réservations), et données d'utilisation de l'application.</p>
    </section>

    <section>
      <h2>3. Finalités du traitement</h2>
      <p>Vos données sont utilisées pour : créer et gérer votre compte, vous permettre de centraliser vos voyages, vous envoyer des notifications relatives à votre compte, améliorer nos services, et vous contacter en cas de besoin.</p>
    </section>

    <section>
      <h2>4. Base légale</h2>
      <p>Le traitement de vos données repose sur votre consentement (lors de la création du compte) et sur l'exécution du contrat de service entre vous et MyTripCircle.</p>
    </section>

    <section>
      <h2>5. Partage des données et sous-traitants</h2>
      <p>Vos données ne sont jamais vendues à des tiers. Elles peuvent être partagées avec vos collaborateurs de voyage (uniquement ce que vous choisissez de partager) et avec nos sous-traitants techniques : MongoDB Atlas (hébergement de la base de données, États-Unis), Google LLC (authentification OAuth, géolocalisation via l'API Places, fourniture de la messagerie via Gmail), Groq Inc. (génération d'itinéraires par IA, fonctionnalité optionnelle). Ces sous-traitants sont soumis à des obligations contractuelles conformes au RGPD.</p>
    </section>

    <section>
      <h2>6. Durée de conservation</h2>
      <p>Vos données sont conservées pendant toute la durée de votre utilisation du service, et supprimées dans un délai de 30 jours suivant la clôture de votre compte, sauf obligation légale contraire.</p>
    </section>

    <section>
      <h2>7. Vos droits</h2>
      <p>Conformément au RGPD, vous disposez des droits suivants : accès, rectification, suppression, portabilité, limitation et opposition au traitement de vos données. Pour les exercer, contactez-nous à <a href="mailto:privacy@mytripcircle.com">privacy@mytripcircle.com</a>.</p>
    </section>

    <section>
      <h2>8. Sécurité</h2>
      <p>Nous mettons en œuvre des mesures techniques et organisationnelles appropriées pour protéger vos données contre tout accès non autorisé, perte ou divulgation.</p>
    </section>

    <section>
      <h2>9. Cookies et traceurs</h2>
      <p>L'application mobile MyTripCircle n'utilise pas de cookies. Aucun identifiant de suivi ni cookie publicitaire n'est déposé sur votre appareil. Le stockage local (SecureStore iOS / Keystore Android) est utilisé exclusivement pour sécuriser votre session d'authentification.</p>
    </section>

    <section>
      <h2>10. Modifications</h2>
      <p>Nous pouvons mettre à jour cette politique à tout moment. Toute modification significative vous sera notifiée par e-mail ou via l'application.</p>
    </section>

    <section>
      <h2>11. Réclamation</h2>
      <p>Si vous estimez que vos droits ne sont pas respectés, vous pouvez introduire une réclamation auprès de la CNIL (<a href="https://www.cnil.fr" target="_blank" rel="noopener">www.cnil.fr</a>).</p>
    </section>

    <footer>
      <p>MyTripCircle — <a href="mailto:privacy@mytripcircle.com">privacy@mytripcircle.com</a></p>
    </footer>
  </div>
</body>
</html>`;

const termsHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Conditions d'utilisation — MyTripCircle</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f9f7f5;
      color: #1a1a1a;
      line-height: 1.7;
      padding: 40px 20px 80px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    header { margin-bottom: 40px; }
    header h1 { font-size: 2rem; font-weight: 700; color: #c4714a; margin-bottom: 6px; }
    header p  { font-size: 0.9rem; color: #888; }
    section   { margin-bottom: 32px; }
    h2 { font-size: 1.1rem; font-weight: 600; color: #333; margin-bottom: 8px; }
    p  { font-size: 0.95rem; color: #444; }
    footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e0d9d2; font-size: 0.85rem; color: #aaa; text-align: center; }
    a { color: #c4714a; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Conditions d'utilisation</h1>
      <p>Dernière mise à jour : avril 2026</p>
    </header>

    <section>
      <h2>1. Acceptation des conditions</h2>
      <p>En utilisant MyTripCircle, vous acceptez les présentes conditions d'utilisation. Si vous n'acceptez pas ces conditions, veuillez ne pas utiliser l'application.</p>
    </section>

    <section>
      <h2>2. Description du service</h2>
      <p>MyTripCircle est une application de gestion de voyages permettant de centraliser vos réservations, adresses et de collaborer avec vos proches sur vos projets de voyage.</p>
    </section>

    <section>
      <h2>3. Création de compte</h2>
      <p>Pour utiliser MyTripCircle, vous devez créer un compte avec une adresse e-mail valide. Vous êtes responsable de la confidentialité de vos identifiants et de toutes les activités réalisées depuis votre compte.</p>
    </section>

    <section>
      <h2>4. Utilisation acceptable</h2>
      <p>Vous vous engagez à utiliser MyTripCircle uniquement à des fins légales et personnelles. Il est interdit d'utiliser l'application pour diffuser du contenu illégal, abusif ou frauduleux.</p>
    </section>

    <section>
      <h2>5. Propriété intellectuelle</h2>
      <p>Tous les éléments de MyTripCircle (logo, design, code, contenus) sont la propriété exclusive de MyTripCircle et sont protégés par les lois sur la propriété intellectuelle.</p>
    </section>

    <section>
      <h2>6. Limitation de responsabilité</h2>
      <p>MyTripCircle ne saurait être tenu responsable des dommages directs ou indirects résultant de l'utilisation ou de l'impossibilité d'utiliser le service, ni des erreurs ou omissions dans les informations fournies.</p>
    </section>

    <section>
      <h2>7. Modification des conditions</h2>
      <p>MyTripCircle se réserve le droit de modifier ces conditions à tout moment. Les utilisateurs seront informés de toute modification significative par e-mail ou notification dans l'application.</p>
    </section>

    <section>
      <h2>8. Résiliation</h2>
      <p>MyTripCircle se réserve le droit de suspendre ou de supprimer votre compte en cas de violation des présentes conditions, sans préavis ni remboursement.</p>
    </section>

    <section>
      <h2>9. Droit applicable</h2>
      <p>Les présentes conditions sont régies par le droit français. Tout litige sera soumis à la compétence exclusive des tribunaux français.</p>
    </section>

    <section>
      <h2>10. Contact</h2>
      <p>Pour toute question relative aux présentes conditions, contactez-nous à : <a href="mailto:support@mytripcircle.com">support@mytripcircle.com</a></p>
    </section>

    <footer>
      <p>MyTripCircle — <a href="mailto:support@mytripcircle.com">support@mytripcircle.com</a></p>
    </footer>
  </div>
</body>
</html>`;

router.get("/privacy", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(privacyHtml);
});

router.get("/terms", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(termsHtml);
});

module.exports = router;
