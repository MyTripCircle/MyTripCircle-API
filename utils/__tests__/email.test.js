// Le transport SMTP et la configuration sont doublés : aucun email n'est envoyé,
// et l'on peut recharger le module avec ou sans identifiants de messagerie.
// Préfixe `mock` obligatoire : les factories de jest.mock sont hoistées au-dessus des require.
const mockSendMail = jest.fn(async () => ({ messageId: "msg-1" }));
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));
const mockConfig = {
  MAIL_USER: "bot@mytripcircle.test",
  MAIL_PASS: "mot-de-passe-applicatif",
  API_BASE_URL: "https://api.mytripcircle.test",
};

jest.mock("nodemailer", () => ({ createTransport: mockCreateTransport }));
jest.mock("../../config", () => mockConfig);

const DEFAULT_CONFIG = { ...mockConfig };

/** Recharge `email.js` avec la configuration voulue (le transport est créé au require). */
function loadEmailModule(configOverrides = {}) {
  jest.resetModules();
  Object.assign(mockConfig, DEFAULT_CONFIG, configOverrides);
  return require("../email");
}

/** Dernier message remis au transport SMTP. */
function lastMail() {
  return mockSendMail.mock.calls.at(-1)[0];
}

describe("email", () => {
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("transport", () => {
    it("should create a Gmail transport when credentials are configured", () => {
      // Act
      loadEmailModule();

      // Assert
      expect(mockCreateTransport).toHaveBeenCalledWith({
        service: "gmail",
        auth: {
          user: "bot@mytripcircle.test",
          pass: "mot-de-passe-applicatif",
        },
      });
    });

    it("should warn instead of creating a transport when credentials are missing", () => {
      // Act
      loadEmailModule({ MAIL_USER: undefined, MAIL_PASS: undefined });

      // Assert
      expect(mockCreateTransport).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "[email] Transporteur non configuré – les emails ne seront pas envoyés"
      );
    });

    it("should report a logged-only success when no transport is configured", async () => {
      // Arrange
      const { sendOtpEmail } = loadEmailModule({ MAIL_PASS: undefined });

      // Act
      const result = await sendOtpEmail("dest@test.com", "123456");

      // Assert
      expect(result).toEqual({ success: true, logged: true });
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it("should send from the configured mailbox when a transport exists", async () => {
      // Arrange
      const { sendOtpEmail } = loadEmailModule();

      // Act
      const result = await sendOtpEmail("dest@test.com", "123456");

      // Assert
      expect(result).toEqual({ success: true });
      expect(lastMail().from).toBe('"MyTripCircle" <bot@mytripcircle.test>');
      expect(lastMail().to).toBe("dest@test.com");
    });

    it("should return the failure reason without leaking it in the log when sending fails", async () => {
      // Arrange
      const { sendOtpEmail } = loadEmailModule();
      mockSendMail.mockRejectedValueOnce(new Error("SMTP indisponible"));

      // Act
      const result = await sendOtpEmail("dest@test.com", "123456");

      // Assert
      expect(result).toEqual({ success: false, error: "SMTP indisponible" });
      expect(errorSpy).toHaveBeenCalledWith(
        "[email] Erreur lors de l'envoi d'un email"
      );
    });
  });

  describe("sendOtpEmail", () => {
    it("should include the one-time code and its expiry in the message", async () => {
      // Arrange
      const { sendOtpEmail } = loadEmailModule();

      // Act
      await sendOtpEmail("dest@test.com", "987654");

      // Assert
      expect(lastMail().subject).toBe("Votre code de vérification MyTripCircle");
      expect(lastMail().html).toContain("987654");
      expect(lastMail().html).toContain("10 minutes");
    });

    it("should wrap the content in the branded header and footer", async () => {
      // Arrange
      const { sendOtpEmail } = loadEmailModule();

      // Act
      await sendOtpEmail("dest@test.com", "987654");

      // Assert
      expect(lastMail().html).toContain("🌍 MyTripCircle");
      expect(lastMail().html).toContain(
        "Cet email a été envoyé automatiquement, merci de ne pas y répondre."
      );
    });
  });

  describe("sendPasswordResetEmail", () => {
    it("should build the reset link from the API base URL and the token", async () => {
      // Arrange
      const { sendPasswordResetEmail } = loadEmailModule();

      // Act
      await sendPasswordResetEmail("dest@test.com", "tok-123");

      // Assert
      const expectedLink =
        "https://api.mytripcircle.test/reset-password?token=tok-123";
      expect(lastMail().subject).toBe("Réinitialisation de votre mot de passe");
      expect(lastMail().html).toContain(expectedLink);
      expect(lastMail().text).toContain(expectedLink);
    });
  });

  describe("sendFriendRequestEmail", () => {
    it("should send the French version by default", async () => {
      // Arrange
      const { sendFriendRequestEmail } = loadEmailModule();

      // Act
      await sendFriendRequestEmail("dest@test.com", "Alice");

      // Assert
      expect(lastMail().subject).toBe("Nouvelle demande d'ami sur MyTripCircle");
      expect(lastMail().html).toContain("souhaite vous ajouter en ami");
    });

    it("should send the English version when the language is en", async () => {
      // Arrange
      const { sendFriendRequestEmail } = loadEmailModule();

      // Act
      await sendFriendRequestEmail("dest@test.com", "Alice", "en");

      // Assert
      expect(lastMail().subject).toBe("New friend request on MyTripCircle");
      expect(lastMail().html).toContain("wants to add you as a friend");
    });

    it("should escape the HTML special characters of the sender name", async () => {
      // Arrange
      const { sendFriendRequestEmail } = loadEmailModule();

      // Act
      await sendFriendRequestEmail(
        "dest@test.com",
        "<script>alert(\"x & 'y'\")</script>"
      );

      // Assert — aucune balise injectée ne subsiste dans le corps du message
      expect(lastMail().html).not.toContain("<script>");
      expect(lastMail().html).toContain(
        "&lt;script&gt;alert(&quot;x &amp; &#39;y&#39;&quot;)&lt;/script&gt;"
      );
    });

    it("should stringify a non-string sender name", async () => {
      // Arrange
      const { sendFriendRequestEmail } = loadEmailModule();

      // Act
      await sendFriendRequestEmail("dest@test.com", 42);

      // Assert
      expect(lastMail().html).toContain(">42</strong>");
    });

    it("should render an empty name when the sender name is null", async () => {
      // Arrange
      const { sendFriendRequestEmail } = loadEmailModule();

      // Act
      await sendFriendRequestEmail("dest@test.com", null);

      // Assert
      expect(lastMail().html).toContain("></strong>");
      expect(lastMail().html).not.toContain("null");
    });
  });

  describe("sendFriendRequestFoundEmail", () => {
    it("should announce the signup in French by default", async () => {
      // Arrange
      const { sendFriendRequestFoundEmail } = loadEmailModule();

      // Act
      await sendFriendRequestFoundEmail("dest@test.com", "Bob");

      // Assert
      expect(lastMail().subject).toBe("Votre demande d'ami a été trouvée !");
      expect(lastMail().html).toContain("vient de s'inscrire sur MyTripCircle");
    });

    it("should announce the signup in English when the language is en", async () => {
      // Arrange
      const { sendFriendRequestFoundEmail } = loadEmailModule();

      // Act
      await sendFriendRequestFoundEmail("dest@test.com", "Bob", "en");

      // Assert
      expect(lastMail().subject).toBe("Your friend request has been found!");
      expect(lastMail().html).toContain("just signed up on MyTripCircle");
    });
  });

  describe("sendTripInvitationEmail", () => {
    const invitation = {
      inviterName: "Alice",
      tripTitle: "Roadtrip <Corse>",
      tripDestination: "Ajaccio",
      // Dates sans fuseau : interprétées en heure locale, donc stables partout
      tripStartDate: "2026-03-05T12:00:00",
      tripEndDate: "2026-03-12T12:00:00",
      invitationLink: "https://api.mytripcircle.test/invite/abc",
    };

    it("should format the trip dates with the French locale by default", async () => {
      // Arrange
      const { sendTripInvitationEmail } = loadEmailModule();

      // Act
      await sendTripInvitationEmail("dest@test.com", invitation);

      // Assert
      expect(lastMail().subject).toBe(
        "Invitation à rejoindre un voyage sur MyTripCircle"
      );
      expect(lastMail().html).toContain("05/03/2026 → 12/03/2026");
    });

    it("should format the trip dates with the US locale when the language is en", async () => {
      // Arrange
      const { sendTripInvitationEmail } = loadEmailModule();

      // Act
      await sendTripInvitationEmail("dest@test.com", invitation, "en");

      // Assert
      expect(lastMail().subject).toBe(
        "You've been invited to join a trip on MyTripCircle"
      );
      expect(lastMail().html).toContain("3/5/2026 → 3/12/2026");
    });

    it("should escape the trip title and destination", async () => {
      // Arrange
      const { sendTripInvitationEmail } = loadEmailModule();

      // Act
      await sendTripInvitationEmail("dest@test.com", invitation);

      // Assert
      expect(lastMail().html).toContain("Roadtrip &lt;Corse&gt;");
      expect(lastMail().html).toContain("📍 Ajaccio");
    });

    it("should point the call-to-action at the invitation link", async () => {
      // Arrange
      const { sendTripInvitationEmail } = loadEmailModule();

      // Act
      await sendTripInvitationEmail("dest@test.com", invitation);

      // Assert
      expect(lastMail().html).toContain(
        'href="https://api.mytripcircle.test/invite/abc"'
      );
      expect(lastMail().html).toContain("Accepter l'invitation");
    });

    it("should include the personal message block when a message is provided", async () => {
      // Arrange
      const { sendTripInvitationEmail } = loadEmailModule();

      // Act
      await sendTripInvitationEmail(
        "dest@test.com",
        { ...invitation, message: "Viens <avec> nous !" },
        "en"
      );

      // Assert
      expect(lastMail().html).toContain('"Viens &lt;avec&gt; nous !"');
    });

    it("should omit the message block when no message is provided", async () => {
      // Arrange
      const { sendTripInvitationEmail } = loadEmailModule();

      // Act
      await sendTripInvitationEmail("dest@test.com", invitation);

      // Assert
      expect(lastMail().html).not.toContain("font-style: italic");
    });
  });

  describe("sendDataExportEmail", () => {
    it("should summarise the exported data counts", async () => {
      // Arrange
      const { sendDataExportEmail } = loadEmailModule();
      const exportData = {
        profile: { name: "Alice", email: "alice@test.com" },
        trips: [{}, {}],
        bookings: [{}],
        addresses: [{}, {}, {}],
        friends: [],
      };

      // Act
      await sendDataExportEmail("dest@test.com", exportData);

      // Assert
      expect(lastMail().subject).toBe(
        "Export de vos données personnelles — MyTripCircle"
      );
      expect(lastMail().html).toContain("Alice");
      expect(lastMail().html).toContain("alice@test.com");
      expect(lastMail().html).toContain("🌍 Voyages : <strong style=\"color: #2A2318;\">2</strong>");
      expect(lastMail().html).toContain("🎫 Réservations : <strong style=\"color: #2A2318;\">1</strong>");
      expect(lastMail().html).toContain("📍 Adresses : <strong style=\"color: #2A2318;\">3</strong>");
      expect(lastMail().html).toContain("👥 Amis : <strong style=\"color: #2A2318;\">0</strong>");
    });

    it("should fall back to placeholders when the export has no profile nor collections", async () => {
      // Arrange
      const { sendDataExportEmail } = loadEmailModule();

      // Act
      await sendDataExportEmail("dest@test.com", {});

      // Assert
      expect(lastMail().html).toContain("👤 Nom : <strong style=\"color: #2A2318;\">—</strong>");
      expect(lastMail().html).toContain("✉️ Email : <strong style=\"color: #2A2318;\">—</strong>");
      expect(lastMail().html).toContain("🌍 Voyages : <strong style=\"color: #2A2318;\">0</strong>");
    });

    it("should attach the raw JSON export in the plain text body", async () => {
      // Arrange
      const { sendDataExportEmail } = loadEmailModule();
      const exportData = { profile: { name: "Alice" } };

      // Act
      await sendDataExportEmail("dest@test.com", exportData);

      // Assert
      expect(lastMail().text).toContain(JSON.stringify(exportData, null, 2));
      expect(lastMail().text).toContain("supprimé dans 7 jours");
    });
  });

  describe("sendFriendJoinedEmail", () => {
    it("should name the new friend in the subject and escape it in the body", async () => {
      // Arrange
      const { sendFriendJoinedEmail } = loadEmailModule();

      // Act
      await sendFriendJoinedEmail("dest@test.com", "Bob & <Alice>");

      // Assert
      expect(lastMail().subject).toBe(
        "Bob & <Alice> a rejoint vos amis sur MyTripCircle"
      );
      expect(lastMail().html).toContain("Bob &amp; &lt;Alice&gt;");
      expect(lastMail().html).toContain("a accepté votre invitation");
    });
  });
});
