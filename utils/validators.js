function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isValidPhone(phone) {
  return typeof phone === "string" && /^\+?[\d\s().-]{7,20}$/.test(phone);
}

module.exports = { isValidEmail, isValidPhone };
