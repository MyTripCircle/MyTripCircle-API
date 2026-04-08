function isValidEmail(email) {
  return typeof email === "string" && /^[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,253}\.[a-zA-Z]{2,}$/.test(email);
}

function isValidPhone(phone) {
  return typeof phone === "string" && /^\+?[\d\s().-]{7,20}$/.test(phone);
}

module.exports = { isValidEmail, isValidPhone };
